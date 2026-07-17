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

  function reportText(report) {
    if (!report) return "";
    var text = report.text == null ? "" : String(report.text);
    if (!text) return "";
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

  // A zoom type of -1 is DF's explicit NONE. Older payloads have no zoomType, so retain the
  // valid-position fallback. Prefer the primary target, then the additive secondary target.
  function zoomTarget(report) {
    if (!report) return null;
    if (report.pos && Number(report.zoomType) !== -1) return report.pos;
    if (report.pos2 && Number(report.zoomType2) !== -1) return report.pos2;
    return null;
  }

  var api = {
    ALERT_NAMES: ALERT_NAMES,
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
