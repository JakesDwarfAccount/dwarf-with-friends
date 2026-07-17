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

// WT13 "Fortress activity" -- a summonable analytics overview of what players have DONE.
//
// DATA LAYER (what actually exists, be precise): the plugin's AttributionRegistry (src/
// attribution.cpp) stamps a creator name onto every web-issued mutation that returns a stable DF
// id -- BUILDINGS (workshops/furnaces/furniture AND each tile of a multi-tile construction, so a
// 10-tile wall = 10 building ids), STOCKPILES, ZONES (rooms), and manager WORK ORDERS. It is
// exposed verbatim as GET /attrib = {world, buildings:{id:name}, orders, stockpiles, zones}.
// This screen AGGREGATES that map CLIENT-SIDE (count ids per name per section) -- no server change.
//
// THE COUNTING WINDOW (stated honestly, in the UI too): the registry lives in plugin memory,
// SESSION-ONLY. It survives a browser refresh (the server holds it), but it resets when the host
// restarts Dwarf Fortress / reloads the plugin / switches world (attribution.cpp clears on a new
// save_dir). So these are "since the fort was loaded" counts -- NOT all-time. analyticsWindowLabel()
// says exactly that and it is rendered at the top of the panel.
//
// WHAT IS NOT TRACKED (honest gaps, surfaced as greyed "not tracked yet" rows, never faked):
// dig/mining, tree-cutting, plant gathering, smoothing/engraving, item marking (forbid/dump/claim),
// squad/military orders -- all are tile/item DESIGNATIONS with no stable object id to attribute, so
// the registry never sees them. When the attribution layer grows to cover them, they graduate from
// the gaps list to real columns.
//
// UI: built entirely from DWFUI (headerHtml + statTileHtml + barRowHtml + rowHtml) -- no hand-rolled
// markup, no per-module palette (all colours live in web/css/dwf.css .an-* / .dwfui-*).
//
// The pure shapers (analyticsAggregate / analyticsWindowLabel + the ANALYTICS_* tables) take plain
// JSON and return display structs with NO DOM/fetch dependency, so
// tools/harness/analytics_fixture_test.mjs exercises them (incl. seeded-bad rows) offline. They are
// node-exported at the bottom behind a browser-safe guard.

  // ---- pure data model (node-testable) --------------------------------------------------------

  // The four attributed action kinds, in display order, each with a friendly label + blurb. `key`
  // MUST match the /attrib section name (attribution.cpp map_for()).
  const ANALYTICS_KINDS = [
    { key: "buildings",  label: "Constructions", blurb: "workshops, furniture & built tiles" },
    { key: "zones",      label: "Rooms & zones", blurb: "bedrooms, dining halls, pastures…" },
    { key: "stockpiles", label: "Stockpiles",    blurb: "where the hauling piles up" },
    { key: "orders",     label: "Work orders",   blurb: "manager queue jobs" },
  ];

  // Player actions that genuinely happen but are NOT attributed today (no stable id). Rendered as
  // greyed "not tracked yet" rows so the screen is honest about its own blind spots.
  const ANALYTICS_UNTRACKED = [
    { label: "Digging & mining",                note: "tile designations aren't stamped with a player yet" },
    { label: "Tree cutting & gathering",        note: "designation jobs — no stable id to attribute" },
    { label: "Smoothing & engraving",           note: "designation jobs — not attributed" },
    { label: "Item marking (forbid / dump / claim)", note: "acts on items, not attributed" },
    { label: "Squad & military orders",         note: "not attributed yet" },
  ];

  // Aggregate a /attrib payload (raw OR already attribParse'd -- same {world, buildings, ...} shape)
  // into per-player counts. DEFENSIVE by design: counts only non-empty STRING creator names, so a
  // garbage/partial payload (numeric or empty values, a missing section, null/42) yields an honest
  // empty result and never throws or fabricates a count for an unknown creator.
  function analyticsAggregate(payload) {
    const src = (payload && typeof payload === "object") ? payload : {};
    const world = typeof src.world === "string" ? src.world : "";
    const byPlayer = new Map(); // name -> {buildings, zones, stockpiles, orders}
    const grand = { buildings: 0, zones: 0, stockpiles: 0, orders: 0 };
    for (const kind of ANALYTICS_KINDS) {
      const section = src[kind.key];
      if (!section || typeof section !== "object") continue;
      for (const id of Object.keys(section)) {
        const name = section[id];
        if (typeof name !== "string" || !name) continue; // unknown/garbage creator -> never counted
        let rec = byPlayer.get(name);
        if (!rec) { rec = { buildings: 0, zones: 0, stockpiles: 0, orders: 0 }; byPlayer.set(name, rec); }
        rec[kind.key] += 1;
        grand[kind.key] += 1;
      }
    }
    const players = [...byPlayer.entries()].map(([name, counts]) => ({
      name, counts,
      total: counts.buildings + counts.zones + counts.stockpiles + counts.orders,
    })).sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
    const grandTotal = grand.buildings + grand.zones + grand.stockpiles + grand.orders;
    // Fun derived stats -- ONLY when real data backs them (null otherwise; the UI omits the tile).
    const busiest = (players.length && players[0].total > 0)
      ? { name: players[0].name, total: players[0].total } : null;
    let topBuilder = null;
    for (const p of players) {
      if (p.counts.buildings > 0 && (!topBuilder || p.counts.buildings > topBuilder.count))
        topBuilder = { name: p.name, count: p.counts.buildings };
    }
    return {
      world, players, grand, grandTotal, playerCount: players.length,
      empty: grandTotal === 0,
      fun: { busiest, topBuilder },
    };
  }

  // The honest window statement, rendered at the top of the panel. NEVER claims "all-time".
  function analyticsWindowLabel() {
    return "This session — counted since the fort was loaded. Resets when the host restarts " +
      "Dwarf Fortress or switches world.";
  }

  // ---- render (browser-only, DWFUI-built) -----------------------------------------------------

  function _anUI() { return (typeof window !== "undefined" && window.DWFUI) ? window.DWFUI : null; }

  // "12 constructions · 3 rooms · 2 stockpiles" -- omit zero kinds; naive pluralize.
  function _anBreakdown(counts) {
    const unit = { buildings: "construction", zones: "room", stockpiles: "stockpile", orders: "work order" };
    const parts = [];
    for (const kind of ANALYTICS_KINDS) {
      const n = counts[kind.key];
      if (n > 0) parts.push(`${n} ${unit[kind.key]}${n === 1 ? "" : "s"}`);
    }
    return parts.join(" · ");
  }

  function _anUntrackedHtml(D) {
    const rows = ANALYTICS_UNTRACKED.map(u => D.rowHtml({
      cls: "an-untracked-row", label: u.label,
      sub: { text: u.note, cls: "an-untracked-note" },
      trailing: `<span class="an-dash">—</span>`,
    })).join("");
    return `<div class="an-section-title">Not tracked yet</div>` +
      `<div class="an-kinds">${rows}</div>`;
  }

  // Build the whole panel body from an aggregate. Pure string assembly (DOM-free besides DWFUI).
  function anRenderBody(agg) {
    const D = _anUI();
    if (!D) return "";
    const windowLine = `<div class="an-window">${D.esc(analyticsWindowLabel())}</div>`;
    if (!agg || agg.empty) {
      return windowLine +
        `<div class="an-empty">No tracked activity yet. Build something, designate a room, drop a ` +
        `stockpile, or queue a work order — it'll show up here.</div>` +
        _anUntrackedHtml(D);
    }
    // Stat tiles -- each fun stat only rendered when real data backs it.
    const tiles = [
      D.statTileHtml({
        label: "Things built & designated", value: agg.grandTotal, tone: "gold",
        sub: `${agg.playerCount} ${agg.playerCount === 1 ? "player" : "players"}`,
      }),
      agg.fun.busiest ? D.statTileHtml({
        label: "Busiest overseer", value: agg.fun.busiest.name, tone: "green",
        sub: `${agg.fun.busiest.total} things`,
      }) : "",
      agg.fun.topBuilder ? D.statTileHtml({
        label: "Master builder", value: agg.fun.topBuilder.name, tone: "gold",
        sub: `${agg.fun.topBuilder.count} construction${agg.fun.topBuilder.count === 1 ? "" : "s"}`,
      }) : "",
    ].join("");
    const tilesRow = `<div class="an-tiles">${tiles}</div>`;
    // Per-player leaderboard as proportional bar rows (bar = share of the busiest player's total).
    const max = agg.players[0].total || 1;
    const bars = agg.players.map(p => D.barRowHtml({
      label: p.name, value: p.total, max, tone: "gold",
      sub: _anBreakdown(p.counts),
    })).join("");
    const board = `<div class="an-section-title">Who's been busy</div>` +
      `<div class="an-board">${bars}</div>`;
    // By-kind totals.
    const kindRows = ANALYTICS_KINDS.map(k => D.rowHtml({
      cls: "an-kind-row", label: k.label,
      sub: { text: k.blurb, cls: "an-kind-blurb" },
      trailing: `<span class="an-kind-total">${agg.grand[k.key]}</span>`,
    })).join("");
    const kinds = `<div class="an-section-title">By kind</div>` +
      `<div class="an-kinds">${kindRows}</div>`;
    return windowLine + tilesRow + board + kinds + _anUntrackedHtml(D);
  }

  // ---- DOM shell + framework registration (mirrors the combat-log panel) -----------------------

  let anShell = null;   // { panel, body }
  let anOpen = false;
  let anTimer = null;   // live-refresh interval while open

  function anEnsureShell() {
    if (anShell || typeof document === "undefined") return anShell;
    const D = _anUI();
    const panel = document.createElement("div");
    panel.className = "an-panel";
    panel.style.display = "none";
    const head = D ? D.headerHtml({ cls: "an-head", title: "Fortress activity", close: { title: "Close" } })
      : `<div class="an-head">Fortress activity</div>`;
    panel.innerHTML = `${head}<div class="an-body"></div>`;
    document.body.appendChild(panel);
    // Right-click anywhere closes (native DF convention, matching the combat log).
    panel.addEventListener("contextmenu", e => { e.preventDefault(); anClose(); });
    // The DWFUI header close (data-bld-close) closes too -- wired directly so it works even if the
    // framework never adopted the header (dormant / old cached page).
    panel.addEventListener("click", e => {
      if (e.target.closest && e.target.closest("[data-bld-close]")) { e.preventDefault(); anClose(); }
    });
    anShell = { panel, body: panel.querySelector(".an-body") };
    if (typeof window !== "undefined" && window.DFPanelFrame) {
      window.DFPanelFrame.register({
        key: "analytics", el: () => anShell && anShell.panel, title: "Fortress activity",
        headSel: ".an-head", closable: true, resizable: { minW: 340, minH: 260 },
        fillSel: ".an-body", persistOpen: false,
        defaultPos: (vw, vh) => ({ anchor: "tl", x: 80, y: 60, w: 460, h: 520 }),
        open: () => { if (!anOpen) openAnalyticsPanel(); },
        close: () => anClose(),
        isOpen: () => anOpen, escClosable: true,
      });
    }
    return anShell;
  }

  // Fetch the latest attribution registry, aggregate it, and paint. Prefers the attribution
  // module's own refresh (shared TTL/dedup + parsed state); falls back to a raw /attrib fetch.
  async function anLoad() {
    let state = {};
    try {
      if (typeof window !== "undefined" && typeof window.attribRefresh === "function") {
        state = (await window.attribRefresh(true)) || {};
      } else if (typeof fetch === "function") {
        const r = await fetch(`/attrib?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) state = await r.json();
      }
    } catch (_) { /* keep the last paint; try again on the next tick */ }
    if (!anShell) return;
    anShell.body.innerHTML = anRenderBody(analyticsAggregate(state));
  }

  function openAnalyticsPanel() {
    const shell = anEnsureShell();
    if (!shell) return;
    shell.panel.style.display = "flex";
    anOpen = true;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("analytics", true); } catch (_) {}
    anLoad();
    if (!anTimer) anTimer = setInterval(() => { if (anOpen) anLoad(); }, 3000);
  }

  function anClose() {
    anOpen = false;
    if (anTimer) { clearInterval(anTimer); anTimer = null; }
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("analytics", false); } catch (_) {}
    if (anShell) anShell.panel.style.display = "none";
  }

  function toggleAnalyticsPanel() { if (anOpen) anClose(); else openAnalyticsPanel(); }

  // Topbar summon button (#analyticsBtn, alongside lobby/settings/help). The panel is ALSO reachable
  // from the settings cog's "Panels" list for free (DFPanelFrame lists every registered panel).
  function anInstallButton() {
    if (typeof document === "undefined") return;
    const btn = document.getElementById("analyticsBtn");
    if (!btn || btn._anHooked) return;
    btn._anHooked = true;
    btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggleAnalyticsPanel(); });
  }

  if (typeof document !== "undefined") {
    const boot = () => { anEnsureShell(); anInstallButton(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  // Expose the openers globally so the topbar button, cog Panels list, or a future hotkey can launch.
  if (typeof window !== "undefined") {
    window.openAnalyticsPanel = openAnalyticsPanel;
    window.toggleAnalyticsPanel = toggleAnalyticsPanel;
    window.dfAnalytics = { open: openAnalyticsPanel, toggle: toggleAnalyticsPanel, close: anClose };
  }

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      analyticsAggregate, analyticsWindowLabel, anRenderBody,
      ANALYTICS_KINDS, ANALYTICS_UNTRACKED,
    };
  }
