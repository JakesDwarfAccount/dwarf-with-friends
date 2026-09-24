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

// ---- The native chronological Announcements screen. ----
// Native rows are flat: no icon column, badges, expander, acknowledgement, clear action or footer count.
if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
  DWFUI.require("reports",
    ["artBtnHtml", "listHtml", "rawHtml", "rowHtml", "tabsHtml", "statusHtml", "windowHtml"]);

const REP_LOG_CAP = 10000; // native report-list bound (ledger 0016 E10)
const REP_PAGE = 500;      // largest page the existing /reports route accepts
const REP_AUTO_BACKFILL_ROWS = 30; // a real working set before top-of-list paging takes over
const REP_FLAG_D_DISPLAY = 2;
const REP_FLAG_UCR = 64;
const REP_FLAG_UCR_ACTIVE = 128;

let repLog = [];             // oldest -> newest
let repSinceId = -1;
let repBeforeId = -1;
let repReachedOldest = false;
let repPollTimer = null;
let repLoading = false;
let repLoadingOlder = false;
const REP_TAB_ALL = "All";  // the leading native page, activated on open by 0x1400EEAF0

let repTab = REP_TAB_ALL;

function repFormat() {
  return typeof DwfAnnouncementFormat !== "undefined" ? DwfAnnouncementFormat : null;
}

function repGroupReports(reports) {
  const fmt = repFormat();
  return fmt ? fmt.groupReports(reports) : (Array.isArray(reports) ? reports : []);
}

function repMessage(report) {
  const fmt = repFormat();
  return fmt ? fmt.reportText(report, { repeat: false }) : String(report?.text || "");
}

function repTabName(report) {
  const fmt = repFormat();
  return fmt ? fmt.alertTab(report?.alertType) : "General";
}

// P1: D_DISPLAY and neither combat-log routing mode. `taxonomyFlags` is copied from the same
// per-type announcements configuration table by the server; no text/category guess is involved.
function repEligible(report) {
  const flags = Number(report?.taxonomyFlags);
  return Number.isInteger(flags) &&
    (flags & REP_FLAG_D_DISPLAY) !== 0 &&
    (flags & (REP_FLAG_UCR | REP_FLAG_UCR_ACTIVE)) === 0;
}

function repPosition(report, which) {
  const pos = which === 2 ? report?.pos2 : report?.pos;
  // Z1 is x-only. The current wire unfortunately nulls positions when zoom_type is NONE; this
  // predicate intentionally does not add a second, invented zoom-type gate on top of that wire gap.
  return pos && Number(pos.x) !== -30000 ? pos : null;
}

function repLinks(report) {
  const links = [];
  if (repPosition(report, 1)) links.push({ index: 1, pos: report.pos });
  if (repPosition(report, 2)) links.push({ index: 2, pos: report.pos2 });
  return links;
}

const REP_MONTHS = ["Granite", "Slate", "Felsite", "Hematite", "Malachite", "Galena",
                    "Limestone", "Sandstone", "Timber", "Moonstone", "Opal", "Obsidian"];

