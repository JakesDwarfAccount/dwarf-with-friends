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

// WP-C client: player action attribution (wants-WT-spec §5 WT04 / §6 WT06).
//
// Fetches GET /attrib -- {world, buildings, orders, stockpiles, zones} -- and merges the
// creator name into inspect panels (building/workshop/stockpile/zone) and the work-orders list
// BY ID, entirely client-side (no server-side string splicing; the workshop/stockpile inspect
// JSON is lua-generated and passed through verbatim). Rendered as `● name` in that player's
// cursor color (window.DwfTiles.playerColor -- the one canonical helper, §1.4), gated by
// the `showAttribution` display toggle (default ON).
//
// GRACEFUL ON THE LIVE PRE-WP-C DLL: /attrib 404s there -> the maps stay empty, attribFor()
// returns null everywhere, no dots render, and nothing throws. The feature simply lies dormant
// until the WP-C DLL window lands.
//
// Pure helpers (attribParse / attribLookup / attribDotHtml / attribShouldShow) are node-exported
// at the bottom for the offline fixture test.

  // ---- pure helpers (node-testable) -----------------------------------------------------

  const ATTRIB_KINDS = ["buildings", "orders", "stockpiles", "zones"];

  // Map a caller kind ("building"/"order"/"stockpile"/"zone", singular or plural) to the
  // /attrib section key.
  function _attribSection(kind) {
    switch (String(kind == null ? "" : kind).toLowerCase()) {
      case "building": case "buildings": case "workshop": case "furnace": return "buildings";
      case "order": case "orders": case "workorder": return "orders";
      case "stockpile": case "stockpiles": return "stockpiles";
      case "zone": case "zones": return "zones";
      default: return null;
    }
  }

  // Normalize a raw /attrib payload into {world, buildings:{}, orders:{}, stockpiles:{}, zones:{}}
  // with string id keys, tolerating a missing/garbage payload (returns empty sections).
  function attribParse(payload) {
    const out = { world: "", buildings: {}, orders: {}, stockpiles: {}, zones: {} };
    if (!payload || typeof payload !== "object") return out;
    out.world = (typeof payload.world === "string") ? payload.world : "";
    for (const section of ATTRIB_KINDS) {
      const src = payload[section];
      if (src && typeof src === "object") {
        for (const k of Object.keys(src)) {
          const v = src[k];
          if (typeof v === "string" && v) out[section][String(k)] = v;
        }
      }
    }
    return out;
  }

  // Look up the creator of (kind, id) in a parsed state. Returns the player name or null.
  function attribLookup(state, kind, id) {
    if (!state || id == null) return null;
    const section = _attribSection(kind);
    if (!section || !state[section]) return null;
    const name = state[section][String(id)];
    return (typeof name === "string" && name) ? name : null;
  }

  // Whether the display toggle is on. Reads localStorage (default ON) with a browser-safe guard
  // so the pure test can force a value via the optional override.
  function attribShouldShow(override) {
    if (override === true || override === false) return override;
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem("dwf.showAttribution");
        if (v === "0" || v === "false") return false;
        if (v === "1" || v === "true") return true;
      }
    } catch (_) {}
    return true; // default ON (spec Q1)
  }

  // Build the `● name` attribution chip HTML for a player. colorOf lets the pure test inject a
  // deterministic color; in the browser it defaults to the canonical playerColor helper.
  function attribDotHtml(player, colorOf, escaper) {
    if (!player || typeof player !== "string") return "";
    const esc = (typeof escaper === "function") ? escaper
      : (typeof escapeHtml === "function") ? escapeHtml
      : (s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
    // playerColor returns {fill, dark} (canonical `.fill` usage per dwf-lobby.js) --
    // normalize either shape (string OR {fill}) from colorOf/playerColor to a CSS color string.
    const asCss = c => (typeof c === "string") ? c
      : (c && typeof c === "object" && typeof c.fill === "string") ? c.fill : "";
    let color = "";
    if (typeof colorOf === "function") color = asCss(colorOf(player));
    else if (typeof window !== "undefined" && window.DwfTiles &&
             typeof window.DwfTiles.playerColor === "function") {
      try { color = asCss(window.DwfTiles.playerColor(player)); } catch (_) { color = ""; }
    }
    const dot = `<span class="attrib-dot"${color ? ` style="color:${color}"` : ""}>&#9679;</span>`;
    return `<span class="attrib-chip" title="Ordered by ${esc(player)}">${dot}<span class="attrib-name">${esc(player)}</span></span>`;
  }

  // ---- browser state + fetch ------------------------------------------------------------

  let _attribState = { world: "", buildings: {}, orders: {}, stockpiles: {}, zones: {} };
  let _attribAt = 0;          // last successful/attempted fetch time
  let _attribInflight = null; // dedup concurrent refreshes
  let _attribSupported = null; // null=unknown, false=route 404 on this DLL (pre-WP-C)
  const ATTRIB_TTL_MS = 2000;

  // Fetch /attrib at most once per TTL. Graceful: a 404 (pre-WP-C DLL) or any error leaves the
  // prior state intact and marks the route unsupported so we stop hammering it.
  async function attribRefresh(force) {
    if (typeof fetch !== "function") return _attribState;
    const now = Date.now();
    if (!force && _attribSupported === false) return _attribState; // route absent: stay dormant
    if (!force && (now - _attribAt) < ATTRIB_TTL_MS) return _attribState;
    if (_attribInflight) return _attribInflight;
    _attribAt = now;
    _attribInflight = (async () => {
      try {
        const res = await fetch(`/attrib?t=${now}`, { cache: "no-store" });
        if (res.status === 404) { _attribSupported = false; return _attribState; }
        if (!res.ok) return _attribState;
        _attribSupported = true;
        _attribState = attribParse(await res.json());
      } catch (_) {
        // network/parse hiccup: keep the last good state, try again after the TTL.
      } finally {
        _attribInflight = null;
      }
      return _attribState;
    })();
    return _attribInflight;
  }

  // Synchronous lookup against the last-fetched state (callers kick attribRefresh() on their
  // own poll/open). Returns the player name or null.
  function attribFor(kind, id) {
    return attribLookup(_attribState, kind, id);
  }

  // The ready-to-inline chip for (kind, id), honoring the display toggle. "" when off / unknown.
  function attribRowHtml(kind, id) {
    if (!attribShouldShow()) return "";
    const player = attribFor(kind, id);
    return player ? attribDotHtml(player) : "";
  }

  function attribShowEnabled() { return attribShouldShow(); }
  function attribSetShow(on) {
    try {
      if (typeof localStorage !== "undefined")
        localStorage.setItem("dwf.showAttribution", on ? "1" : "0");
    } catch (_) {}
  }

  // One-time scoped CSS for the chip (injected from here so no shared CSS file is touched).
  function _attribInjectStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById("attrib-styles")) return;
    const style = document.createElement("style");
    style.id = "attrib-styles";
    style.textContent = `
      .attrib-chip{display:inline-flex;align-items:center;gap:3px;font-size:12px;opacity:.92;}
      .attrib-chip .attrib-dot{font-size:11px;line-height:1;}
      .attrib-chip .attrib-name{color:#c8b487;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", _attribInjectStyles);
    else _attribInjectStyles();
  }

  // Expose the browser API globally for the panels that render dots.
  if (typeof window !== "undefined") {
    window.attribRefresh = attribRefresh;
    window.attribFor = attribFor;
    window.attribRowHtml = attribRowHtml;
    window.attribShowEnabled = attribShowEnabled;
    window.attribSetShow = attribSetShow;
    window.dfAttrib = {
      refresh: attribRefresh, for: attribFor, rowHtml: attribRowHtml,
      showEnabled: attribShowEnabled, setShow: attribSetShow,
    };
  }

  // Node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { attribParse, attribLookup, attribShouldShow, attribDotHtml };
  }
