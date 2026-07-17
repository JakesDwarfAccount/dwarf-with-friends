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

// WT26 -- COMMAND CONSOLE: a browser equivalent of DFHack's native gui/launcher.
//
// WHO CAN USE IT: every authed player (decision 2026-07-13). Not host-only. The server refuses
// anonymous callers via the existing join-auth cookie gate; there is no loopback/host check.
//
// WHAT CONTAINS IT: a SERVER-SIDE blocklist (src/console_policy.h), which binds the host exactly as
// it binds a friend. This module ALSO greys blocked commands in the palette -- that is UX ONLY. The
// deny rules are SHIPPED BY THE SERVER in /console/commands ("denyRules"), never hardcoded here, and
// the server re-checks every single run against the same table. A patched client gains nothing.
//
// THE WARNING IS NOT DECORATION: a DFHack command runs under DF's core lock (CoreSuspender) for its
// whole duration and CANNOT be interrupted -- no timeout can abort it. A slow command freezes the
// fort FOR EVERY CONNECTED PLAYER until it finishes on its own. Since any friend can now press this
// button, the panel states that before the run and makes Run a two-step (arm -> confirm) action.
//
// DATA: the catalog (helpdb's own command list + short-help blurbs -- literally what native
// autocomplete ranks against) is fetched ONCE per panel open and filtered CLIENT-SIDE, so
// search-as-you-type costs zero round-trips and zero core-lock acquisitions. Only Run touches DF.
//
// The pure shapers (consoleDenyMatch / consoleFilter / consoleHistoryPush / consoleFreezeWarning /
// csRenderBody) take plain JSON and return display structs with NO DOM/fetch dependency, so
// tools/harness/console_panel_test.mjs exercises them (incl. seeded-bad rows) offline. They are
// node-exported at the bottom behind a browser-safe guard.

  // ---- pure data model (node-testable) --------------------------------------------------------

  const CONSOLE_HISTORY_MAX = 25;

  // The mandatory copy. Stated once, here, so the banner and the confirm step cannot drift apart.
  function consoleFreezeWarning() {
    return "This command runs under the world lock and CANNOT be interrupted — it may freeze the " +
      "fort for everyone until it finishes.";
  }

  // Split a command line into tokens (mirrors the server's coarse tokenizer: whitespace only).
  function _csTokens(line) {
    return String(line == null ? "" : line).trim().split(/\s+/).filter(Boolean);
  }

  // DISPLAY-ONLY deny check against the rules the SERVER shipped us. Same semantics as
  // dwf::console::command_denied (case-insensitive head; `prefix` = namespace, `exact` = whole
  // head), so the palette greys what the server will refuse. The TABLE is not duplicated -- it rides
  // the wire -- and the server re-checks anyway, so a divergence here is a cosmetic bug, never a
  // security hole. Returns {denied, reason} or {denied:false}.
  function consoleDenyMatch(rules, line) {
    const toks = _csTokens(line);
    if (!toks.length) return { denied: true, reason: "empty command" };
    const head = toks[0].toLowerCase();
    for (const rule of (Array.isArray(rules) ? rules : [])) {
      if (!rule || typeof rule.token !== "string") continue;
      const tok = rule.token.toLowerCase();
      const hit = rule.kind === "prefix" ? head.startsWith(tok) : head === tok;
      if (hit) return { denied: true, reason: String(rule.reason || "blocked by the host") };
    }
    // The server's one arg-aware rule: `prospect all` is a whole-embark scan; bare `prospect` is not.
    if (head === "prospect" && toks.slice(1).some(t => t.toLowerCase() === "all"))
      return { denied: true, reason: "`prospect all` scans the whole embark and freezes the fort" };
    return { denied: false };
  }

  // Search-as-you-type over the cached catalog. Ranks like the native launcher does: exact head
  // first, then prefix matches, then substring matches (name before blurb). DEFENSIVE: a garbage
  // catalog entry (missing/non-string name) is skipped rather than rendered as "undefined".
  // Blocked commands are NOT hidden -- they are marked, so a player learns why instead of hunting a
  // command that silently is not there.
  function consoleFilter(catalog, query, rules) {
    const list = Array.isArray(catalog) ? catalog : [];
    const q = String(query == null ? "" : query).trim().toLowerCase();
    const rows = [];
    for (const entry of list) {
      if (!entry || typeof entry.name !== "string" || !entry.name) continue;
      const name = entry.name;
      const short = typeof entry.short === "string" ? entry.short : "";
      const lname = name.toLowerCase();
      let rank;
      if (!q) rank = 3;
      else if (lname === q) rank = 0;
      else if (lname.startsWith(q)) rank = 1;
      else if (lname.indexOf(q) >= 0) rank = 2;
      else if (short.toLowerCase().indexOf(q) >= 0) rank = 4;
      else continue;
      const deny = consoleDenyMatch(rules, name);
      rows.push({ name, short, rank, blocked: deny.denied, reason: deny.denied ? deny.reason : "" });
    }
    rows.sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));
    return rows;
  }

  // Most-recent-first, de-duplicated, capped. Pure: returns a NEW array.
  function consoleHistoryPush(history, cmd) {
    const line = String(cmd == null ? "" : cmd).trim();
    const prev = Array.isArray(history) ? history.filter(h => typeof h === "string" && h.trim()) : [];
    if (!line) return prev.slice(0, CONSOLE_HISTORY_MAX);
    return [line, ...prev.filter(h => h !== line)].slice(0, CONSOLE_HISTORY_MAX);
  }

  // ---- render (DWFUI-built; no hand-rolled controls, no local palette) --------------------------

  function _csUI() { return (typeof window !== "undefined" && window.DWFUI) ? window.DWFUI : null; }

  function _csRowsHtml(D, rows) {
    if (!rows.length)
      return `<div class="cs-empty">No command matches that search.</div>`;
    return rows.map(r => D.rowHtml({
      cls: "cs-cmd-row", chassis: "slab", label: r.name,
      disabled: r.blocked,
      dataset: { csPick: r.name },
      title: r.blocked ? `Blocked: ${r.reason}` : (r.short || r.name),
      sub: r.blocked
        ? [{ text: r.short || "", cls: "cs-cmd-blurb" },
           { text: `Blocked — ${r.reason}`, tone: "warning" }]
        : { text: r.short || "", cls: "cs-cmd-blurb" },
    })).join("");
  }

  // The whole panel body from a plain state object. `state`:
  //   {catalog, denyRules, query, cmd, output, status, busy, armed, error, history}
  function csRenderBody(state) {
    const D = _csUI();
    if (!D) return "";
    const s = state && typeof state === "object" ? state : {};
    const rules = Array.isArray(s.denyRules) ? s.denyRules : [];
    const rows = consoleFilter(s.catalog, s.query, rules);
    const cmd = typeof s.cmd === "string" ? s.cmd : "";
    const deny = cmd.trim() ? consoleDenyMatch(rules, cmd) : { denied: false };

    // The freeze warning is ALWAYS on screen -- not only on the confirm step. Any friend can press
    // Run now, so the cost of a bad command is stated up front, permanently.
    const warn = D.statusHtml({
      cls: "cs-warn", tone: "warning", role: "note", text: consoleFreezeWarning(),
    });

    const search = D.searchHtml({
      cls: "cs-search", placement: "pane-header", magnifier: true, preserveKey: "console-search",
      dataAttr: "cs-search", value: s.query || "", placeholder: "Search commands…",
      ariaLabel: "Search DFHack commands",
    });

    const list = D.scrollHtml(
      { cls: "cs-list", preserveKey: "console-list", ariaLabel: "Command list" },
      _csRowsHtml(D, rows));

    const input = D.textInputHtml({
      cls: "cs-input", id: "csCmdInput", value: cmd, maxLength: 512,
      placeholder: "Type a command, e.g. ls", ariaLabel: "Command to run",
      dataset: { csCmd: "" },
    });

    // Two-step Run: the first press ARMS (and restates the freeze cost); the second executes. A
    // blocked command never arms at all -- the button is disabled and says why.
    const runLabel = s.busy ? "Running…" : (s.armed ? "Confirm — run it" : "Run");
    const run = D.plaqueBtnHtml({
      cls: "cs-run", label: runLabel, tone: s.armed ? "destructive" : "",
      dataset: { csRun: "" }, disabled: !!s.busy || !cmd.trim() || deny.denied,
      title: deny.denied ? deny.reason : consoleFreezeWarning(),
    });

    let banner = "";
    if (deny.denied && cmd.trim()) {
      banner = D.statusHtml({ cls: "cs-blocked", tone: "warning", role: "alert",
        text: `Blocked by the host: ${deny.reason}` });
    } else if (s.error) {
      banner = D.statusHtml({ cls: "cs-error", tone: "warning", role: "alert", text: String(s.error) });
    } else if (s.busy) {
      banner = D.statusHtml({ cls: "cs-busy", live: "polite",
        text: "Running — the fort is frozen for everyone until this command returns." });
    } else if (s.armed) {
      banner = D.statusHtml({ cls: "cs-arm", tone: "warning", role: "alert",
        text: `${consoleFreezeWarning()} Press again to run “${cmd.trim()}”.` });
    } else if (typeof s.status === "number") {
      banner = D.statusHtml({ cls: "cs-done",
        text: s.status === 0 ? "Command finished." : `Command returned status ${s.status}.` });
    }

    // Output: untrusted text end-to-end. It goes through esc() and NEVER into innerHTML raw.
    const outText = typeof s.output === "string" ? s.output : "";
    const output = D.scrollHtml(
      { cls: "cs-output", preserveKey: "console-output", ariaLabel: "Command output" },
      outText
        ? `<pre class="cs-output-text">${D.esc(outText)}</pre>`
        : `<div class="cs-empty">Output appears here.</div>`);

    const history = (Array.isArray(s.history) ? s.history : []).slice(0, 8);
    const historyHtml = history.length
      ? `<div class="cs-section-title">Recent</div><div class="cs-history">` +
        history.map(h => D.rowHtml({
          cls: "cs-hist-row", label: h, dataset: { csPick: h }, title: `Reuse: ${h}`,
        })).join("") + `</div>`
      : "";

    return warn +
      `<div class="cs-search-wrap">${search}</div>` +
      list +
      `<div class="cs-runbar">${input}${run}</div>` +
      banner +
      `<div class="cs-section-title">Output</div>` +
      output +
      historyHtml;
  }

  // ---- DOM shell + framework registration (mirrors the analytics panel) -------------------------

  let csShell = null;      // { panel, body }
  let csOpen = false;
  let csState = {
    catalog: [], denyRules: [], query: "", cmd: "", output: "", status: null,
    busy: false, armed: false, error: "", history: [], loaded: false,
  };

  const CS_HISTORY_KEY = "dwf.console.history";

  function _csLoadHistory() {
    try {
      const raw = localStorage.getItem(CS_HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(h => typeof h === "string") : [];
    } catch (_) { return []; }
  }
  function _csSaveHistory(history) {
    try { localStorage.setItem(CS_HISTORY_KEY, JSON.stringify(history)); } catch (_) {}
  }

  function csPaint() {
    if (!csShell) return;
    const D = _csUI();
    csShell.body.innerHTML = csRenderBody(csState);
    if (D) {
      try { D.paintSprites(csShell.body); } catch (_) {}
      try { D.paintBitmapText(csShell.body); } catch (_) {}
      try { D.restoreSearchCaret(csShell.body); } catch (_) {}
      try { D.restoreScroll(csShell.body); } catch (_) {}
    }
  }

  // Fetch the catalog ONCE per panel open (static for a play session). A server without the route
  // (old DLL) 404s -> the panel says so and stays inert; it never retries in a loop.
  async function csLoadCatalog() {
    if (csState.loaded) return;
    try {
      const r = await fetch("/console/commands", { cache: "no-store" });
      if (!r.ok) {
        // W23: a 403 {"guarded":true} means the HOST SETTING is off (dfhack_console). Surface the
        // server's own sentence -- the route is the gate; this panel just repeats its reason.
        let guarded = "";
        if (r.status === 403) {
          try { const g = await r.json(); if (g && g.guarded) guarded = g.error || ""; } catch (_) {}
        }
        csState.error = guarded
          ? guarded
          : (r.status === 404
              ? "This host has no command console (needs a plugin update)."
              : `Could not load the command list (${r.status}).`);
        csState.loaded = true;
        csPaint();
        return;
      }
      const j = await r.json();
      // safe_json() on the lua side turns an internal error into {"ok":false,"error":...} with a 200,
      // so a bare Array.isArray(commands) check would render that as a silently EMPTY palette. Say so.
      if (j && j.ok === false) {
        csState.error = `The host could not build the command list: ${j.error || "unknown error"}`;
        csState.catalog = [];
        csState.denyRules = Array.isArray(j.denyRules) ? j.denyRules : [];
        csState.loaded = true;
        csPaint();
        return;
      }
      csState.catalog = Array.isArray(j.commands) ? j.commands : [];
      csState.denyRules = Array.isArray(j.denyRules) ? j.denyRules : [];
      csState.loaded = true;
      csState.error = "";
    } catch (_) {
      csState.error = "Could not reach the host for the command list.";
      csState.loaded = true;
    }
    csPaint();
  }

  async function csRun() {
    const cmd = String(csState.cmd || "").trim();
    if (!cmd || csState.busy) return;
    // The client-side deny is UX only; the server refuses independently. Never bypass this by
    // "helpfully" sending anyway -- a 403 with the reason is exactly what should happen if it does.
    if (consoleDenyMatch(csState.denyRules, cmd).denied) { csPaint(); return; }
    if (!csState.armed) { csState.armed = true; csPaint(); return; }   // step 1: arm + warn

    csState.busy = true; csState.armed = false; csState.error = ""; csState.status = null;
    csPaint();
    try {
      const r = await fetch(`/console/run?cmd=${encodeURIComponent(cmd)}`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        csState.error = j && j.err ? String(j.err) : `Command refused (${r.status}).`;
        csState.output = "";
      } else {
        csState.output = typeof j.output === "string" ? j.output : "";
        csState.status = typeof j.status === "number" ? j.status : 0;
        csState.history = consoleHistoryPush(csState.history, cmd);
        _csSaveHistory(csState.history);
      }
    } catch (_) {
      csState.error = "The host did not answer — it may still be running the command.";
    }
    csState.busy = false;
    csPaint();
  }

  function csEnsureShell() {
    if (csShell || typeof document === "undefined") return csShell;
    const D = _csUI();
    if (D) D.require("console", ["headerHtml", "searchHtml", "scrollHtml", "rowHtml", "statusHtml",
                                "textInputHtml", "plaqueBtnHtml"]);
    const panel = document.createElement("div");
    panel.className = "cs-panel";
    panel.style.display = "none";
    const head = D ? D.headerHtml({ cls: "cs-head", title: "Command console", close: { title: "Close" } })
      : `<div class="cs-head">Command console</div>`;
    panel.innerHTML = `${head}<div class="cs-body"></div>`;
    document.body.appendChild(panel);
    panel.addEventListener("contextmenu", e => { e.preventDefault(); csClose(); });

    panel.addEventListener("click", e => {
      const t = e.target;
      if (t.closest && t.closest("[data-bld-close]")) { e.preventDefault(); csClose(); return; }
      const pick = t.closest && t.closest("[data-cs-pick]");
      if (pick) {
        e.preventDefault();
        csState.cmd = pick.dataset.csPick || "";
        csState.armed = false;                       // a new command must be re-armed
        csPaint();
        return;
      }
      if (t.closest && t.closest("[data-cs-run]")) { e.preventDefault(); csRun(); }
    });

    panel.addEventListener("input", e => {
      const t = e.target;
      if (t.dataset && "csSearch" in t.dataset) { csState.query = t.value || ""; csPaint(); return; }
      if (t.dataset && "csCmd" in t.dataset) {
        csState.cmd = t.value || "";
        csState.armed = false;                       // editing disarms; you re-confirm what you typed
        csPaint();
      }
    });

    // Enter in the command field arms/confirms exactly like the button, so the keyboard path can
    // never skip the confirmation the mouse path enforces.
    panel.addEventListener("keydown", e => {
      const t = e.target;
      if (t.dataset && "csCmd" in t.dataset && e.key === "Enter") { e.preventDefault(); csRun(); }
    });

    csShell = { panel, body: panel.querySelector(".cs-body") };
    if (typeof window !== "undefined" && window.DFPanelFrame) {
      window.DFPanelFrame.register({
        key: "console", el: () => csShell && csShell.panel, title: "Command console",
        headSel: ".cs-head", closable: true, resizable: { minW: 360, minH: 320 },
        fillSel: ".cs-body", persistOpen: false,
        defaultPos: () => ({ anchor: "tl", x: 110, y: 70, w: 520, h: 600 }),
        open: () => { if (!csOpen) openConsolePanel(); },
        close: () => csClose(),
        isOpen: () => csOpen, escClosable: true,
      });
    }
    return csShell;
  }

  function openConsolePanel() {
    const shell = csEnsureShell();
    if (!shell) return;
    if (!csState.history.length) csState.history = _csLoadHistory();
    shell.panel.style.display = "flex";
    csOpen = true;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("console", true); } catch (_) {}
    csPaint();
    csLoadCatalog();
  }

  function csClose() {
    csOpen = false;
    csState.armed = false;                           // never leave a live confirm behind a closed panel
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("console", false); } catch (_) {}
    if (csShell) csShell.panel.style.display = "none";
  }

  function toggleConsolePanel() { if (csOpen) csClose(); else openConsolePanel(); }

  // W23: the console is host-gated (flag dfhack_console, default OFF; the ROUTE refuses when
  // off -- see src/console_routes.cpp). The button is the honesty half: hidden unless the host
  // enabled the console, shown/hidden live off the DFWriteGuards poll, and if the host turns the
  // console off while the panel is open, the panel closes rather than sit there looking live.
  function csConsoleAllowed() {
    const wg = typeof window !== "undefined" ? window.DFWriteGuards : null;
    return !!(wg && wg.enabled("dfhack_console"));
  }

  function csApplyGuard() {
    const btn = typeof document !== "undefined" ? document.getElementById("consoleBtn") : null;
    const allowed = csConsoleAllowed();
    if (btn) btn.style.display = allowed ? "" : "none";
    if (!allowed && csOpen) csClose();
  }

  function csInstallButton() {
    if (typeof document === "undefined") return;
    const btn = document.getElementById("consoleBtn");
    if (!btn || btn._csHooked) return;
    btn._csHooked = true;
    btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggleConsolePanel(); });
    csApplyGuard();
    window.addEventListener("dfwriteguards", csApplyGuard);
  }

  if (typeof document !== "undefined") {
    const boot = () => { csEnsureShell(); csInstallButton(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  if (typeof window !== "undefined") {
    window.openConsolePanel = openConsolePanel;
    window.toggleConsolePanel = toggleConsolePanel;
    window.dfConsole = { open: openConsolePanel, toggle: toggleConsolePanel, close: csClose };
  }

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      consoleDenyMatch, consoleFilter, consoleHistoryPush, consoleFreezeWarning, csRenderBody,
      CONSOLE_HISTORY_MAX,
    };
  }
