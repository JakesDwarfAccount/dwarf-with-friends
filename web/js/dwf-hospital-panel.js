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

// Wave 3.3 hospital / health panel. A hospital is an abstract_building_hospitalst LOCATION
// attached to a MeetingHall/DiningHall/Bedroom civzone, so the shared openZonePanel
// (dwf-building-zone-stockpile-panels.js) delegates here when /zone-info reports
// isHospital:true. Reads /hospital-info (supplies, furniture, doctors, chief medic) +
// /hospital-patients (patient list + active medical-job queue); mutates /hospital-supply (the
// exact desired_*/need_more write DF's Locations screen + quickfort perform). Per-dwarf medical
// labor toggles reuse the Labor tab (openPanel("labor")); chief-medical assignment reuses the
// generic /noble-candidates + /noble-assign routes (fort_admin.cpp) -- precedent exists, so the
// picker is wired, not deferred.
//
// The pure data-shapers below (supplyRows / furnitureText / chiefMedicalText / doctorRows /
// patientRows / queueRows) take plain JSON and return display strings/structs with NO DOM
// dependency, so tools/harness/hospital_fixture_test.mjs can exercise them (incl. seeded-bad
// rows) offline. They are node-exported at the bottom behind a browser-safe guard.

  // esc: reuse the shared global escapeHtml in the browser; fall back to a minimal impl so the
  // pure shapers still run under node (the fixture test).
  function _hospEsc(s) {
    if (typeof DWFUI !== "undefined" && DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Labels for the seven supplies, in DF's Locations-screen order. Mirrors kSupplies in
  // src/hospital.cpp (the server is authoritative for scale; the client only displays levels).
  var _HOSP_SUPPLY_LABELS = {
    splints: "Splints", thread: "Thread", cloth: "Cloth", crutches: "Crutches",
    plaster: "Plaster", buckets: "Buckets", soap: "Soap",
  };

  // ---- pure data-shapers (node-testable) ------------------------------------------------

  // Supplies: one row per supply. `level`/`countLevel` are the human numbers (raw / scale) the
  // server already divided; we clamp defensively (a malformed/NaN level renders as 0) and expose
  // the +/- step targets (0..99, matching the server clamp) so the stepper never posts junk.
  function supplyRows(info) {
    var list = (info && Array.isArray(info.supplies)) ? info.supplies.filter(Boolean) : [];
    return list.map(function (s) {
      var key = (s && s.key) || "";
      var level = Number(s && s.desiredLevel);
      if (!Number.isFinite(level)) level = 0;
      level = Math.max(0, Math.min(99, Math.round(level)));
      var count = Number(s && s.countLevel);
      if (!Number.isFinite(count)) count = 0;
      count = Math.max(0, Math.round(count));
      return {
        key: key,
        label: (s && s.label) || _HOSP_SUPPLY_LABELS[key] || key || "(supply)",
        level: level,
        count: count,
        needMore: !!(s && s.needMore),
        dec: Math.max(0, level - 1),
        inc: Math.min(99, level + 1),
      };
    }).filter(function (r) { return r.key; });
  }

  // One line summarising the hospital furniture (from the zone extents).
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

  // Chief Medical Dwarf presence line + whether the assign picker should show.
  function chiefMedicalText(info) {
    var c = info && info.chiefMedical;
    if (!c || !c.found)
      return "No Chief Medical Dwarf position in this fort (create it in Nobles).";
    if (c.filled) return "Chief Medical Dwarf: " + (c.name || "(appointed)");
    return "Chief Medical Dwarf: vacant — assign a diagnostician.";
  }

  // Doctors: citizens with >=1 medical labor. Normalise labor keys to display labels.
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

  // Patients: active fort units with a health request or an active wound.
  function patientRows(data) {
    var list = (data && Array.isArray(data.patients)) ? data.patients.filter(Boolean) : [];
    return list.map(function (p) {
      var flags = (p && Array.isArray(p.flags)) ? p.flags.filter(Boolean) : [];
      var wounds = Number(p && p.woundCount);
      if (!Number.isFinite(wounds) || wounds < 0) wounds = 0;
      return {
        unitId: Number(p && p.unitId),
        name: (p && p.name) || "(patient)",
        profession: (p && p.profession) || "",
        professionColor: Number(p && p.professionColor),
        woundCount: wounds,
        inTraction: !!(p && p.inTraction),
        flags: flags,
      };
    }).filter(function (r) { return Number.isFinite(r.unitId) && r.unitId >= 0; });
  }

  // Treatment queue: active medical jobs (read-only -- DF schedules healthcare itself).
  function queueRows(data) {
    var list = (data && Array.isArray(data.queue)) ? data.queue.filter(Boolean) : [];
    return list.map(function (j) {
      return {
        jobType: (j && j.jobType) || "(job)",
        worker: (j && j.worker) || "",
        workerProfessionColor: Number(j && j.workerProfessionColor),
        patient: (j && j.patient) || "",
        patientProfessionColor: Number(j && j.patientProfessionColor),
      };
    });
  }

  // ---- rendering (browser only) ---------------------------------------------------------

  var _hospState = {
    zoneId: -1, locationId: -1, info: null, patients: null,
    locationData: null,
    patientsOpen: false, chiefPickerOpen: false, chiefCandidates: null,
    zoneName: "Hospital", busy: false,
  };

  function _hospHeader(name) {
    return DWFUI.headerHtml({ cls: "bld-head", title: name || "Hospital", titleCls: "bld-name",
      close: { cls: "bld-x", dataset: { hospClose: "" }, title: "Close", glyph: "&#10005;" } });
  }

  // Resolve query key: prefer the zone id (carries its own site_id server-side), else location id.
  function _hospKey() {
    var s = _hospState;
    return s.zoneId >= 0 ? ("zone=" + s.zoneId) : ("location=" + s.locationId);
  }

  async function _hospFetchJson(path) {
    var r = await fetch(path, { cache: "no-store" });
    var text = await r.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok && !(data && data.ok === false))
      throw new Error((data && data.error) || text.trim() || "request failed");
    return data;
  }

  async function _hospPost(path) {
    var sep = path.includes("?") ? "&" : "?";
    var r = await fetch(path + sep + "t=" + Date.now(), { method: "POST", cache: "no-store" });
    var text = await r.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false)
      throw new Error(data.error || text.trim() || "request failed");
    return data;
  }

  async function openHospitalPanel(locationId, zoneInfo) {
    _hospState = {
      zoneId: (zoneInfo && Number(zoneInfo.id) >= 0) ? Number(zoneInfo.id) : -1,
      locationId: Number(locationId) >= 0 ? Number(locationId)
                 : ((zoneInfo && Number(zoneInfo.hospitalLocationId)) || -1),
      info: null, patients: null, patientsOpen: false,
      locationData: (zoneInfo && zoneInfo.locationData) || null,
      chiefPickerOpen: false, chiefCandidates: null,
      zoneName: (zoneInfo && zoneInfo.name) || "Hospital", busy: false,
    };
    if (typeof selection !== "undefined") {
      selection.className = "visible building-panel";
      panelContent(selection).innerHTML = _hospHeader(_hospState.zoneName) +
        '<div class="bld-status">Loading hospital…</div>';
      var x = selection.querySelector("[data-hosp-close]");
      if (x) x.addEventListener("click", function (e) { e.stopPropagation(); closeSelection(); focusPage(); });
    }
    try {
      _hospState.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now());
    } catch (err) {
      _hospState.info = { ok: false, error: (err && err.message) || "unavailable" };
    }
    if (!_hospState.locationData && _hospState.locationId >= 0) {
      try { _hospState.locationData = await _hospFetchJson("/location-detail?id=" + _hospState.locationId + "&t=" + Date.now()); }
      catch (_) {}
    }
    _hospRender();
  }

  function _hospBadge(text, cls) {
    return '<span class="hosp-badge' + (cls ? " " + cls : "") + '">' + _hospEsc(text) + '</span>';
  }

  function _hospProfessionStyle(record) {
    var idx = Number(record && record.professionColor);
    return Number.isInteger(idx) && idx >= 0 && idx <= 15
      ? ' style="color:' + DWFUI.dfColor(idx) + '"' : "";
  }

  function hospitalPanelMarkup(state) {
    var s = state || {};
    if (!s.info) return _hospHeader(s.zoneName || "Hospital") + '<div class="bld-status">Loading hospitalâ€¦</div>';
    var info = s.info || {};
    if (info.ok === false) {
      return _hospHeader(s.zoneName || "Hospital") +
        '<div class="bld-status err">' + _hospEsc(info.error || "Hospital data unavailable.") + '</div>';
    }

    // Supplies block with +/- steppers.
    //
    // ---- WAVE 5: `art: true` -- the steppers now use DF's OWN +/- TILES ------------------------
    // This is stepperHtml's only production consumer, and it was passing neither art flag -- so the
    // one place the native stepper actually ships was rendering the "+" and "-" as PLAIN TEXT
    // GLYPHS while WORK_ORDERS_INCREASE_AMOUNT / _DECREASE_AMOUNT sat unused in TOKENS.sprites.
    //
    // *** `hash: true` IS DELIBERATELY NOT PASSED, against the lane brief, and the FOUNDATION SAYS
    // WHY IN ITS OWN WORDS: "`hash` is opt-in (the '#' enter-amount tile has NO MEANING on a
    // READ-ONLY stepper SUCH AS THE HOSPITAL SUPPLY ROW)". This row is `editable: false` -- it has
    // no editable field to type into and no handler bound to an enter-amount action. A '#' tile would
    // be a control that dispatches `{dwfui-step, enter:1}` into a void: a DEAD BUTTON, which is
    // precisely the fabricated-UI failure this programme exists to stop. The stockpile storage row
    // IS editable and DOES have a `#` handler, and that is where the hash tile belongs. Reported in
    // the lane closeout as a considered deviation, not an omission.
    var supplies = supplyRows(info);
    var suppliesHtml = supplies.length ? supplies.map(function (r) {
      var need = r.needMore ? _hospBadge("acquiring", "want") : "";
      return '<div class="hosp-supply" data-hosp-supply="' + _hospEsc(r.key) + '">' +
        '<span class="hosp-supply-label">' + _hospEsc(r.label) + '</span>' +
        DWFUI.stepperHtml({ cls: "hosp-supply-ctrl", value: r.level, min: 0, max: 99, editable: false,
          art: true,
          ariaLabel: r.label + " maximum stock", minusDataset: { hospSupplySet: r.dec }, plusDataset: { hospSupplySet: r.inc } }) +
        '<span class="hosp-supply-meta">have ' + r.count + ' ' + need + '</span></div>';
    }).join("") : '<div class="bld-note">No supply data.</div>';

    // Furniture line.
    var furnHtml = '<div class="bld-note">' + _hospEsc(furnitureText(info)) + '</div>';

    // Chief medical dwarf + assign picker (reuses /noble-candidates + /noble-assign).
    var chief = info.chiefMedical || {};
    var chiefHtml = chief.filled
      ? '<div class="bld-note">Chief Medical Dwarf: <span' + _hospProfessionStyle(chief) + '>' +
        _hospEsc(chief.name || "(appointed)") + '</span></div>'
      : '<div class="bld-note">' + _hospEsc(chiefMedicalText(info)) + '</div>';
    if (chief.found && Number(chief.positionId) >= 0) {
      chiefHtml += DWFUI.plaqueBtnHtml({ cls: 'bld-btn' + (s.chiefPickerOpen ? " active" : ""),
        tone: s.chiefPickerOpen ? "green" : "gold", dataset: { hospAct: "chief-toggle" },
        label: s.chiefPickerOpen ? "Close picker" : (chief.filled ? "Reassign Chief Medical Dwarf" : "Assign Chief Medical Dwarf") });
      if (s.chiefPickerOpen) chiefHtml += _hospChiefPickerHtml(s);
    }

    // Doctors: citizens with medical labors; link to the Labor tab for per-dwarf toggling.
    var docs = doctorRows(info);
    var docsHtml = docs.length ? docs.map(function (d) {
      var labs = d.labors.length ? d.labors.map(function (l) { return _hospBadge(l); }).join("") : _hospBadge("(no labor)", "warn");
      return '<div class="hosp-doctor"><div class="hosp-doctor-name"' + _hospProfessionStyle(d) + '>' + _hospEsc(d.name) +
        (d.profession ? ' <span class="hosp-dim">' + _hospEsc(d.profession) + '</span>' : "") +
        '</div><div class="hosp-doctor-labs">' + labs + '</div></div>';
    }).join("") : '<div class="bld-note">No dwarves have a medical labor enabled.</div>';
    docsHtml += DWFUI.plaqueBtnHtml({ cls: "bld-btn", dataset: { hospAct: "labor" }, label: "Manage medical labors (Labor tab)" });

    // Patients block (lazy).
    var patientsHtml = DWFUI.plaqueBtnHtml({ cls: "bld-btn", dataset: { hospAct: "patients-toggle" },
      label: s.patientsOpen ? "Hide patients" : "Show patients & treatment queue" });
    if (s.patientsOpen) {
      if (!s.patients) {
        patientsHtml += '<div class="bld-note">Loading patients…</div>';
      } else if (s.patients.ok === false) {
        patientsHtml += '<div class="bld-status err">' + _hospEsc(s.patients.error || "Patients unavailable.") + '</div>';
      } else {
        var prows = patientRows(s.patients);
        var plist = prows.length ? prows.map(function (p) {
          var badges = [
            p.inTraction ? _hospBadge("in traction", "ok") : "",
            p.woundCount ? _hospBadge(p.woundCount + " wound" + (p.woundCount === 1 ? "" : "s"), "warn") : "",
          ].concat(p.flags.map(function (f) { return _hospBadge(f); })).filter(Boolean).join("");
          return '<div class="hosp-patient"><div class="hosp-patient-name"' + _hospProfessionStyle(p) + '>' + _hospEsc(p.name) +
            (p.profession ? ' <span class="hosp-dim">' + _hospEsc(p.profession) + '</span>' : "") +
            '</div><div class="hosp-patient-flags">' + (badges || _hospBadge("stable", "ok")) + '</div></div>';
        }).join("") : '<div class="bld-note">No wounded or sick dwarves right now.</div>';
        var qrows = queueRows(s.patients);
        var qlist = qrows.length ? qrows.map(function (q) {
          var worker = q.worker ? 'by <span' + _hospProfessionStyle({ professionColor: q.workerProfessionColor }) + '>' + _hospEsc(q.worker) + '</span>' : "";
          var patient = q.patient ? 'for <span' + _hospProfessionStyle({ professionColor: q.patientProfessionColor }) + '>' + _hospEsc(q.patient) + '</span>' : "";
          var who = [worker, patient].filter(Boolean).join(" ");
          return '<div class="hosp-job"><span class="hosp-job-type">' + _hospEsc(q.jobType) + '</span>' +
            (who ? ' <span class="hosp-dim">' + who + '</span>' : "") + '</div>';
        }).join("") : '<div class="bld-note">No active treatment jobs.</div>';
        patientsHtml += '<div class="hosp-section-label">Patients</div>' + plist +
          '<div class="hosp-section-label">Treatment queue</div>' + qlist;
      }
    }

    var accessHtml = s.locationData && window.DFLocationMarkup && window.DFLocationMarkup.locationAccessHtml
      ? window.DFLocationMarkup.locationAccessHtml(s.locationData) : "";
    var markup = accessHtml +
      '<div class="bld-status">Hospital' + (Number(info.value) ? ' · value ' + Number(info.value) : "") + '</div>' +
      '<div class="hosp-section"><div class="hosp-section-label">Supplies (max stock)</div>' + suppliesHtml + '</div>' +
      '<div class="hosp-section"><div class="hosp-section-label">Facilities</div>' + furnHtml + '</div>' +
      '<div class="hosp-section"><div class="hosp-section-label">Chief Medical Dwarf</div>' + chiefHtml + '</div>' +
      '<div class="hosp-section"><div class="hosp-section-label">Doctors</div>' + docsHtml + '</div>' +
      '<div class="hosp-section">' + patientsHtml + '</div>';
    return _hospHeader(info.name || s.zoneName) +
      DWFUI.scrollHtml({ cls: "hosp-panel-body", ariaLabel: "Hospital controls" }, markup);
  }

  function _hospRender() {
    if (typeof selection === "undefined") return;
    var info = _hospState.info || {};
    selection.className = info.ok === false ? "visible building-panel" : "visible building-panel hosp-panel";
    panelContent(selection).innerHTML = hospitalPanelMarkup(_hospState);
    if (info.ok === false) {
      var x0 = selection.querySelector("[data-hosp-close]");
      if (x0) x0.addEventListener("click", function (e) { e.stopPropagation(); closeSelection(); focusPage(); });
      return;
    }
    _hospWire();
  }

  function _hospChiefPickerHtml(state) {
    var s = state || _hospState;
    if (!s.chiefCandidates) return '<div class="bld-note">Loading candidates…</div>';
    if (s.chiefCandidates.error)
      return '<div class="bld-note">Candidates unavailable: ' + _hospEsc(s.chiefCandidates.error) + '</div>';
    var cands = Array.isArray(s.chiefCandidates.candidates) ? s.chiefCandidates.candidates : [];
    var rows = ['<div class="hosp-candidate" data-hosp-pick="-1">— Vacant —</div>']
      .concat(cands.map(function (c) {
        return '<div class="hosp-candidate' + (c.current ? " current" : "") + '" data-hosp-pick="' + c.unitId + '">' +
          '<span' + _hospProfessionStyle(c) + '>' + _hospEsc(c.name) + '</span>' +
          (c.profession ? ' <span class="hosp-dim">' + _hospEsc(c.profession) + '</span>' : "") + '</div>';
      }));
    return '<div class="hosp-candidate-list">' + (cands.length ? rows.join("") : rows[0] +
      '<div class="bld-note">No eligible citizens.</div>') + '</div>';
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
        } catch (_) {}
        s.busy = false;
        _hospRender();
        focusPage();
      });
    });

    // Supply steppers: POST the new level, then refresh /hospital-info.
    selection.querySelectorAll("[data-hosp-supply-set]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (s.busy) return;
        s.busy = true;
        var row = btn.closest("[data-hosp-supply]");
        var key = row ? row.getAttribute("data-hosp-supply") : "";
        var level = btn.getAttribute("data-hosp-supply-set");
        try { await _hospPost("/hospital-supply?" + _hospKey() + "&supply=" + encodeURIComponent(key) + "&level=" + level); }
        catch (_) {}
        try { s.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now()); } catch (_) {}
        s.busy = false;
        _hospRender();
        focusPage();
      });
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
        if (act === "patients-toggle") {
          s.patientsOpen = !s.patientsOpen;
          if (s.patientsOpen && !s.patients) {
            _hospRender();
            try { s.patients = await _hospFetchJson("/hospital-patients?" + _hospKey() + "&t=" + Date.now()); }
            catch (err) { s.patients = { ok: false, error: (err && err.message) || "patients failed" }; }
          }
          _hospRender();
          return;
        }
        if (act === "chief-toggle") {
          s.chiefPickerOpen = !s.chiefPickerOpen;
          if (s.chiefPickerOpen && !s.chiefCandidates) {
            _hospRender();
            var pid = (s.info && s.info.chiefMedical && s.info.chiefMedical.positionId);
            var player = (typeof window !== "undefined" && window.playerName) ? window.playerName
                        : (typeof player !== "undefined" ? player : "");
            try {
              s.chiefCandidates = await _hospFetchJson(
                "/noble-candidates?player=" + encodeURIComponent(player) + "&position=" + pid + "&t=" + Date.now());
            } catch (err) { s.chiefCandidates = { error: (err && err.message) || "unavailable" }; }
          }
          _hospRender();
          return;
        }
      });
    });

    // Chief-medical candidate pick -> /noble-assign, then refresh /hospital-info.
    selection.querySelectorAll("[data-hosp-pick]").forEach(function (el) {
      el.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (s.busy) return;
        s.busy = true;
        var unitId = el.getAttribute("data-hosp-pick");
        var pid = (s.info && s.info.chiefMedical && s.info.chiefMedical.positionId);
        var player = (typeof window !== "undefined" && window.playerName) ? window.playerName
                    : (typeof player !== "undefined" ? player : "");
        try {
          await _hospPost("/noble-assign?player=" + encodeURIComponent(player) +
            "&position=" + pid + "&unit=" + unitId);
        } catch (_) {}
        s.chiefPickerOpen = false;
        s.chiefCandidates = null;
        try { s.info = await _hospFetchJson("/hospital-info?" + _hospKey() + "&t=" + Date.now()); } catch (_) {}
        s.busy = false;
        _hospRender();
        focusPage();
      });
    });
  }

  // Expose the opener to the shared zone panel (browser global).
  if (typeof window !== "undefined") window.openHospitalPanel = openHospitalPanel;
  if (typeof window !== "undefined") window.DFHospitalMarkup = { hospitalPanelMarkup: hospitalPanelMarkup };

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { supplyRows, furnitureText, chiefMedicalText, doctorRows, patientRows, queueRows, hospitalPanelMarkup };
  }