function repOrdinal(day) {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

function repDate(report) {
  const year = Number(report?.year) || 0;
  const time = Number(report?.time);
  if (!Number.isFinite(time) || time < 0) return `Date: ${year}`;
  const dayIndex = Math.floor(time / 1200);
  const day = (dayIndex % 28) + 1;
  const month = Math.max(0, Math.min(11, Math.floor(dayIndex / 28)));
  return `Date: ${repOrdinal(day)}, ${REP_MONTHS[month]}, ${year}`;
}

function repDfColor(report) {
  const fg = Math.max(0, Math.min(7, Number(report?.color) || 0));
  return DWFUI.dfColor(fg + (report?.bright ? 8 : 0));
}

function repUnitButtonHtml(report) {
  const id = Number(report?.speakerId);
  if (!Number.isInteger(id) || id < 0) return "";
  // The widget's legacy face is not identified in the atlas, so this stays an explicit identity gap
  // rather than borrowing an unrelated "view item" or camera tile.
  return DWFUI.artBtnHtml({
    cls: "reports-native-link reports-speaker-link unit-link",
    dataset: {
      unitId: id,
      dfIdentityMissing: "widgets::unit_sheet_button",
    },
    placeholder: true,
    title: "Open unit sheet (native button face not yet identified)",
    ariaLabel: "Open unit sheet",
  });
}

function repRecenterButtonHtml(report, which) {
  if (!repPosition(report, which)) return "";
  return DWFUI.artBtnHtml({
    sprite: DWFUI.TOKENS.sprites.recenter,
    cls: "reports-native-link reports-recenter-link",
    dataset: { repCenter: report.id, repLink: which },
    title: "Recenter",
    ariaLabel: "Recenter",
  });
}

function repRowHtml(report) {
  const message = repMessage(report);
  const tools = repUnitButtonHtml(report) +
    repRecenterButtonHtml(report, 1) +
    repRecenterButtonHtml(report, 2);
  const rowBody = DWFUI.statusHtml({
    cls: "reports-message",
    text: message,
    columns: 72,
    dfColor: Math.max(0, Math.min(7, Number(report?.color) || 0)) + (report?.bright ? 8 : 0),
  }) +
    DWFUI.statusHtml({ cls: "reports-date", text: repDate(report), dfColor: 15 });
  return DWFUI.rowHtml({
    cls: "reports-row",
    announce: true,
    dataset: { reportId: report?.id },
    labelHtml: DWFUI.rawHtml("A report is two independently coloured text lines.", rowBody),
    trailing: tools ? `<span class="dwfui-announce-actions">${tools}</span>` : "",
  });
}

function repEligibleRows(log) {
  return repGroupReports(log).filter(repEligible);
}

function repAvailableTabs() {
  const fmt = repFormat();
  return fmt ? fmt.NATIVE_TABS.slice() : [REP_TAB_ALL, "General"];
}

// Every eligible report appears on All exactly once: native re-parents the SAME row widget rather than
// building a second copy, so nothing here may double-count it.
function repRows(log, tab = repTab) {
  const all = !tab || tab === REP_TAB_ALL;
  return repEligibleRows(log)
    .filter(report => all || repTabName(report) === tab)
    .map(repRowHtml)
    .join("");
}

function repTabsHtml(log, active = repTab) {
  const tabs = repAvailableTabs();
  if (!tabs.length) return "";
  const selected = tabs.includes(active) ? active : tabs[0];
  return DWFUI.tabsHtml({
    level: "primary-short",
    cls: "reports-tabs",
    tabCls: "reports-tab",
    dataAttr: "reports-tab",
    ariaLabel: "Announcement categories",
    wrap: true,
    // promote:false restores parity: this strip's pages come from a PINNED caption table, and promotion
    // packs against the original order and re-wraps, which moves "All" into the middle of the strip.
    promote: false,
    width: "hug",
    active: selected,
    tabs: tabs.map(label => ({ key: label, label })),
  });
}

function reportsPanelMarkup(state) {
  const log = Array.isArray(state?.log) ? state.log : [];
  const tabs = repAvailableTabs();
  const selected = tabs.includes(state?.tab) ? state.tab : (tabs[0] || "");
  const rows = repRows(log, selected);
  const content = rows || DWFUI.statusHtml({
    cls: "reports-empty",
    text: "No announcements.",
    dfColor: 15,
  });
  return DWFUI.windowHtml({
    cls: "reports-native-window",
    ariaLabel: "Announcements",
    bodyHtml:
      `<div class="reports-tabs-host" data-announcement-tabs>${repTabsHtml(log, selected)}</div>` +
      // listHtml's defaults are what this screen wants: the wheel moves one whole REPORT and the scrollbar
      // gutter comes out of the window's own width. `key` is what survives the full innerHTML rebuild.
      DWFUI.listHtml({
        cls: "reports-list",
        rows: ".reports-row",
        key: "reports",
        ariaLabel: "Announcement reports",
      }, content),
  });
}

function reportsPanelIsOpen() {
  return activeInfoPanel === "reports" &&
    clientPanel.classList.contains("visible") &&
    clientPanel.classList.contains("reports-window");
}

async function repFetchPage({ since = -1, before = -1 } = {}) {
  const query = { max: REP_PAGE };
  if (since >= 0) query.since = since;
  if (before >= 0) query.before = before;
  return DwfReportTransport.reportsPage(query);
}

function repPageRows(page) {
  return Array.isArray(page?.reports) ? page.reports : [];
}

async function repLoadInitial() {
  repLoading = true;
  repLog = [];
  repSinceId = -1;
  repBeforeId = -1;
  repReachedOldest = false;
  try {
    const page = await repFetchPage();
    repLog = repPageRows(page);
    repSinceId = Number(page.nextReportId) || -1;
    repBeforeId = Number.isFinite(Number(page.nextBeforeId)) ? Number(page.nextBeforeId) : -1;
    repReachedOldest = !!page.reachedOldest;
  } catch (err) {
    DwfErr.report("reports.initial-load", err);
    repLog = [];
  } finally {
    repLoading = false;
  }
}

async function repLoadOlder() {
  if (repLoadingOlder || repReachedOldest || repLoading || repBeforeId < 0) return;
  repLoadingOlder = true;
  try {
    const page = await repFetchPage({ before: repBeforeId });
    const older = repPageRows(page);
    if (older.length) repLog = older.concat(repLog);
    // The cap is the NEWEST end on both paths: slice(0, CAP) would keep the OLDEST rows and drop the live
    // tail. Once CAP rows are held, any further "older" page would be discarded by this same trim.
    if (repLog.length >= REP_LOG_CAP) {
      repLog = repLog.slice(repLog.length - REP_LOG_CAP);
      repReachedOldest = true;
      return;
    }
    const next = Number(page.nextBeforeId);
    if (Number.isFinite(next) && next >= 0 && next < repBeforeId) repBeforeId = next;
    else repReachedOldest = true;
    if (page.reachedOldest) repReachedOldest = true;
  } catch (err) {
    DwfErr.report("reports.older-load", err);
    repReachedOldest = true;
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
    const page = await repFetchPage({ since: repSinceId });
    const incoming = repPageRows(page);
    repSinceId = Number(page.nextReportId) || repSinceId;
    // DEF-014: a real append still rebuilds all N rows, and that is not a local fix -- repGroupReports
    // collapses repeats ACROSS the whole log, so a new report can mutate an existing row, not only add one.
    if (!incoming.length) return;
    repLog = repLog.concat(incoming);
    if (repLog.length > REP_LOG_CAP) repLog = repLog.slice(repLog.length - REP_LOG_CAP);
    if (reportsPanelIsOpen()) renderReportsPanel({ append: true });
  } catch { /* the two-second reports poll retries while the panel remains open */ }
}

function repStartPolling() {
  if (!repPollTimer) repPollTimer = window.setInterval(repPoll, 2000);
}

function repStopPolling() {
  if (!repPollTimer) return;
  window.clearInterval(repPollTimer);
  repPollTimer = null;
}

// The one control's host for this panel, and its last arranged geometry. Everything below states
// the log's position as an ENTRY INDEX; there is no pixel arithmetic left in this file.
function repListHost() { return clientPanel.querySelector('[data-dwfui-list-key="reports"]'); }
function repListGeom() { const host = repListHost(); return host ? host.__dwfuiListGeom : null; }
function repNeedsOlderPage(geom, reachedOldest = repReachedOldest) {
  // A handful of tall rows can yield a one-position scrollbar: technically scrollable, but it leaves
  // nearly all history behind a single move event, so fill a modest working set first.
  return !!geom && !reachedOldest &&
    (geom.bottomMost <= geom.min || geom.totalItems < REP_AUTO_BACKFILL_ROWS);
}

function renderReportsPanel(options = {}) {
  // The control restores its own position across the rebuild; only the three cases a key cannot know are
  // handled here, each as an INDEX -- end on a fresh open or a new report, shifted down on an older page.
  const oldGeom = repListGeom();
  const oldRows = oldGeom ? oldGeom.totalItems : 0;
  const atEnd = !oldGeom || oldGeom.position >= oldGeom.bottomMost;

  const tabs = repAvailableTabs();
  if (!tabs.includes(repTab)) repTab = tabs[0] || "";
  clientPanel.className = "visible info-panel alerts-window reports-window";
  panelContent(clientPanel).innerHTML = reportsPanelMarkup({ log: repLog, tab: repTab });

  clientPanel.querySelectorAll("[data-reports-tab]").forEach(button => {
    button.addEventListener("click", () => {
      repTab = button.dataset.reportsTab || repTab;
      renderReportsPanel();
    });
  });

  clientPanel.querySelectorAll("[data-rep-center]").forEach(button => {
    button.addEventListener("click", () => {
      const report = repGroupReports(repLog)
        .find(row => String(row.id) === String(button.dataset.repCenter));
      const target = repPosition(report, Number(button.dataset.repLink));
      if (target) centerAndFlashMapPos(target);
    });
  });

  if (typeof fortBindUnitLinks === "function") fortBindUnitLinks(clientPanel);

  // Mount the control now rather than waiting for DWFUI's DOM observer: the position cases below
  // need an arranged geometry (a page size, and therefore a bottom-most position) to aim at.
  DWFUI.mountLists(clientPanel);
  const host = repListHost();
  if (!host) return;
  const geom = host.__dwfuiListGeom;
  const added = geom ? Math.max(0, geom.totalItems - oldRows) : 0;
  if (options.keepScroll) DWFUI.setListPosition(host, (oldGeom ? oldGeom.position : 0) + added);
  else if (!options.append || atEnd) DWFUI.setListPosition(host, "end");
  // Paging older reports in at the top is DWF-only -- native's log is finite -- so it hangs off the
  // control's move event rather than being built into it.
  host.addEventListener("dwfui-list-scroll", event => {
    if (event.detail && event.detail.position <= event.detail.min) repLoadOlder();
  });
  // Filtering can leave fewer eligible rows than one working set while thousands remain server-side, so
  // keep backfilling to the cap or the server's oldest report.
  if (repNeedsOlderPage(geom) && !repLoadingOlder && !repLoading)
    void repLoadOlder();
}

async function openReportsPanel(seedReportId = null, _seedAlertType = null) {
  setActiveToolbar("reports");
  if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
  activeInfoPanel = "reports";
  clientPanel.className = "visible info-panel alerts-window reports-window";
  panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
    cls: "reports-native-window",
    ariaLabel: "Announcements loading",
    bodyHtml: DWFUI.statusHtml({ cls: "reports-empty", text: "Loading reports...", dfColor: 15 }),
  });
  await repLoadInitial();
  if (!reportsPanelIsOpen()) return;
  const seed = seedReportId == null
    ? null
    : repGroupReports(repLog).find(report => String(report.id) === String(seedReportId));
  // An open never resumes the tab the player last selected: it takes the seed's tab, else the hint, else All.
  if (seed && repEligible(seed)) repTab = repTabName(seed);
  else {
    // Combat-family groups stay on All: those reports are excluded by P1 and can never populate their tabs.
    const fmt = repFormat();
    const hinted = fmt && _seedAlertType != null ? fmt.alertTab(_seedAlertType) : "";
    repTab = hinted && !["Combat", "Sparring", "Hunting"].includes(hinted) &&
      repAvailableTabs().includes(hinted) ? hinted : REP_TAB_ALL;
  }
  renderReportsPanel();
  repStartPolling();
}

const repMarkupApi = {
  REP_TAB_ALL,
  reportsPanelMarkup,
  repRows,
  repTabsHtml,
  repAvailableTabs,
  repEligible,
  repRowHtml,
  repDate,
  repLinks,
  repPosition,
  repMessage,
  repTabName,
  repDfColor,
  repNeedsOlderPage,
};
if (typeof window !== "undefined") window.DFReportsMarkup = repMarkupApi;
if (typeof module !== "undefined" && module.exports)
  module.exports = { ...repMarkupApi, repFetchPage };
