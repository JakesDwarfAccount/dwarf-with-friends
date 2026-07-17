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

// dwf-digest.js -- join-time "Since you left" digest.
//
// The digest is intentionally client-only: /reports already supports a monotonic since cursor
// (`nextReportId` -> next request's `since`) and report typeKeys. Each browser stores a per-player
// cursor in localStorage. First visit seeds the cursor without replaying the fort's whole history;
// later joins fetch the delta, aggregate the useful categories, advance the cursor, and show one
// dismissible, non-blocking panel if anything changed.

(function (root) {
  "use strict";

  var LS_PREFIX = "dwf.digest.lastSeen.";
  var MAX_FETCH = 300;
  var MAX_HEADLINES = 3;

  var CATEGORY_DEFS = [
    { id: "citizens", label: "New citizens" },
    { id: "deaths", label: "Deaths" },
    { id: "builds", label: "Completed builds" },
    { id: "events", label: "Sieges & events" },
  ];

  // announcement_alert_type names mirrored from dwf-unit-hud-notifications.js so this file
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
    try { name = encodeURIComponent(name); } catch (_) {}
    return LS_PREFIX + name;
  }

  function readWatermark(store, player) {
    try {
      var raw = store && store.getItem ? store.getItem(storageKey(player)) : null;
      if (raw == null || raw === "") return null;
      var n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    } catch (_) { return null; }
  }

  function writeWatermark(store, player, value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return false;
    try {
      if (store && store.setItem) store.setItem(storageKey(player), String(Math.floor(n)));
      return true;
    } catch (_) { return false; }
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

  // ---- WAVE-5 / R1: THE PRIVATE 8-HEX PALETTE IS GONE. ------------------------------------------
  // This block hard-coded its own colour table, and every colour in it was a SUPERSEDED one:
  //   #d89b27  the LEGACY gold. The MEASURED native frame gold is #ffbf01 (--dwfui-gold).
  //   #f2e6cf  "parchment" -- a MISNOMER that appears in ZERO DF menus (it is the outer game-frame
  //            art only). Native menu body text is white.
  //   #ffd45c / #e7dcc8 / #c8b790 / #a99b78 / #5a4316 / #6b5a2a / #29231a / #1c160c -- eight more
  //            one-off approximations of tones the shared tokens already declare exactly.
  // Every one is now a `var(--dwfui-*)` reference into dwf.css :root, so this panel and the rest
  // of the interface cannot drift apart, and R1 has nothing left to count.
  //
  // The block is NOT deleted, and the reason is load-bearing: it is not only a palette. It carries
  // the digest's whole EXISTENCE as an overlay -- `#dfDigestHost{position:fixed;inset:0}` plus the
  // panel's sizing/scroll box. There is no --dwfui-* rule that positions a fixed centred overlay, and
  // this lane may not edit CSS, so deleting the block would leave the digest an unpositioned div at
  // the bottom of <body>. The COLOURS were the drift; the LAYOUT is this file's own and stays here
  // until a CSS wave can rehome it (reported as CSS-GAP-W5C-DIGEST).
  function ensureStyle(doc) {
    if (!doc || doc.getElementById("dfDigestStyle")) return;
    var st = doc.createElement("style");
    st.id = "dfDigestStyle";
    st.textContent = [
      "#dfDigestHost{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;pointer-events:none;font-family:var(--dwfui-font-face)}",
      "#dfDigestPanel{width:min(520px,calc(100vw - 28px));max-height:min(70vh,520px);overflow:auto;pointer-events:auto;background:var(--dwfui-surface);border:1px solid var(--dwfui-gold);border-radius:6px;color:var(--dwfui-text-body);box-shadow:0 12px 32px rgba(0,0,0,.58)}",
      "#dfDigestPanel .dfd-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;border-bottom:1px solid var(--dwfui-gold-bevel-dark)}",
      "#dfDigestPanel .dfd-title{font-size:14px;font-weight:700;color:var(--dwfui-text-title)}",
      "#dfDigestPanel .dfd-close{border:1px solid var(--dwfui-gold-bevel-dark);background:var(--dwfui-surface);color:var(--dwfui-text-secondary);border-radius:4px;padding:2px 7px;cursor:pointer;font:inherit}",
      "#dfDigestPanel .dfd-body{padding:10px 12px 12px;display:grid;gap:10px}",
      "#dfDigestPanel .dfd-cat{display:grid;gap:4px;border-bottom:1px solid var(--dwfui-gold-bevel-dark);padding-bottom:8px}",
      "#dfDigestPanel .dfd-cat:last-child{border-bottom:0;padding-bottom:0}",
      "#dfDigestPanel .dfd-cat-title{font-size:12px;color:var(--dwfui-text-heading)}",
      "#dfDigestPanel .dfd-line{font-size:12px;line-height:1.35;color:var(--dwfui-text-body)}",
      "#dfDigestPanel .dfd-more{font-size:11px;color:var(--dwfui-text-secondary)}",
    ].join("");
    (doc.head || doc.documentElement).appendChild(st);
  }

  function closePanel() {
    var doc = root.document;
    var host = doc && doc.getElementById ? doc.getElementById("dfDigestHost") : null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    try { doc.removeEventListener("keydown", onKeyDown, true); } catch (_) {}
    try { doc.removeEventListener("pointerdown", onPointerDown, true); } catch (_) {}
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
      cls: "dfd-head", title: "Since you left", titleCls: "dfd-title",
      close: { cls: "dfd-close", dataset: { digestClose: "" }, title: "Dismiss digest", glyph: "Dismiss" },
    });
    var body = (summary.categories || []).map(function (cat) {
      var categoryTitle = cat.label + " (" + cat.count + ")";
      var lines = (cat.headlines || []).map(function (line) {
        return '<div class="dfd-line">' + root.DWFUI.esc(line) + "</div>";
      }).join("");
      var more = cat.count > (cat.headlines || []).length
        ? '<div class="dfd-more">+' + (cat.count - cat.headlines.length) + " more</div>" : "";
      return '<section class="dfd-cat"><div class="dfd-cat-title" aria-label="' + root.DWFUI.esc(categoryTitle) + '">' +
        root.DWFUI.statusHtml({ tag: "span", cls: "dfd-cat-title-copy", text: categoryTitle }) + "</div>" + lines + more + "</section>";
    }).join("");
    return head + '<div class="dfd-body">' + body + "</div>";
  }

  function renderDigest(summary, doc) {
    doc = doc || root.document;
    if (!doc || !summary || !summary.total) return null;
    ensureStyle(doc);
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
    var store = root.localStorage;
    var lastSeen = readWatermark(store, player);
    var firstSeen = lastSeen == null;
    var since = firstSeen ? -1 : lastSeen;
    try {
      var response = await root.fetch(reportsUrl(player, since, firstSeen ? 1 : MAX_FETCH), { cache: "no-store" });
      if (!response || !response.ok) return null;
      var page = await response.json();
      if (page && page.nextReportId != null) writeWatermark(store, player, page.nextReportId);
      if (firstSeen) return null;
      var summary = aggregateReports(page && page.reports);
      if (!summary.total) return null;
      if (canRender()) renderDigest(summary, root.document);
      return summary;
    } catch (_) {
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
    preparePreview: function () { ensureStyle(root.document); },
    _pure: pure,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = pure;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
