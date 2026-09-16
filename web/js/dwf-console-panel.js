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

// dwf-console-panel.js -- the command console. The SERVER-SIDE blocklist (src/console_policy.h)
// is the only gate; greying a blocked command here is presentation, never enforcement.

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

  // DISPLAY-ONLY deny check against the rules the SERVER shipped. The table is not duplicated -- it rides
  // the wire -- and the server re-checks anyway, so a divergence here is cosmetic, never a security hole.
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

  // Ranks exact head, then prefix, then substring. A garbage catalog entry is skipped rather than rendered
  // as "undefined", and blocked commands are MARKED, never hidden.
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
      return `<div class="console-empty">No command matches that search.</div>`;
    return rows.map(r => D.rowHtml({
      cls: "console-cmd-row", chassis: "slab", label: r.name,
      disabled: r.blocked,
      dataset: { csPick: r.name },
      title: r.blocked ? `Blocked: ${r.reason}` : (r.short || r.name),
      sub: r.blocked
        ? [{ text: r.short || "", cls: "console-cmd-blurb" },
           { text: `Blocked — ${r.reason}`, tone: "warning" }]
        : { text: r.short || "", cls: "console-cmd-blurb" },
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
      cls: "console-warn", tone: "warning", role: "note", text: consoleFreezeWarning(),
    });

    const search = D.searchHtml({
      cls: "console-search", placement: "pane-header", magnifier: true, preserveKey: "console-search",
      dataAttr: "console-search", value: s.query || "", placeholder: "Search commands…",
      ariaLabel: "Search DFHack commands",
    });

    const list = D.scrollHtml(
      { cls: "console-list", preserveKey: "console-list", ariaLabel: "Command list" },
      _csRowsHtml(D, rows));

    const input = D.textInputHtml({
      cls: "console-input", id: "csCmdInput", value: cmd, maxLength: 512,
      placeholder: "Type a command, e.g. ls", ariaLabel: "Command to run",
      dataset: { csCmd: "" },
    });

    // Two-step Run: the first press ARMS (and restates the freeze cost); the second executes. A
    // blocked command never arms at all -- the button is disabled and says why.
    const runLabel = s.busy ? "Running…" : (s.armed ? "Confirm — run it" : "Run");
    const run = D.plaqueBtnHtml({
      cls: "console-run", label: runLabel, tone: s.armed ? "destructive" : "",
      dataset: { csRun: "" }, disabled: !!s.busy || !cmd.trim() || deny.denied,
      title: deny.denied ? deny.reason : consoleFreezeWarning(),
    });

    let banner = "";
    if (deny.denied && cmd.trim()) {
      banner = D.statusHtml({ cls: "console-blocked", tone: "warning", role: "alert",
        text: `Blocked by the host: ${deny.reason}` });
    } else if (s.error) {
      banner = D.statusHtml({ cls: "console-error", tone: "warning", role: "alert", text: String(s.error) });
    } else if (s.busy) {
      banner = D.statusHtml({ cls: "console-busy", live: "polite",
        text: "Running — the fort is frozen for everyone until this command returns." });
    } else if (s.armed) {
      banner = D.statusHtml({ cls: "console-arm", tone: "warning", role: "alert",
        text: `${consoleFreezeWarning()} Press again to run “${cmd.trim()}”.` });
    } else if (typeof s.status === "number") {
      banner = D.statusHtml({ cls: "console-done",
        text: s.status === 0 ? "Command finished." : `Command returned status ${s.status}.` });
    }

    // Output: untrusted text end-to-end. It goes through esc() and NEVER into innerHTML raw.
    const outText = typeof s.output === "string" ? s.output : "";
    const output = D.scrollHtml(
      { cls: "console-output", preserveKey: "console-output", ariaLabel: "Command output" },
      outText
        // UI-DIV-004: command output is meant to be selected and copied, so it opts OUT of the
        // drag-anywhere surface grab. The rest of the console panel still drags from anywhere.
        ? `<pre class="console-output-text" data-pf-nodrag>${D.esc(outText)}</pre>`
        : `<div class="console-empty">Output appears here.</div>`);

    const history = (Array.isArray(s.history) ? s.history : []).slice(0, 8);
    const historyHtml = history.length
      ? `<div class="console-section-title">Recent</div><div class="console-history">` +
        history.map(h => D.rowHtml({
          cls: "console-hist-row", label: h, dataset: { csPick: h }, title: `Reuse: ${h}`,
        })).join("") + `</div>`
      : "";

    return warn +
      `<div class="console-search-wrap">${search}</div>` +
      list +
      `<div class="console-runbar">${input}${run}</div>` +
      banner +
      `<div class="console-section-title">Output</div>` +
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
    const raw = globalThis.DwfUtil.lsGet(CS_HISTORY_KEY,
      err => DwfErr.report("console.history.read", err));
    try {
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(h => typeof h === "string") : [];
    } catch (err) {
      DwfErr.report("console.history.parse", err);
      return [];
    }
  }
  function _csSaveHistory(history) {
    let encoded;
    try { encoded = JSON.stringify(history); }
    catch (err) {
      DwfErr.report("console.history.encode", err);
      return;
    }
    globalThis.DwfUtil.lsSet(CS_HISTORY_KEY, encoded,
      err => DwfErr.report("console.history.write", err));
  }

  function csPaintStep(operation, fn) {
    try {
      const pending = fn();
      if (pending && typeof pending.catch === "function")
        pending.catch(err => DwfErr.report(`console.${operation}`, err));
    }
    catch (err) { DwfErr.report(`console.${operation}`, err); }
  }

  function csPaint() {
    if (!csShell) return;
    const D = _csUI();
    csShell.body.innerHTML = csRenderBody(csState);
    if (D) {
      csPaintStep("paint-sprites", () => D.paintSprites(csShell.body));
      csPaintStep("paint-bitmap-text", () => D.paintBitmapText(csShell.body));
      csPaintStep("restore-search-caret", () => D.restoreSearchCaret(csShell.body));
      csPaintStep("restore-scroll", () => D.restoreScroll(csShell.body));
    }
  }

  // Fetch the catalog ONCE per panel open (static for a play session). A server without the route
  // (old DLL) 404s -> the panel says so and stays inert; it never retries in a loop.
  async function csLoadCatalog() {
    if (csState.loaded) return;
    try {
      const r = await fetch("/console/commands", { cache: "no-store" });
      if (!r.ok) {
        // A 403 {"guarded":true} means the host setting is off: surface the server's own sentence, because the
        // route is the gate and this panel only repeats its reason.
        let guarded = "";
        if (r.status === 403) {
          try { const g = await r.json(); if (g && g.guarded) guarded = g.error || ""; }
          catch { guarded = ""; }
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
    } catch {
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
    } catch {
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
    panel.className = "console-panel";
    const head = D ? D.headerHtml({ cls: "console-head", title: "Command console", close: { title: "Close" } })
      : `<div class="console-head">Command console</div>`;
    panel.innerHTML = `${head}<div class="console-body"></div>`;
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

    csShell = { panel, body: panel.querySelector(".console-body") };
    if (typeof window !== "undefined" && window.DFPanelFrame) {
      window.DFPanelFrame.register({
        key: "console", el: () => csShell && csShell.panel, title: "Command console",
        headSel: ".console-head", closable: true, resizable: { minW: 360, minH: 320 },
        fillSel: ".console-body", persistOpen: false,
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
    shell.panel.classList.add("open");
    csOpen = true;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("console", true); }
    catch (err) { DwfErr.report("console.panel-frame.open", err); }
    csPaint();
    csLoadCatalog();
  }

  function csClose() {
    csOpen = false;
    csState.armed = false;                           // never leave a live confirm behind a closed panel
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("console", false); }
    catch (err) { DwfErr.report("console.panel-frame.close", err); }
    if (csShell) csShell.panel.classList.remove("open");
  }

  function toggleConsolePanel() { if (csOpen) csClose(); else openConsolePanel(); }

  // The console is host-gated and the ROUTE refuses when off. The button is the honesty half: hidden
  // unless the host enabled it, and the panel closes if the host turns it off while it is open.
  function csConsoleAllowed() {
    const wg = typeof window !== "undefined" ? window.DFWriteGuards : null;
    return !!(wg && wg.enabled("dfhack_console"));
  }

  function csApplyGuard() {
    const btn = typeof document !== "undefined" ? document.getElementById("consoleBtn") : null;
    const allowed = csConsoleAllowed();
    if (btn) btn.classList.toggle("console-allowed", allowed);
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
