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

// WT14 "Fortress vote" -- the barony/county/duchy elevation vote popup.
//
// WHAT THE VOTE IS (honest contract, rendered in the panel footer): the vote only ADVISES. The
// native accept/decline still happens inside Dwarf Fortress by whoever is at the keyboard; this
// panel exists so everyone connected can weigh in on "Become a Barony?" while the game is asking.
//
// WIRE: the server (src/vote.cpp) pushes {"type":"vote", seq, active, lastResult, detection}
// frames over the existing WebSocket -- on vote open / every cast / close, and once to late
// joiners. dwf-ws.js routes them to window.DwfVote.onVote (the pause/chat consumer
// posture: inert if this module isn't loaded).
//
// FEATURE DETECT / DORMANCY (hard requirement -- the client half ships BEFORE the DLL half): this
// module makes ZERO network requests and paints nothing until the first vote frame arrives. An
// old server never sends {"type":"vote"}, so against the current live server the module stays
// completely dormant: no fetches, no 404s, no console errors. The panel (reachable from the cog
// Panels list) then shows a "needs a newer server" note, still without fetching. Only after a
// vote frame proves the wire exists does openVotePanel() sync via GET /vote.
//
// UI: DWFUI-built (headerHtml + rowHtml + barRowHtml + plaqueBtnHtml), modal-ISH but never
// input-trapping: a floating DFPanelFrame panel (drag/resize/Esc/X), auto-OPENED for everyone
// when a vote opens or closes, dismissible + reopenable (topbar ballot button + cog Panels list),
// and it never captures game input.
//
// The pure shapers (voteInitialState / voteReduce / voteMyChoice / voteRenderBody) take plain
// JSON and return state/markup with NO DOM/fetch dependency; tools/harness/vote_fixture_test.mjs
// drives the full lifecycle (open -> cast -> change -> close -> result) offline.

  // ---- pure data model (node-testable) --------------------------------------------------------

  const VOTE_ADVISORY = "Result advises the overseer — accept or decline in the game itself.";

  function voteInitialState() {
    return {
      supported: false, seq: 0, active: null, lastResult: null,
      detection: { pending: false, topic: "", titles: [] },
    };
  }

  // One vote row: {player, choice} with choice "yes"|"no". Anything malformed is dropped --
  // a garbage entry must never fabricate a ballot.
  function _vtVotes(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const v of list) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.player !== "string" || !v.player) continue;
      if (v.choice !== "yes" && v.choice !== "no") continue;
      if (seen.has(v.player)) continue; // one ballot per name, first wins (server enforces too)
      seen.add(v.player);
      out.push({ player: v.player, choice: v.choice });
    }
    return out;
  }

  function _vtTally(votes) {
    let yes = 0, no = 0;
    for (const v of votes) (v.choice === "yes" ? yes++ : no++);
    return { yes, no };
  }

  function _vtRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const votes = _vtVotes(raw.votes);
    const t = _vtTally(votes); // recomputed from the ballots, never trusted from the wire
    return {
      id: Number(raw.id) || 0,
      topic: typeof raw.topic === "string" ? raw.topic : "",
      kind: typeof raw.kind === "string" ? raw.kind : "",
      openedBy: typeof raw.openedBy === "string" ? raw.openedBy : "",
      openedMs: Number(raw.openedMs) || 0,
      yes: t.yes, no: t.no, votes,
    };
  }

  // Reduce a {"type":"vote"} frame (or a GET /vote payload -- same shape) into client state.
  // DEFENSIVE: a garbage message returns the previous state untouched; a valid one marks the
  // wire as supported forever after.
  function voteReduce(prev, msg) {
    const base = prev && typeof prev === "object" ? prev : voteInitialState();
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return base;
    // Must look like a vote payload at all: an old/foreign message never flips `supported`.
    if (!("active" in msg) && !("lastResult" in msg) && !("detection" in msg)) return base;
    const active = _vtRecord(msg.active);
    let lastResult = null;
    if (msg.lastResult && typeof msg.lastResult === "object") {
      lastResult = _vtRecord(msg.lastResult);
      if (lastResult) {
        lastResult.closedBy = typeof msg.lastResult.closedBy === "string" ? msg.lastResult.closedBy : "";
        lastResult.closedMs = Number(msg.lastResult.closedMs) || 0;
        const r = msg.lastResult.result;
        // result recomputed from ballots; wire value only breaks a malformed tie label
        lastResult.result = lastResult.yes > lastResult.no ? "yes"
          : (lastResult.no > lastResult.yes ? "no"
          : (r === "yes" || r === "no" || r === "tie" ? r : "tie"));
      }
    }
    const det = (msg.detection && typeof msg.detection === "object") ? msg.detection : {};
    return {
      supported: true,
      seq: Number(msg.seq) || 0,
      active, lastResult,
      detection: {
        pending: det.pending === true,
        topic: typeof det.topic === "string" ? det.topic : "",
        titles: Array.isArray(det.titles) ? det.titles.filter(t => typeof t === "string") : [],
      },
    };
  }

  function voteMyChoice(state, player) {
    if (!state || !state.active || !player) return null;
    const mine = state.active.votes.find(v => v.player === player);
    return mine ? mine.choice : null;
  }

  // ---- render (DWFUI string assembly; DOM-free) -------------------------------------------------
  //
  // DWFUI contract. This family consumed DWFUI with ZERO require() declarations, so a component
  // removed from the layer failed SILENTLY, mid-render, as a half-painted panel. Declared here.
  // (vote.js was ALREADY the family's model citizen -- headerHtml + rowHtml + barRowHtml +
  // plaqueBtnHtml, no raw controls, no private palette. The other eight files were migrated onto
  // ITS pattern this wave; the only thing it was missing is this declaration.)
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("vote", ["headerHtml", "rowHtml", "barRowHtml", "plaqueBtnHtml", "esc"]);

  function _vtUI() {
    if (typeof window !== "undefined" && window.DWFUI) return window.DWFUI;
    if (typeof globalThis !== "undefined" && globalThis.DWFUI) return globalThis.DWFUI;
    return null;
  }

  function _vtWhoVotedHtml(D, votes) {
    if (!votes.length) return `<div class="vt-nobody">No votes cast yet.</div>`;
    return votes.map(v => D.rowHtml({
      cls: "vt-voter-row",
      label: v.player,
      on: v.choice === "yes",
      trailing: `<span class="vt-voter-mark ${v.choice}">` +
        `${v.choice === "yes" ? D.TOKENS.glyphs.check : D.TOKENS.glyphs.cross}</span>`,
    })).join("");
  }

  function _vtTallyHtml(D, rec) {
    const max = Math.max(rec.yes, rec.no, 1);
    return D.barRowHtml({ cls: "vt-bar", label: "Yes", value: rec.yes, max, tone: "green" }) +
      D.barRowHtml({ cls: "vt-bar", label: "No", value: rec.no, max, tone: "red" });
  }

  // The whole panel body. `player` is MY name (highlights my ballot on the YES/NO plaques).
  function voteRenderBody(state, player) {
    const D = _vtUI();
    if (!D) return "";
    const s = state && typeof state === "object" ? state : voteInitialState();
    if (!s.supported) {
      return `<div class="vt-dormant">Fortress votes need a newer server build. ` +
        `Ask the host to redeploy, then this panel wakes up on its own.</div>`;
    }
    const foot = `<div class="vt-foot">${D.esc(VOTE_ADVISORY)}</div>`;
    if (s.active) {
      const a = s.active;
      const mine = voteMyChoice(s, player);
      const opened = a.openedBy === "server"
        ? "The realm is asking — the offer is on the table in game right now."
        : `Called by ${D.esc(a.openedBy)}.`;
      const cast = `<div class="vt-cast">` +
        D.plaqueBtnHtml({ label: "YES", tone: "green", cls: `vt-cast-yes${mine === "yes" ? " selected" : ""}`,
          dataset: { voteCast: "yes" }, title: "Vote yes" }) +
        D.plaqueBtnHtml({ label: "NO", tone: "red", cls: `vt-cast-no${mine === "no" ? " selected" : ""}`,
          dataset: { voteCast: "no" }, title: "Vote no" }) +
        `</div>`;
      const mineLine = mine
        ? `<div class="vt-mine">Your vote: <b class="${mine}">${mine.toUpperCase()}</b> — click the other plaque to change it.</div>`
        : `<div class="vt-mine">You have not voted yet.</div>`;
      return `<div class="vt-topic">${D.esc(a.topic)}</div>` +
        `<div class="vt-opened">${opened}</div>` +
        cast + mineLine + _vtTallyHtml(D, a) +
        `<div class="vt-section">Who voted</div>` + _vtWhoVotedHtml(D, a.votes) +
        `<div class="vt-close-row">` +
        D.plaqueBtnHtml({ label: "Close vote", tone: "grey", cls: "vt-close-vote",
          dataset: { voteClose: "" }, title: "Close the vote and freeze the tally" }) +
        `</div>` + foot;
    }
    // No active vote: last result banner (if any) + a way to call one.
    let out = "";
    if (s.lastResult) {
      const r = s.lastResult;
      const verdict = r.result === "tie" ? "TIED" : `${r.result.toUpperCase()} wins`;
      out += `<div class="vt-result ${r.result}">` +
        `<div class="vt-result-verdict">${verdict} — ${r.yes} yes / ${r.no} no</div>` +
        `<div class="vt-result-topic">${D.esc(r.topic)}</div></div>` +
        _vtWhoVotedHtml(D, r.votes);
    } else {
      out += `<div class="vt-nobody">No vote in progress.</div>`;
    }
    if (s.detection.pending)
      out += `<div class="vt-detect">The game is asking: ${D.esc(s.detection.topic)}</div>`;
    out += `<div class="vt-close-row">` +
      D.plaqueBtnHtml({ label: "Call a vote", tone: "green", cls: "vt-start-vote",
        dataset: { voteStart: "" }, title: "Open a yes/no vote for everyone connected" }) +
      `</div>` + foot;
    return out;
  }

  // ---- DOM shell + wire consumer (browser-only; mirrors the analytics panel) --------------------

  let vtState = voteInitialState();
  let vtShell = null;   // { panel, body }
  let vtOpen = false;

  function _vtPlayer() {
    try { return (typeof window.playerName === "string" && window.playerName) ? window.playerName : ""; }
    catch (_) { return ""; }
  }

  function vtPaint() {
    if (!vtShell) return;
    vtShell.body.innerHTML = voteRenderBody(vtState, _vtPlayer());
  }

  function _vtApi(path) {
    // POSTs are only ever reachable AFTER a vote frame proved the wire exists (supported=true
    // gates every caller), so a dormant client never emits a request.
    try {
      if (typeof fetch !== "function") return;
      fetch(path, { method: "POST", cache: "no-store" }).catch(() => {});
    } catch (_) { /* repaint arrives with the next broadcast anyway */ }
  }

  function vtEnsureShell() {
    if (vtShell || typeof document === "undefined") return vtShell;
    const D = _vtUI();
    const panel = document.createElement("div");
    panel.className = "vt-panel";
    panel.style.display = "none";
    const head = D ? D.headerHtml({ cls: "vt-head", title: "Fortress vote", close: { title: "Close" } })
      : `<div class="vt-head">Fortress vote</div>`;
    panel.innerHTML = `${head}<div class="vt-body"></div>`;
    document.body.appendChild(panel);
    panel.addEventListener("contextmenu", e => { e.preventDefault(); vtClose(); });
    panel.addEventListener("click", e => {
      const t = e.target.closest ? e.target : null;
      if (!t) return;
      if (t.closest("[data-bld-close]")) { e.preventDefault(); vtClose(); return; }
      const cast = t.closest("[data-vote-cast]");
      if (cast && vtState.supported && vtState.active) {
        e.preventDefault();
        const choice = cast.getAttribute("data-vote-cast") === "no" ? "no" : "yes";
        const me = _vtPlayer();
        if (!me) return;
        // Optimistic local apply; the server broadcast is the source of truth moments later.
        const mine = vtState.active.votes.find(v => v.player === me);
        if (mine) mine.choice = choice; else vtState.active.votes.push({ player: me, choice });
        const t2 = _vtTally(vtState.active.votes);
        vtState.active.yes = t2.yes; vtState.active.no = t2.no;
        vtPaint();
        _vtApi(`/vote-cast?player=${encodeURIComponent(me)}&choice=${choice}`);
        return;
      }
      if (t.closest("[data-vote-close]") && vtState.supported && vtState.active) {
        e.preventDefault();
        const me = _vtPlayer();
        if (me) _vtApi(`/vote-close?player=${encodeURIComponent(me)}`);
        return;
      }
      if (t.closest("[data-vote-start]") && vtState.supported && !vtState.active) {
        e.preventDefault();
        const me = _vtPlayer();
        if (me) _vtApi(`/vote-start?player=${encodeURIComponent(me)}`);
        return;
      }
    });
    vtShell = { panel, body: panel.querySelector(".vt-body") };
    if (typeof window !== "undefined" && window.DFPanelFrame) {
      window.DFPanelFrame.register({
        key: "vote", el: () => vtShell && vtShell.panel, title: "Fortress vote",
        headSel: ".vt-head", closable: true, resizable: { minW: 300, minH: 240 },
        fillSel: ".vt-body", persistOpen: false,
        defaultPos: (vw, vh) => ({ anchor: "tl", x: Math.max(60, ((vw | 0) - 380) / 2), y: 90, w: 380, h: 440 }),
        open: () => { if (!vtOpen) openVotePanel(); },
        close: () => vtClose(),
        isOpen: () => vtOpen, escClosable: true,
      });
    }
    return vtShell;
  }

  function openVotePanel() {
    const shell = vtEnsureShell();
    if (!shell) return;
    shell.panel.style.display = "flex";
    vtOpen = true;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("vote", true); } catch (_) {}
    vtPaint();
    // Manual open on a PROVEN wire: resync once (covers a reopen after frames were dismissed).
    if (vtState.supported && typeof fetch === "function") {
      fetch(`/vote?t=${Date.now()}`, { cache: "no-store" })
        .then(r => (r.ok ? r.json() : null))
        .then(j => { if (j) { vtState = voteReduce(vtState, j); vtPaint(); _vtBadge(); } })
        .catch(() => {});
    }
  }

  function vtClose() {
    vtOpen = false;
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("vote", false); } catch (_) {}
    if (vtShell) vtShell.panel.style.display = "none";
  }

  function toggleVotePanel() { if (vtOpen) vtClose(); else openVotePanel(); }

  // Topbar ballot button: hidden until the wire proves itself (feature detect), pulses while a
  // vote is live so a dismissed popup stays one click away.
  function _vtBadge() {
    if (typeof document === "undefined") return;
    const btn = document.getElementById("voteBtn");
    if (!btn) return;
    btn.style.display = vtState.supported ? "" : "none";
    btn.classList.toggle("vt-live", !!vtState.active);
  }

  // Wire entry point (dwf-ws.js routes {"type":"vote"} frames here).
  function onVote(msg) {
    const prev = vtState;
    const next = voteReduce(prev, msg);
    if (next === prev) return; // garbage frame -- ignore
    vtState = next;
    _vtBadge();
    vtPaint();
    // Auto-open ONLY on real transitions (new vote opened / vote just closed) -- a dismissed
    // panel is not re-forced by mere tally updates (dismissible, never input-trapping).
    const prevId = prev.active ? prev.active.id : 0;
    const newVote = next.active && next.active.id !== prevId;
    const justClosed = !next.active && prev.active &&
      next.lastResult && next.lastResult.id === prevId;
    if (newVote || justClosed) openVotePanel();
  }

  function vtInstallButton() {
    if (typeof document === "undefined") return;
    const btn = document.getElementById("voteBtn");
    if (!btn || btn._vtHooked) return;
    btn._vtHooked = true;
    btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggleVotePanel(); });
  }

  if (typeof document !== "undefined") {
    const boot = () => { vtEnsureShell(); vtInstallButton(); _vtBadge(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  if (typeof window !== "undefined") {
    window.openVotePanel = openVotePanel;
    window.toggleVotePanel = toggleVotePanel;
    window.DwfVote = { onVote, open: openVotePanel, toggle: toggleVotePanel, close: vtClose };
  }

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      voteInitialState, voteReduce, voteMyChoice, voteRenderBody, VOTE_ADVISORY,
    };
  }
