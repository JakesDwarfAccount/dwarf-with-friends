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

  // ===========================================================================================
  // B232 -- THE FULL ANNOUNCEMENTS / REPORTS SCREEN.
  //
  // What this is, and what it is not. The alert stack + the ticker + the box popup
  // (dwf-unit-hud-notifications.js, dwf-popup.js) are the LIVE surfaces: they tell you
  // what is happening NOW and they are dismissable. THIS is the HISTORY: every report DF has ever
  // filed for this fort, filtered, paged, and centre-able. Per-player dismissal (B197) applies to
  // the live alerts; it does NOT apply here -- a dismissed alert is still a thing that happened, and
  // the log shows history regardless.
  //
  // THREE THINGS CHANGED HERE, AND EACH FIXES A REAL DEFECT:
  //
  // 1. SECTIONS ARE REAL NOW. B160 shipped `typeKey === "SIEGE"` and `typeKey === "ARTIFACT_CREATED"`.
  //    NEITHER TOKEN EXISTS. Checked against BOTH DF's own raws (data/init/announcements.txt, 352
  //    tokens) and df::announcement_type (356 entries): there is no SIEGE and no ARTIFACT_CREATED,
  //    and df::announcement_alert_type has no SIEGE either. So those two sections matched exactly
  //    zero reports and always rendered empty. The taxonomy is now GENERATED from the raws
  //    (dwf-announce-taxonomy.js / src/announce_taxonomy.gen.h -- one generator, two outputs),
  //    the server resolves each report's `section` and ships it, and the real artifact tokens
  //    (MADE_ARTIFACT / NAMED_ARTIFACT / ARTIFACT_BEGUN / STRANGE_MOOD) and the real invasion family
  //    (every AMBUSH_*, NIGHT_ATTACK_*, MEGABEAST_ARRIVAL, WEREBEAST_ARRIVAL, UNDEAD_ATTACK, ...)
  //    land where the owner asked for them.
  //
  // 2. IT IS THE WHOLE LOG, NOT THE LAST 300 ROWS. The old panel only ever asked for the newest
  //    page and had no way to ask for an older one, so a year-3 fort's year-1 history was
  //    unreachable. `before=` walks backward; "Load older" (and scrolling to the top) pages through
  //    it. `since=` still follows the live tail.
  //
  // 3. A MESSAGE IS ONE ROW. DF wraps long lines into a lead report + continuation reports. The
  //    server now attaches a lead's whole continuation tail, and only a LEAD can start a page -- so
  //    a page can no longer open mid-sentence on an orphan fragment. That is the rest of TX14's
  //    "combat is especially bad".
  //
  // CAMERA (B216): the camera moves ONLY when the Center button is explicitly clicked. Rendering a
  // row, opening the panel, switching a chip, and paging older all move nothing. There is
  // deliberately no click handler on the row itself.
  // ===========================================================================================
  DWFUI.require("reports", ["rowHtml", "plaqueBtnHtml", "headerHtml", "scrollHtml", "windowHtml"]);

  const REP_LOG_CAP = 3000;   // rows held in memory; the tail is dropped past this
  const REP_PAGE = 200;       // messages per request

  // WAVE-5 / R7. The row "Center" control and the chips are TEXT controls, so both take native's
  // TEXT PLAQUE (plaqueBtnHtml) rather than an art tile -- and both keep their pinned
  // .alerts-action / .rep-chip class names through `cls`, so the existing CSS and the
  // [data-rep-center] / [data-rep-filter] listeners resolve exactly as before.
  //
  // SUPERSET PRESERVED: the chips are OURS. Native DF has no announcements log to filter at all.
  // The `active` chip keeps its class -- plaqueBtnHtml's `focus` would paint native's gold corner
  // brackets, but the brackets mean FOCUSED SLOT, not SELECTED FILTER, and borrowing them here would
  // invent a grammar. Selection stays on the pinned .active class.
  function repCenterButtonHtml(reportId) {
    return `<span class="alerts-actions">` + DWFUI.plaqueBtnHtml({
      label: "Center", cls: "alerts-action", dataset: { repCenter: reportId },
      title: "Move the camera to this event (nothing else moves it)",
    }) + `</span>`;
  }

  let repLog = [];             // oldest -> newest, for the currently selected section
  let repSinceId = -1;         // highest report id loaded (cursor for the live tail poll)
  let repBeforeId = -1;        // oldest id examined (cursor for backfill); -1 = start at newest
  let repSection = "all";      // "all" or a taxonomy section key
  let repCounts = null;        // {sectionKey: n} from the server, for the chip badges
  let repSections = [];        // [{id,key,label}] from the server (falls back to the baked table)
  let repReachedOldest = false;
  let repTotal = 0;
  let repPollTimer = null;
  let repLoading = false;
  let repLoadingOlder = false;

  function repTaxonomy() {
    return typeof DwfAnnounceTaxonomy !== "undefined" ? DwfAnnounceTaxonomy : null;
  }

  // The section list is SERVED (so a server that grows a section needs no client deploy), but the
  // baked table is the fallback -- the panel must still section correctly against an older server.
  function repSectionList(sections = repSections) {
    if (Array.isArray(sections) && sections.length) return sections;
    const tax = repTaxonomy();
    return tax ? tax.SECTIONS.map(s => ({ id: s.id, key: s.key, label: s.label })) : [];
  }

  // Prefer what the SERVER said. Fall back to the baked table only when the field is absent (an old
  // server, or a /notifications payload reused here). Never guess from the report TEXT.
  function repSectionOf(report) {
    if (!report) return "misc";
    if (typeof report.section === "string" && report.section) return report.section;
    const tax = repTaxonomy();
    return tax ? tax.sectionKey(report.typeKey, report.alertType) : "misc";
  }

  function repSectionLabel(key) {
    const found = repSectionList().find(s => s.key === key);
    if (found) return found.label;
    const tax = repTaxonomy();
    return tax ? tax.sectionLabel(key) : "Misc";
  }

  // Mirrors the existing notificationsPanelIsOpen() pattern: derive "is my panel actually on
  // screen" from real DOM state + the shared activeInfoPanel flag, instead of a private bool.
  // Switching to another toolbar panel overwrites clientPanel wholesale without calling back
  // into this file, so a private "I'm open" flag would go stale and the poll loop would keep
  // clobbering whatever panel replaced this one.
  function reportsPanelIsOpen() {
    return activeInfoPanel === "reports" &&
      clientPanel.classList.contains("visible") &&
      clientPanel.classList.contains("reports-window");
  }

  // One fetch shape for all three jobs (first page / older page / live tail). `section` is a KEY,
  // not a number, so the URL stays readable and an unknown key degrades to "all" server-side.
  async function repFetchPage({ since = -1, before = -1, section = "all", counts = false } = {}) {
    const params = new URLSearchParams();
    params.set("player", player);
    params.set("max", String(REP_PAGE));
    if (since >= 0) params.set("since", String(since));
    if (before >= 0) params.set("before", String(before));
    if (section && section !== "all") params.set("section", section);
    if (counts) params.set("counts", "1");
    params.set("t", String(Date.now()));
    const response = await fetch(`/reports?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("reports failed (" + response.status + ")");
    return response.json();
  }

  function repAbsorbPage(page) {
    if (!page) return [];
    if (Array.isArray(page.sections) && page.sections.length) repSections = page.sections;
    if (page.counts && typeof page.counts === "object") repCounts = page.counts;
    if (Number.isFinite(Number(page.totalReports))) repTotal = Number(page.totalReports);
    return Array.isArray(page.reports) ? page.reports : [];
  }

  async function repLoadInitial() {
    repLoading = true;
    repLog = [];
    repSinceId = -1;
    repBeforeId = -1;
    repReachedOldest = false;
    try {
      // counts:1 ONCE, on open -- it is the only O(N) pass and the chips are the only thing that
      // needs it. The 2s tail poll never asks for it.
      const page = await repFetchPage({ section: repSection, counts: true });
      repLog = repAbsorbPage(page);
      repSinceId = Number(page.nextReportId) || repSinceId;
      repBeforeId = Number.isFinite(Number(page.nextBeforeId)) ? Number(page.nextBeforeId) : -1;
      repReachedOldest = !!page.reachedOldest;
    } catch (_) {
      repLog = [];
    } finally {
      repLoading = false;
    }
  }

  // BACKFILL. `nextBeforeId` is the oldest id the server EXAMINED, not the oldest it MATCHED -- so
  // a section filter that found nothing in this window still advances the cursor and the next call
  // makes progress instead of re-scanning the same tail forever.
  async function repLoadOlder() {
    if (repLoadingOlder || repReachedOldest || repLoading) return;
    if (repBeforeId < 0) return;
    repLoadingOlder = true;
    try {
      const page = await repFetchPage({ before: repBeforeId, section: repSection });
      const older = repAbsorbPage(page);
      if (older.length) repLog = older.concat(repLog);
      if (repLog.length > REP_LOG_CAP) repLog = repLog.slice(0, REP_LOG_CAP);
      const next = Number(page.nextBeforeId);
      // Guard against a server that cannot advance: without this a stuck cursor would let the
      // scroll-to-top handler hammer /reports forever.
      if (Number.isFinite(next) && next >= 0 && next < repBeforeId) repBeforeId = next;
      else repReachedOldest = true;
      if (page.reachedOldest) repReachedOldest = true;
    } catch (_) {
      repReachedOldest = true; // stop retrying a failing backfill
    } finally {
      repLoadingOlder = false;
      if (reportsPanelIsOpen()) renderReportsPanel({ keepScroll: true });
    }
  }

  async function repPoll() {
    if (!reportsPanelIsOpen() || repLoading) {
      repStopPolling();
      return;
    }
    try {
      const page = await repFetchPage({ since: repSinceId, section: repSection });
      const incoming = repAbsorbPage(page);
      if (incoming.length) {
        repLog = repLog.concat(incoming);
        if (repLog.length > REP_LOG_CAP) repLog = repLog.slice(repLog.length - REP_LOG_CAP);
      }
      repSinceId = Number(page.nextReportId) || repSinceId;
      if (reportsPanelIsOpen()) renderReportsPanel({ append: incoming.length > 0 });
    } catch (_) {}
  }

  function repStartPolling() {
    if (repPollTimer) return;
    repPollTimer = window.setInterval(repPoll, 2000);
  }

  function repStopPolling() {
    if (repPollTimer) {
      window.clearInterval(repPollTimer);
      repPollTimer = null;
    }
  }

  async function repSetSection(sectionKey) {
    const next = sectionKey || "all";
    if (next === repSection) return;
    repSection = next;
    clientPanel.querySelector(".rep-list")?.classList.add("rep-loading");
    await repLoadInitial();
    if (reportsPanelIsOpen()) renderReportsPanel();
  }

  // ---- rows ---------------------------------------------------------------------------------

  // DF's calendar: 12 months x 28 days x 1200 ticks. `time` is the tick within the year. A bare
  // "Year 250" cannot order two events inside a year -- which is exactly what you need when you are
  // reading a siege back afterwards.
  const REP_MONTHS = ["Granite", "Slate", "Felsite", "Hematite", "Malachite", "Galena",
                      "Limestone", "Sandstone", "Timber", "Moonstone", "Opal", "Obsidian"];
  function repDate(report) {
    const year = Number(report && report.year) || 0;
    const time = Number(report && report.time);
    if (!Number.isFinite(time) || time < 0) return `Year ${year}`;
    const month = Math.min(11, Math.floor(time / 33600));
    const day = Math.floor((time % 33600) / 1200) + 1;
    return `${REP_MONTHS[month]} ${day}, ${year}`;
  }

  // The two DF behaviour flags worth showing, straight from the raws: BOX ("this one stopped the
  // game and put a box in your face") and ALERT ("this one lit the alert button"). They are the
  // reason the row mattered at the time, and a log row without them loses that entirely.
  function repBadges(report) {
    const tax = repTaxonomy();
    const box = report && report.box != null ? !!report.box : !!(tax && report && tax.isBox(report.typeKey));
    const alert = report && report.alert != null ? !!report.alert : !!(tax && report && tax.isAlert(report.typeKey));
    let html = "";
    if (box) html += `<span class="rep-badge rep-badge-box" title="DF paused the game and showed this in a box">PAUSED</span>`;
    if (alert) html += `<span class="rep-badge rep-badge-alert" title="This lit the alert button">ALERT</span>`;
    return html;
  }

  function repRowHtml(report) {
    const target = repZoomTarget(report);
    const sectionKey = repSectionOf(report);
    const lines = Number(report.lineCount) || 1;
    return DWFUI.rowHtml({
      chassis: "table", cls: `alerts-row rep-row rep-row--${sectionKey}`,
      dataset: { repId: report.id, repSection: sectionKey },
      icon: `<span class="alerts-icon" style="${alertIconStyle(Number(report.alertType) || 0)}"></span>`,
      labelHtml: `<span style="color:${dfTextColor(report)}">${escapeHtml(reportText(report) || report.typeKey || "Report")}</span>`,
      labelCls: "alerts-title",
      sub: {
        html: `${repBadges(report)}<span class="rep-meta">${escapeHtml(repSectionLabel(sectionKey))}` +
          ` &middot; ${escapeHtml(repCategoryName(report.alertType))}` +
          ` &middot; ${escapeHtml(repDate(report))}` +
          `${lines > 1 ? ` &middot; ${lines} lines` : ""}</span>`,
        cls: "alerts-sub",
      },
      trailing: target ? repCenterButtonHtml(report.id) : "",
    });
  }

  // Signature preserved for tx14_announce_test (repRows(log, filter)). The second argument now only
  // shapes the empty-state copy: filtering moved SERVER-side, because it has to -- filtering a
  // 200-row page client-side gives you three siege rows and no way to ask for more.
  function repRows(sourceLog = repLog, filter = repSection) {
    const messages = repGroupReports(Array.isArray(sourceLog) ? sourceLog : []);
    if (!messages.length) {
      const named = filter != null && filter !== -1 && filter !== "all";
      return `<div class="info-message">No reports recorded${named ? " in this section" : ""}.</div>`;
    }
    return messages.map(repRowHtml).join("");
  }

  // TX14 shared-format shims. The module (dwf-announcement-format.js) is the single owner of
  // the 37-entry category table, the continuation-line stitcher and the zoom-target resolver; these
  // wrappers keep this file working (unchanged behaviour) if it ever loads without the module.
  function repGroupReports(reports) {
    const list = Array.isArray(reports) ? reports : [];
    return typeof DwfAnnouncementFormat !== "undefined"
      ? DwfAnnouncementFormat.groupReports(list)
      : list;
  }

  function repZoomTarget(report) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.zoomTarget(report);
    return report && report.pos ? report.pos : null;
  }

  function repCategoryName(alertType) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.categoryName(alertType);
    const i = Number(alertType);
    if (Number.isFinite(i) && typeof ALERT_NAMES !== "undefined" && ALERT_NAMES[i]) return ALERT_NAMES[i];
    return "Other";
  }

  // B160, ACTUALLY DELIVERED. The registry landed this as a filter on `typeKey === "SIEGE"` /
  // `"ARTIFACT_CREATED"` -- tokens that DO NOT EXIST in DF, so it rendered nothing, ever. It now
  // keys off the generated SECTION, which is derived from the tokens DF really has. The two
  // highlight strips pin the things you would otherwise scroll past: an arriving siege, and a
  // finished artifact.
  //
  // These are HIGHLIGHTS, not a re-sectioning of the log. The log itself stays chronological --
  // grouping a timeline by category is how you lose the timeline. The CHIPS are the sections.
  function repSpecialSections(reports, sectionKey = repSection) {
    if (sectionKey && sectionKey !== "all" && sectionKey !== -1) return ""; // already filtered
    const messages = repGroupReports(Array.isArray(reports) ? reports : []);
    return ["sieges", "artifacts"].map(key => {
      const rows = messages.filter(report => repSectionOf(report) === key);
      if (!rows.length) return "";
      return `<div class="alerts-section-title">${escapeHtml(repSectionLabel(key))}</div>` +
        `<div class="alerts-recent rep-highlight">${rows.slice(-6).map(repRowHtml).join("")}</div>`;
    }).join("");
  }

  // ---- chips --------------------------------------------------------------------------------
  // The sections, as filter chips, with the server's per-section totals. `counts` covers the WHOLE
  // fort log, not the loaded page, so "Sieges 4" means four sieges EVER -- not four in the last 200
  // rows, which is the only count worth printing on a history screen.
  function repChips(sections = repSections, active = repSection, counts = repCounts) {
    const chip = (key, label, count) => DWFUI.plaqueBtnHtml({
      label: count == null ? label : `${label} ${count}`,
      cls: `rep-chip${active === key ? " active" : ""}${count === 0 ? " rep-chip-empty" : ""}`,
      dataset: { repFilter: key },
      title: active === key ? `Showing ${label}` : `Show only ${label}`,
    });
    const total = counts ? Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0) : null;
    const chips = [chip("all", "All", total)];
    repSectionList(sections).forEach(s => {
      chips.push(chip(s.key, s.label, counts ? (Number(counts[s.key]) || 0) : null));
    });
    return chips.join("");
  }

  // ---- markup -------------------------------------------------------------------------------
  function reportsPanelMarkup(state) {
    state = state || {};
    const log = Array.isArray(state.log) ? state.log : [];
    const section = typeof state.section === "string" ? state.section : "all";
    const sections = Array.isArray(state.sections) ? state.sections : [];
    const counts = state.counts && typeof state.counts === "object" ? state.counts : null;
    const reachedOldest = !!state.reachedOldest;
    const total = Number(state.total) || 0;
    const shown = repGroupReports(log).length;

    // R3: the close drops its `&times;` glyph for headerHtml's DEFAULT native tile
    // (TOKENS.sprites.close = BUILDING_JOBS_REMOVE). `data: "close-reports"` still emits
    // data-close-reports and `.info-close` is a CLOSE_SEL member, so PanelFrame is unaffected.
    //
    // B232 ROUND 2: the Alerts/Reports tab row is GONE. WD-7 merged Alerts+Reports into one
    // tabbed window; the reopen un-merged them -- the ALERT button opens the NATIVE ALERT BOX
    // (dwf-unit-hud-notifications.js alertBoxMarkup, oracle B232-oracle-native.png), and
    // this screen is reached through that box's log icon or the world map's Reports plaque. A tab
    // row whose other mode is a modal box would be incoherent, and native has no tabs here.
    //
    // UNVERIFIED AGAINST NATIVE: no capture of DF's own full announcements screen is banked yet
    // (ui-lab reports-log story: "Native full announcements capture still required"). Everything
    // else on this screen (chips, highlight strips, badges, footer) is the round-1 superset, kept
    // deliberately until that capture lands -- do NOT "nativize" it by guesswork.
    const head = DWFUI.headerHtml({
      cls: "info-header", title: "Announcements", titleCls: "info-title",
      close: { cls: "info-close", data: "close-reports", title: "Close announcements" },
    });

    // The backfill control lives INSIDE the scrollbox, at the top -- where the older rows will
    // appear -- so pressing it does not shove the rows you are already reading.
    const older = reachedOldest
      ? `<div class="rep-older rep-older-done">${total ? "Beginning of the log." : ""}</div>`
      : `<div class="rep-older">` + DWFUI.plaqueBtnHtml({
          label: "Load older", cls: "rep-older-btn", dataset: { repOlder: "1" },
          title: "Fetch the previous page of the log",
        }) + `</div>`;

    // .dwfui-scroll (DWFUI.scrollHtml) is what gives this the NATIVE STYLED SCROLLBAR -- the "the
    // scroll bar should be styled (along with all other scrollbars)" half of TX14. The rows and the
    // backfill control both live inside it.
    const rows = DWFUI.scrollHtml({ cls: "info-body rep-list", ariaLabel: "Announcement reports" },
      `${older}${repRows(log, section)}`);

    return DWFUI.windowHtml({
      ariaLabel: "Announcements",
      bodyHtml: `${head}` +
        `<div class="rep-toolbar"><div class="rep-chips">${repChips(sections, section, counts)}</div></div>` +
        `${repSpecialSections(log, section)}${rows}`,
      footerHtml: `<div>${shown} shown${section !== "all" ? ` &middot; ${escapeHtml(repSectionLabel(section))}` : ""}` +
        `${total ? ` &middot; ${total} in the log` : ""}</div>`,
    });
  }

  function renderReportsPanel(options = {}) {
    const body = clientPanel.querySelector(".rep-list");
    const stickBottom = body ? body.scrollTop + body.clientHeight >= body.scrollHeight - 8 : true;
    const oldScrollTop = body ? body.scrollTop : 0;
    const oldScrollHeight = body ? body.scrollHeight : 0;

    // WD-7/WD-1.3: shares the alerts-window shell (one announcements system) --
    // "reports-window" stays too so the existing .reports-window CSS hooks keep working.
    clientPanel.className = "visible info-panel alerts-window reports-window";
    panelContent(clientPanel).innerHTML = reportsPanelMarkup({
      log: repLog, section: repSection, sections: repSections, counts: repCounts,
      reachedOldest: repReachedOldest, total: repTotal,
    });

    clientPanel.querySelector("[data-close-reports]")?.addEventListener("click", () => {
      repStopPolling();
      closeClientPanel();
    });
    clientPanel.querySelectorAll("[data-rep-filter]").forEach(button => {
      button.addEventListener("click", () => repSetSection(button.dataset.repFilter));
    });
    clientPanel.querySelector("[data-rep-older]")?.addEventListener("click", () => repLoadOlder());

    // B216: THE ONLY THING IN THIS FILE THAT MOVES THE CAMERA. There is deliberately no handler on
    // the ROW -- opening or clicking a log entry must never move the camera by itself.
    clientPanel.querySelectorAll("[data-rep-center]").forEach(button => {
      button.addEventListener("click", () => {
        const report = repGroupReports(repLog).find(r => String(r.id) === String(button.dataset.repCenter));
        const target = repZoomTarget(report);
        if (target) centerAndFlashMapPos(target);
      });
    });

    const list = clientPanel.querySelector(".rep-list");
    if (list) {
      if (options.keepScroll) {
        // Backfill prepended rows ABOVE the viewport: hold the reader's line by shifting the scroll
        // position by exactly how much taller the content got.
        list.scrollTop = oldScrollTop + (list.scrollHeight - oldScrollHeight);
      } else if (options.append) {
        list.scrollTop = stickBottom ? list.scrollHeight : oldScrollTop;
      } else {
        list.scrollTop = list.scrollHeight;
      }
      list.addEventListener("scroll", () => {
        if (list.scrollTop <= 4) repLoadOlder();
      });
    }
  }

  async function openReportsPanel() {
    setActiveToolbar("reports");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    activeInfoPanel = "reports";
    clientPanel.className = "visible info-panel alerts-window reports-window";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      ariaLabel: "Announcements loading",
      bodyHtml: `${DWFUI.headerHtml({ cls: "info-header", title: "Announcements", titleCls: "info-title", close: false })}<div class="info-body"><div class="info-message">Loading reports...</div></div>`,
    });
    await repLoadInitial();
    if (!reportsPanelIsOpen()) return; // user switched to a different panel while this awaited
    renderReportsPanel();
    repStartPolling();
  }

  const repMarkupApi = {
    reportsPanelMarkup, repRows, repChips, repSpecialSections,
    repSectionOf, repSectionLabel, repDate, repBadges, repRowHtml,
  };
  if (typeof window !== "undefined") window.DFReportsMarkup = repMarkupApi;
  if (typeof module !== "undefined" && module.exports) module.exports = repMarkupApi;
