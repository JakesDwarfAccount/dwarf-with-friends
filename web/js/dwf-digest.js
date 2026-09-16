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

// ---- Join-time "Since you left" digest: client-only, riding /reports' monotonic `since` cursor. ----
// The first visit seeds the cursor without replaying the fort's whole history.

(function (root) {
  "use strict";

  var LS_PREFIX = "dwf.digest.lastSeen.";
  var MAX_FETCH = 300;
  var MAX_HEADLINES = 3;

  function reportDigest(key, err) {
    if (root.DwfErr && typeof root.DwfErr.report === "function") root.DwfErr.report(key, err);
  }

  var CATEGORY_DEFS = [
    { id: "citizens", label: "New citizens" },
    { id: "deaths", label: "Deaths" },
    { id: "builds", label: "Completed builds" },
    { id: "events", label: "Sieges & events" },
  ];

  // announcement_alert_type names mirrored from dwf-announcement-viewer.js so this file
  // can classify /reports without depending on that module's private constants.
  var ALERT_NAMES = [
    "General", "Era Change", "Underground", "Migrants", "Monster", "Ambush",
    "Trade", "Noble", "Animal", "Birth", "Mood", "Labor Change", "Military",
    "Marriage", "Berserk", "Martial Trance", "Emotion", "Stress",
    "Art Defacement", "Masterpiece", "Job Failed", "Death", "Ghost",
    "Undead Attack", "Weather", "Vermin", "Curious Guzzler",
    "Research Breakthrough", "Guest Arrival", "Holdings", "Rumor",
    "Agreement", "Crime", "Deity Curse", "Combat", "Sparring", "Hunting"
  ];

  var EVENT_TYPE_KEYS = new Set([
    "STRUCK_DEEP_METAL",
    "AMBUSH_THIEF_SUPPORT_SKULKING",
    "AMBUSH_THIEF_SUPPORT_NATURE",
    "AMBUSH_THIEF_SUPPORT",
    "AMBUSH_SNATCHER_SUPPORT",
    "AMBUSH_AMBUSHER_NATURE",
    "AMBUSH_AMBUSHER",
    "MADE_ARTIFACT",
    "FEATURE_DISCOVERY",
    "ENDGAME_EVENT_2",
    "MEGABEAST_ARRIVAL",
    "WEREBEAST_ARRIVAL",
    "UNDEAD_ATTACK",
    "STRANGE_MOOD",
    "MARRIAGE"
  ]);

  function normalizedText(report) {
    if (!report) return "";
    var text = report.text != null ? String(report.text) : "";
    var repeat = Number(report.repeatCount);
    if (text && repeat > 0) text += " x" + (repeat + 1);
    if (text) return text;
    var key = report.typeKey != null ? String(report.typeKey) : "Report";
    return key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, function (ch) { return ch.toUpperCase(); });
  }

  function includesAny(haystack, needles) {
    for (var i = 0; i < needles.length; i++) {
      if (haystack.indexOf(needles[i]) >= 0) return true;
    }
    return false;
  }

  function alertName(report) {
    var i = Number(report && report.alertType);
    return Number.isFinite(i) && ALERT_NAMES[i] ? ALERT_NAMES[i] : "";
  }

  function categorizeReport(report) {
    var key = String(report && report.typeKey || "").toUpperCase();
    var text = normalizedText(report).toLowerCase();
    var alert = alertName(report).toLowerCase();

    // Job cancellations are operational spam, and filtering them first also stops a profession such as
    // "Siege Operator" tripping the event substring matcher.
    if (includesAny(key, ["JOB_CANCEL"]) || /\bcancels?\b/.test(text)) return null;

    if (alert === "death" || includesAny(key, ["DEATH", "DIED", "SLAIN", "MURDER"]) ||
        includesAny(text, [" has died", " has been found dead", " has been slain", " has bled to death", " starved to death", " drowned"])) {
      return "deaths";
    }
    if (alert === "birth" || alert === "migrants" || key === "BIRTH_CITIZEN" ||
        includesAny(key, ["MIGRANT", "CITIZEN_BIRTH", "NEW_CITIZEN"]) ||
        includesAny(text, ["gave birth", "has been born", "migrants arrived", "some migrants", "new arrival", "petition accepted"])) {
      return "citizens";
    }
    if (includesAny(key, ["CONSTRUCTION", "BUILDING", "WORKSHOP", "FURNACE", "BRIDGE", "ROAD"]) ||
        includesAny(text, ["construction", "completed", "built", "constructed", "workshop", "furnace", "bridge", "wall", "floor", "stair", "road"])) {
      return "builds";
    }
    if (EVENT_TYPE_KEYS.has(key) || alert === "monster" || alert === "ambush" || alert === "undead attack" ||
        alert === "underground" || alert === "mood" || alert === "marriage" || alert === "masterpiece" ||
        includesAny(key, ["SIEGE", "AMBUSH", "MEGABEAST", "WEREBEAST", "UNDEAD", "MOOD", "ARTIFACT", "DISCOVERY", "ENDGAME"]) ||
        includesAny(text, ["siege", "ambush", "vile force", "forgotten beast", "werebeast", "undead", "strange mood", "artifact", "cavern", "struck", "wedding", "married"])) {
      return "events";
    }
    return null;
  }

  function emptySummary() {
    var byId = {};
    var categories = CATEGORY_DEFS.map(function (def) {
      var row = { id: def.id, label: def.label, count: 0, headlines: [] };
      byId[def.id] = row;
      return row;
    });
    return { total: 0, categories: categories, byId: byId };
  }

  function aggregateReports(reports) {
    var summary = emptySummary();
    (Array.isArray(reports) ? reports : []).forEach(function (report) {
      if (!report || report.continuation) return;
      var cat = categorizeReport(report);
      if (!cat || !summary.byId[cat]) return;
      var row = summary.byId[cat];
      row.count++;
      summary.total++;
      if (row.headlines.length < MAX_HEADLINES) row.headlines.push(normalizedText(report));
    });
    summary.categories = summary.categories.filter(function (row) { return row.count > 0; });
    delete summary.byId;
    return summary;
  }

  function storageKey(player) {
    var name = String(player || "player").trim() || "player";
    try { name = encodeURIComponent(name); }
    catch (err) { reportDigest("digest.watermark-key", err); }
    return LS_PREFIX + name;
  }

  function readWatermark(store, player) {
    try {
      var key = storageKey(player);
      var raw = store && store.getItem ? store.getItem(key) :
        (root.DwfUtil ? root.DwfUtil.lsGet(key, function (err) { reportDigest("digest.watermark-read", err); }) : null);
      if (raw == null || raw === "") return null;
      var n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    } catch (err) {
      reportDigest("digest.watermark-read", err);
      return null;
    }
  }

  function writeWatermark(store, player, value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return false;
    try {
      var key = storageKey(player), encoded = String(Math.floor(n));
      if (store && store.setItem) { store.setItem(key, encoded); return true; }
      return root.DwfUtil ? root.DwfUtil.lsSet(key, encoded,
        function (err) { reportDigest("digest.watermark-write", err); }) : false;
    } catch (err) {
      reportDigest("digest.watermark-write", err);
      return false;
    }
  }

  function reportsUrl(player, since, max) {
    var params = new root.URLSearchParams();
    params.set("player", String(player || ""));
    params.set("since", String(since));
    params.set("max", String(max || MAX_FETCH));
    params.set("t", String(root.Date.now()));
    return "/reports?" + params.toString();
  }

  function canRender() {
    return !!(root.document && root.document.createElement && root.document.body);
  }

  function closePanel() {
    var doc = root.document;
    var host = doc && doc.getElementById ? doc.getElementById("dfDigestHost") : null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    try { doc.removeEventListener("keydown", onKeyDown, true); }
    catch (err) { reportDigest("digest.detach-keydown", err); }
    try { doc.removeEventListener("pointerdown", onPointerDown, true); }
    catch (err) { reportDigest("digest.detach-pointer", err); }
  }

  function onPointerDown() {
    closePanel();
  }

  function onKeyDown(ev) {
    if (ev && ev.key === "Escape") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closePanel();
    }
  }

  function digestPanelMarkup(summary) {
    if (!summary || !summary.total) return "";
    var head = root.DWFUI.headerHtml({
      cls: "digest-head", title: "Since you left", titleCls: "digest-title",
      close: { cls: "digest-close", dataset: { digestClose: "" }, title: "Dismiss digest", glyph: "Dismiss" },
    });
    var body = (summary.categories || []).map(function (cat) {
      var categoryTitle = cat.label + " (" + cat.count + ")";
      var lines = (cat.headlines || []).map(function (line) {
        return '<div class="digest-line">' + root.DWFUI.esc(line) + "</div>";
      }).join("");
      var more = cat.count > (cat.headlines || []).length
        ? '<div class="digest-more">+' + (cat.count - cat.headlines.length) + " more</div>" : "";
      return '<section class="digest-cat"><div class="digest-cat-title" aria-label="' + root.DWFUI.esc(categoryTitle) + '">' +
        root.DWFUI.statusHtml({ tag: "span", cls: "digest-cat-title-copy", text: categoryTitle }) + "</div>" + lines + more + "</section>";
    }).join("");
    return head + '<div class="digest-body">' + body + "</div>";
  }

  function renderDigest(summary, doc) {
    doc = doc || root.document;
    if (!doc || !summary || !summary.total) return null;
    closePanel();

    var host = doc.createElement("div");
    host.id = "dfDigestHost";
    var panel = doc.createElement("div");
    panel.id = "dfDigestPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Since you left");

    panel.innerHTML = digestPanelMarkup(summary);
    var close = panel.querySelector("[data-digest-close]");
    if (close) close.addEventListener("click", closePanel);
    host.appendChild(panel);
    doc.body.appendChild(host);
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("pointerdown", onPointerDown, true);
    return host;
  }

  var inFlight = false;
  async function onJoinComplete(opts) {
    opts = opts || {};
    if (inFlight) return null;
    inFlight = true;
    var player = String(opts.player || opts.playerName || "");
    var lastSeen = readWatermark(null, player);
    var firstSeen = lastSeen == null;
    var since = firstSeen ? -1 : lastSeen;
    try {
      var response = await root.fetch(reportsUrl(player, since, firstSeen ? 1 : MAX_FETCH), { cache: "no-store" });
      if (!response || !response.ok) return null;
      var page = await response.json();
      if (page && page.nextReportId != null) writeWatermark(null, player, page.nextReportId);
      if (firstSeen) return null;
      var summary = aggregateReports(page && page.reports);
      if (!summary.total) return null;
      if (canRender()) renderDigest(summary, root.document);
      return summary;
    } catch (err) {
      reportDigest("digest.fetch", err);
      return null;
    } finally {
      inFlight = false;
    }
  }

  var pure = {
    LS_PREFIX: LS_PREFIX,
    CATEGORY_DEFS: CATEGORY_DEFS,
    storageKey: storageKey,
    readWatermark: readWatermark,
    writeWatermark: writeWatermark,
    reportsUrl: reportsUrl,
    normalizedText: normalizedText,
    categorizeReport: categorizeReport,
    aggregateReports: aggregateReports,
    renderDigest: renderDigest,
    digestPanelMarkup: digestPanelMarkup,
  };

  root.DwfDigest = {
    onJoinComplete: onJoinComplete,
    close: closePanel,
    storyMarkup: digestPanelMarkup,
    preparePreview: function () {},
    _pure: pure,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = pure;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
