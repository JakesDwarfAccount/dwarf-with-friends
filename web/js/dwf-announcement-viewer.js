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

  function notificationsPanelIsOpen() {
    return activeInfoPanel === "alerts" &&
      clientPanel.classList.contains("visible") &&
      clientPanel.classList.contains("alertbox-panel");
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
  function alertTypeForKey(typeKey) {
    const key = String(typeKey || "").toUpperCase();
    const name = key === "MIGRANT" ? "MIGRANTS" :
      (key === "LOSE_EMOTION" ? "EMOTION" : key.replace(/_/g, " "));
    return ALERT_NAMES.findIndex(candidate => candidate.toUpperCase() === name);
  }
  // The wire's `typeKey` IS the variant name graphics_announcements.txt binds the icon under
  // (src/notifications.cpp emits the enum key), so the name alone addresses the art.
  function alertIconToken(alert) {
    return `ANNOUNCEMENT_ALERT:${alert?.typeKey || ""}`;
  }
  // A report ships { color: 0..7, bright }, and the native curses index is fg + bright*8. This is the
  // ONLY report-to-colour path; no local 16-colour table lives here.
  function dfTextColor(report) {
    const fg = Math.max(0, Math.min(7, Number(report?.color) || 0));
    return DWFUI.dfColor(fg + (report?.bright ? 8 : 0));
  }
  // `options.repeat === false` asks for the message alone. The one-line surfaces keep the " xN"
  // suffix; the announcements log passes repeat:false and prints the count as a chip instead.
  function reportText(report, options) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.reportText(report, options);
    if (!report || !report.text) return "";
    const bare = options && options.repeat === false;
    const suffix = !bare && Number(report.repeatCount) > 0 ? ` x${Number(report.repeatCount) + 1}` : "";
    return `${report.text}${suffix}`;
  }

  function normalizeCombatReportEntries(items) {
    return (Array.isArray(items) ? items : []).flatMap(item => {
      const wrapped = item && typeof item === "object" && item.report && typeof item.report === "object";
      const report = wrapped ? item.report : item;
      if (!report || typeof report !== "object") return [];
      const target = DwfAnnouncementFormat.zoomTarget(report);
      return [{
        ...report,
        id: report.id == null ? -1 : report.id,
        leadId: report.id == null ? -1 : report.id,
        repeatCount: Math.max(0, Number(report.repeatCount) || 0),
        pos: target,
        pos2: null,
        zoomType: target ? 0 : -1,
        zoomType2: -1,
        hasPos: !!target,
        hasPos2: false,
        logKey: wrapped ? (item.logKey || null) : (report.logKey || null),
        logType: wrapped && item.logType != null ? item.logType :
          (report.logType != null ? report.logType : -1),
      }];
    });
  }

  function combatReportGroups(items) {
    return DwfAnnouncementFormat.groupReports(normalizeCombatReportEntries(items));
  }

  function combatReportKey(report) {
    const id = Number(report?.leadId);
    if (Number.isFinite(id) && id >= 0) return `id:${id}`;
    return `orphan:${report?.year || 0}:${report?.time || 0}:${report?.text || ""}`;
  }

  function mergeCombatReportGroups(current, incoming, cap = REP_LOG_CAP) {
    const merged = [];
    const seen = new Set();
    for (const report of [...(Array.isArray(current) ? current : []),
      ...(Array.isArray(incoming) ? incoming : [])]) {
      const key = combatReportKey(report);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(report);
    }
    const limit = Math.max(0, Number(cap) || 0);
    return limit && merged.length > limit ? merged.slice(merged.length - limit) : merged;
  }

  function mergeOlderCombatReportGroups(current, older, cap = REP_LOG_CAP) {
    return mergeCombatReportGroups(older, current, cap);
  }

  async function unitReports(unitId, options = {}) {
    const transport = options.transport || DwfReportTransport;
    const pageSize = Math.max(1, Math.min(REP_PAGE, Number(options.pageSize) || REP_PAGE));
    const cap = Math.max(1, Number(options.cap) || REP_LOG_CAP);
    const log = options.log == null ? "all" : options.log;
    let since = Number.isFinite(Number(options.since)) ? Number(options.since) : -1;
    let groups = [];
    let unitFound;
    let truncated = false;
    let nextReportId = since;
    for (;;) {
      const page = await transport.unitReportsPage(unitId,
        { log, since, max: pageSize });
      unitFound = page?.unitFound !== false;
      nextReportId = Number.isFinite(Number(page?.nextReportId))
        ? Number(page.nextReportId) : nextReportId;
      if (!unitFound) return { unitId, unitFound: false, groups: [], sinceId: since,
        nextReportId, truncated: false };
      const pageEntries = Array.isArray(page?.entries) ? page.entries : [];
      const fresh = combatReportGroups(pageEntries);
      const merged = mergeCombatReportGroups(groups, fresh, 0);
      if (merged.length > cap) truncated = true;
      groups = merged.length > cap ? merged.slice(merged.length - cap) : merged;
      const ids = fresh.map(report => Number(report.leadId)).filter(Number.isFinite);
      let nextSince = ids.length ? Math.max(since, ...ids) : since;
      if (!page?.truncated && nextReportId >= 0) nextSince = Math.max(nextSince, nextReportId - 1);
      if (!page?.truncated || nextSince <= since) {
        since = nextSince;
        break;
      }
      since = nextSince;
    }
    return { unitId, unitFound, groups, sinceId: since, nextReportId, truncated };
  }
  function alertDisplayLines(alert) {
    // The combat-family hover is the ordered report-unit list, not the blow-by-blow stream; the
    // coloured strikes appear only after selecting a fighter.
    if (typeof DwfAnnouncementFormat !== "undefined" &&
        DwfAnnouncementFormat.isCombatAlert(alert?.type)) {
      return DwfAnnouncementFormat.combatUnitRows(alert).map(row => ({
        text: row.label,
        // A composed (non-report) combat row has no served colour yet, so it deliberately inherits;
        // df::report lines below do carry colour and use the live palette.
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
      // `cache: "no-cache"`, never "no-store" and never a `&t=` buster: the browser must revalidate on
      // every poll, but it must also be able to send If-None-Match and reuse the body on a 304.
      const response = await fetch(`/notifications?player=${encodeURIComponent(player)}`, { cache: "no-cache" });
      if (!response.ok) throw new Error("notifications failed");
      notificationState = await response.json();
      renderAlertStack();
      if (notificationsPanelIsOpen())
        renderAlertBox({ skipIfSame: true });
      void followActiveCombatDrilldowns();
    } catch {}
  }
  let pinnedAlertDrilldownKey = null;
  let panelAlertDrilldownKey = null;
  let standaloneCombatAlert = null;
  const combatDrilldowns = new Map();
  const COMBAT_DRILLDOWN_CACHE_CAP = 8;

  function touchCombatDrilldown(state) {
    combatDrilldowns.delete(state.key);
    combatDrilldowns.set(state.key, state);
    while (combatDrilldowns.size > COMBAT_DRILLDOWN_CACHE_CAP)
      combatDrilldowns.delete(combatDrilldowns.keys().next().value);
    return state;
  }

  function releaseCombatDrilldown(key) {
    if (key && key !== pinnedAlertDrilldownKey && key !== panelAlertDrilldownKey)
      combatDrilldowns.delete(key);
  }

  function closePinnedCombatDrilldown() {
    const key = pinnedAlertDrilldownKey;
    pinnedAlertDrilldownKey = null;
    releaseCombatDrilldown(key);
  }

  function closePanelCombatDrilldown() {
    const key = panelAlertDrilldownKey;
    panelAlertDrilldownKey = null;
    releaseCombatDrilldown(key);
  }

  function selectPinnedCombatDrilldown(key) {
    closePinnedCombatDrilldown();
    pinnedAlertDrilldownKey = key || null;
  }

  function selectPanelCombatDrilldown(key) {
    closePanelCombatDrilldown();
    panelAlertDrilldownKey = key || null;
  }

  function combatDrilldownState(ref) {
    if (!ref) return null;
    const key = `${ref.unitId}:${ref.category}`;
    let state = combatDrilldowns.get(key);
    if (!state) {
      state = {
        key,
        unitId: ref.unitId,
        log: ref.category == null ? "all" : ref.category,
        groups: combatReportGroups(ref.reports),
        sinceId: -1,
        unitFound: true,
        loaded: false,
        loading: false,
      };
    }
    return touchCombatDrilldown(state);
  }

  function repaintCombatDrilldown(key) {
    const alerts = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
    if (pinnedAlertDrilldownKey === key && (pinnedAlertKey || standaloneCombatAlert)) {
      const alert = standaloneCombatAlert || alerts.find(item => item.dismissKey === pinnedAlertKey);
      if (alert) showAlertPopup(alert);
    }
    if (panelAlertDrilldownKey === key && notificationsPanelIsOpen()) renderAlertBox();
  }

  async function loadCombatDrilldown(ref) {
    const state = combatDrilldownState(ref);
    if (!state || state.loading) return state;
    state.loading = true;
    try {
      const page = await unitReports(state.unitId, {
        log: state.log,
        since: state.loaded ? state.sinceId : -1,
      });
      if (page.unitFound || state.groups.length) {
        state.groups = state.loaded
          ? mergeCombatReportGroups(state.groups, page.groups)
          : page.groups;
        state.unitFound = true;
      } else {
        state.groups = [];
        state.unitFound = false;
      }
      state.sinceId = page.sinceId;
      state.loaded = true;
      repaintCombatDrilldown(state.key);
    } catch (err) {
      DwfErr.report("announcements.combat-drilldown", err);
    } finally {
      state.loading = false;
    }
    return state;
  }

  function followActiveCombatDrilldowns() {
    const pinnedOpen = !!pinnedAlertDrilldownKey && !!(pinnedAlertKey || standaloneCombatAlert) &&
      alertPopup.classList.contains("native-alert-viewer");
    const panelOpen = !!panelAlertDrilldownKey && notificationsPanelIsOpen();
    if (pinnedAlertDrilldownKey && !pinnedOpen) closePinnedCombatDrilldown();
    if (panelAlertDrilldownKey && !panelOpen) closePanelCombatDrilldown();
    const keys = new Set([
      pinnedOpen ? pinnedAlertDrilldownKey : null,
      panelOpen ? panelAlertDrilldownKey : null,
    ].filter(Boolean));
    for (const key of keys) {
      const state = combatDrilldowns.get(key);
      if (state) void loadCombatDrilldown({ unitId: state.unitId, category: state.log });
    }
  }
  function alertStackMarkup(alerts, pinnedKey = null) {
    return (Array.isArray(alerts) ? alerts : []).map(alert => {
      const pinned = pinnedKey === alert.dismissKey;
      const name = alertName(alert);
      return DWFUI.artBtnHtml({
        sprite: alertIconToken(alert),
        cls: `alert-button${pinned ? " pinned" : ""}`,
        active: pinned,
        dataset: { alertKey: alert.dismissKey || "" },
        ariaLabel: name,
        title: name,
      });
    }).join("");
  }
  function renderAlertStack() {
    const alerts = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
    const markup = alertStackMarkup(alerts, pinnedAlertKey);
    const changed = alertStack.__dwfStackMarkup !== markup;
    if (changed) {
      alertStack.innerHTML = markup;
      alertStack.__dwfStackMarkup = markup;
      DWFUI.paintSprites(alertStack);
    }
    alertStack.classList.toggle("alert-stack-empty", !alerts.length);
    if (changed) alertStack.querySelectorAll(".alert-button").forEach(button => {
      const liveAlert = () => {
        const live = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
        return live.find(a => a.dismissKey === button.dataset.alertKey);
      };
      if (!liveAlert()) return;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const current = liveAlert();
        if (!current) return;
        standaloneCombatAlert = null;
        pinnedAlertKey = current.dismissKey || null;
        closePinnedCombatDrilldown();
        showAlertPopup(current);
        renderAlertStack();
      });
      // The badge's context-menu gesture must send every key the alert owns, or its "right-click to
      // dismiss" instruction is not truthful.
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        const current = liveAlert();
        if (current) void dismissAlert(current);
      });
    });
    if (pinnedAlertKey && !alerts.some(a => a.dismissKey === pinnedAlertKey))
      pinnedAlertKey = null;
    const retainedAlert = pinnedAlertKey && alerts.find(a => a.dismissKey === pinnedAlertKey);
    const retainedButton = retainedAlert && Array.from(alertStack.querySelectorAll(".alert-button"))
      .find(button => button.dataset.alertKey === retainedAlert.dismissKey);
    if (retainedAlert && retainedButton)
      showAlertPopup(retainedAlert);
    else if (!pinnedAlertKey && !standaloneCombatAlert)
      hideAlertPopup();
  }
  // This card is UNCAPPED: never reintroduce a line cap or a "+N earlier reports" row -- both are
  // inventions. Only the PINNED viewer scrolls; `#alertPopup:not(.pinned)` is overflow-y:hidden.
  function alertPopupParts(alert) {
    const lines = alertDisplayLines(alert);
    const rows = lines.length
      ? lines.map(line => DWFUI.rowHtml({
          cls: "alert-popup-row",
          announce: true,
          labelHtml: DWFUI.rawHtml(
            "A transient announcement row keeps the decoded report color supplied by the shared formatter.",
            `<span class="alert-line${line.unit ? " alert-unit-line" : ""}"` +
              `${line.color ? ` style="color:${line.color}"` : ""}>${DWFUI.esc(line.text)}</span>`),
        })).join("")
      : DWFUI.rowHtml({
          cls: "alert-popup-row",
          announce: true,
          label: alertName(alert),
          labelCls: "alert-line alert-unit-line",
        });
    return {
      html: DWFUI.windowHtml({
        cls: "alert-popup-window",
        ariaLabel: "Announcement preview",
        bodyHtml:
          `<div class="alert-help">Left click for recenter and expand options. Right click to dismiss.</div>` +
          `<div class="alert-popup-rows">${rows}</div>`,
      }),
      lines,
    };
  }
  function alertPopupMarkup(alert) {
    return alertPopupParts(alert).html;
  }

  // ---- the large pinned alert viewer, reached by activating an alert-group button ---------------
  function alertViewerPosition(report, which) {
    const pos = which === 2 ? report?.pos2 : report?.pos;
    return pos && Number(pos.x) !== -30000 ? pos : null;
  }

  function alertViewerReportRows(reports) {
    const grouped = typeof DwfAnnouncementFormat !== "undefined"
      ? DwfAnnouncementFormat.groupReports(reports)
      : (Array.isArray(reports) ? reports : []);
    return grouped.map(report => ({ kind: "report", report }));
  }

  function alertViewerUnitColor(ref, alert) {
    const category = Number(ref?.category);
    const key = String(ref?.categoryKey || alert?.typeKey || "").toLowerCase();
    if (category === 1 || key === "sparring") return 11; // bright cyan
    if (category === 2 || key === "hunting") return 10;  // bright green
    return 12;                                           // bright red
  }

  function alertViewerUnitLabel(ref, alert) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.fightingLabel(
        ref?.unitName || "",
        ref?.categoryKey || alert?.typeKey || "Combat"
      );
    return String(ref?.unitName || "");
  }

  function alertViewerUnitRef(alert, key) {
    if (!key) return null;
    const ref = (Array.isArray(alert?.unitReports) ? alert.unitReports : []).find(ref =>
      `${ref?.unitId}:${ref?.category}` === key
    ) || null;
    const state = ref && combatDrilldowns.get(key);
    return state ? { ...ref, reports: state.groups, unitFound: state.unitFound } : ref;
  }

  function alertViewerRows(alert, drilldown = null) {
    if (drilldown?.unitFound === false)
      return [{ kind: "empty", text: "Unit not found (it may have left the fort)." }];
    if (drilldown) return alertViewerReportRows(drilldown.reports);
    const combatFamily = typeof DwfAnnouncementFormat !== "undefined"
      ? DwfAnnouncementFormat.isCombatAlert(alert?.type)
      : [34, 35, 36].includes(Number(alert?.type));
    if (combatFamily && Array.isArray(alert?.unitReports) && alert.unitReports.length)
      return alert.unitReports.map(ref => ({ kind: "unit", ref }));
    return alertViewerReportRows(alert?.reports);
  }

  function alertViewerRecenterButton(report, which) {
    const pos = alertViewerPosition(report, which);
    if (!pos) return "";
    return DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.recenter,
      cls: "alert-viewer-recenter",
      dataset: { alertViewerCenter: report.id, alertViewerLink: which },
      title: "Recenter",
      ariaLabel: "Recenter",
    });
  }

  function alertViewerMarkup(alert, drilldown = null) {
    const rows = alertViewerRows(alert, drilldown);
    const unitList = !drilldown && rows.some(row => row.kind === "unit");
    const instruction = unitList
      ? "Select a report to view the full text.&nbsp; Right click to close."
      : "You can recenter on certain announcements.&nbsp; Right click to close.";
    const rowHtml = rows.map(row => {
      if (row.kind === "empty") {
        return DWFUI.rowHtml({
          cls: "alert-viewer-row",
          announce: true,
          labelHtml: DWFUI.rawHtml(
            "The combat-report route can identify a unit that no longer exists.",
            DWFUI.statusHtml({ cls: "alert-line", text: row.text, columns: 80, dfColor: 15 })),
        });
      }
      if (row.kind === "unit") {
        const key = `${row.ref?.unitId}:${row.ref?.category}`;
        const label = DWFUI.statusHtml({
            cls: "alert-line",
            text: alertViewerUnitLabel(row.ref, alert),
            columns: 80,
            dfColor: alertViewerUnitColor(row.ref, alert),
          });
        const narration = DWFUI.artBtnHtml({
          cls: "alert-viewer-narration-action",
          dataset: { alertViewerUnit: key },
          title: "View this fighter's reports",
          ariaLabel: "View this fighter's reports",
          glyphHtml: label,
        });
        const sheet = DWFUI.actionButtonsHtml([{
          action: "view",
          sprite: DWFUI.TOKENS.sprites.view,
          dataset: { alertViewerSheet: row.ref?.unitId },
          title: "View this fighter's unit sheet",
        }], { cls: "alert-viewer-actions dwfui-announce-actions", ariaLabel: "Fighter actions" });
        return DWFUI.rowHtml({
          cls: "alert-viewer-row alert-viewer-unit",
          announce: true,
          labelHtml: DWFUI.rawHtml(
            "The native combat-report picker uses a separate text-track action beside its unit-sheet tile.",
            narration),
          trailing: sheet,
        });
      }
      const report = row.report;
      const actions = alertViewerRecenterButton(report, 1) +
        alertViewerRecenterButton(report, 2);
      // Through the SAME row grammar as the unit rows above; a raw <div> here is how formatting drifts.
      return DWFUI.rowHtml({
        cls: "alert-viewer-row",
        announce: true,
        announceLine: !drilldown,
        dataset: { alertViewerReport: report?.id },
        labelHtml: DWFUI.rawHtml(
          "A decoded announcement report line keeps its native bitmap color.",
          DWFUI.statusHtml({
            cls: `alert-line${drilldown ? " alert-viewer-narration" : ""}`,
            text: drilldown ? reportText(report) : String(report?.text || ""),
            columns: 80,
            dfColor: Math.max(0, Math.min(7, Number(report?.color) || 0)) +
              (report?.bright ? 8 : 0),
          })),
        trailing: `<span class="alert-viewer-actions dwfui-announce-actions">${actions}</span>`,
      });
    }).join("");
    const openAll = DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.openAnnouncements,
      cls: "alert-viewer-open-all",
      dataset: { alertOpenAll: "" },
      title: "Open all announcements",
      ariaLabel: "Open all announcements",
    });
    return DWFUI.windowHtml({
      cls: "alert-viewer-window",
      ariaLabel: "Announcement alert",
      bodyHtml:
        `<div class="alert-viewer-instruction">${instruction}</div>` +
        `<div class="alert-viewer-open-all-host">${openAll}</div>` +
        DWFUI.listHtml({
          cls: "alert-viewer-rows",
          hostCls: "alert-viewer-list",
          rows: ".alert-viewer-row",
          unit: "rows",
          pageRows: 29,
          key: "alert-viewer",
          ariaLabel: "Alert announcements",
        }, rowHtml),
    });
  }

  function bindAlertViewerUnitActions(root, onNarration, onUnitSheet) {
    root.querySelectorAll("[data-alert-viewer-unit]").forEach(button => {
      button.addEventListener("click", () => onNarration(button.dataset.alertViewerUnit));
    });
    root.querySelectorAll("[data-alert-viewer-sheet]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        const unitId = Number(button.dataset.alertViewerSheet);
        if (!Number.isInteger(unitId) || unitId < 0) return;
        if (onUnitSheet) onUnitSheet(unitId);
        else if (typeof window.openUnitById === "function") window.openUnitById(unitId);
      });
    });
  }

  // Replacing the scroll host resets scrollTop and any focused row, so compare both the rendered
  // answer and the current DOM before replacing it.
  function updatePinnedAlertPopupMarkup(host, markup) {
    if (host.__dwfPinnedAlertMarkup === markup && host.innerHTML === markup)
      return false;
    host.innerHTML = markup;
    host.__dwfPinnedAlertMarkup = markup;
    return true;
  }

  // UI-DIV-004: the pinned alert viewer is movable and remembered, with zero added chrome -- hence
  // `chromeless: true`. `variantKey` keeps its rect separate from the transient hover card's.
  let alertPopupPanelRegistered = false;
  function registerAlertPopupPanel() {
    if (alertPopupPanelRegistered || !alertPopup) return;
    if (!window.DFPanelFrame || typeof window.DFPanelFrame.register !== "function") return;
    alertPopupPanelRegistered = true;
    window.DFPanelFrame.register({
      key: "alertPopup", el: () => alertPopup, title: "Alerts",
      movable: true, chromeless: true, closable: false, menu: false, zBand: false,
      escClosable: false, persistOpen: false,
      variantKey: () => "alertPopup.viewer",
      // Only the decoded viewer is live; the predicate stops fixture markup writing a geometry record.
      persistGeometry: el => el.classList.contains("native-alert-viewer"),
      isOpen: () => alertPopup.classList.contains("native-alert-viewer"),
    });
  }

  function showAlertPopup(alert) {
    registerAlertPopupPanel();
    const drilldown = alertViewerUnitRef(alert, pinnedAlertDrilldownKey);
    const lines = alertViewerRows(alert, drilldown);
    const replaced = updatePinnedAlertPopupMarkup(alertPopup, alertViewerMarkup(alert, drilldown));
    alertPopup.classList.add("pinned", "native-alert-viewer");
    alertPopup.style.left = "";
    alertPopup.style.top = "";
    // Dropping the inline offsets hands the panel back to the framework, which re-applies the
    // player's remembered rect for this variant or leaves the CSS dock alone.
    try { window.DFPanelFrame?.syncOpenState("alertPopup", true); } catch {}
    alertPopup.oncontextmenu = event => {
      event.preventDefault();
      event.stopPropagation();
      if (pinnedAlertDrilldownKey) {
        closePinnedCombatDrilldown();
        showAlertPopup(alert);
        return;
      }
      pinnedAlertKey = null;
      hideAlertPopup();
      renderAlertStack();
    };
    // Only bind after a real markup replacement, or an unchanged poll stacks duplicate listeners.
    if (!replaced) return;
    alertPopup.querySelector("[data-alert-open-all]")?.addEventListener("click", () => {
      const seed = Array.isArray(alert?.reportIds) && alert.reportIds.length
        ? alert.reportIds[0]
        : (Array.isArray(alert?.reports) && alert.reports.length ? alert.reports[0].id : null);
      pinnedAlertKey = null;
      closePinnedCombatDrilldown();
      hideAlertPopup();
      window.openReportsPanel(seed, alert?.type);
    });
    bindAlertViewerUnitActions(alertPopup, key => {
      selectPinnedCombatDrilldown(key);
      const ref = alertViewerUnitRef(alert, pinnedAlertDrilldownKey);
      showAlertPopup(alert);
      if (ref) void loadCombatDrilldown(ref);
    });
    alertPopup.querySelectorAll("[data-alert-viewer-center]").forEach(button => {
      button.addEventListener("click", async () => {
        const report = lines.map(line => line.report)
          .find(item => item && String(item.id) === button.dataset.alertViewerCenter);
        const pos = alertViewerPosition(report, Number(button.dataset.alertViewerLink));
        if (!pos) return;
        const { setCameraToMapPos, flashMapTile, focusPage } = window;
        await setCameraToMapPos(pos);
        await flashMapTile(pos);
        focusPage();
      });
    });
  }

  function unitCombatHistoryModel(unit) {
    const unitId = Number(unit?.unitId);
    if (!Number.isInteger(unitId) || unitId < 0) return null;
    const ref = {
      unitId,
      unitName: String(unit?.unitName || ""),
      category: null,
      categoryKey: "combat",
      reports: [],
    };
    return { ref, alert: { type: 34, typeKey: "COMBAT", reports: [], unitReports: [ref] } };
  }

  function openUnitCombatHistory(unit) {
    const model = unitCombatHistoryModel(unit);
    if (!model) return;
    const { ref, alert } = model;
    standaloneCombatAlert = alert;
    pinnedAlertKey = null;
    const state = combatDrilldownState(ref);
    selectPinnedCombatDrilldown(state.key);
    showAlertPopup(standaloneCombatAlert);
    void loadCombatDrilldown(ref);
  }

  function hideAlertPopup() {
    closePinnedCombatDrilldown();
    standaloneCombatAlert = null;
    try { window.DFPanelFrame?.syncOpenState("alertPopup", false); } catch {}
    alertPopup.oncontextmenu = null;
    alertPopup.classList.remove("native-alert-viewer");
  }
  function closePinnedAlertViewer() {
    pinnedAlertKey = null;
    closePinnedCombatDrilldown();
    hideAlertPopup();
    renderAlertStack();
  }
  async function dismissAlert(alert) {
    const keys = Array.isArray(alert?.dismissKeys) ? alert.dismissKeys.filter(Boolean) : [];
    if (!keys.length && alert?.dismissKey) keys.push(alert.dismissKey);
    if (!keys.length) return;
    await dismissAlertKeys(keys, alert);
  }
  async function dismissAlertKeys(keys, alert = null) {
    try {
      await fetch(`/notification-action?player=${encodeURIComponent(player)}&action=dismiss&keys=${encodeURIComponent(keys.join(","))}`,
        { method: "POST", cache: "no-store" });
    } catch {}
    // Always drop the popup for the alert just dismissed: re-rendering the stack removes the hovered
    // button, so no mouseleave ever fires and the popup would stay stuck on screen.
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
  // The toolbar route presents the newest active group through the same viewer as an alert-stack click.
  function alertBoxMarkup(sourceState, drilldownKey = null) {
    const alerts = Array.isArray(sourceState?.alerts) ? sourceState.alerts : [];
    const alert = alerts[0] || { type: 0, reports: [], unitReports: [], reportIds: [] };
    return alertViewerMarkup(alert, alertViewerUnitRef(alert, drilldownKey));
  }

  function bindPanelAlertViewer(alert) {
    const drilldown = alertViewerUnitRef(alert, panelAlertDrilldownKey);
    const lines = alertViewerRows(alert, drilldown);
    const viewer = clientPanel.querySelector(".alert-viewer-window");
    viewer?.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      if (panelAlertDrilldownKey) {
        closePanelCombatDrilldown();
        renderAlertBox();
      } else {
        closeClientPanel();
      }
    });
    clientPanel.querySelector("[data-alert-open-all]")?.addEventListener("click", () => {
      const seed = Array.isArray(alert?.reportIds) && alert.reportIds.length
        ? alert.reportIds[0]
        : (Array.isArray(alert?.reports) && alert.reports.length ? alert.reports[0].id : null);
      closePanelCombatDrilldown();
      window.openReportsPanel(seed, alert?.type);
    });
    bindAlertViewerUnitActions(clientPanel, key => {
        selectPanelCombatDrilldown(key);
        const ref = alertViewerUnitRef(alert, panelAlertDrilldownKey);
        renderAlertBox();
        if (ref) void loadCombatDrilldown(ref);
    });
    clientPanel.querySelectorAll("[data-alert-viewer-center]").forEach(button => {
      button.addEventListener("click", async () => {
        const report = lines.map(line => line.report)
          .find(item => item && String(item.id) === button.dataset.alertViewerCenter);
        const pos = alertViewerPosition(report, Number(button.dataset.alertViewerLink));
        if (!pos) return;
        const { setCameraToMapPos, flashMapTile, focusPage } = window;
        await setCameraToMapPos(pos);
        await flashMapTile(pos);
        focusPage();
      });
    });
  }

  function renderAlertBox(options = {}) {
    activeInfoPanel = "alerts";
    const signature = notificationPanelSignature();
    if (options.skipIfSame && signature === lastNotificationPanelSignature) return;
    const alerts = Array.isArray(notificationState?.alerts) ? notificationState.alerts : [];
    const alert = alerts[0] || { type: 0, reports: [], unitReports: [], reportIds: [] };
    clientPanel.className = "visible alertbox-panel";
    panelContent(clientPanel).innerHTML = alertBoxMarkup(notificationState, panelAlertDrilldownKey);
    bindPanelAlertViewer(alert);
    lastNotificationPanelSignature = signature;
  }
  async function openNotificationsPanel() {
    setActiveToolbar("alerts");
    clearBuildPlacement(false);
    activeInfoPanel = "alerts";
    closePanelCombatDrilldown();
    // notificationState is already fresh, so render now; the await re-renders when the fetch lands.
    renderAlertBox();
    await loadNotifications();
  }


if (typeof window !== "undefined") {
  window.DFAnnouncementMarkup = {
    alertBoxMarkup, alertViewerMarkup, alertViewerRows, alertStackMarkup, alertPopupMarkup,
    alertTypeForKey, closePinnedAlertViewer, closePanelCombatDrilldown, openUnitCombatHistory,
    bindAlertViewerUnitActions, unitReports, combatReportGroups,
    mergeCombatReportGroups, mergeOlderCombatReportGroups
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    alertBoxMarkup,
    alertViewerMarkup,
    alertViewerRows,
    alertStackMarkup,
    alertPopupMarkup,
    alertTypeForKey,
    bindAlertViewerUnitActions,
    openUnitCombatHistory,
    unitCombatHistoryModel,
    closePinnedAlertViewer,
    updatePinnedAlertPopupMarkup,
    dfTextColor,
    reportText,
    unitReports,
    normalizeCombatReportEntries,
    combatReportGroups,
    mergeCombatReportGroups,
    mergeOlderCombatReportGroups,
    combatDrilldownState,
    releaseCombatDrilldown,
    selectPanelCombatDrilldown,
    followActiveCombatDrilldowns,
    combatDrilldownCacheKeys: () => Array.from(combatDrilldowns.keys()),
  };
}
