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

(function (root) {
  "use strict";

  // Exact df::announcement_alert_type order (DFHack 53.15-r1).
  var ALERT_NAMES = Object.freeze([
    "General", "Era Change", "Underground", "Migrants", "Monster", "Ambush",
    "Trade", "Noble", "Animal", "Birth", "Mood", "Labor Change", "Military",
    "Marriage", "Berserk", "Martial Trance", "Emotion", "Stress",
    "Art Defacement", "Masterpiece", "Job Failed", "Death", "Ghost",
    "Undead Attack", "Weather", "Vermin", "Curious Guzzler",
    "Research Breakthrough", "Guest Arrival", "Holdings", "Rumor",
    "Agreement", "Crime", "Deity Curse", "Combat", "Sparring", "Hunting"
  ]);

  function categoryName(alertType) {
    var i = Number(alertType);
    return Number.isInteger(i) && ALERT_NAMES[i] ? ALERT_NAMES[i] : "Other";
  }

  // The category -> tab grouping is MANY-TO-ONE, so a tab can never be turned back into a category:
  // this table is DISPLAY ONLY, and everything that filters, stores or pages keeps the raw `alertType`.
  var ALERT_TABS = Object.freeze([
    { label: "World", categories: [1, 27, 29, 30] },
    { label: "Environment", categories: [2, 24] },
    { label: "Arrivals", categories: [3, 28] },
    { label: "Attacks", categories: [4, 5, 23] },
    { label: "Trade", categories: [6] },
    { label: "Nobles", categories: [7] },
    { label: "Animal", categories: [8] },
    { label: "Life changes", categories: [9, 13] },
    { label: "Strange moods", categories: [10] },
    { label: "Profession changes", categories: [11] },
    { label: "Military", categories: [12] },
    { label: "Mental state", categories: [14, 15, 16, 17] },
    { label: "Masterpieces", categories: [18, 19] },
    { label: "Job failures", categories: [20] },
    { label: "Death", categories: [21] },
    { label: "Ghosts", categories: [22] },
    { label: "Wildlife", categories: [25, 26] },
    { label: "Labor", categories: [31] },
    { label: "Crime", categories: [32] },
    { label: "Curses", categories: [33] },
    { label: "Combat", categories: [34] },
    { label: "Sparring", categories: [35] },
    { label: "Hunting", categories: [36] }
  ]);

  var NATIVE_TAB_ALL = "All";
  var NATIVE_TABS = Object.freeze(
    [NATIVE_TAB_ALL, "General"].concat(ALERT_TABS.map(function (tab) { return tab.label; })));

  var TAB_BY_CATEGORY = (function () {
    var map = {};
    ALERT_TABS.forEach(function (tab) {
      tab.categories.forEach(function (c) { map[c] = tab.label; });
    });
    return map;
  })();

  // Category 0 and anything unlisted fall through to General -- DF's own fallback.
  function alertTab(alertType) {
    var i = Number(alertType);
    return Number.isInteger(i) && TAB_BY_CATEGORY[i] ? TAB_BY_CATEGORY[i] : "General";
  }

  // Only the REDUNDANT restatement of the category is dropped; where the tab says something the category
  // does not, it is still shown. The category remains what is stored, filtered and printed.
  function tabKey(label) {
    return String(label == null ? "" : label).toLowerCase()
      .replace(/[^a-z0-9]+/g, "")     // "Mental state" -> "mentalstate"
      .replace(/s$/, "");             // Deaths/Ghosts/Nobles == Death/Ghost/Noble
  }

  // The tab label ONLY when it adds something the category name does not; "" otherwise.
  function distinctAlertTab(alertType) {
    var tab = alertTab(alertType);
    return tabKey(tab) === tabKey(categoryName(alertType)) ? "" : tab;
  }

  // A report carries TWO independent location links and may have zero, one or two. The payload has
  // already applied DF's gate, so a non-null position here IS a link.
  function reportLinks(report) {
    var out = [];
    if (!report) return out;
    if (report.pos) out.push({ index: 1, pos: report.pos, kind: Number(report.zoomType) });
    if (report.pos2) out.push({ index: 2, pos: report.pos2, kind: Number(report.zoomType2) });
    return out;
  }

  // The link kind is DF's report_zoom_type: -1 none / 0 generic / 1 item / 2 unit. It is NOT a gate
  // (Z1) -- it is a label, and only ever a label.
  function linkKindLabel(kind) {
    var k = Number(kind);
    if (k === 1) return "Item";
    if (k === 2) return "Unit";
    return "Location";
  }

  // The repeat count is ONE fact and a surface must state it ONCE: single-line surfaces take the " xN"
  // suffix by default, and the log, which has a chip and a detail line, asks for the message alone.
  function reportText(report, options) {
    if (!report) return "";
    var text = report.text == null ? "" : String(report.text);
    if (!text) return "";
    if (options && options.repeat === false) return text;
    var repeat = Number(report.repeatCount);
    return text + (Number.isFinite(repeat) && repeat > 0 ? " x" + (repeat + 1) : "");
  }

  // DF stores wrapped lines as a lead report followed by continuation reports. Native renders
  // that run as one message; preserve the lead's formatting, repeat count, linkage, and target.
  function groupReports(reports) {
    var out = [];
    var current = null;
    (Array.isArray(reports) ? reports : []).forEach(function (report) {
      if (!report || typeof report !== "object") return;
      var text = report.text == null ? "" : String(report.text);
      if (report.continuation && current) {
        current.text = current.text ? current.text + " " + text : text;
        current.lineCount++;
        current.reportIds.push(report.id);
        return;
      }
      current = Object.assign({}, report, {
        text: text,
        lineCount: 1,
        orphanContinuation: !!report.continuation,
        reportIds: [report.id]
      });
      out.push(current);
    });
    return out;
  }

  function isCombatAlert(type) {
    type = Number(type);
    return type === 34 || type === 35 || type === 36;
  }

  function fightingLabel(unitName, categoryKey) {
    var verbs = { combat: "is fighting!", sparring: "is sparring.", hunting: "is hunting." };
    var verb = verbs[String(categoryKey == null ? "" : categoryKey).toLowerCase()] || verbs.combat;
    var name = String(unitName == null ? "" : unitName).trim();
    name = name.replace(/\s*"[^"]*"/g, "").replace(/\s{2,}/g, " ").trim();
    var split = name.lastIndexOf(", ");
    if (split >= 0) {
      var person = name.slice(0, split).trim();
      var role = name.slice(split + 2).trim();
      name = person && role ? role + " " + person : (person || role);
    } else {
      name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    }
    return name ? "The " + name + " " + verb : verb.charAt(0).toUpperCase() + verb.slice(1);
  }

  function combatUnitRows(alert) {
    var refs = alert && Array.isArray(alert.unitReports) ? alert.unitReports : [];
    return refs.filter(function (ref) { return ref && typeof ref === "object"; }).map(function (ref) {
      var categoryKey = ref.categoryKey || (alert && alert.typeKey) || "Combat";
      return {
        unitId: ref.unitId == null ? -1 : ref.unitId,
        category: ref.category == null ? -1 : ref.category,
        categoryKey: categoryKey,
        unitName: ref.unitName || "",
        label: ref.combatLabel ? String(ref.combatLabel) : fightingLabel(ref.unitName, categoryKey),
        pos: ref.pos || null,
        hasPos: !!ref.pos,
        reports: Array.isArray(ref.reports) ? ref.reports : [],
        dismissKey: ref.dismissKey || null
      };
    });
  }

  // Ledger 0016 Z1 / native panel and alert-viewer renderers: presence is the x sentinel ONLY.
  // report_zoom_type labels the link's payload; it is never a visibility gate.
  function zoomTarget(report) {
    if (!report) return null;
    if (report.pos && Number(report.pos.x) !== -30000) return report.pos;
    if (report.pos2 && Number(report.pos2.x) !== -30000) return report.pos2;
    return null;
  }

  var api = {
    ALERT_NAMES: ALERT_NAMES,
    ALERT_TABS: ALERT_TABS,
    NATIVE_TABS: NATIVE_TABS,
    NATIVE_TAB_ALL: NATIVE_TAB_ALL,
    alertTab: alertTab,
    distinctAlertTab: distinctAlertTab,
    reportLinks: reportLinks,
    linkKindLabel: linkKindLabel,
    categoryName: categoryName,
    reportText: reportText,
    groupReports: groupReports,
    isCombatAlert: isCombatAlert,
    fightingLabel: fightingLabel,
    combatUnitRows: combatUnitRows,
    zoomTarget: zoomTarget
  };
  root.DwfAnnouncementFormat = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
