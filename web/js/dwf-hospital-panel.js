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

// The hospital / health panel, delegated to from the shared zone panel when a zone is a hospital.

  // Falls back to a minimal escape so the pure shapers below still run under node.
  function _hospEsc(s) {
    if (typeof DWFUI !== "undefined" && DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Fallback labels only: the server's `label` is authoritative and its array fixes the order.
  var _HOSP_SUPPLY_LABELS = {
    splints: "Splints", thread: "Thread", cloth: "Cloth", crutches: "Crutches",
    plaster: "Cast powder", buckets: "Buckets", soap: "Soap",
  };

  // Tooltip note for the scaled rows: what one unit of this supply actually costs.
  var _HOSP_SUPPLY_UNIT_NOTE = {
    thread: "One unit here is a full reel of thread.",
    cloth: "One unit here is a full bolt of cloth.",
    plaster: "One unit here is a full bag of cast powder.",
    soap: "One unit here is a full cake of soap.",
  };

  // ---- pure data-shapers (node-testable) ------------------------------------------------

  // stockDisplay and targetDisplay arrive PRE-ROUNDED and their rules differ (stock up, target
  // down); recomputing either from the raw counts misreads a partial thread reel as 0 in stock.
  function supplyRows(info) {
    var list = (info && Array.isArray(info.supplies)) ? info.supplies.filter(Boolean) : [];
    return list.map(function (s) {
      var key = (s && s.key) || "";
      var level = Number(s && (s.targetDisplay != null ? s.targetDisplay : s.desiredLevel));
      if (!Number.isFinite(level)) level = 0;
      level = Math.max(0, Math.min(99, Math.round(level)));
      // countLevel is the older floor value, a fallback only.
      var count = Number(s && (s.stockDisplay != null ? s.stockDisplay : s.countLevel));
      if (!Number.isFinite(count)) count = 0;
      count = Math.max(0, Math.round(count));
      var isShort = (s && s.short != null) ? !!s.short : !!(s && s.needMore);
      return {
        key: key,
        label: (s && s.label) || _HOSP_SUPPLY_LABELS[key] || key || "(supply)",
        level: level,
        count: count,
        short: isShort,
        needMore: isShort,
        unitNote: _HOSP_SUPPLY_UNIT_NOTE[key] || "",
        dec: Math.max(0, level - 1),
        inc: Math.min(99, level + 1),
      };
    }).filter(function (r) { return r.key; });
  }

  // Exactly one access level is in force at a time: a priority chain, not four toggles.
  var _HOSP_ACCESS_TEXT = {
    MEMBERS: "Members only",
    ALL_VISITORS: "Open to all visitors",
    CITIZENS_AND_RESIDENTS: "Citizens and long-term residents",
    CITIZENS: "Citizens only",
  };
  function accessText(info) {
    return _HOSP_ACCESS_TEXT[info && info.accessLevel] || "";
  }

  // A hospital's access strip is THREE tiles (visitors, residents, citizens). "Members" is a
  // temple/guildhall concept, and a fourth tile invents a policy the player cannot be in.
  var _HOSP_ACCESS_TILES = [
    { key: "visitors",  word: "VISITORS",  label: "All visitors welcome",
      title: "This option allows visitors from outside the fortress to enter this location." },
    { key: "residents", word: "RESIDENTS", label: "Citizens and long-term residents only",
      title: "This option allows long-term residents of the fortress to enter this location." },
    { key: "citizens",  word: "CITIZENS",  label: "Citizens only",
      title: "This option indicates that the location is only open to fortress citizens." },
  ];
  function hospitalAccessHtml(locationData) {
    var d = locationData || {};
    var native = d.native || {};
    var raw = native.accessMode != null ? native.accessMode
      : (d.restriction != null ? d.restriction : null);
    var current = raw == null ? "" : String(raw);
    if (current === "everyone") current = "visitors";
    var enabled = !!(native.guards && native.guards.locationAccess);
    var selected = null;
    _HOSP_ACCESS_TILES.forEach(function (a) { if (a.key === current) selected = a; });
    var tiles = DWFUI.accessPolicyButtonsHtml({
      options: _HOSP_ACCESS_TILES, current: current, enabled: enabled, datasetKey: "locAccess",
    });
    var status = selected
      ? DWFUI.statusHtml({ tag: "span", cls: "location-access-state", tone: "good", text: selected.label })
      : DWFUI.statusHtml({ tag: "span", cls: "location-access-state", tone: "dim", text: "Access unavailable" });
    var guard = enabled ? "" : DWFUI.statusHtml({
      tag: "span", cls: "location-access-guard", tone: "dim",
      text: "Read-only: the host has not enabled location access changes.",
    });
    return '<div class="location-access hospital-access" aria-label="Hospital access">' +
      tiles + status + guard + '</div>';
  }

  var _HOSP_OCCUPATION_ORDER = ["DOCTOR", "DIAGNOSTICIAN", "SURGEON", "BONE_DOCTOR"];
  var _HOSP_OCCUPATION_LABELS = {
    DOCTOR: "Doctor", DIAGNOSTICIAN: "Diagnostician",
    SURGEON: "Surgeon", BONE_DOCTOR: "Bone Doctor",
  };
  function occupationRows(info) {
    var list = (info && Array.isArray(info.occupations)) ? info.occupations.filter(Boolean) : [];
    return list.map(function (o) {
      var key = (o && o.typeKey) || "";
      return {
        typeKey: key,
        label: _HOSP_OCCUPATION_LABELS[key] || key,
        holderName: (o && o.holderName) || null,
      };
    }).filter(function (r) { return _HOSP_OCCUPATION_LABELS[r.typeKey]; });
  }

  // ---- staff rows -----------------------------------------------------------------------------
  function staffRows(locationData) {
    var list = (locationData && Array.isArray(locationData.occupations))
      ? locationData.occupations.filter(Boolean) : [];
    var rows = [];
    _HOSP_OCCUPATION_ORDER.forEach(function (typeKey) {
      var mine = list.filter(function (o) { return o && o.typeKey === typeKey; });
      var label = _HOSP_OCCUPATION_LABELS[typeKey];
      mine.forEach(function (o) {
        if (!(Number(o.unitId) >= 0)) return;
        rows.push({
          typeKey: typeKey, label: label, filled: true,
          slot: "id:" + Number(o.id), occId: Number(o.id), unitId: Number(o.unitId),
          holder: String(o.holder || ""), professionColor: Number(o.professionColor),
        });
      });
      var vacant = null;
      for (var i = 0; i < mine.length; i++) {
        if (Number(mine[i].unitId) < 0 && Number(mine[i].id) >= 0) { vacant = mine[i]; break; }
      }
      rows.push({
        typeKey: typeKey, label: label, filled: false,
        slot: vacant ? ("id:" + Number(vacant.id)) : typeKey,
        occId: vacant ? Number(vacant.id) : -1, unitId: -1,
        holder: "", professionColor: -1,
      });
    });
    return rows;
  }

  // ---- candidate filter: children are not hospital staff --------------------------------------
  function isChildProfession(profession) {
    return /(^|\s)(child|baby)$/i.test(String(profession == null ? "" : profession).trim());
  }

  function staffCandidates(locationData, query) {
    var result = DwfLocationModel.candidateRows(locationData, query, {
      accept: function (candidate) { return !isChildProfession(candidate.profession); },
      validateUnitId: true,
      reportRejected: true,
    });
    return { rows: result.rows, serverChildren: result.rejected };
  }

  // Older hosts send no `staffed`, so a missing field must count as staffed or an unchanged
  // server blanks a working panel.
  function isStaffed(info) {
    return !info || info.staffed == null ? true : !!info.staffed;
  }

  // Native's wording: `chests` is what the server counts as Box/Cabinet.
  function furnitureLines(info) {
    var f = (info && info.furniture) || {};
    var n = function (v) { return Math.max(0, Number(v) || 0); };
    return [
      "Beds in common area: " + n(f.beds),
      "Tables in common area: " + n(f.tables),
      "Traction benches in common area: " + n(f.tractionBenches),
      "Chests in common area: " + n(f.containers),
    ];
  }

  function furnitureText(info) {
    var f = (info && info.furniture) || {};
    var beds = Number(f.beds) || 0;
    var tables = Number(f.tables) || 0;
    var traction = Number(f.tractionBenches) || 0;
    var containers = Number(f.containers) || 0;
    function plur(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
    return [plur(beds, "bed"), plur(tables, "table"),
            plur(traction, "traction bench", "traction benches"),
            plur(containers, "container")].join(" · ");
  }

  // Medical labor key -> display label.
  var _HOSP_LABOR_LABELS = {
    diagnose: "Diagnosis", surgery: "Surgery", bonesetting: "Bone setting",
    suturing: "Suturing", dressing: "Dressing", feedwater: "Feed/water", recover: "Recovery",
  };
  function doctorRows(info) {
    var list = (info && Array.isArray(info.doctors)) ? info.doctors.filter(Boolean) : [];
    return list.map(function (d) {
      var labors = (d && Array.isArray(d.labors)) ? d.labors : [];
      return {
        unitId: Number(d && d.unitId),
        name: (d && d.name) || "(dwarf)",
        profession: (d && d.profession) || "",
        professionColor: Number(d && d.professionColor),
        labors: labors.map(function (k) { return _HOSP_LABOR_LABELS[k] || k; }),
      };
    }).filter(function (r) { return Number.isFinite(r.unitId) && r.unitId >= 0; });
  }

  // ---- rendering (browser only) ---------------------------------------------------------

  var _hospState = {
    zoneId: -1, locationId: -1, info: null, locationData: null,
    zoneName: "Hospital", busy: false,
    // Staff flow: the open picker's slot key, its search text, and unitId -> only_do_assigned_jobs.
    pickerFor: null, search: "", specialists: null, portraits: null,
  };

  // The kind suffix is appended here, never baked into the server's bare `name`. The rename route
  // is keyed by ZONE id, so the quill fails closed on a hospital opened without one.
  function _hospTitle(info, fallback) {
    var base = String((info && info.name) || fallback || "Hospital").trim();
    if (!base) return "Hospital";
    return /hospital$/i.test(base) ? base : base + " Hospital";
  }
  function _hospRenameZoneId(state) {
    var s = state || {};
    if (Number(s.zoneId) >= 0) return Number(s.zoneId);
    var zones = s.locationData && Array.isArray(s.locationData.zones) ? s.locationData.zones : [];
    return zones.length && Number(zones[0].id) >= 0 ? Number(zones[0].id) : -1;
  }
  function _hospHeader(name, state) {
    var s = state || {};
    var canRename = _hospRenameZoneId(s) >= 0 && Number(s.locationId) >= 0;
    return DWFUI.headerHtml({ cls: "building-head", title: name || "Hospital", titleCls: "building-name",
      tools: [{ role: "quill", cls: "hospital-rename", disabled: !canRename,
        dataset: canRename ? { hospAct: "rename" } : {},
        title: canRename
          ? "Rename this hospital"
          : "Renaming needs the zone this hospital is attached to, which this panel was not given.",
        ariaLabel: "Rename hospital" }],
      close: { cls: "building-x", dataset: { hospClose: "" }, title: "Close" } });
  }

  // Prefer the zone id: it carries its own site_id server-side.
  function _hospKey() {
    var s = _hospState;
    return s.zoneId >= 0 ? ("zone=" + s.zoneId) : ("location=" + s.locationId);
  }

  async function _hospFetchJson(path) {
    var r = await fetch(path, { cache: "no-store" });
    var text = await r.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("hospital-panel.response-parse"); }
    if (!r.ok && !(data && data.ok === false))
      throw new Error((data && data.error) || text.trim() || "request failed");
    return data;
  }

  async function _hospPost(path) {
    var sep = path.includes("?") ? "&" : "?";
    var r = await fetch(path + sep + "t=" + Date.now(), { method: "POST", cache: "no-store" });
    var text = await r.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { globalThis.DwfErr?.count("hospital-panel.post-response-parse"); }
    if (!r.ok || data.ok === false)
      throw new Error(data.error || text.trim() || "request failed");
    return data;
  }

  async function openHospitalPanel(locationId, zoneInfo) {
    _hospState = {
      zoneId: (zoneInfo && Number(zoneInfo.id) >= 0) ? Number(zoneInfo.id) : -1,
      locationId: Number(locationId) >= 0 ? Number(locationId)
                 : ((zoneInfo && Number(zoneInfo.hospitalLocationId)) || -1),
      info: null,
      locationData: (zoneInfo && zoneInfo.locationData) || null,
      zoneName: (zoneInfo && zoneInfo.name) || "Hospital", busy: false,
      pickerFor: null, search: "", specialists: null, portraits: null,
    };
    if (typeof selection !== "undefined") {
      selection.className = "visible building-panel";
      panelContent(selection).innerHTML = _hospHeader(_hospState.zoneName) +
        '<div class="building-status">Loading hospital…</div>';
      var x = selection.querySelector("[data-hosp-close]");
      if (x) x.addEventListener("click", function (e) { e.stopPropagation(); closeSelection(); focusPage(); });
    }
    try {
      _hospState.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now());
    } catch (err) {
      _hospState.info = { ok: false, error: (err && err.message) || "unavailable" };
    }
    await _hospLoadLocation();
    await _hospLoadSpecialists();
    _hospRender();
  }

  // The only read carrying occupation ids and candidates, so the assign controls need it. Always
  // re-fetch on open: a payload handed over from the location panel may predate a later write.
  async function _hospLoadLocation() {
    var s = _hospState;
    if (!(s.locationId >= 0)) return;
    try { s.locationData = await _hospFetchJson("/location-detail?id=" + s.locationId + "&t=" + Date.now()); }
    catch { globalThis.DwfErr?.count("hospital-panel.location-load"); }
  }

  // /labor?detail=<i> returns the fort-wide roster, so one request fills every lock tile. On
  // failure `specialists` stays null and the tiles render disabled rather than guessing.
  async function _hospLoadSpecialists() {
    var s = _hospState;
    s.specialists = null;
    try {
      var index = await _hospFetchJson("/labor?t=" + Date.now());
      var details = (index && Array.isArray(index.details)) ? index.details : [];
      if (!details.length) return;
      var first = Number(details[0].index);
      if (!Number.isFinite(first)) return;
      var page = await _hospFetchJson("/labor?detail=" + first + "&t=" + Date.now());
      var rows = (page && Array.isArray(page.rows)) ? page.rows : [];
      if (!rows.length) return;
      var map = {}, portraits = {};
      rows.forEach(function (row) {
        if (!row || !(Number(row.id) >= 0)) return;
        map[Number(row.id)] = !!row.specialist;
        // /location-detail's occupation rows carry no portraitTexpos; this read is where it comes from.
        portraits[Number(row.id)] = Number(row.portraitTexpos);
      });
      s.specialists = map;
      s.portraits = portraits;
    } catch { s.specialists = null; s.portraits = null; }
  }

  function _hospBadge(text, cls) {
    return '<span class="hospital-badge' + (cls ? " " + cls : "") + '">' + _hospEsc(text) + '</span>';
  }

  function _hospProfessionStyle(record) {
    var idx = Number(record && record.professionColor);
    return Number.isInteger(idx) && idx >= 0 && idx <= 15
      ? ' style="color:' + DWFUI.dfColor(idx) + '"' : "";
  }

  // ---- one native staff row -------------------------------------------------------------------
  // DF ships exactly ONE hospital occupation icon, so native draws the same caduceus on all four roles.
  function _hospStaffRowHtml(r, s, cands) {
    var open = s.pickerFor === r.slot;
    var texpos = (s.portraits && s.portraits[r.unitId] != null) ? s.portraits[r.unitId] : undefined;
    var portrait = r.filled
      ? (typeof unitPortraitMarkup === "function"
        ? unitPortraitMarkup({ unitId: r.unitId, id: r.unitId, name: r.holder,
            portraitTexpos: texpos }, "info-portrait-small")
        : "")
      : DWFUI.artBtnHtml({
        cls: "hospital-staff-assign", sprite: "LOCATION_ASSIGN_OCCUPATION", size: 24,
        active: open, dataset: { hospStaffAssign: r.slot },
        title: open ? "Close the candidate list" : "Assign a " + r.label.toLowerCase(),
        ariaLabel: "Assign a " + r.label.toLowerCase(),
      });
    var specialist = s.specialists ? s.specialists[r.unitId] : undefined;
    var lock = "";
    if (r.filled) {
        // Unknown specialist state renders the latch DISABLED: a padlock is a claim about the dwarf,
        // and the wrong colour lies about whether they will take hospital work.
      lock = DWFUI.latchHtml({
        cls: "hospital-staff-lock", on: specialist === true,
        sprite: "WORKER_DO_ANY_AVAILABLE_JOB", activeSprite: "WORKER_ONLY_DO_ASSIGNED_JOBS",
        size: 24, disabled: specialist === undefined, hotkey: "Ctrl+z",
        dataset: specialist === undefined ? {} : { hospStaffSpec: r.unitId, on: specialist ? 1 : 0 },
        title: specialist === undefined
          ? "Worker specialization is unavailable (the labor read did not return)."
          : (specialist
            ? "Locked: only does its assigned work details (click to allow any free task)"
            : "Unlocked: does any free task (click to lock to assigned work)"),
      });
    }
    var remove = r.filled
      ? DWFUI.artBtnHtml({
        cls: "hospital-staff-remove", sprite: "LOCATION_OCCUPATION_REMOVE_WORKER", size: 24,
        dataset: { hospStaffRemove: r.slot },
        title: "Remove " + (r.holder || "this worker") + " from this post",
        ariaLabel: "Remove from post",
      })
      : "";
    var name = r.filled
      ? '<span class="hospital-staff-name"' + _hospProfessionStyle(r) + '>' + _hospEsc(r.holder) + '</span>'
      : '<span class="hospital-staff-name hospital-dim"></span>';
    var row = '<div class="hospital-staff' + (r.filled ? " filled" : " vacant") + '" data-hosp-staff="' +
      _hospEsc(r.slot) + '">' +
      '<span class="hospital-staff-icon">' +
        DWFUI.iconHtml({ sprite: "LOCATION_OCCUPATION_DOCTOR", size: 24, nativeCell: true, alt: "" }) +
      '</span>' +
      '<span class="hospital-staff-role">' + _hospEsc(r.label) + '</span>' +
      '<span class="hospital-staff-portrait">' + portrait + '</span>' +
      name +
      '<span class="hospital-staff-ctrl">' + lock + remove + '</span>' +
      '</div>';
    return row + (open ? _hospPickerHtml(r, s, cands) : "");
  }

  function _hospPickerHtml(r, s, cands) {
    var rows = cands.rows;
    var body = rows.length
      ? rows.map(function (c) {
        return '<div class="hospital-cand" data-hosp-staff-pick="' + c.unitId + '" data-hosp-staff-slot="' +
          _hospEsc(r.slot) + '">' +
          '<span class="hospital-cand-name"' + _hospProfessionStyle(c) + '>' + _hospEsc(c.name) + '</span>' +
          (c.held ? ' <span class="hospital-dim">already ' + _hospEsc(c.held) + '</span>' : "") +
          '</div>';
      }).join("")
      : '<div class="building-note">No eligible citizens' + (s.search ? " match that search" : "") + '.</div>';
    return '<div class="hospital-staff-picker">' +
      DWFUI.searchHtml({ cls: "hospital-cand-search-row", inputCls: "hospital-cand-search",
        dataAttr: "hospital-staff-search", value: s.search || "", magnifier: true,
        placeholder: "Search citizens", ariaLabel: "Search staff candidates" }) +
      DWFUI.scrollHtml({ cls: "hospital-cand-list", preserveKey: "hospital-candidates",
        ariaLabel: "Staff candidates" }, body) +
      '</div>';
  }

  function hospitalPanelMarkup(state) {
    var s = state || {};
    if (!s.info) return _hospHeader(s.zoneName || "Hospital") + '<div class="building-status">Loading hospitalâ€¦</div>';
    var info = s.info || {};
    if (info.ok === false) {
      return _hospHeader(s.zoneName || "Hospital") +
        '<div class="building-status err">' + _hospEsc(info.error || "Hospital data unavailable.") + '</div>';
    }

    // An unstaffed hospital renders ONE sentence and nothing else: stocked supplies for a hospital
    // that cannot treat anyone is the misleading state this gate exists to prevent.
    if (!isStaffed(info)) {
      var position = (info.requiredPosition || "").trim();
      var sentence = position
        ? "This hospital will not treat anyone until a " + position + " is appointed."
        : "This hospital will not treat anyone until a chief medical dwarf is appointed.";
      return _hospHeader(info.name || s.zoneName) +
        DWFUI.scrollHtml({ cls: "hospital-panel-body", ariaLabel: "Hospital" },
          // `.building-status` alone is the panel's success green; `gate` is the blocked-but-fixable amber.
          '<div class="building-status gate">' + _hospEsc(sentence) + '</div>' +
          DWFUI.plaqueBtnHtml({ cls: "building-btn", tone: "gold", dataset: { hospAct: "nobles" },
            label: "Open Nobles" }));
    }

    // The only production consumer of stepperHtml: it must pass `art: true`, or "+" and "-" render
    // as plain text glyphs while the native increase/decrease tiles sit unused.
    var supplies = supplyRows(info);
    var suppliesHtml = supplies.length ? supplies.map(function (r) {
      // The shortfall badge comes from the server's `short` flag (DF's need_more bit), never stock < target.
      var need = r.short ? _hospBadge("short", "want") : "";
      return '<div class="hospital-supply" data-hosp-supply="' + _hospEsc(r.key) + '"' +
        (r.unitNote ? ' title="' + _hospEsc(r.unitNote) + '"' : "") + '>' +
        // Native's own row caption is "<Supply> (Desired):" -- the label carries the "(Desired)"
        // qualifier, and the stock/target pair lives in the stepper's readout beside the tiles.
        // The `-meta` track therefore holds nothing now: the count it used to carry ("have 0") is
        // the first half of the readout, and printing it twice is how a row starts disagreeing
        // with itself. The element stays because the row's four-track grid is pinned by
        // w4_health_hospital_fixture_test V1 and re-flowing that grid is not this lane's business.
        '<span class="hospital-supply-label">' + _hospEsc(r.label) + ' (Desired):</span>' +
        '<span class="hospital-supply-meta"></span>' +
        '<span class="hospital-supply-flag">' + need + '</span>' +
        // Native's own value format: stock first, target in parentheses -- "Thread (Desired): 0 (5)".
        DWFUI.stepperHtml({ cls: "hospital-supply-ctrl", value: r.level, min: 0, max: 99, editable: false,
          art: true, hash: true, valueText: r.count + " (" + r.level + ")",
          title: r.unitNote || undefined,
          ariaLabel: r.label + " maximum stock", hashDataset: { hospSupplyEnter: r.level },
          minusDataset: { hospSupplySet: r.dec }, plusDataset: { hospSupplySet: r.inc } }) +
        '</div>';
    }).join("") : '<div class="building-note">No supply data.</div>';

    // The four location posts, distinct from the medical-labor list further down.
    var occs = occupationRows(info);
    // A post is a SLOT and a HOLDER, not a doctor: `.hospital-post`, never the doctor chassis.
    var occsHtml = occs.length ? occs.map(function (o) {
      return '<div class="hospital-post"><span class="hospital-post-label">' + _hospEsc(o.label) + '</span>' +
        '<span class="hospital-post-holder">' + (o.holderName
          ? _hospEsc(o.holderName)
          : '<span class="hospital-dim">vacant</span>') + '</span></div>';
    }).join("") : "";

    // ---- the native staff section -------------------------------------------------------------
    var staff = staffRows(s.locationData);
    var cands = staffCandidates(s.locationData, s.search);
    var staffHtml = "";
    if (s.locationData && Array.isArray(s.locationData.occupations)) {
      staffHtml = staff.map(function (r) {
        return _hospStaffRowHtml(r, s, cands);
      }).join("");
      // Honesty line: a silently-filtered list would imply the wire is clean.
      if (cands.serverChildren > 0)
        staffHtml += DWFUI.statusHtml({ cls: "hospital-staff-note", tone: "dim",
          text: "Note: the server offered " + cands.serverChildren + " child" +
            (cands.serverChildren === 1 ? "" : "ren") +
            " as staff candidates; they are hidden here. Children cannot hold an occupation." });
    }

    // Native prints four separate lines -- beds, tables, traction benches, chests -- in its own
    // order and wording. furnitureText() survives only because the offline fixture suite pins it.
    var furnHtml = furnitureLines(info).map(function (line) {
      return '<div class="building-note">' + _hospEsc(line) + '</div>';
    }).join("");

    // Native reports the appointed chief here but does not offer appointment controls.
    var chief = info.chiefMedical || {};
    var chiefHtml = chief.filled
      ? '<div class="building-note">Chief Medical Dwarf: <span' + _hospProfessionStyle(chief) + '>' +
        _hospEsc(chief.name || "(appointed)") + '</span></div>'
      : '<div class="building-note">Chief Medical Dwarf: vacant.</div>';

    // Doctors: citizens with medical labors; link to the Labor tab for per-dwarf toggling.
    //
    // THIS SECTION IS A DWF ADDITION, not a native region -- native's page has no medical-labor
    // roster -- and it is the list the owner was looking at when he reported children. On this
    // fort the server returns 49 "doctors" of which 42 are children, because every citizen
    // including children carries FEED_WATER_CIVILIANS by default and the server admits anyone with
    // one medical labor. The same stopgap predicate the candidate picker uses is applied here so
    // the roster stops being a nursery; the server-side fix is specified in the lane report.
    // Whether this invented section should exist at all is a product call above this lane -- it is
    // pinned by two registered tests (panel_parity_corrections_test, w4_health_hospital_fixture
    // _test), so it is filtered rather than deleted, and reported.
    var docs = doctorRows(info).filter(function (d) { return !isChildProfession(d.profession); });
    var docsHtml = docs.length ? docs.map(function (d) {
      var labs = d.labors.length ? d.labors.map(function (l) { return _hospBadge(l); }).join("") : _hospBadge("(no labor)", "warn");
      return '<div class="hospital-doctor"><div class="hospital-doctor-name"' + _hospProfessionStyle(d) + '>' + _hospEsc(d.name) +
        (d.profession ? ' <span class="hospital-dim">' + _hospEsc(d.profession) + '</span>' : "") +
        '</div><div class="hospital-doctor-labs">' + labs + '</div></div>';
    }).join("") : '<div class="building-note">No dwarves have a medical labor enabled.</div>';
    docsHtml += DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { hospAct: "labor" }, label: "Manage medical labors (Labor tab)" });

    var accessHtml = s.locationData ? hospitalAccessHtml(s.locationData) : "";
    // One resolved access value, rendered read-only: this panel does not offer the choice.
    var accessLine = accessText(info);
    // Page order is native's: name, access strip, common-area counts, supplies, staff. Every DWF
    // addition stays below that, so nothing native must be scrolled past to reach an invention.
    var markup = accessHtml +
      '<div class="building-status">Hospital' + (Number(info.value) ? ' · value ' + Number(info.value) : "") + '</div>' +
      (accessLine && !accessHtml
        ? '<div class="hospital-section"><div class="hospital-section-label">Access</div>' +
          '<div class="building-note">' + _hospEsc(accessLine) + '</div></div>' : "") +
      '<div class="hospital-section"><div class="hospital-section-label">Facilities</div>' + furnHtml + '</div>' +
      '<div class="hospital-section"><div class="hospital-section-label">Supplies (max stock)</div>' + suppliesHtml + '</div>' +
      // Without /location-detail ids there is nothing to write against: fall back to read-only posts.
      (staffHtml
        ? '<div class="hospital-section"><div class="hospital-section-label">Staff</div>' + staffHtml + '</div>'
        : (occsHtml ? '<div class="hospital-section"><div class="hospital-section-label">Hospital posts</div>' + occsHtml + '</div>' : "")) +
      '<div class="hospital-section"><div class="hospital-section-label">Chief Medical Dwarf</div>' + chiefHtml + '</div>' +
      '<div class="hospital-section"><div class="hospital-section-label">Doctors</div>' + docsHtml + '</div>';
    // `preserveKey`: every staff control re-renders by replacing innerHTML, which resets scrollTop
    // to 0 -- without it, clicking "assign" scrolls away from the picker it just opened.
    return _hospHeader(_hospTitle(info, s.zoneName), s) +
      DWFUI.scrollHtml({ cls: "hospital-panel-body hospital-native-one-page", preserveKey: "hospital-panel",
        ariaLabel: "Hospital controls" }, markup);
  }

  function _hospRender() {
    if (typeof selection === "undefined") return;
    var info = _hospState.info || {};
    selection.className = info.ok === false ? "visible building-panel" : "visible building-panel hospital-panel";
    panelContent(selection).innerHTML = hospitalPanelMarkup(_hospState);
    if (info.ok === false) {
      var x0 = selection.querySelector("[data-hosp-close]");
      if (x0) x0.addEventListener("click", function (e) { e.stopPropagation(); closeSelection(); focusPage(); });
      return;
    }
    _hospWire();
  }

  function _hospWire() {
    if (typeof selection === "undefined") return;
    var s = _hospState;
    var closeBtn = selection.querySelector("[data-hosp-close]");
    if (closeBtn) closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeSelection(); focusPage(); });

    selection.querySelectorAll("[data-loc-access]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (s.busy || s.locationId < 0 || btn.classList.contains("active")) return;
        s.busy = true;
        var mode = btn.getAttribute("data-loc-access") || "";
        try {
          await _hospPost("/location-native-action?id=" + s.locationId + "&action=access&mode=" + encodeURIComponent(mode));
          s.locationData = await _hospFetchJson("/location-detail?id=" + s.locationId + "&t=" + Date.now());
        } catch (err) { globalThis.DwfOrder.lost("hospital.location-access", err, "That access change"); }
        s.busy = false;
        _hospRender();
        focusPage();
      });
    });

    selection.querySelectorAll("[data-hosp-supply-set]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (s.busy) return;
        s.busy = true;
        var row = btn.closest("[data-hosp-supply]");
        var key = row ? row.getAttribute("data-hosp-supply") : "";
        var level = btn.getAttribute("data-hosp-supply-set");
        try { await _hospPost("/hospital-supply?" + _hospKey() + "&supply=" + encodeURIComponent(key) + "&level=" + level); }
        catch (err) { globalThis.DwfOrder.lost("hospital.supply-level", err, "That supply level"); }
        try { s.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now()); }
        catch (err) { globalThis.DwfErr.report("hospital.info-refresh", err); }
        s.busy = false;
        _hospRender();
        focusPage();
      });
    });

    // ---- supply "#": native's enter-amount tile ------------------------------------------------
    selection.querySelectorAll("[data-hosp-supply-enter]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (s.busy) return;
        var row = btn.closest("[data-hosp-supply]");
        var key = row ? row.getAttribute("data-hosp-supply") : "";
        var current = btn.getAttribute("data-hosp-supply-enter") || "0";
        var entered = window.prompt("Desired maximum stock (0-99)", current);
        if (entered == null || !/^\d+$/.test(entered.trim())) return;
        var level = Math.max(0, Math.min(99, parseInt(entered.trim(), 10)));
        s.busy = true;
        try { await _hospPost("/hospital-supply?" + _hospKey() + "&supply=" + encodeURIComponent(key) + "&level=" + level); }
        catch (err) { globalThis.DwfOrder.lost("hospital.supply-level", err, "That supply level"); }
        try { s.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now()); }
        catch (err) { globalThis.DwfErr.report("hospital.info-refresh", err); }
        s.busy = false;
        _hospRender();
        focusPage();
      });
    });

    // ---- staff: open/close a slot's candidate picker --------------------------------------------
    // Local state only, no round trip -- the candidate list already arrived with /location-detail.
    selection.querySelectorAll("[data-hosp-staff-assign]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var slot = btn.getAttribute("data-hosp-staff-assign") || "";
        s.pickerFor = (s.pickerFor === slot) ? null : slot;
        s.search = "";
        _hospRender();
      });
    });

    // ---- staff: assign / unassign ---------------------------------------------------------------
    selection.querySelectorAll("[data-hosp-staff-pick]").forEach(function (el) {
      el.addEventListener("click", async function (e) {
        e.stopPropagation();
        await _hospStaffAssign(el.getAttribute("data-hosp-staff-slot") || "",
          el.getAttribute("data-hosp-staff-pick"));
      });
    });
    selection.querySelectorAll("[data-hosp-staff-remove]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        await _hospStaffAssign(btn.getAttribute("data-hosp-staff-remove") || "", -1);
      });
    });

    // ---- staff: the worker-specialization latch --------------------------------------------------
    selection.querySelectorAll("[data-hosp-staff-spec]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (s.busy) return;
        var unit = Number(btn.getAttribute("data-hosp-staff-spec"));
        if (!(unit >= 0)) return;
        var next = btn.getAttribute("data-on") === "1" ? 0 : 1;
        s.busy = true;
        try { await _hospPost("/labor-specialist?unit=" + unit + "&on=" + next); }
        catch (err) { globalThis.DwfOrder.lost("hospital.staff-specialist", err, "That specialist change"); }
        await _hospLoadSpecialists();
        s.busy = false;
        _hospRender();
        focusPage();
      });
    });

    // Picker search: re-render in place and put the caret back where it was.
    var search = selection.querySelector("[data-hosp-staff-search]");
    if (search) search.addEventListener("input", function () {
      s.search = search.value || "";
      _hospRender();
      var next = selection.querySelector("[data-hosp-staff-search]");
      if (next) {
        next.focus();
        try { next.setSelectionRange(next.value.length, next.value.length); } catch { globalThis.DwfErr?.count("hospital-panel.search-caret"); }
      }
    });

    selection.querySelectorAll("[data-hosp-act]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        var act = btn.getAttribute("data-hosp-act");
        if (act === "labor") {
          if (typeof openPanel === "function") openPanel("labor");
          closeSelection(); focusPage();
          return;
        }
        // Navigation only: this panel never attempts the noble appointment itself.
        if (act === "nobles") {
          if (typeof openPanel === "function") openPanel("nobles");
          closeSelection(); focusPage();
          return;
        }
        if (act === "rename") {
          var zone = _hospRenameZoneId(s);
          if (!(zone >= 0) || !(s.locationId >= 0)) return;
          var current = (s.info && s.info.name) || s.zoneName || "";
          var entered = window.prompt("Rename this hospital", current);
          if (entered == null) return;
          entered = entered.trim();
          if (!entered) return;
          if (s.busy) return;
          s.busy = true;
          try {
            await _hospPost("/zone-location-action?id=" + zone + "&action=rename&location=" +
              s.locationId + "&kind=" + encodeURIComponent(entered));
          } catch (err) { globalThis.DwfOrder.lost("hospital.location-rename", err, "That rename"); }
          try { s.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now()); }
          catch (err) { globalThis.DwfErr.report("hospital.info-refresh", err); }
          await _hospLoadLocation();
          s.busy = false;
          _hospRender();
          focusPage();
          return;
        }
      });
    });
  }

  // The one staff write. `unit` < 0 vacates the slot; anything else fills it.
  async function _hospStaffAssign(slot, unit) {
    var s = _hospState;
    if (s.busy || !(s.locationId >= 0) || !slot) return;
    s.busy = true;
    s.pickerFor = null;
    s.search = "";
    try {
      await _hospPost("/location-action?id=" + s.locationId + "&action=occupation-assign" +
        "&kind=" + encodeURIComponent(slot) + "&unit=" + encodeURIComponent(unit));
    } catch (err) { globalThis.DwfOrder.lost("hospital.occupation-assign", err, "That assignment"); }
    await _hospLoadLocation();
    await _hospLoadSpecialists();
    try { s.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now()); } catch { globalThis.DwfErr?.count("hospital-panel.staff-refresh"); }
    s.busy = false;
    _hospRender();
    focusPage();
  }

  if (typeof window !== "undefined") window.openHospitalPanel = openHospitalPanel;
  if (typeof window !== "undefined") window.DFHospitalMarkup = { hospitalPanelMarkup: hospitalPanelMarkup };

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { supplyRows, furnitureText, furnitureLines, doctorRows, hospitalPanelMarkup,
      occupationRows, accessText, isStaffed,
      staffRows, staffCandidates, isChildProfession, hospitalAccessHtml };
  }
