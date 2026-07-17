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

// Combat-log panel (B61) -- reproduces DF v50's NATIVE grouped combat-report flow:
//
//   STATE A (report list)  header "Select a report to view the full text."
//     One row per FIGHTING UNIT: "The <name> is fighting!" + zoom + unit-sheet buttons.
//     Source: the COMBAT/SPARRING/HUNTING alert's `unitReports[]` from /notifications
//     (already live on the deployed DLL; DF's own report_unid ordering IS the native
//     order -- oracle-verified against the 3 the owner screenshots).
//
//   STATE B (full text)    header "You can recenter on certain announcements."
//     The clicked unit's whole combat log, continuation-joined, chronological
//     (oldest->newest, newest at bottom -- matches native). Positioned lines get a
//     recenter button. Source: GET /combat-reports?unit=<id>&log=<n> (route shipped
//     window #4); degrades to the alert's inline last-12 reports if the route 404s.
//
// The "The <name> is fighting!" label is COMPOSED client-side from the unit's readable
// name because DF generates that banner string on the fly (it is NOT stored in
// world.status.reports). clFightingLabel() reproduces DF's format and prefers a
// server-provided `combatLabel` when a future DLL supplies one (graceful upgrade).
//
// The pure data-shapers (clGroupReports / clFightingLabel / clAlertUnitRows /
// clCombatAlertByType / clUnitDrilldownGroups / clMergeFollow / clLogLabel) take plain
// JSON and return display structs with NO DOM/fetch dependency, so
// tools/harness/combatlog_fixture_test.mjs exercises them (incl. seeded-bad rows)
// offline. They are node-exported at the bottom behind a browser-safe guard.

  // esc: reuse the shared global escapeHtml in the browser; fall back to a minimal impl so the
  // pure shapers still run (and node --check passes) under node.
  function _clEsc(s) {
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- pure data-shapers (node-testable) ------------------------------------------------

  // Accept either a raw report entry (/reports, /combat-reports entries) or a
  // {report, logKey, logType} wrapper and return the underlying report + its log tag.
  function _clUnwrap(item) {
    if (item && typeof item === "object" && item.report && typeof item.report === "object") {
      return { r: item.report, logKey: item.logKey || item.report.logKey || null,
               logType: (item.logType != null) ? item.logType : -1 };
    }
    return { r: item, logKey: (item && item.logKey) || null,
             logType: (item && item.logType != null) ? item.logType : -1 };
  }

  function _clReportTarget(report) {
    if (!report) return null;
    if (report.pos && Number(report.zoomType) !== -1) return report.pos;
    if (report.pos2 && Number(report.zoomType2) !== -1) return report.pos2;
    return null;
  }

  // Collapse continuation runs into logical messages. Input MUST be oldest->newest (the order
  // both endpoints return). A continuation line with no open group is kept as its OWN group,
  // flagged orphanContinuation, so a malformed stream neither drops text nor merges it wrongly.
  function clGroupReports(items) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    let cur = null;
    for (const item of list) {
      const { r, logKey, logType } = _clUnwrap(item);
      if (!r || typeof r !== "object") continue;
      const isCont = !!r.continuation;
      const text = String(r.text == null ? "" : r.text);
      if (isCont && cur) {
        cur.text = cur.text ? (cur.text + " " + text) : text;
        cur.lineCount += 1;
        continue;
      }
      const target = _clReportTarget(r);
      cur = {
        leadId: (r.id != null ? r.id : -1),
        color: (r.color != null ? r.color : 7),
        bright: !!r.bright,
        text: text,
        year: (r.year != null ? r.year : 0),
        time: (r.time != null ? r.time : 0),
        hasPos: !!target,
        pos: target,
        repeatCount: (r.repeatCount != null ? r.repeatCount : 0),
        logKey: logKey,
        logType: logType,
        lineCount: 1,
        orphanContinuation: isCont, // true only when a continuation opened the group (no lead)
      };
      out.push(cur);
    }
    return out;
  }

  // Fort-wide (/reports) payload -> grouped rows, newest first for display. (Legacy path,
  // kept for the fort-wide fallback + back-compat callers.)
  function clCombatRows(page) {
    const reports = (page && Array.isArray(page.reports)) ? page.reports : [];
    return clGroupReports(reports).slice().reverse();
  }

  // Per-unit (/combat-reports) payload -> grouped rows, newest first, each tagged with its log.
  function clUnitGroups(page) {
    const entries = (page && Array.isArray(page.entries)) ? page.entries : [];
    return clGroupReports(entries).slice().reverse();
  }

  // DRILL-DOWN (State B): per-unit combat log in CHRONOLOGICAL order (oldest->newest, newest
  // at the bottom) to match DF's native full-report view. No reverse.
  function clUnitDrilldownGroups(page) {
    const entries = (page && Array.isArray(page.entries)) ? page.entries : [];
    return clGroupReports(entries);
  }

  // Live-follow merge: keep prior groups, append only genuinely-new ones (dedup by leadId).
  function clMergeFollow(prev, incoming) {
    const seen = new Set();
    const out = [];
    const push = g => { if (g && !seen.has(g.leadId)) { seen.add(g.leadId); out.push(g); } };
    (Array.isArray(prev) ? prev : []).forEach(push);
    (Array.isArray(incoming) ? incoming : []).forEach(push);
    return out;
  }

  function clLogLabel(key) {
    switch (String(key == null ? "" : key).toLowerCase()) {
      case "combat": return "Combat";
      case "sparring": return "Sparring";
      case "hunting": return "Hunting";
      default: return "Combat log";
    }
  }

  // Reproduce DF's "The <name> is fighting!" banner. DF builds this from the unit's title;
  // our /notifications `unitName` is DFHack Units::getReadableName, e.g.
  //   'Sigun Matlolok "Bendgranite", Metalcrafter'  ->  "The Metalcrafter Sigun Matlolok is fighting!"
  //   'Urdim Zegrith "Tattoobells", expedition leader' -> "The expedition leader Urdim Zegrith is fighting!"
  //   'Gray Langur'                                  ->  "The Gray Langur is fighting!"
  //   'Dog (tame)'                                   ->  "The Dog is fighting!"
  // (Oracle-verified against all rows of the 3 the owner combat-log screenshots.)
  // The per-type verb suffixes are the DF binary's own report-tab strings ("fighting!",
  // "sparring.", "hunting." -- verified by extracting them from Dwarf Fortress.exe; note the
  // Sparring/Hunting variants end in a PERIOD, not the "!" the fighting banner uses).
  function clFightingLabel(unitName, categoryKey) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.fightingLabel(unitName, categoryKey);
    const verbMap = { combat: "is fighting!", sparring: "is sparring.", hunting: "is hunting." };
    const verb = verbMap[String(categoryKey == null ? "" : categoryKey).toLowerCase()] || "is fighting!";
    let name = String(unitName == null ? "" : unitName).trim();
    // Strip the DF nickname clause: `Name "Nick", Prof` -> `Name, Prof`.
    name = name.replace(/\s*"[^"]*"/g, "").replace(/\s{2,}/g, " ").trim();
    const ci = name.lastIndexOf(", ");
    if (ci >= 0) {
      const person = name.slice(0, ci).trim();
      const role = name.slice(ci + 2).trim();
      if (person && role) name = role + " " + person;
      else name = (person || role).trim();
    } else {
      // Animal / plain species: drop a trailing state parenthetical like " (tame)".
      name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    }
    if (!name) return verb.charAt(0).toUpperCase() + verb.slice(1); // "Is fighting!" (nameless fallback)
    return `The ${name} ${verb}`;
  }

  // Extract the fighting-unit rows (State A) from a single /notifications alert object.
  function clAlertUnitRows(alert) {
    if (typeof DwfAnnouncementFormat !== "undefined")
      return DwfAnnouncementFormat.combatUnitRows(alert);
    const refs = (alert && Array.isArray(alert.unitReports)) ? alert.unitReports : [];
    const out = [];
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const categoryKey = ref.categoryKey || (alert && alert.typeKey) || "";
      const pos = ref.pos || null;
      out.push({
        unitId: (ref.unitId != null ? ref.unitId : -1),
        category: (ref.category != null ? ref.category : -1),
        categoryKey: categoryKey,
        unitName: ref.unitName || "",
        label: (ref.combatLabel ? String(ref.combatLabel) : clFightingLabel(ref.unitName, categoryKey)),
        hasPos: !!pos,
        pos: pos,
        reports: Array.isArray(ref.reports) ? ref.reports : [],
        dismissKey: ref.dismissKey || null,
      });
    }
    return out;
  }

  // Find the combat-family alert (COMBAT=34, SPARRING=35, HUNTING=36) of a given type in a
  // /notifications state, or the first combat-family alert present when type is null.
  function clCombatAlertByType(state, type) {
    const alerts = (state && Array.isArray(state.alerts)) ? state.alerts : [];
    const combatTypes = new Set([34, 35, 36]);
    if (type != null) return alerts.find(a => Number(a && a.type) === Number(type)) || null;
    return alerts.find(a => combatTypes.has(Number(a && a.type))) || null;
  }

  // ---- DOM (browser-only) ---------------------------------------------------------------

  const CL_STYLE_ID = "cl-combat-styles";
  function _clInjectStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById(CL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = CL_STYLE_ID;
    // LAYOUT ONLY -- every colour is now a --dwfui-* token, so this module no longer owns a hex
    // table (drift R1). The BLOCK ITSELF STAYS: `.cl-*` has no rules at all in web/css/dwf.css
    // and the stylesheet is locked this wave, so deleting it would leave both the live panel and the
    // Studio story (tools/ui-lab/stories.js calls DFCombatLogMarkup.ensureStyles()) completely
    // unstyled. The .cl-btn / .cl-close / .cl-back rules are GONE: those three controls are DWFUI
    // components now and are painted by .dwfui-art-btn / .dwfui-actions in the shared sheet.
    // The instruction line's border-bottom is dropped too -- neither combat-log oracle shows a rule
    // under it (the window has no header band at all; the first line IS the instruction).
    style.textContent = `
      .cl-panel{position:fixed;left:44px;top:44px;z-index:4000;pointer-events:auto;
        width:min(940px,calc(100vw - 72px));max-height:calc(100vh - 88px);display:flex;font-family:inherit;
        flex-direction:column;background:var(--dwfui-surface);border:2px solid var(--dwfui-gold);border-radius:4px;
        box-shadow:0 6px 28px rgba(0,0,0,.6);color:var(--dwfui-text-body);}
      .cl-panel .cl-help.pf-handle{cursor:move;}
      .cl-help{padding:10px 14px 8px;font-size:13px;color:var(--dwfui-text-body);
        display:flex;justify-content:space-between;gap:12px;align-items:center;}
      .cl-rows{overflow-y:auto;padding:6px 6px 10px;flex:1 1 auto;min-height:0;}
      .cl-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:3px;}
      .cl-list .cl-row{cursor:pointer;}
      .cl-list .cl-row:hover{background:var(--dwfui-hatch);}
      .cl-list .cl-text{color:inherit;font-weight:700;}
      .cl-text{flex:1;min-width:0;line-height:1.35;overflow-wrap:anywhere;}
      .cl-list .cl-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .cl-detail .cl-row{align-items:flex-start;padding:6px 8px;}
      .cl-detail .cl-text{white-space:normal;}
      .cl-actions{display:flex;gap:4px;flex:0 0 auto;}
      .cl-empty{padding:16px 14px;color:var(--dwfui-text-secondary);font-size:13px;}
      .cl-gap{height:8px;}
      .cl-x{color:var(--dwfui-text-secondary);font-size:11px;}
      .cl-tag{color:var(--dwfui-text-secondary);font-size:11px;margin-right:4px;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  async function _clFetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  function _clColor(g) {
    // Shared helper returns a CSS color string from a report's {color,bright}.
    if (typeof dfTextColor === "function") {
      try { return dfTextColor(g); } catch (_) { return ""; }
    }
    return "";
  }

  function _clZoom(pos) {
    if (!pos) return;
    if (typeof centerAndFlashMapPos === "function") { centerAndFlashMapPos(pos); return; }
    if (typeof zoomToTile === "function") { zoomToTile(pos.x, pos.y, pos.z); return; }
    if (typeof sendCamera === "function") sendCamera(pos.x, pos.y, pos.z);
  }

  function _clOpenSheet(unitId) {
    if (unitId == null || unitId < 0) return;
    if (typeof openUnitById === "function") { openUnitById(unitId); return; }
    if (typeof showUnitSheet === "function" && typeof player !== "undefined") {
      fetch(`/unit?player=${encodeURIComponent(player)}&id=${encodeURIComponent(unitId)}&t=${Date.now()}`,
        { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) showUnitSheet(d); })
        .catch(() => {});
    }
  }

  // ONE BUTTON PER ROW, AND ITS IDENTITY IS WHAT THE ROW AFFORDS. Both native click-state oracles
  // ("combat log announcement click state.png" = the report list, "...click unit drill down.png" =
  // one unit's full text) show exactly one button on each row -- never two, and never a text button:
  //   * the row references a UNIT  -> the gold magnifier STOCKS_VIEW_ITEM. In native that IS the
  //     sheet-open ("each fighting unit has the sheets button on each line of text").
  //   * the row references a PLACE -> the recenter tile RECENTER_RECENTER (the drill-down oracle's
  //     per-line button).
  //   * the row affords neither    -> NOTHING is rendered. Native OMITS the cell; it never blanks it.
  // Both handlers stay wired -- _clOpenSheet on the unit case, _clZoom on the place case -- so the
  // pair of raw text buttons this replaces ("Zoom" + "Sheet") loses no dispatch. NOTE: STOCKS_VIEW_ITEM
  // is the magnifier ON ITS OWN; SQUADS_INSPECT is a DIFFERENT sprite (magnifier on a grey plate) and
  // is NOT what the combat log uses. Both verified present in web/interface_map.json.
  // cfg: {kind:'sheet'|'zoom'|'recenter', i, title, btnCls}. The title is taken as a NAMED `title:`
  // property at every call site on purpose: the "?" help reference harvests every tooltip in the
  // client by scanning source for `title=`/`title:` followed by a quoted literal
  // (tools/harness/help_corpus_extractor.mjs). Passing it positionally would still show the tooltip
  // on the button but would silently drop it from "a list of ALL of the tooltips in the game".
  function _clRowActionHtml(cfg) {
    const c = cfg || {};
    if (!c.kind) return "";   // absent affordance renders NOTHING
    const sprite = (c.kind === "sheet") ? DWFUI.TOKENS.sprites.view : DWFUI.TOKENS.sprites.recenter;
    return DWFUI.actionButtonsHtml(
      [{ action: c.kind, sprite: sprite, dataset: { i: c.i }, title: c.title }],
      { cls: "cl-actions", btnCls: c.btnCls });
  }

  // Pure markup shared by the live panel and the offline Parity Studio. Keeping the HTML here
  // means review fixtures exercise the same row/action grammar that ships in the game client.
  function clListRowsHtml(units) {
    if (!Array.isArray(units) || !units.length) return `<div class="cl-empty">No active combat reports.</div>`;
    return units.map((u, i) => {
      const color = u.reports && u.reports.length ? _clColor(u.reports[u.reports.length - 1]) : "";
      // A fighting-unit row references a unit -> the magnifier opens its sheet. A row that carries
      // only a position keeps the ZOOM wire on the recenter tile, so neither handler is stranded.
      const actions = (u.unitId != null && u.unitId >= 0)
        ? _clRowActionHtml({ kind: "sheet", i: i, title: "Open unit sheet", btnCls: "cl-btn cl-sheet" })
        : (u.hasPos ? _clRowActionHtml({ kind: "zoom", i: i, title: "Recenter", btnCls: "cl-btn cl-zoom" }) : "");
      return `<div class="cl-row" data-i="${i}"${color ? ` style="color:${color}"` : ""}>` +
             `<span class="cl-text">${_clEsc(u.label)}</span>${actions}</div>`;
    }).join("");
  }

  function clDetailRowsHtml(groups) {
    if (!Array.isArray(groups) || !groups.length) return `<div class="cl-empty">No combat text for this fighter yet.</div>`;
    return groups.map((g, i) => {
      const color = _clColor(g);
      const rep = (g.repeatCount && g.repeatCount > 0) ? ` <span class="cl-x">x${g.repeatCount + 1}</span>` : "";
      const actions = g.hasPos ? _clRowActionHtml({ kind: "recenter", i: i, title: "Recenter", btnCls: "cl-btn cl-rc" }) : "";
      return `<div class="cl-row"${color ? ` style="color:${color}"` : ""}>` +
             `<span class="cl-text">${_clEsc(g.text)}${rep}</span>${actions}</div>`;
    }).join("");
  }

  // THE INSTRUCTION-LINE WINDOW. Native's combat log has NO header band, NO title and NO X: the
  // first body line is a white instruction and DF dismisses the window with a right-click (both
  // oracles). ONE header builder now serves the live panel AND the Studio story -- they used to be
  // two different code paths, and the Studio card rendered the bitmap title while the shipping game
  // rendered `helpText.textContent` in the raw browser font. The owner would have signed off on a panel the
  // game never built.
  //
  // The shared panel frame also opts out of its normal X for this one panel. Right-click and Escape
  // remain the native close paths, so parity does not cost functionality.
  function clHeaderHtml(mode) {
    const help = mode === "unit"
      ? "You can recenter on certain announcements.  Right click to close."
      : "Select a report to view the full text.  Right click to close.";
    return DWFUI.headerHtml({
      cls: "cl-help", titleTag: "span", titleCls: "cl-help-text", title: help,
      // Both exact Steam captures carry this report-sheet tile in the upper-right corner. It is
      // the native UNIT_SHEET_VIEW_REPORTS cell, not a new close/back action. The panel is already
      // the report destination, so the tile is informational here and deliberately has no route.
      tools: [{ sprite: DWFUI.TOKENS.sprites.viewReports, title: "Combat reports" }],
      // Native has no visible back or close tiles here. Right-click and Escape close the panel.
      back: false,
      close: false,
    });
  }

  function clPanelMarkup(state) {
    const mode = state && state.mode === "unit" ? "unit" : "list";
    const rows = mode === "unit" ? clDetailRowsHtml(state && state.groups) : clListRowsHtml(state && state.units);
    const list = DWFUI.scrollHtml({ cls: `cl-rows ${mode === "unit" ? "cl-detail" : "cl-list"}`, ariaLabel: mode === "unit" ? "Combat report details" : "Combat reports" }, rows);
    return `<section class="cl-panel" data-cl-mode="${mode}">${clHeaderHtml(mode)}${list}</section>`;
  }

  // Live refreshes must never replace scrollHtml's shared class. The old renderers assigned
  // `rows.className = "cl-rows ..."`, silently deleting `dwfui-scroll` after the first async fetch;
  // Parity Studio kept the initial class while the real game fell back to Chromium's scrollbar.
  function clSetRowsMode(rows, mode) {
    if (!rows) return;
    rows.className = `dwfui-scroll cl-rows ${mode === "unit" ? "cl-detail" : "cl-list"}`;
  }

  // ----- STATE A: fighting-unit list -----
  function _clRenderList(rows, units) {
    if (!rows) return;
    if (!units.length) {
      clSetRowsMode(rows, "list");
      rows.innerHTML = `<div class="cl-empty">No active combat reports.</div>`;
      return;
    }
    clSetRowsMode(rows, "list");
    rows.innerHTML = clListRowsHtml(units);
    rows.querySelectorAll(".cl-zoom").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const u = units[+el.dataset.i];
      if (u) _clZoom(u.pos);
    }));
    rows.querySelectorAll(".cl-sheet").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const u = units[+el.dataset.i];
      if (u) _clOpenSheet(u.unitId);
    }));
    rows.querySelectorAll(".cl-row").forEach(el => el.addEventListener("click", () => {
      const u = units[+el.dataset.i];
      if (u && typeof el._clOpenUnit === "function") el._clOpenUnit(u);
    }));
  }

  // ----- STATE B: one unit's full combat text -----
  function _clRenderDetail(rows, groups) {
    if (!rows) return;
    clSetRowsMode(rows, "unit");
    if (!groups.length) {
      rows.innerHTML = `<div class="cl-empty">No combat text for this fighter yet.</div>`;
      return;
    }
    rows.innerHTML = clDetailRowsHtml(groups);
    rows.querySelectorAll(".cl-rc").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const g = groups[+el.dataset.i];
      if (g) _clZoom(g.pos);
    }));
    // Keep the newest line in view (native shows newest at the bottom).
    rows.scrollTop = rows.scrollHeight;
  }

  // ----- WT07 M6: persistent single panel (was a per-open .cl-overlay) --------------------
  // The combat log used to create and remove a fresh full-screen overlay on every open. The
  // shared framework registers a panel ONCE and binds drag/resize to a stable element, so the
  // panel now lives for the whole session (created lazily, shown/hidden) and is a body-level
  // position:fixed element the framework can z-band (fixing the "combat log floats over toasts
  // and the Esc menu" class -- spec R5). `clSession` holds the active open's timer teardown so a
  // re-open never leaks its /notifications + /combat-reports poll timers.
  let clShell = null;    // { panel, head, rows }
  let clSession = null;  // teardown for the active open (stops its poll timers)
  let clOpen = false;

  function clEnsureShell() {
    if (clShell || typeof document === "undefined") return clShell;
    _clInjectStyles();
    const panel = document.createElement("div");
    panel.className = "cl-panel";
    panel.style.display = "none";
    // The SAME builder the Studio story uses -- no second, divergent live markup path.
    panel.innerHTML = clHeaderHtml("list") +
      DWFUI.scrollHtml({ cls: "cl-rows cl-list", ariaLabel: "Combat reports" }, "");
    document.body.appendChild(panel);
    // Right-click anywhere on the panel closes it (native DF behavior), as the old overlay did.
    panel.addEventListener("contextmenu", e => { e.preventDefault(); clCloseActive(); });
    clShell = {
      panel: panel,
      head: panel.querySelector(".cl-help"),
      rows: panel.querySelector(".cl-rows"),
    };
    if (typeof window !== "undefined" && window.DFPanelFrame) {
      window.DFPanelFrame.register({
        key: "combatlog", el: () => clShell && clShell.panel, title: "Combat log",
        headSel: ".cl-help", closable: false, resizable: { minW: 380, minH: 240 },
        fillSel: ".cl-rows",
        persistOpen: false,
        defaultPos: (vw, vh) => ({ anchor: "tl", x: 44, y: 44, w: Math.min(940, vw - 72), h: Math.min(560, vh - 88) }),
        open: () => { if (!clOpen) openCombatLogPanel({}); },
        close: () => clCloseActive(),
        isOpen: () => clOpen, escClosable: true,
      });
    }
    return clShell;
  }
  function clShowPanel() {
    if (!clShell) return;
    clShell.panel.style.display = "flex";
    clOpen = true;
    try { if (typeof window !== "undefined" && window.DFPanelFrame) window.DFPanelFrame.syncOpenState("combatlog", true); } catch (_) {}
  }
  function clHidePanel() {
    clOpen = false;
    try { if (typeof window !== "undefined" && window.DFPanelFrame) window.DFPanelFrame.syncOpenState("combatlog", false); } catch (_) {}
    if (clShell) clShell.panel.style.display = "none";
  }
  function clCloseActive() {
    if (clSession) { const teardown = clSession; clSession = null; teardown(); }
    clHidePanel();
  }

  // Open the native combat-log flow.
  //   { alertType }                      -> State A (fighting-unit list) for that alert type
  //   { unitId, unitName, log, category }-> jump straight to State B for one unit
  function openCombatLogPanel(opts) {
    opts = opts || {};
    const shell = clEnsureShell();
    if (typeof document === "undefined" || !shell) return { close() {} };
    // Tear down any prior open (its poll timers) before this open reuses the same panel.
    if (clSession) { const teardown = clSession; clSession = null; teardown(); }

    const state = {
      mode: (opts.unitId != null) ? "unit" : "list",
      alertType: (opts.alertType != null) ? Number(opts.alertType) : 34,
      // unit-mode fields
      unitId: (opts.unitId != null) ? opts.unitId : null,
      unitName: opts.unitName || null,
      category: (opts.category != null) ? opts.category : null,
      log: (opts.log != null) ? opts.log : "all",
      groups: [],
      nextId: -1,
      listTimer: null,
      followTimer: null,
    };

    const panel = shell.panel;
    const rows = shell.rows;

    function stopFollow() { if (state.followTimer) { clearInterval(state.followTimer); state.followTimer = null; } }
    function stopList() { if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null; } }
    // WT07 M6: the private Escape listener is GONE -- DFPanelFrame.escCloseTopmost() (via the
    // controls-placement cascade) now closes the topmost panel, one layer per press.
    clSession = () => { stopFollow(); stopList(); };

    // THE LIVE PATH NOW RENDERS THROUGH clHeaderHtml -- the same builder the Studio story calls. It
    // used to set `helpText.textContent` (raw browser font) and hand-write the two raw buttons, so
    // the panel the owner reviewed in the Studio and the panel the game shipped were different renders.
    //
    // Only the header's CONTENTS are swapped, never the `.cl-help` NODE: DFPanelFrame.buildChrome()
    // stamped .pf-handle on that element and bound the drag listener to it at attach, and (this panel
    // being resizable) there is no heal observer to rebuild them -- replacing the node would silently
    // kill dragging. Sprites/bitmap text inside the fresh contents are painted by DWFUI.mountDom()'s
    // document-wide observer; this module never calls paintSprites itself.
    function renderHelp() {
      const head = shell.head;
      if (!head) return;
      const tmp = document.createElement("div");
      tmp.innerHTML = clHeaderHtml(state.mode);
      const fresh = tmp.firstElementChild;
      head.innerHTML = fresh ? fresh.innerHTML : "";
      const backBtn = head.querySelector("[data-cl-back]");
      if (backBtn) backBtn.addEventListener("click", () => showList());
      const closeBtn = head.querySelector("[data-cl-close]");
      if (closeBtn) closeBtn.addEventListener("click", clCloseActive);
    }

    // ---- list mode ----
    function currentUnits() {
      const st = (typeof notificationState !== "undefined") ? notificationState : null;
      const alert = clCombatAlertByType(st, state.alertType) || clCombatAlertByType(st, null);
      return clAlertUnitRows(alert);
    }
    function paintList() {
      _clRenderList(rows, currentUnits());
      // Wire each row's click -> detail via a closure hook the renderer invokes.
      rows.querySelectorAll(".cl-row").forEach(el => { el._clOpenUnit = (u) => showUnit(u); });
    }
    function showList() {
      state.mode = "list";
      stopFollow();
      renderHelp();
      paintList();
      // Live-refresh the list from the app's own /notifications poll (units join/leave a fight).
      if (!state.listTimer) state.listTimer = setInterval(() => {
        if (state.mode === "list") paintList();
      }, 1500);
    }

    // ---- unit (detail) mode ----
    function unitUrl(since) {
      const logParam = (state.category != null) ? String(state.category) : (state.log || "all");
      return `/combat-reports?unit=${encodeURIComponent(state.unitId)}` +
             `&log=${encodeURIComponent(logParam)}&since=${since}&max=200`;
    }
    async function loadUnit(initial) {
      try {
        const page = await _clFetchJson(unitUrl(initial ? -1 : state.nextId));
        if (page && page.unitFound === false && state.groups.length === 0) {
          clSetRowsMode(rows, "unit");
          rows.innerHTML = `<div class="cl-empty">Unit not found (it may have left the fort).</div>`;
          return;
        }
        state.nextId = (page && page.nextReportId != null) ? page.nextReportId : state.nextId;
        const fresh = clUnitDrilldownGroups(page); // oldest->newest
        state.groups = initial ? fresh
          : clMergeFollow(state.groups, fresh); // keep chronological, append new tail
        _clRenderDetail(rows, state.groups);
      } catch (e) {
        // Route missing (pre-window-4 DLL) or transient: on first load fall back to the
        // alert's inline last-12 reports so the drill-down still shows SOMETHING.
        if (initial && state.groups.length === 0) {
          if (state.inlineReports && state.inlineReports.length) {
            state.groups = clGroupReports(state.inlineReports);
            _clRenderDetail(rows, state.groups);
          } else {
            clSetRowsMode(rows, "unit");
            const missing = /HTTP 404/.test(String(e && e.message));
            rows.innerHTML = `<div class="cl-empty">${missing
              ? "Per-unit combat log needs the latest server (pending deploy)."
              : "Combat log unavailable right now."}</div>`;
          }
        }
      }
    }
    function showUnit(u) {
      state.mode = "unit";
      state.unitId = u.unitId;
      state.unitName = u.unitName;
      state.category = (u.category != null && u.category >= 0) ? u.category : null;
      state.log = "all";
      state.groups = [];
      state.nextId = -1;
      state.inlineReports = Array.isArray(u.reports) ? u.reports : [];
      stopList();
      renderHelp();
      // Immediate paint from inline reports (leads only) so the panel never flashes empty,
      // then enrich with the full continuation-joined log from /combat-reports.
      if (state.inlineReports.length) {
        state.groups = clGroupReports(state.inlineReports);
        _clRenderDetail(rows, state.groups);
      } else {
        clSetRowsMode(rows, "unit");
        rows.innerHTML = `<div class="cl-empty">Loading&hellip;</div>`;
      }
      loadUnit(true);
      if (!state.followTimer) state.followTimer = setInterval(() => {
        if (state.mode === "unit") loadUnit(false);
      }, 3000);
    }

    clShowPanel();
    if (state.mode === "unit") {
      state.inlineReports = [];
      showUnit({ unitId: state.unitId, unitName: state.unitName, category: state.category, reports: [] });
    } else {
      showList();
    }
    return { close: clCloseActive };
  }

  // ---- entry hook: intercept combat-family alert clicks (B61 native flow) ----------------
  // Capturing-phase delegation on the #alertStack CONTAINER: survives smalls' ~500ms
  // renderAlertStack() rebuilds by construction (listener is on the parent, not the buttons),
  // and touches ZERO other-owned files. Only COMBAT(34)/SPARRING(35)/HUNTING(36) buttons are
  // intercepted; every other alert falls through to its original handler untouched.
  function _clCombatAlertClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest(".alert-button") : null;
    if (!btn) return;
    const m = /^a:(\d+)$/.exec(btn.dataset ? (btn.dataset.alertKey || "") : "");
    if (!m) return;
    const type = Number(m[1]);
    if (type !== 34 && type !== 35 && type !== 36) return; // not combat-family: let it through
    e.stopPropagation();
    e.preventDefault();
    // B216 defect 1: opening the combat log is an OPEN-A-PANEL click, not a jump-to-event, so it
    // must NOT move the camera. The old `recenterOnAlert(alert)` call jerked the view to the
    // alert's surface z on every open. Recentering stays an EXPLICIT affordance only: the per-unit
    // Zoom tile (.cl-zoom) and per-report recenter tile (.cl-rc) inside the log, plus the alert
    // popup's RECENTER_RECENTER tiles. This matches the notifications alert-button, which likewise
    // only opens its popup and never recenters on click (see announcement_parity_test).
    openCombatLogPanel({ alertType: type });
  }
  function _clInstallHook() {
    if (typeof document === "undefined") return;
    if (typeof window !== "undefined" && window.combatLogHookEnabled === false) return;
    const stack = document.getElementById("alertStack");
    if (!stack) { setTimeout(_clInstallHook, 500); return; }
    if (stack._clHooked) return;
    stack._clHooked = true;
    stack.addEventListener("click", _clCombatAlertClick, true); // capture phase
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _clInstallHook);
    } else {
      _clInstallHook();
    }
  }

  // Expose the opener globally so an alert, notifications panel, or unit sheet can launch it.
  if (typeof window !== "undefined") {
    window.openCombatLogPanel = openCombatLogPanel;
    window.DFCombatLogMarkup = { clGroupReports, clAlertUnitRows, clListRowsHtml, clDetailRowsHtml, clPanelMarkup, ensureStyles: _clInjectStyles };
  }

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      clGroupReports, clCombatRows, clUnitGroups, clUnitDrilldownGroups, clMergeFollow,
      clLogLabel, clFightingLabel, clAlertUnitRows, clCombatAlertByType,
      clListRowsHtml, clDetailRowsHtml, clPanelMarkup, clSetRowsMode,
      _clRenderList, _clRenderDetail,
    };
  }
