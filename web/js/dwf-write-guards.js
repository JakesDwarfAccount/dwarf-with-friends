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

// W23 -- client mirror of GET /write-guards (dfcapture-hostwrites.json, C++ side).
//
// One rule, the B227 justice contract generalized: a guarded write must NEVER look live. Every
// consumer asks DFWriteGuards.enabled(flag) at render time and FAILS CLOSED -- before the first
// fetch answers, after a fetch error, on an old server without the route (404), or on any value
// that is not exactly `true`, the write renders LOCKED. When the host flips a flag the poll picks
// it up within ~10 s and a "dfwriteguards" window event tells open panels to re-render -- no
// reload, no rebuild.
(function () {
  "use strict";

  const FLAGS = ["dfhack_console"];

  // Plain-English lock reasons, shared by every consumer so the copy stays in one voice.
  // Written for the player at the button, not for engineers.
  const COPY = {
    dfhack_console:
      "The host has not enabled the DFHack command console. It lets players run commands on the " +
      "host's PC, so it ships off; the host can turn it on in the host panel.",
    unreachable:
      "The host is not reporting its write-guard flags, so this action stays locked. That is a " +
      "host/plugin problem, not a rule -- tell whoever runs the fort.",
  };

  let state = null;        // guards object from the server, or null = unreachable (locked)
  let timer = null;

  function enabled(flag) {
    // FAIL CLOSED: only a present, reachable, literally-true flag unlocks.
    return !!(state && state[flag] === true);
  }

  function reason(flag) {
    if (!state) return COPY.unreachable;
    return COPY[flag] || COPY.unreachable;
  }

  async function refresh() {
    let next = null;
    try {
      const r = await fetch(`/write-guards?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.guards && typeof j.guards === "object") next = j.guards;
      }
    } catch (_) { /* unreachable -> locked */ }
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (changed && typeof window !== "undefined") {
      try { window.dispatchEvent(new CustomEvent("dfwriteguards", { detail: { guards: state } })); }
      catch (_) {}
    }
    return state;
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, 10000);   // host flips show up within ~10 s, no reload
  }

  if (typeof window !== "undefined") {
    window.DFWriteGuards = { FLAGS, COPY, enabled, reason, refresh, start,
                             get state() { return state; } };
    if (typeof document !== "undefined") {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    }
  }
})();
