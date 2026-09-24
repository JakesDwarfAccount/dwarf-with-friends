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

  // ---- Fort administration: Nobles, Justice, Petitions. ----
  // Per-petition approve/deny is fail-closed (501): the plugin cannot faithfully grant native residency.
  let adminTab = "nobles";                       // active tab
  let adminData = { nobles: null, justice: null, petitions: null };
  let petitionSelectedId = null;

  // One assign picker open at a time; opening another position's picker closes this one.
  let nobleAssignOpenPosition = -1;
  let nobleAssignCandidates = null;   // {positionId, positionName, candidates:[...]} | {error}
  let nobleAssignLoading = false;

  // The sixth mode is "Intelligence" in base DF; the `counterintel` KEY stays -- it is the /justice contract.
  const JUSTICE_MODES = [
    { key: "open", label: "Open cases", empty: "No open cases." },
    { key: "closed", label: "Closed cases", empty: "No closed cases." },
    { key: "cold", label: "Cold cases", empty: "No cold cases." },
    { key: "guard", label: "Fortress guard", empty: "No fortress guard assigned." },
    { key: "convicts", label: "Convicts", empty: "No convicts." },
    { key: "counterintel", label: "Intelligence", empty: "No interrogation reports have been recorded." },
  ];
  let justiceMode = "open";
  let justiceSelectedCase = -1;   // R3: selected crime id (open/closed/cold) or convict crimeId
  let justiceSelectedReport = -1; // creation-order index from world.status.interrogation_reports
  let justiceChooser = null;      // { kind: "convict"|"interrogate", crimeId }

  let justiceHostState = null;
  let justicePollTimer = null;

  function fortProfessionColorStyle(record, key = "professionColor") {
    const idx = record && record[key];
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }

  const ADMIN_TABS = [
    { key: "nobles", label: "Nobles", route: "/nobles" },
    { key: "justice", label: "Justice", route: "/justice" },
    { key: "petitions", label: "Petitions", route: "/petitions" },
  ];

  function adminRouteFor(tab) {
    const t = ADMIN_TABS.find(x => x.key === tab);
    return t ? t.route : "/nobles";
  }

  // Nobles and Justice re-host into the shared info-window shell; Petitions owns its own DWFUI window.
  async function openFortAdminPanel(startTab) {
    setActiveToolbar(startTab || adminTab);
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    adminTab = startTab || adminTab || "petitions";
    fortLoadingShell("Petitions");
    await refreshFortAdmin();
  }

  async function openNoblesPanel() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("nobles"); // first-time help
    setActiveToolbar("nobles");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    adminTab = "nobles";
    activeInfoPanel = "nobles";
    nobleAssignOpenPosition = -1;
    nobleAssignCandidates = null;
    infoShellLoadingShell("nobles", "Nobles and administrators");
    await refreshFortAdmin();
  }
  async function openJusticePanel() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("justice"); // first-time help
    setActiveToolbar("justice");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    adminTab = "justice";
    activeInfoPanel = "justice";
    justiceChooser = null;
    infoShellLoadingShell("justice", "Justice");
    await refreshFortAdmin();
    justiceStartPoll();
  }
  function openPetitionsPanel() { return openFortAdminPanel("petitions"); }

  function justiceStopPoll() {
    if (justicePollTimer) { clearInterval(justicePollTimer); justicePollTimer = null; }
  }
  function justiceStartPoll() {
    justiceStopPoll();
    let last = JSON.stringify([adminData.justice, justiceHostState]);
    justicePollTimer = setInterval(async () => {
      // The panel was closed or a different info tab took over -> stop (nothing to keep alive).
      if (adminTab !== "justice" || activeInfoPanel !== "justice" ||
          typeof clientPanel === "undefined" || !clientPanel ||
          !clientPanel.querySelector("[data-justice-mode]")) { justiceStopPoll(); return; }
      await refreshFortAdminData();
      const now = JSON.stringify([adminData.justice, justiceHostState]);
      if (now === last) return;
      last = now;
      renderFortAdminPanel();
    }, 2000);
  }

  // Fetch only -- no render. (Split out of refreshFortAdmin so the poll can diff before painting.)
  async function refreshFortAdminData() {
    try {
      let route = adminRouteFor(adminTab);
      if (adminTab === "justice") route += `?mode=${encodeURIComponent(justiceMode)}&`;
      else route += "?";
      adminData[adminTab] = await fortFetchJson(
        `${route}player=${encodeURIComponent(player)}&t=${Date.now()}`);
    } catch (err) {
      adminData[adminTab] = { error: err.message || "unavailable" };
    }
    if (adminTab !== "justice") return;
    // If the host's unlock flags cannot be read, every drive renders LOCKED -- fail closed.
    try {
      const state = await fortFetchJson(
        `/justice-state?player=${encodeURIComponent(player)}&t=${Date.now()}`);
      justiceHostState = (state && state.ok) ? state : null;
    } catch {
      justiceHostState = null;
    }
  }

  async function refreshFortAdmin() {
    await refreshFortAdminData();
    renderFortAdminPanel();
  }

  // ---- Nobles ----

  async function toggleNobleAssign(positionId) {
    if (nobleAssignOpenPosition === positionId) {
      nobleAssignOpenPosition = -1;
      nobleAssignCandidates = null;
      renderFortAdminPanel();
      return;
    }
    nobleAssignOpenPosition = positionId;
    nobleAssignCandidates = null;
    nobleAssignLoading = true;
    renderFortAdminPanel();
    try {
      const data = await fortFetchJson(
        `/noble-candidates?player=${encodeURIComponent(player)}&position=${positionId}&t=${Date.now()}`);
      if (nobleAssignOpenPosition !== positionId) return; // a different row opened meanwhile
      nobleAssignCandidates = data;
    } catch (err) {
      if (nobleAssignOpenPosition !== positionId) return;
      nobleAssignCandidates = { error: err.message || "unavailable" };
    } finally {
      nobleAssignLoading = false;
      renderFortAdminPanel();
    }
  }

  async function submitNobleAssign(positionId, unitId) {
    try {
      await fortFetchJson(
        `/noble-assign?player=${encodeURIComponent(player)}&position=${positionId}&unit=${unitId}&t=${Date.now()}`,
        { method: "POST" });
      nobleAssignOpenPosition = -1;
      nobleAssignCandidates = null;
      adminData.nobles = null;
      await refreshFortAdmin();
      fortSetStatus(unitId >= 0 ? "Position assigned." : "Position vacated.", false);
    } catch (err) {
      fortSetStatus(err.message || "Assignment failed.", true);
    }
  }

  function nobleCandidateListHtml(positionId, candidateData = nobleAssignCandidates,
                                  loading = nobleAssignLoading) {
    let inner;
    if (loading) {
      inner = `<div class="info-message">Loading candidates...</div>`;
    } else if (!candidateData || candidateData.error) {
      inner = `<div class="info-message">Candidates unavailable: ${escapeHtml((candidateData && candidateData.error) || "")}</div>`;
    } else {
      const candidates = Array.isArray(candidateData.candidates) ? candidateData.candidates : [];
      const vacant = DWFUI.rowHtml({
        cls: "fort-candidate-row fort-candidate-vacant",
        dataset: { noblePick: positionId, nobleUnit: -1 },
        label: "Vacant",
      });
      const rows = candidates.map(c => DWFUI.rowHtml({
        cls: `fort-candidate-row${c.current ? " fort-candidate-current" : ""}`,
        dataset: { noblePick: positionId, nobleUnit: c.unitId },
        labelHtml: DWFUI.rawHtml("profession-coloured candidate name",
          `<span${fortProfessionColorStyle(c)}>${DWFUI.bitmapTextHtml(c.name || `unit ${c.unitId}`)}</span>`),
        trailing: c.profession ? DWFUI.bitmapTextHtml(c.profession, { cls: "fort-dim" }) : "",
      })).join("");
      const empty = candidates.length ? "" : `<div class="info-message">No eligible citizens.</div>`;
      // Vacating is a supported /noble-assign operation and remains available even when the
      // candidate set is empty. The old branch accidentally discarded this row in that state.
      inner = DWFUI.scrollHtml({
        cls: "fort-candidate-list", rows: ".fort-candidate-row",
        preserveKey: `noble-candidates-${positionId}`, ariaLabel: "Candidates",
      }, vacant + rows + empty);
    }
    return inner;
  }

  function nobleCandidatesModeHtml(positionId, candidateData, loading) {
    const positionName = candidateData && candidateData.positionName;
    const back = DWFUI.plaqueBtnHtml({
      label: "Back to positions", tone: "grey", cls: "noble-candidates-back",
      dataset: { nobleAssign: positionId },
    });
    return `<div id="fortStatus" class="info-message fort-status"></div>` +
      `<div class="dwfui-text--section fort-section-title">${DWFUI.bitmapTextHtml(
        positionName ? `Appoint ${positionName}` : "Appoint a citizen")}</div>` +
      back + nobleCandidateListHtml(positionId, candidateData, loading);
  }

  // Native's width gates are in 8px interface cells. A not-yet-laid-out panel reports no bound, so keep
  // the wide rendering until the first real layout instead of flashing controls out during the handoff.
  function nobleUsableWidthCells() {
    return DWFUI.cellsForElementWidth(
      typeof clientPanel !== "undefined" ? clientPanel : null,
      { content: ".info-main, .info-body",
        document: typeof document !== "undefined" ? document : null,
        unavailable: Infinity });
  }

  // The five room-requirement icons, left to right as native draws them: office/bedroom/dining/tomb/box.
  // `key` is the SERVER's field name in /nobles; DF names the coffer's sprite family FURN, not BOX.
  const NOBLE_ROOM_KINDS = [
    { key: "office",  art: "OFFICE",  label: "Office" },
    { key: "bedroom", art: "BEDROOM", label: "Bedroom" },
    { key: "dining",  art: "DINING",  label: "Dining room" },
    { key: "tomb",    art: "TOMB",    label: "Tomb" },
    { key: "box",     art: "FURN",    label: "Coffer" },
  ];
  // Returns [] when the DLL served no room data, so the caller falls back to the legacy text requirements.
  function nobleRoomIconStates(p) {
    if (!p || !p.rooms || typeof p.rooms !== "object") return [];
    const reqs = p.rooms;
    const sat = (p.roomsSatisfied && typeof p.roomsSatisfied === "object") ? p.roomsSatisfied : {};
    return NOBLE_ROOM_KINDS.map(k => {
      const required = Number(reqs[k.key] || 0) > 0;
      const satisfied = (k.key === "box") ? null
        : (typeof sat[k.key] === "boolean" ? sat[k.key] : null);
      return { kind: k.key, required, satisfied, art: k.art, label: k.label };
    });
  }

  function nobleRoomSpriteState(st) {
    if (!st || !st.required) return "NA";
    if (st.satisfied === true) return "GOOD";
    if (st.satisfied === false) return "MISSING";
    return "PARTIAL";
  }
  function nobleRoomSprite(st) {
    return `NOBLES_${(st && st.art) || "FURN"}_${nobleRoomSpriteState(st)}`;
  }
  // AXIS MISMATCH, DECLARED. DEF-030: the sprite family is a DEADLINE ramp but nobleMandateIcons derives
  // SEVERITY, so only the ramp's endpoints are used -- TIME_GOOD and TIME_WARN_2 stay unreached, not guessed.
  const NOBLE_CLOCK_STATE = { red: "TIME_WARN_3", yellow: "TIME_WARN_1" };
  // Demand chest + mandate hammer, joined from the served `mandates` by unitId; never fabricated.
  function nobleMandateIcons(p, mandates) {
    const out = { demand: null, mandate: null };
    if (!p || !p.filled || !(Number(p.unitId) >= 0)) return out;
    const mine = (Array.isArray(mandates) ? mandates : []).filter(m => Number(m.unitId) === Number(p.unitId));
    for (const m of mine) {
      const mode = String(m.mode || "").toLowerCase();
      if (mode === "make") {
        out.demand = "red";
      } else {
        const sev = Number(m.hammerstrikes) > 0 ? "red" : "yellow";
        if (out.mandate !== "red") out.mandate = sev;
      }
    }
    return out;
  }
  // Bookkeeper 1-5 precision selector: enum value 0..4 → highlighted button (index+1). Clamp guard so
  // an absent/invalid value highlights nothing.
  function noblePrecisionActiveButton(precision) {
    const v = Number(precision);
    return (v >= 0 && v <= 4) ? v + 1 : -1;
  }

  // INDICATORS, NOT BUTTONS -- iconHtml, and no click handler.
  const NOBLE_ROOM_WORDS = { GOOD: "satisfied", PARTIAL: "required", MISSING: "not satisfied", NA: "not required" };
  function nobleRoomIconHtml(st) {
    const label = `${st.label}: ${NOBLE_ROOM_WORDS[nobleRoomSpriteState(st)]}`;
    return DWFUI.iconHtml({
      sprite: nobleRoomSprite(st), cls: "noble-room-icon", size: 24, title: label, alt: label,
    });
  }
  function nobleClockIconHtml(family, severity, cls, onTitle, offTitle) {
    const title = severity ? onTitle : offTitle;
    return DWFUI.iconHtml({
      sprite: `NOBLES_${family}_${NOBLE_CLOCK_STATE[severity] || "NA"}`,
      cls, size: 24, title, alt: title,
    });
  }
  function nobleMandateIconHtml(icons) {
    return nobleClockIconHtml("DEMANDS", icons.demand, "noble-demand-icon", "Active demand", "No demand")
      + nobleClockIconHtml("MANDATES", icons.mandate, "noble-mandate-icon", "Active mandate", "No mandate");
  }
  // The bookkeeper's 1..5 accounting-precision strip: five hand-built raw buttons with inline hex
  // borders/fills, over TEN sprites DF ships for exactly this control
  // (NOBLES_ACCOUNTING_{1..5}_{ACTIVE,INACTIVE}). It is a radiogroup -- exactly one active.
  //
  // *** segmentedHtml LIMITATION, REPORTED (lane contract says report, do not edit the foundation).
  // DWFUI.segmentedHtml is the right SEMANTIC component here (role=radiogroup / role=radio /
  // aria-checked) but it has NO per-option sprite or art channel: its options render only through
  // bitmapTextHtml (ui-components.js:1779-1785), so it physically cannot show DF's ten accounting
  // tiles. web/js/dwf-ui-components.js is LOCKED this wave, so per the contract's explicit
  // instruction the strip is composed from actionButtonsHtml + the sprites, and the gap is reported.
  // The cost is the radiogroup ARIA, not the art. `data-noble-precision` is unchanged, so
  // wireNoblesBody() and POST /noble-precision dispatch exactly as before.
  function noblePrecisionHtml(precision) {
    const active = noblePrecisionActiveButton(precision);
    return DWFUI.actionButtonsHtml(
      [1, 2, 3, 4, 5].map(n => ({
        action: `precision${n}`,
        sprite: `NOBLES_ACCOUNTING_${n}_INACTIVE`,
        activeSprite: `NOBLES_ACCOUNTING_${n}_ACTIVE`,
        active: n === active,
        title: `Bookkeeper precision ${n}`,
        dataset: { noblePrecision: n - 1 },
      })),
      { cls: "noble-precision", ariaLabel: "Bookkeeper accounting precision" });
  }

  // A noble seat has FOUR display states: holder, vacant, unfillable, travelling.
  // TRAVELLING is `filled && unitId < 0` -- keyed off the historical figure record, not off a live unit.
  const NOBLE_SEAT_YELLOW_BRIGHT = 14;
  const NOBLE_SEAT_WHITE = 7;
  function nobleSeatState(p) {
    if (!p) return "unfillable";
    if (p.filled) return Number(p.unitId) >= 0 ? "holder" : "travelling";
    return Number(p.assignmentId) >= 0 ? "vacant" : "unfillable";
  }

  function noblesBody(data, options = {}) {
    if (!data || data.error) return `<div class="info-message">Nobles unavailable: ${escapeHtml(data && data.error || "")}</div>`;
    const positions = Array.isArray(data.positions) ? data.positions : [];
    const mandates = Array.isArray(data.mandates) ? data.mandates : [];
    const hasPrecision = typeof data.bookkeeperPrecision === "number";
    const candidatePositionId = Object.prototype.hasOwnProperty.call(options, "candidatePositionId")
      ? Number(options.candidatePositionId) : nobleAssignOpenPosition;
    const candidateData = Object.prototype.hasOwnProperty.call(options, "candidateData")
      ? options.candidateData : nobleAssignCandidates;
    const candidateLoading = Object.prototype.hasOwnProperty.call(options, "candidateLoading")
      ? !!options.candidateLoading : nobleAssignLoading;
    // Native candidates are a top-level Nobles mode: they replace the position list rather than
    // expanding beneath one row. Keep the existing data-noble-* hooks and routes unchanged.
    if (Number.isInteger(candidatePositionId) && candidatePositionId >= 0)
      return nobleCandidatesModeHtml(candidatePositionId, candidateData, candidateLoading);
    const usableWidth = Object.prototype.hasOwnProperty.call(options, "usableWidth") &&
        Number.isFinite(Number(options.usableWidth))
      ? Number(options.usableWidth) : nobleUsableWidthCells();
    const rows = positions.length ? positions.map(p => {
      const holderName = p.holder || `unit ${p.unitId}`;
      const portrait = p.filled && typeof unitPortraitMarkup === "function"
        ? unitPortraitMarkup(Object.assign({ id: p.unitId, name: holderName }, p), "info-portrait-small")
        : "";
      const seatState = nobleSeatState(p);
      let who;
      if (seatState === "holder") {
        who = DWFUI.rowHtml({
          layout: "icon", cls: "noble-holder-row", icon: portrait,
          labelHtml: DWFUI.rawHtml("profession-coloured linked noble holder",
            `<span${fortProfessionColorStyle(p)}>${fortUnitRef(p.unitId, holderName)}</span>`),
        });
      } else if (seatState === "travelling") {
        // State 4: the histfig name, white, with the travelling suffix -- no portrait and no unit deep link.
        who = DWFUI.statusHtml({
          tag: "span", cls: "fort-seat fort-seat-travelling", dfColor: NOBLE_SEAT_WHITE,
          text: `${holderName} (travelling)`, dataset: { nobleSeat: "travelling" },
        });
      } else {
        who = DWFUI.statusHtml({
          tag: "span", cls: `fort-vacant fort-seat fort-seat-${seatState}`,
          dfColor: NOBLE_SEAT_YELLOW_BRIGHT,
          text: seatState === "vacant" ? "VACANT" : "NEW",
          dataset: { nobleSeat: seatState },
        });
      }
      // R4: room-requirement icons + demand/mandate icons for filled rows (native shows no icons on
      // VACANT rows). Falls back to the legacy "Needs:" text when the DLL served no room data.
      const iconStates = nobleRoomIconStates(p);
      const isBookkeeper = /bookkeeper/i.test(String(p.name || ""));
      const showRequirements = p.filled && usableWidth > 100 && iconStates.length;
      const showPrecision = isBookkeeper && usableWidth > 121 && hasPrecision;
      let subHtml = "";
      if (p.filled || showPrecision) {
        subHtml = `<div class="noble-icons">`
          + (showRequirements ? iconStates.map(nobleRoomIconHtml).join("") : "")
          + (showRequirements ? `<span class="noble-icon-spacer"></span>` : "")
          + (p.filled && !iconStates.length && p.requirements
            ? `<span class="fort-dim">Needs: ${escapeHtml(p.requirements)}</span>` : "")
          // Demands and mandates are filled-seat gates, independent of whether room data was served
          // and independent of the requirements strip's 100-cell responsive gate.
          + (p.filled ? nobleMandateIconHtml(nobleMandateIcons(p, mandates)) : "")
          + (showPrecision ? noblePrecisionHtml(Number(data.bookkeeperPrecision)) : "")
          + `</div>`;
      } else if (!p.filled) {
        subHtml = p.requirements ? `<span class="fort-dim">Needs: ${escapeHtml(p.requirements)}</span>` : "";
      }
      // [+] assign is drawn on EVERY row: /nobles carries no appointed/elected/reassignable flag, and
      // deriving one from `precedence` would be a guess. Reported rather than deleting a live capability.
      const assignBtn = DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.noblesAdd, cls: "fort-assign-btn", size: 24,
        dataset: { nobleAssign: p.positionId },
        title: "Assign / unassign this position", ariaLabel: "Assign or unassign this position",
      });
      // The crown dispatches nothing; `placeholder` applies the unverified styling and the required title.
      const crownBtn = p.filled ? DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.noblesCrown, cls: "fort-crown-btn", size: 24,
        placeholder: true, disabled: true, ariaLabel: "Assign a symbol",
        title: "Assign a symbol -- the native symbols screen is not implemented, so this tile does " +
          "nothing yet. Placeholder: its behaviour is unverified.",
      }) : `<span class="noble-regalia-slot" aria-hidden="true"></span>`;
      // `.fort-row-noble` is a FIXED five-track grid that places children BY ORDER, so this must emit exactly
      // five direct children -- copy | [+] | who | crown | sub -- and the empty sub cell still occupies a track.
      return `<div class="fort-noble-row">
        ${DWFUI.rowHtml({
          chassis: "table", cls: "fort-row fort-row-noble",
          copyCls: "fort-cell-main", labelCls: "noble-position-name",
          labelHtml: DWFUI.bitmapTextHtml(p.name),
          // R4: squad name second line on militia rows ("The Pinkertons"/"Delta Squad").
          sub: p.squadName ? { text: p.squadName, cls: "fort-dim noble-squad-name" } : null,
          // Native's order: [+], holder, crown, then the room and demand tiles.
          cells: [
            { html: assignBtn },
            { html: who, cls: "fort-cell-who" },
            { html: crownBtn, cls: "fort-cell-regalia" },
            { html: subHtml, cls: "fort-cell-sub" },
          ],
        })}
      </div>`;
    }).join("") : `<div class="info-message">No fort positions defined.</div>`;
    // No `chassis:` here: `.fort-row-tall` is a one-column grid whose three children stack, and the table
    // chassis would re-lay it.
    const mandateRows = mandates.length ? mandates.map(m => {
      const byText = m.unitId >= 0 ? fortUnitRef(m.unitId, m.by) : DWFUI.bitmapTextHtml(m.by || "");
      const by = `<span${fortProfessionColorStyle(m, "byProfessionColor")}>${byText}</span>`;
      const kind = fortPrettyKey(m.mode); // Make / Export / Guild
      const isExport = String(m.mode || "").toLowerCase() === "export";
      // Material + item together ("iron short sword" / "silver"), whichever the mandate carries.
      const what = [m.material, m.item].map(s => (s || "").trim()).filter(Boolean).join(" ");
      const titleText = what
        ? `${isExport ? "Do not export" : "Make " + m.amountTotal} ${what}`
        : kind;
      // Countdown: server sends daysRemaining (-1 == ongoing/no deadline, e.g. an export ban).
      const deadline = (typeof m.daysRemaining === "number" && m.daysRemaining >= 0)
        ? `${m.daysRemaining} day(s) left` : "Ongoing";
      const progress = isExport ? ""
        : `<span class="fort-dim">${DWFUI.bitmapTextHtml(`${m.amountRemaining}/${m.amountTotal} left`)}</span> &middot; `;
      const penalty = m.punishMultiple
        ? ` &middot; <span class="fort-dim">${DWFUI.bitmapTextHtml("multiple offenders punished")}</span>` : "";
      return DWFUI.rowHtml({
        cls: "fort-row fort-row-tall",
        copyCls: "fort-cell-main",
        labelHtml: DWFUI.bitmapTextHtml(titleText) +
          `<span class="fort-dim"> &middot; ${DWFUI.bitmapTextHtml(kind)}</span>`,
        cells: [
          { html: `${progress}<span class="fort-badge fort-badge-open">${DWFUI.bitmapTextHtml(deadline)}</span>${penalty}`,
            cls: "fort-cell-who" },
          { html: `${DWFUI.bitmapTextHtml("By")} ${by}`, cls: "fort-cell-sub" },
        ],
      });
    }).join("") : `<div class="info-message">No active mandates.</div>`;
    const positionList = DWFUI.scrollHtml({
      cls: "nobles-position-list",
      rows: ".fort-noble-row",
      preserveKey: "nobles-positions",
      ariaLabel: "Nobles and administrators",
    }, rows);
    const mandateList = DWFUI.scrollHtml({
      cls: "nobles-mandate-list", rows: ".fort-row", preserveKey: "nobles-mandates", ariaLabel: "Active mandates",
    }, mandateRows);
    return `<div class="nobles-screen"><div id="fortStatus" class="info-message fort-status"></div>
      <div class="dwfui-text--note fort-note">Members of the nobility have required rooms and can make demands. They cannot be reassigned. Administrators handle various aspects of your fortress and can be reassigned. Many administrators also require rooms.</div>
      ${positionList}
      <div class="dwfui-text--section fort-section-title">Active mandates</div>${mandateList}</div>`;
  }

  function wireNoblesBody(root) {
    root.querySelectorAll("[data-noble-assign]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        toggleNobleAssign(Number(button.dataset.nobleAssign));
      });
    });
    root.querySelectorAll("[data-noble-pick]").forEach(row => {
      row.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        submitNobleAssign(Number(row.dataset.noblePick), Number(row.dataset.nobleUnit));
      });
    });
    // R4: bookkeeper precision selector.
    root.querySelectorAll("[data-noble-precision]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        submitNoblePrecision(Number(button.dataset.noblePrecision));
      });
    });
  }

  async function submitNoblePrecision(level) {
    try {
      await fortFetchJson(
        `/noble-precision?player=${encodeURIComponent(player)}&level=${level}&t=${Date.now()}`,
        { method: "POST" });
      adminData.nobles = null;
      await refreshFortAdmin();
      fortSetStatus("Bookkeeper precision set.", false);
    } catch (err) {
      fortSetStatus(err.message || "Precision change failed.", true);
    }
  }

  // ---- Justice ----

  function justiceSubTabsHtml(activeMode = justiceMode) {
    // The six Justice sub-tabs are the SHORT_SUBTAB tier; without `level` they never reach the native art.
    return DWFUI.tabsHtml({
      cls: "info-detail-tabs", tabCls: "info-tab", dataAttr: "justice-mode", level: "subtab",
      ariaLabel: "Justice section", active: activeMode,
      tabs: JUSTICE_MODES.map(mode => ({ key: mode.key, label: mode.label })),
    });
  }

  // Keys on the served enum string; falls back to prettyFn for modes the oracle did not pin.
  function justiceCrimeModeLabel(mode, prettyFn) {
    const m = String(mode || "");
    if (/production ?order/i.test(m)) return "Violation of production order";
    if (/export/i.test(m)) return "Violation of export prohibition";
    if (/job ?order/i.test(m)) return "Violation of job order";
    return typeof prettyFn === "function" ? prettyFn(m) : m;
  }
  // Right-pane summary lines. Native always states the disposition, including an unresolved
  // open case whose record does not yet carry a primary accused.
  function justiceCaseDetailLines(c) {
    const lines = [];
    if (!c) return lines;
    const has = (name, id) => (name != null && String(name).trim() !== "") || Number(id) >= 0;
    if (has(c.victim, c.victimId)) lines.push({ kind: "injured", label: "Injured party", name: c.victim, unitId: Number(c.victimId), professionColor: c.victimProfessionColor });
    if (c.sentenced && has(c.criminal, c.criminalId)) lines.push({ kind: "convicted", label: "Convicted", name: c.criminal, unitId: Number(c.criminalId), professionColor: c.criminalProfessionColor });
    else if (c.sentenced) lines.push({ kind: "unknown-convict", text: "Unknown convict." });
    else if (has(c.accused, c.accusedId)) lines.push({ kind: "accused", label: "Accused", name: c.accused, unitId: Number(c.accusedId), professionColor: c.accusedProfessionColor });
    else lines.push({ kind: "unsolved", text: "Unsolved." });
    return lines;
  }

  // ---- convict / interrogate ---------------------------------------------------------------------
  const JUSTICE_GUARD_COPY = {
    convict: 'Convicting from the browser is built, but it is locked until the host verifies it ' +
      'on this machine: flag "justice_convict" in dfcapture-hostwrites.json (next to the DF exe) ' +
      'is off. Dwarf Fortress itself performs the conviction; nothing is written until the flag is ' +
      'on. It unlocks live -- no reload.',
    interrogate: 'Assigning an interrogation from the browser is built, but it is locked until the ' +
      'host verifies it on this machine: flag "justice_interrogate" in dfcapture-hostwrites.json ' +
      '(next to the DF exe) is off. It unlocks live -- no reload.',
    unreadable: 'The host is not reporting its justice action flags, so this action stays locked. ' +
      'That is a host/plugin problem, not a rule -- tell whoever runs the fort.',
  };

  // {enabled, reason} for one drive. `hostState` is the GET /justice-state payload (or null when
  // it could not be read). Fails closed on every unknown: no flags = no action.
  function justiceActionState(hostState, kind) {
    const key = kind === "convict" ? "justiceConvict" : "justiceInterrogate";
    const guards = hostState && hostState.guards;
    if (!guards) return { enabled: false, reason: JUSTICE_GUARD_COPY.unreadable };
    if (guards[key] !== true) return { enabled: false, reason: JUSTICE_GUARD_COPY[kind] };
    return { enabled: true, reason: "" };
  }

  // DEF-039 WIRE GAP: the full native suspect population/ranking is not served. Offer only people
  // named by the case's structured evidence (primary parties, then witness accusations), deduped.
  function justiceCaseParties(c) {
    const parties = [];
    const seen = {};
    if (!c) return parties;
    const named = [
      { kind: "accused", id: c.accusedId, name: c.accused,
        scheduled: c.accusedScheduled, interviewed: c.accusedInterviewed },
      { kind: "criminal", id: c.criminalId, name: c.criminal,
        scheduled: c.criminalScheduled, interviewed: c.criminalInterviewed },
    ];
    for (const w of Array.isArray(c.witnesses) ? c.witnesses : []) {
      named.push({ kind: "witness-accused", id: w.accusedId, name: w.accused,
        scheduled: false, interviewed: false });
    }
    for (const p of named) {
      const id = Number(p.id);
      const name = p.name != null ? String(p.name).trim() : "";
      if (Number.isInteger(id) && id >= 0 && !seen[id]) {
        seen[id] = true;
        parties.push({ kind: p.kind, id, name: name || `unit ${id}`,
          scheduled: !!p.scheduled, interviewed: !!p.interviewed });
      }
    }
    return parties;
  }

  // Ledger 0010 R9/R10: these are derived from crime.reports and crime.counterintelligence on
  // every server read. Scheduled wins if malformed data happens to put the same person in both.
  function justiceInterviewAnnotation(party) {
    if (party && party.scheduled) return { state: "scheduled", text: "Interview queued", tone: "warn" };
    if (party && party.interviewed) return { state: "interviewed", text: "Interview completed", tone: "interviewed" };
    return null;
  }

  function justiceDate(year, tick) {
    const y = Number(year);
    const t = Number(tick);
    if (!Number.isFinite(y)) return "Date unavailable";
    if (!Number.isFinite(t) || t < 0) return `Year ${y}`;
    return `Year ${y}, day ${Math.floor(t / 1200) + 1}`;
  }

  function justiceWitnessClaim(w) {
    const accused = Number(w && w.accusedId) >= 0 || !!String(w && w.accused || "").trim();
    const type = String(w && w.type || "").toUpperCase();
    const name = String(w && w.accused || "a person");
    if (accused) return type === "COCONSPIRATOR_IMPLICATED"
      ? `Connected ${name} to the scheme.` : `Named ${name} as responsible.`;
    if (type === "FOUND_BODY") return "Came upon the body.";
    if (type === "SAW_THAT_OBJECT_WAS_MISSING") return "Noticed that an object had disappeared.";
    if (type === "SAW_DISTURBED_OBJECT") return "Noticed that an object had been disturbed.";
    if (type === "SOMEBODY_ADMIRED_OBJECT") return `Saw ${name} paying close attention to the object.`;
    return ""; // Native deliberately emits no claim line for the other no-accused codes.
  }

  function justiceWitnessesHtml(c) {
    const witnesses = Array.isArray(c && c.witnesses) ? c.witnesses : [];
    if (!witnesses.length) return DWFUI.statusHtml({ cls: "justice-no-witnesses", tone: "dim",
      text: "No witness account is attached to this case." });
    return `<div class="justice-witness-list">${witnesses.map(w => {
      const claim = justiceWitnessClaim(w);
      return `<div class="justice-witness-block">` +
        DWFUI.statusHtml({ cls: "justice-witness-name", text: `Witness: ${w.witness || "Identity unresolved"}` }) +
        // Native's witness block is exactly four lines. Unknown/no-accused witness codes keep an
        // empty claim line; omitting the node collapsed those blocks to three lines.
        DWFUI.statusHtml({ cls: "justice-witness-claim", tone: Number(w.accusedId) >= 0 ? "warn" : "dim", text: claim }) +
        DWFUI.statusHtml({ cls: "justice-witness-date", tone: "dim", text: `Occurred: ${justiceDate(w.year, w.tick)}` }) +
        DWFUI.statusHtml({ cls: "justice-witness-reported", tone: "dim", text: `Recorded: ${justiceDate(w.reportedYear, w.reportedTick)}` }) +
        `</div>`;
    }).join("")}</div>`;
  }

  function justiceCaseActionsHtml(c, activeMode, hostState) {
    // Both actions live at the PANEL boundary: witness count, named evidence and parties never decide
    // enablement. The guards below are host capability locks, not game-state predicates.
    if (!c || c.sentenced || c.needsTrial !== true || activeMode !== "open") return "";
    const parties = justiceCaseParties(c);
    const convict = justiceActionState(hostState, "convict");
    const interrogate = justiceActionState(hostState, "interrogate");
    const noCandidates = parties.length === 0;
    const buttons = `<div class="justice-suspect-actions">` +
      DWFUI.plaqueBtnHtml({
        label: "Interrogate a suspect", tone: "grey", cls: "justice-interrogate-btn",
        dataset: { justiceInterrogate: c.id },
        disabled: !interrogate.enabled || noCandidates,
        title: noCandidates ? "No named suspect is attached to this case evidence yet."
          : interrogate.enabled ? "Choose a suspect named by this case's evidence." : interrogate.reason,
      }) +
      DWFUI.plaqueBtnHtml({
        label: "Convict a suspect", tone: "red", cls: "justice-convict-btn",
        dataset: { justiceConvict: c.id },
        disabled: !convict.enabled || noCandidates,
        title: noCandidates ? "No named suspect is attached to this case evidence yet."
          : convict.enabled ? "Choose a suspect named by this case's evidence." : convict.reason,
      }) + `</div>`;
    const locked = [];
    if (noCandidates) locked.push("No named suspect is attached to this case evidence yet.");
    if (!convict.enabled) locked.push(convict.reason);
    if (!interrogate.enabled && interrogate.reason !== convict.reason) locked.push(interrogate.reason);
    const note = locked.length
      ? `<div class="justice-detail-line justice-guard-note">${
          locked.map(r => DWFUI.bitmapTextHtml(r)).join("</div><div class=\"justice-detail-line justice-guard-note\">")}</div>`
      : "";
    return `<div class="justice-detail-actions justice-case-actions">${buttons}</div>${note}`;
  }

  function justiceSuspectChooserHtml(c, kind, hostState) {
    const parties = justiceCaseParties(c);
    const action = justiceActionState(hostState, kind);
    const isConvict = kind === "convict";
    const rows = parties.map(p => {
      const annotation = justiceInterviewAnnotation(p);
      const label = isConvict ? `Convict ${p.name}`
        : `${p.scheduled ? "Remove interview for" : "Queue interview with"} ${p.name}`;
      return `<div class="justice-suspect-choice">` +
        DWFUI.plaqueBtnHtml({
          label, tone: isConvict ? "red" : "grey", cls: `justice-${kind}-btn`,
          dataset: { [isConvict ? "justiceConvict" : "justiceInterrogate"]: c.id, justiceUnit: p.id },
          disabled: !action.enabled,
          title: action.enabled
            ? (isConvict ? "Click twice to confirm this irreversible conviction."
              : "Use Dwarf Fortress's native justice screen to update this interview.")
            : action.reason,
        }) +
        (annotation ? DWFUI.statusHtml({ tag: "span", cls: `justice-interview-state ${annotation.state}`,
          tone: annotation.tone, text: annotation.text }) : "") + `</div>`;
    }).join("");
    const refusal = !action.enabled
      ? `<div class="justice-detail-line justice-guard-note">${DWFUI.bitmapTextHtml(action.reason)}</div>` : "";
    const evidenceLimit = `<div class="justice-detail-line justice-chooser-limit">${DWFUI.bitmapTextHtml(
      "Only suspects named by the served case evidence can be shown; the full native ranked suspect pool is not served (DEF-039).")}</div>`;
    const body = rows || `<div class="info-message">${DWFUI.bitmapTextHtml(
      "No named suspect is attached to this case evidence yet.")}</div>`;
    const prompt = isConvict ? "Choose a suspect to convict." : "Choose a suspect to interrogate.";
    const cancel = DWFUI.plaqueBtnHtml({
        label: "Cancel", tone: "red", cls: "justice-chooser-cancel",
        dataset: { justiceChooserCancel: "" }, title: "Return to the case",
      });
    return DWFUI.modalHtml({
      cls: "justice-suspect-chooser", prompt, ariaLabel: prompt, footerHtml: cancel,
    }, body + evidenceLimit + refusal);
  }

  // Each named party is coloured by that unit's profession, from the payload's professionColor fields.
  function justiceDetailLineHtml(l) {
    if (l && l.text) return `<div class="justice-detail-line justice-${l.kind}">${DWFUI.bitmapTextHtml(l.text)}</div>`;
    const who = Number(l.unitId) >= 0 ? fortUnitRef(l.unitId, l.name) : DWFUI.bitmapTextHtml(l.name || "");
    return `<div class="justice-detail-line">${DWFUI.bitmapTextHtml(`${l.label}:`)} <span${fortProfessionColorStyle(l)}>${who}</span>${DWFUI.bitmapTextHtml(".")}</div>`;
  }
  // Do NOT migrate this to gridHtml: `.dwfui-grid` paints a gold divider through its gap, and the justice
  // master/detail has no divider in any oracle.
  function justiceMasterDetailHtml(listHtml, detailHtml) {
    return `<div class="justice-master-detail">` +
      DWFUI.scrollHtml({
        cls: "justice-case-list",
        rows: ".justice-case-btn, .justice-convict-row, .justice-report-row",
        ariaLabel: "Justice cases and reports",
      }, listHtml) +
      // Prose: its lines are the rows, as in native's text panes.
      DWFUI.scrollHtml({
        cls: "justice-case-detail",
        rows: ".justice-detail-line, .dwfui-status, .justice-breakdown-title, .justice-breakdown-row, " +
          ".justice-detail-actions .dwfui-plaque",
        ariaLabel: "Case details",
      }, detailHtml) + `</div>`;
  }
  // `data-justice-case` IS the capability: it drives the detail pane, the only route to Pardon on Convicts.
  function justiceCaseButtonHtml(id, label, active) {
    return DWFUI.rowHtml({
      tag: "button", chassis: "slab", cls: "justice-case-btn", label: String(label), selected: !!active,
      dataset: { justiceCase: id },
    });
  }

  // The native convict/guard unit row: portrait, name + profession, then the [recenter][magnifier] pair.
  // A guard carries no crimeId, so its row omits data-justice-case and role="option" -- it is not selectable.
  function justiceConvictRowHtml(c, selected) {
    const unitId = Number(c.unitId);
    const name = String(c.name || "Unknown");
    const live = Number.isInteger(unitId) && unitId >= 0;
    const hasCase = Number.isFinite(Number(c.crimeId));
    const portrait = (typeof unitPortraitMarkup === "function")
      ? unitPortraitMarkup(Object.assign({ unitId, id: unitId, name }, c), "info-portrait-small")
      : DWFUI.iconHtml({ letter: name, size: 48, alt: name });
    const profession = String(c.profession || "").trim();
    // Suppress the profession line when the name's trailing comma segment already IS the profession: the
    // wire serves both forms at once, so emitting it unconditionally prints the profession twice.
    const professionShown =
      profession && name.split(",").pop().trim().toLowerCase() !== profession.toLowerCase()
        ? profession : "";
    const labelHtml = `<div class="justice-row-identity"${fortProfessionColorStyle(c)}>` +
      DWFUI.bitmapTextHtml(name) +
      (professionShown ? `<div class="justice-row-profession">${DWFUI.bitmapTextHtml(professionShown)}</div>` : "") +
      `</div>`;
    const S = DWFUI.TOKENS.sprites;
    const actions = DWFUI.actionButtonsHtml(
      [{ action: "recenter", sprite: S.recenterStocks, title: `Center the view on ${name} and open their profile`,
         disabled: !live, dataset: { justiceRecenter: live ? unitId : "" } },
       { action: "view", sprite: S.view, title: `View ${name}`,
         dataset: { unitId: live ? unitId : "" } }],
      { cls: "justice-row-actions", ariaLabel: "Convict actions" });
    return DWFUI.rowHtml(Object.assign({
      chassis: "table", cls: "justice-convict-row", selected: !!selected,
      icon: portrait,
      labelHtml,
      cells: [{ html: actions, cls: "justice-row-actions-cell" }],
    }, hasCase ? { role: "option", dataset: { justiceCase: c.crimeId } } : {}));
  }
  // `Cat` and `Prof` are not on our wire, so those sort buttons render DISABLED with a title saying why.
  function justiceConvictSortHtml(active) {
    return DWFUI.sortHeaderHtml({
      cls: "justice-sort", dataAttr: "justice-sort", ariaLabel: "Sort convicts",
      active: active === "name" ? "name" : "name",
      columns: [
        { key: "name", label: "Name", title: "Sort by name" },
        { key: "cat", label: "Cat", disabled: true,
          title: "Category sorting needs a `category` field on /justice (not served)" },
        { key: "prof", label: "Prof", disabled: true,
          title: "Profession sorting needs a `profession` field on /justice (not served)" },
      ],
    });
  }

  const JUSTICE_METHOD_LABELS = {
    INTIMIDATE: "Pressure", FLATTER: "Praise", RELIGIOUS_SYMPATHY: "Shared belief",
    APPEAL_TO_VALUE: "Principle appeal", BUILD_RAPPORT: "Conversation", LIE: "Misleading account",
  };

  function justiceSigned(value) {
    const n = Number(value) || 0;
    return n > 0 ? `+${n}` : String(n);
  }

  function justiceHeadlineAxis(result) {
    const entries = [
      { axis: "trait", value: Number(result && result.facetModifier) || 0 },
      { axis: "value", value: Number(result && result.valueModifier) || 0 },
      { axis: "feeling", value: Number(result && result.relationshipModifier) || 0 },
    ];
    if (result && result.successful) {
      const eligible = entries.filter(e => e.value >= 1);
      return eligible.length ? eligible.reduce((best, e) => e.value > best.value ? e : best).axis : "";
    }
    const eligible = entries.filter(e => e.value < 0);
    return eligible.length ? eligible.reduce((best, e) => e.value < best.value ? e : best).axis : "";
  }

  function justiceReportBreakdownRows(report) {
    const result = report && report.result || {};
    if (!result.methodSet) return [{ kind: "assessment", label: "Assessment",
      value: "The attempt produced no usable assessment." }];
    const methodKey = String(result.method || "");
    let approach = JUSTICE_METHOD_LABELS[methodKey] || fortPrettyKey(methodKey);
    if (methodKey === "APPEAL_TO_VALUE" && result.value) approach += `: ${fortPrettyKey(result.value)}`;
    if (methodKey === "RELIGIOUS_SYMPATHY" && (result.relevantName || Number(result.relevantId) >= 0))
      approach += `: ${result.relevantName || `group ${result.relevantId}`}`;
    const rows = [
      { kind: "approach", label: "Approach", value: approach },
      { kind: "outcome", label: "Outcome", value: result.successful ? "Effective" : "Ineffective" },
    ];
    if (result.misjudged) rows.push({ kind: "misjudged", label: "Read", value: "The officer chose from a mistaken impression." });
    let score = justiceSigned(result.methodModifier);
    if (Number(result.methodModifier) !== Number(result.methodPerceivedModifier))
      score += ` (expected ${justiceSigned(result.methodPerceivedModifier)})`;
    rows.push({ kind: "score", label: "Approach score", value: score });
    const headline = justiceHeadlineAxis(result);
    for (const row of [
      { kind: "trait", label: "Trait", name: result.facet, rating: result.facetRating, modifier: result.facetModifier },
      { kind: "value", label: "Value", name: result.value, rating: result.valueRating, modifier: result.valueModifier },
      { kind: "feeling", label: "Feeling", name: result.relationshipFactor, rating: result.relationshipRating, modifier: result.relationshipModifier },
    ]) {
      if (!Number(row.modifier)) continue;
      rows.push({ kind: row.kind, label: row.label,
        value: `${fortPrettyKey(row.name || "unknown")} ${Number(row.rating) || 0} (${justiceSigned(row.modifier)})`,
        modifier: Number(row.modifier), headline: headline === row.kind });
    }
    return rows;
  }

  function justiceReportDetailHtml(report) {
    if (!report) return "";
    const details = Array.isArray(report.details) ? report.details : [];
    const outcome = report.result && report.result.successful ? "Effective" : "Ineffective";
    const body = details.length
      ? details.map(text => DWFUI.statusHtml({ cls: "justice-report-paragraph", columns: 58, text })).join("")
      : DWFUI.statusHtml({ cls: "justice-report-diagnostic", tone: "danger", columns: 58,
          text: "This stored report has no body. The producing record is incomplete." });
    const breakdown = justiceReportBreakdownRows(report).map(row => {
      const tone = row.modifier > 0 ? "positive" : row.modifier < 0 ? "negative" : "";
      return `<div class="justice-breakdown-row ${tone}${row.headline ? " headline" : ""}">` +
        DWFUI.bitmapTextHtml(`${row.label}:`) + " " + DWFUI.bitmapTextHtml(row.value) + `</div>`;
    }).join("");
    const guarded = DWFUI.plaqueBtnHtml({ label: "Mark read", tone: "grey", disabled: true,
      title: "This cosmetic write is guarded until its native write site is verified." });
    const conduct = DWFUI.plaqueBtnHtml({ label: "Conduct now", tone: "grey", disabled: true,
      title: "Dwarf Fortress must create the report and apply skill, relationship, crime, and plot effects together." });
    const edit = DWFUI.plaqueBtnHtml({ label: "Revise record", tone: "grey", disabled: true,
      title: "Interrogation reports are write-once records; changing one would desynchronise the linked evidence." });
    return DWFUI.statusHtml({ cls: "justice-report-subject", text: `Subject: ${report.subject || "Identity unresolved"}` }) +
      DWFUI.statusHtml({ cls: "justice-report-officer", tone: "dim", text: `Officer: ${report.officer || "Identity unresolved"}` }) +
      DWFUI.statusHtml({ cls: "justice-report-date", tone: "dim", text: justiceDate(report.year, report.tick) }) +
      DWFUI.statusHtml({ cls: "justice-report-outcome", tone: report.result && report.result.successful ? "good" : "danger", text: outcome }) +
      `<div class="justice-report-body">${body}</div>` +
      `<div class="justice-report-breakdown"><div class="justice-breakdown-title">${DWFUI.bitmapTextHtml("DWF outcome breakdown")}</div>${breakdown}</div>` +
      `<div class="justice-detail-actions justice-report-disabled-actions">${guarded}${conduct}${edit}</div>`;
  }

  // ---- counter-intelligence has two distinct empty states -------------------------------------
  const COUNTERINTEL_STANDING_LINE =
    "Conspiracies are uncovered by interrogating suspects; each interrogation adds a report here.";
  function counterintelEmptyState(data) {
    if (data && data.hasIntelligence === false) return "no-intelligence";
    return "no-reports";
  }
  const COUNTERINTEL_EMPTY_COPY = {
    "no-intelligence": "No intelligence information has been gathered.",
    "no-reports": "No interrogation reports have been recorded.",
  };
  // DEF-040 WIRE GAP: /justice?mode=counterintel serves interrogation reports only. Native's
  // Actors, Organizations and Plots tabs remain visible but locked until those records are served.
  const JUSTICE_INTEL_MODES = [
    { key: "interrogations", label: "Interrogations" },
    { key: "actors", label: "Actors", disabled: true },
    { key: "organizations", label: "Organizations", disabled: true },
    { key: "plots", label: "Plots", disabled: true },
  ];
  function justiceIntelTabsHtml() {
    const reason = "This Intelligence mode is visible in Dwarf Fortress, but its records are not served yet (DEF-040).";
    const tabs = DWFUI.tabsHtml({
      cls: "justice-intel-tabs", tabCls: "justice-intel-tab", dataAttr: "justice-intel-mode",
      level: "subtab", ariaLabel: "Intelligence section", active: "interrogations",
      tabs: JUSTICE_INTEL_MODES.map(mode => ({
        key: mode.key, label: mode.label, disabled: !!mode.disabled,
        title: mode.disabled ? reason : "Interrogation reports",
      })),
    });
    // DEF-040 requires the three real Intelligence modes to stay NAMED while their records are unavailable,
    // so the shared reason is shown without hover instead of DWFUI's blank disabled-tab grammar.
    return tabs + DWFUI.statusHtml({
      cls: "justice-intel-lock-reason", tone: "dim", text: reason,
    });
  }
  function counterintelStandingLineHtml() {
    return `<div class="info-message justice-ci-standing">${DWFUI.bitmapTextHtml(COUNTERINTEL_STANDING_LINE)}</div>`;
  }

  function justiceReportsHtml(data, options) {
    const tabs = justiceIntelTabsHtml();
    const reports = Array.isArray(data && data.reports) ? data.reports.slice().reverse() : [];
    if (!reports.length) {
      const state = counterintelEmptyState(data);
      return tabs + counterintelStandingLineHtml() +
        `<div class="info-message" data-justice-ci-empty="${state}">${escapeHtml(COUNTERINTEL_EMPTY_COPY[state])}</div>`;
    }
    let selected = Number.isFinite(Number(options && options.selectedReport))
      ? Number(options.selectedReport) : justiceSelectedReport;
    if (!reports.some(r => Number(r.index) === selected)) selected = Number(reports[0].index);
    if (!(options && Object.prototype.hasOwnProperty.call(options, "selectedReport"))) justiceSelectedReport = selected;
    const list = reports.map(report => DWFUI.plaqueBtnHtml({
      cls: "justice-report-row", focus: Number(report.index) === selected,
      dataset: { justiceReport: report.index },
      label: report.subject || "Identity unresolved",
      title: `${report.result && report.result.successful ? "Effective" : "Ineffective"}; ${justiceDate(report.year, report.tick)}${report.viewed ? "" : "; unread"}`,
    })).join("");
    const report = reports.find(r => Number(r.index) === selected) || reports[0];
    // R9: the standing explanatory line is NOT an empty state -- it stands beside populated content.
    return tabs + counterintelStandingLineHtml() +
      justiceMasterDetailHtml(`<div class="justice-report-list">${list}</div>`, justiceReportDetailHtml(report));
  }

  function justiceBody(data, options = {}) {
    if (!data || data.error) return `<div class="info-message">Justice unavailable: ${escapeHtml(data && data.error || "")}</div>`;
    const activeMode = options.mode || justiceMode;
    let selectedCase = Number.isFinite(Number(options.selectedCase)) ? Number(options.selectedCase) : justiceSelectedCase;
    const modeDef = JUSTICE_MODES.find(m => m.key === activeMode) || JUSTICE_MODES[0];
    const status = `<div id="fortStatus" class="info-message fort-status"></div>`;

    if (activeMode === "open" || activeMode === "closed" || activeMode === "cold") {
      const crimes = Array.isArray(data.crimes) ? data.crimes : [];
      if (!crimes.length) return status + `<div class="info-message">${modeDef.empty}</div>`;
      if (!crimes.some(c => Number(c.id) === selectedCase)) selectedCase = Number(crimes[0].id);
      if (!options.mode) justiceSelectedCase = selectedCase;
      const sel = crimes.find(c => Number(c.id) === selectedCase) || crimes[0];
      const listHtml = crimes.map(c =>
        justiceCaseButtonHtml(c.id, justiceCrimeModeLabel(c.mode, fortPrettyKey), Number(c.id) === selectedCase)).join("");
      const lines = justiceCaseDetailLines(sel);
      const hostState = Object.prototype.hasOwnProperty.call(options, "hostState")
        ? options.hostState : justiceHostState;
      const chooser = options.chooser || justiceChooser;
      const chooserOpen = chooser && Number(chooser.crimeId) === Number(sel.id) &&
        (chooser.kind === "convict" || chooser.kind === "interrogate");
      // Native order: summary, actions, then witnesses. Closed/cold cases are summary-only.
      const detailHtml = (lines.length ? lines.map(justiceDetailLineHtml).join("") : "")
        + (chooserOpen ? justiceSuspectChooserHtml(sel, chooser.kind, hostState)
          : justiceCaseActionsHtml(sel, activeMode, hostState))
        + (activeMode === "open" && sel.needsTrial === true ? justiceWitnessesHtml(sel) : "");
      return status + justiceMasterDetailHtml(listHtml, detailHtml);
    }
    if (activeMode === "guard") {
      // Guard members reuse justiceConvictRowHtml: identical anatomy, and no crimeId means not selectable.
      const guard = data.guard || {};
      const members = Array.isArray(guard.members) ? guard.members : [];
      const hasDesiredCount = guard.desiredTotal != null && Number.isFinite(Number(guard.desiredTotal));
      const current = Number.isFinite(Number(guard.desiredCurrent)) ? Number(guard.desiredCurrent) : 0;
      const total = hasDesiredCount ? Number(guard.desiredTotal) : 0;
      // Native emits this standing heading unconditionally in Fortress guard mode. Older payloads
      // do not carry the count, so retain the attested heading without inventing numbers.
      const heading = hasDesiredCount
        ? `Desired metal cages and chains in dungeons: ${current} of ${total}`
        : "Desired metal cages and chains in dungeons";
      const headingHtml = `<div class="justice-guard-summary">${DWFUI.bitmapTextHtml(heading)}</div>`;
      if (guard.unsupported || !members.length)
        return status + headingHtml + `<div class="info-message">${modeDef.empty}</div>`;
      // Guard members now use the same profession-coloured identity row as convicts.
      const selectedUnitId = Number(guard.selectedUnitId);
      const rows = members.map(m => justiceConvictRowHtml(m,
        Number.isFinite(selectedUnitId) && Number(m.unitId) === selectedUnitId)).join("");
      return status + headingHtml +
        justiceConvictSortHtml("name") +
        DWFUI.scrollHtml({ cls: "justice-guard-list", rows: ".justice-convict-row", ariaLabel: "Fortress guard" }, rows);
    }
    if (activeMode === "convicts") {
      const convicts = Array.isArray(data.convicts) ? data.convicts : [];
      if (!convicts.length) return status + `<div class="info-message">${modeDef.empty}</div>`;
      if (!convicts.some(c => Number(c.crimeId) === selectedCase)) selectedCase = Number(convicts[0].crimeId);
      if (!options.mode) justiceSelectedCase = selectedCase;
      const sel = convicts.find(c => Number(c.crimeId) === selectedCase) || convicts[0];
      const sorted = convicts.slice().sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || "")));
      const listHtml = justiceConvictSortHtml("name") +
        `<div class="justice-convict-list" role="listbox" aria-label="Convicts">` +
        sorted.map(c => justiceConvictRowHtml(c, Number(c.crimeId) === selectedCase)).join("") +
        `</div>`;
      const serving = sel.prisonTime > 0 || sel.hammerstrikes > 0;
      const sentence = serving
        ? [sel.prisonTime > 0 ? `${sel.prisonTime} days jail` : "", sel.hammerstrikes > 0 ? `${sel.hammerstrikes} hammerstrikes` : ""].filter(Boolean).join(", ")
        : "No sentence pending.";
      const pardonBtn = serving && Number(sel.unitId) >= 0
        ? `<div class="justice-detail-actions">${DWFUI.plaqueBtnHtml({
            label: "Pardon", tone: "grey", cls: "justice-pardon",
            dataset: { justicePardon: sel.unitId },
            title: "Pardon commutes this convict's serving sentence and clears any pending " +
              "hammerstrikes. Convictions and interrogations are decided natively on the host.",
          })}</div>`
        : "";
      // R3: injured-party join (convicts payload now carries victim/victimId). Omit the line when the
      // crime has no recorded victim (seeded-bad guard: never "Injured party: .").
      const hasVictim = Number(sel.victimId) >= 0 || (sel.victim != null && String(sel.victim).trim() !== "");
      const injuredHtml = hasVictim
        ? `<div class="justice-detail-line justice-detail-indent">${DWFUI.bitmapTextHtml("Injured party:")} ` +
          `<span${fortProfessionColorStyle(sel, "victimProfessionColor")}>` +
          `${Number(sel.victimId) >= 0 ? fortUnitRef(sel.victimId, sel.victim) : DWFUI.bitmapTextHtml(sel.victim)}</span>` +
          `${DWFUI.bitmapTextHtml(".")}</div>`
        : "";
      // Native's detail pane carries NO name heading -- the name is already in the selected row.
      const detailHtml = `<div class="justice-detail-line">${DWFUI.bitmapTextHtml(sentence)}</div>`
        + `<div class="justice-detail-line justice-detail-crime">${DWFUI.bitmapTextHtml(justiceCrimeModeLabel(sel.mode, fortPrettyKey))}</div>`
        + injuredHtml
        + pardonBtn;
      return status + justiceMasterDetailHtml(listHtml, detailHtml);
    }
    if (activeMode === "counterintel") {
      // First-class records: body paragraphs come directly from report.details; the structured
      // result explains the outcome beside them and never replaces or re-derives that body.
      return status + justiceReportsHtml(data, options);
    }
    return status + `<div class="info-message">${modeDef.empty}</div>`;
  }

  // run the native conviction / interrogation drive. Success refreshes the justice data;
  // a 501 {"guarded":true} or any drive abort surfaces the server's own reason verbatim.
  async function justiceDrive(kind, crimeId, unitId) {
    // Defence in depth: only a stale render racing a flag flip reaches here, so refuse locally.
    const state = justiceActionState(justiceHostState, kind);
    if (!state.enabled) { fortSetStatus(state.reason, true); return; }
    const route = kind === "convict" ? "/justice-convict" : "/justice-interrogate";
    fortSetStatus(kind === "convict" ? "Convicting through the host's justice screen…"
                                     : "Updating the interrogation list…", false);
    try {
      const data = await fortFetchJson(
        `${route}?player=${encodeURIComponent(player)}&crime=${crimeId}&unit=${unitId}&t=${Date.now()}`,
        { method: "POST" });
      justiceChooser = null;
      adminData.justice = null;
      await refreshFortAdmin();
      if (kind === "convict") fortSetStatus("Conviction recorded by Dwarf Fortress.", false);
      else {
        const delta = Number(data && data.reportsDelta);
        fortSetStatus(delta > 0 ? "Added to the case's interview queue."
          : delta < 0 ? "Removed from the interview queue; the native toggle also cancels a matching active job."
          : "Interview queue unchanged.", false);
      }
    } catch (err) {
      fortSetStatus(err.message || `${kind} failed.`, true);
    }
  }

  async function justicePardon(unitId) {
    if (!(unitId >= 0)) return;
    try {
      await fortFetchJson(
        `/justice-pardon?player=${encodeURIComponent(player)}&unit=${unitId}&t=${Date.now()}`,
        { method: "POST" });
      adminData.justice = null;
      await refreshFortAdmin();
      fortSetStatus("Sentence commuted.", false);
    } catch (err) {
      fortSetStatus(err.message || "Pardon failed.", true);
    }
  }

  // One tile does both: `GET /unit` returns the camera target and the whole sheet payload in one response.
  // Falls back to openUnitById when the camera global is absent, e.g. in the Node harness.
  async function justiceRecenterUnit(unitId) {
    const id = Number(unitId);
    if (!Number.isInteger(id) || id < 0) return false;
    try {
      const response = await fetch(
        `/unit?player=${encodeURIComponent(player)}&id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unit failed");
      const data = await response.json();
      const pos = data && (data.tile || (data.unit && data.unit.tile));
      if (pos && typeof setCameraToMapPos === "function") {
        await setCameraToMapPos(pos);
        if (typeof flashMapTile === "function") flashMapTile(pos);
      }
      if (typeof showUnitSheet === "function") showUnitSheet(data);
      else if (typeof openUnitById === "function") openUnitById(id);
      return true;
    } catch {
      if (typeof openUnitById === "function") openUnitById(id);
      return false;
    }
  }

  function wireJusticeBody(root) {
    root.querySelectorAll("[data-justice-recenter]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceRecenterUnit(button.dataset.justiceRecenter);
      });
    });
    root.querySelectorAll("[data-justice-pardon]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justicePardon(Number(button.dataset.justicePardon));
      });
    });
    // conviction is a one-way door -> armed two-step click (first click arms, second
    // fires); switching targets or re-rendering disarms. Interrogation is reversible: one click.
    root.querySelectorAll("[data-justice-convict]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const crimeId = Number(button.dataset.justiceConvict);
        const unitId = Number(button.dataset.justiceUnit);
        if (!Number.isInteger(unitId) || unitId < 0) {
          justiceChooser = { kind: "convict", crimeId };
          renderFortAdminPanel();
          return;
        }
        if (button.dataset.armed !== "1") {
          root.querySelectorAll("[data-justice-convict]").forEach(b => { b.dataset.armed = ""; b.classList.remove("armed"); });
          button.dataset.armed = "1";
          button.classList.add("armed");
          fortSetStatus("Click again to confirm the conviction — it is irreversible.", true);
          return;
        }
        button.dataset.armed = "";
        button.classList.remove("armed");
        justiceDrive("convict", crimeId, unitId);
      });
    });
    root.querySelectorAll("[data-justice-interrogate]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const crimeId = Number(button.dataset.justiceInterrogate);
        const unitId = Number(button.dataset.justiceUnit);
        if (!Number.isInteger(unitId) || unitId < 0) {
          justiceChooser = { kind: "interrogate", crimeId };
          renderFortAdminPanel();
          return;
        }
        justiceDrive("interrogate", crimeId, unitId);
      });
    });
    root.querySelectorAll("[data-justice-chooser-cancel]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceChooser = null;
        renderFortAdminPanel();
      });
    });
    root.querySelectorAll("[data-justice-mode]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const mode = button.dataset.justiceMode;
        if (mode === justiceMode) return;
        justiceMode = mode;
        justiceSelectedCase = -1;   // R3: reset master-detail selection when switching sub-tabs
        justiceSelectedReport = -1;
        justiceChooser = null;
        adminData.justice = null;
        infoShellLoadingShell("justice", "Justice");
        refreshFortAdmin();
      });
    });
    root.querySelectorAll("[data-justice-report]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceSelectedReport = Number(button.dataset.justiceReport);
        renderFortAdminPanel();
      });
    });
    // R3: master-detail case selection (open/closed/cold + convicts). No refetch -- data is cached.
    root.querySelectorAll("[data-justice-case]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceSelectedCase = Number(button.dataset.justiceCase);
        justiceChooser = null;
        renderFortAdminPanel();
      });
    });
  }

  function petitionsBody(data) {
    if (!data || data.error) return `<div class="info-message">Petitions unavailable: ${escapeHtml(data && data.error || "")}</div>`;
    const petitions = Array.isArray(data.petitions) ? data.petitions : [];
    if (!petitions.length) return `<div id="fortStatus" class="info-message fort-status"></div><div class="info-message">No pending petitions or agreements.</div>`;
    if (!petitions.some(p => Number(p.id) === Number(petitionSelectedId))) petitionSelectedId = petitions[0].id;
    const selected = petitions.find(p => Number(p.id) === Number(petitionSelectedId)) || petitions[0];
    const rows = petitions.map(p => {
      return DWFUI.rowHtml({ cls: "petition-list-row", dataset: { petitionSelect: p.id },
        selected: Number(p.id) === Number(selected.id),
        label: `Status of ${p.petitioner || "Unknown petitioner"}`,
        trailing: "" });
    }).join("");
    const detail = selected.site && selected.purpose
      ? `<div class="petition-copy"><div class="petition-person">${escapeHtml(selected.petitioner)}</div><div>wishes to reside in</div><div class="petition-site">${escapeHtml(selected.site)}</div><div>for the purpose of</div><div class="petition-purpose">${escapeHtml(selected.purpose)}</div></div>`
      : `<div class="petition-copy"><div class="petition-person">${escapeHtml(selected.petitioner || "Unknown petitioner")}</div><div class="petition-wire-gap">${escapeHtml(fortPrettyKey(selected.summary || "Petition details unavailable"))}</div></div>`;
    const selectedActions = selected.pending
      ? `<div class="petition-question">This petition must be decided by the host</div><div class="dwfui-text--note petition-hint">Approving or denying isn't available in the browser — a plugin write can’t grant residency or record the decision, so it would only hide the row without resolving it. The host can decide it in the Steam client (the petition notification / Agreements screen). You can still set the auto-response for future petitions of this kind below.</div>`
      : `<span class="fort-badge fort-badge-done">${DWFUI.bitmapTextHtml("Accepted")}</span>`;
    const future = DWFUI.plaqueBtnHtml({
      label: `Future such petitions: ${selected.futurePolicy || "unavailable"}`,
      tone: "grey", cls: "petition-future", dataset: { petitionFuture: selected.id },
      disabled: !selected.futurePolicy,
    });
    return `<div id="fortStatus" class="info-message fort-status"></div><div class="petition-box"><div class="petition-list">${rows}</div><div class="petition-detail">${detail}${selectedActions}${future}<div class="dwfui-text--note petition-hint">This can also be changed in<br>Labor -&gt; Standing orders -&gt; Petitions.</div></div></div>`;
  }

  function petitionsWindowHtml(data) {
    return DWFUI.windowHtml({
      ariaLabel: "Petitions",
      bodyHtml:
        `<div class="info-header"><div class="info-title">${escapeHtml("Petitions")}</div>` +
        `${fortCloseBtnHtml()}</div>` +
        `<div class="info-body fort-body">${petitionsBody(data)}</div>`,
    });
  }

  function renderFortAdminPanel() {
    const data = adminData[adminTab];
    if (adminTab === "nobles") {
      activeInfoPanel = "nobles";
      renderInfoShellWindow("nobles", noblesBody(data), { onRender: () => wireNoblesBody(clientPanel) });
      return;
    }
    if (adminTab === "justice") {
      activeInfoPanel = "justice";
      renderInfoShellWindow("justice", justiceBody(data), {
        subTabsHtml: justiceSubTabsHtml(),
        onRender: () => wireJusticeBody(clientPanel),
      });
      return;
    }
    clientPanel.className = "visible info-panel fort-window";
    panelContent(clientPanel).innerHTML = petitionsWindowHtml(data);
    clientPanel.querySelector("[data-fort-close]")?.addEventListener("click", closeClientPanel);
    fortBindUnitLinks(clientPanel);
    clientPanel.querySelectorAll("[data-petition-select]").forEach(row =>
      row.addEventListener("click", () => { petitionSelectedId = Number(row.dataset.petitionSelect); renderFortAdminPanel(); }));
    // fail-closed: no [data-petition-accept]/[data-petition-deny] any more -- per-petition
    // approve/deny is host-only (Steam client). Only select + the standing-order policy remain.
    clientPanel.querySelectorAll("[data-petition-future]").forEach(b =>
      b.addEventListener("click", () => petitionPolicyCycle(b.dataset.petitionFuture)));
  }

  const PETITION_POLICY_CYCLE = ["prompt", "accept", "reject"];

  async function petitionPolicyCycle(id) {
    const current = adminData.petitions && Array.isArray(adminData.petitions.petitions)
      ? (adminData.petitions.petitions.find(p => Number(p.id) === Number(id)) || {}).futurePolicy
      : "";
    const idx = PETITION_POLICY_CYCLE.indexOf(current);
    if (idx < 0) { fortSetStatus("Petition policy unavailable for this petition.", true); return; }
    const next = (idx + 1) % PETITION_POLICY_CYCLE.length;
    try {
      await fortFetchJson(`/petition-policy?player=${encodeURIComponent(player)}&id=${encodeURIComponent(id)}&value=${next}&t=${Date.now()}`, { method: "POST" });
      adminData.petitions = null;
      await refreshFortAdmin();
      fortSetStatus(`Future such petitions: ${PETITION_POLICY_CYCLE[next]}.`, false);
    } catch (err) {
      fortSetStatus(err.message || "Policy change failed.", true);
    }
  }

  // fail-closed: petitionPolicyCycle() below (the standing-orders auto-response) is the ONLY
  // petition write this client may make. Approve/deny is host-only -- see the petitions body above.

  // Node export for the offline CIM fixture tests (harmless in the browser: `module` is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { justiceCrimeModeLabel, justiceCaseDetailLines, justiceSubTabsHtml, justiceBody, noblesBody,
      petitionsBody, petitionsWindowHtml,
      justiceConvictRowHtml, justiceRecenterUnit, justiceCaseActionsHtml, justiceSuspectChooserHtml,
      justiceActionState, justiceCaseParties, justiceInterviewAnnotation, justiceWitnessClaim,
      justiceWitnessesHtml, justiceHeadlineAxis, justiceReportBreakdownRows, justiceReportDetailHtml,
      justiceReportsHtml, justiceIntelTabsHtml, JUSTICE_GUARD_COPY,
      JUSTICE_MODES, JUSTICE_INTEL_MODES, nobleRoomIconStates, nobleMandateIcons, noblePrecisionActiveButton, NOBLE_ROOM_KINDS,
      nobleRoomSpriteState, nobleRoomSprite, nobleRoomIconHtml, nobleMandateIconHtml, noblePrecisionHtml,
      nobleCandidateListHtml, nobleCandidatesModeHtml,
      // Ledger 0082 (Stage 6): the four-state seat law and counter-intelligence's two empty states.
      nobleSeatState, NOBLE_SEAT_YELLOW_BRIGHT, NOBLE_SEAT_WHITE,
      counterintelEmptyState, COUNTERINTEL_EMPTY_COPY, COUNTERINTEL_STANDING_LINE };
  }
