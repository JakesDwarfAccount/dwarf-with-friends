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

#pragma once

// WP-B pause arbiter (WT01 debounce/merge + WT03(b) auto-pause-on-leave + WT03(d2) saving/busy
// indicator). Spec: docs/superpowers/specs/2026-07-08-wants-WT-spec.md §1.5/§2/§4.
//
// The arbiter owns ONLY a decision + bookkeeping mutex (g_pause_mutex, module-private). It never
// takes CoreSuspender itself for the pause path: state is applied through the EXISTING
// action_on_core_thread() (interaction.cpp run_suspended), and the live pause_state it reconciles
// against is a stable process-lifetime bool global (df::global::pause_state) read under
// g_pause_mutex without suspension -- the same read DFHack's own PerfCounters does. The one DF
// read that needs care (plotinfo->main.autosave_request, heap, freeable on world unload) is taken
// under a BOUNDED ConditionalCoreSuspender in pause_push_tick() so it can never block the push
// loop during a save and never touch freed memory.
//
// Every applied transition broadcasts a WS text frame to ALL connected players:
//   {"type":"pause","paused":<bool>,"by":"<actor>","reason":"player|external|leave"[,"who":"<n>"]}

#include <string>

namespace dwf {

struct PauseDecision {
    bool applied = false;      // did this request actually change pause_state?
    bool paused_now = false;   // the pause_state after this request resolved
    bool merged = false;       // request absorbed by debounce/merge (rule 2/3) -- not an error
    std::string by;            // the actor currently credited with the pause state
    bool ok = true;            // false only on the "no world / pause_state unavailable" path
    std::string err;           // set when !ok
};

// WT01: resolve a pause request from `player`. kind: "pause"|"unpause"|"play"|"resume"|
// "toggle"|"toggle-pause". Applies via action_on_core_thread when the arbiter decides to and
// broadcasts {"type":"pause",...,"reason":"player"} on any applied transition.
//
// `is_host` is the caller's isHostClient() signal (WsConnection::is_host() / peer_ip_is_loopback
// on the HTTP peer). It only matters when the host-only-unpause gate is ON (crash #4 hardening):
// a request that would LEAVE pause (unpause/play/resume, or a toggle while currently paused) from
// a non-host session is then refused (d.ok=false, d.err="unpause is host-only"). Pausing stays
// open to everyone regardless. Default gate OFF -> is_host is ignored (full back-compat).
PauseDecision pause_request(const std::string& player, const std::string& kind, bool is_host);

// Reconcile against DF's live pause_state (native-host spacebar, DF auto-pause: sieges/
// announcements). Reads pause_state internally under g_pause_mutex (atomic vs pause_request), so
// there is no TOCTOU spurious-external-broadcast after a web-initiated apply. Broadcasts with
// by:"host",reason:"external" on a real external change. Called every push-loop tick.
void pause_reconcile_tick();

// WT03(b): auto-pause after a player's last socket dropped and the grace window expired. No-op if
// already paused (never unpauses, never double-broadcasts). Broadcasts by:"server",reason:"leave",
// who:<player>. Marks the transition immediately reversible (skips WT01 rule 3 for the first
// opposing request -- people should SEE it and be able to resume at once).
void pause_on_player_left(const std::string& player);

// ---- WT03(d2) saving / world-busy indicator (heartbeat + watchdog) -----------------------------
// pause_push_tick: called ONCE per ws_push_loop iteration, AFTER world_stream_tick returns. Stamps
// the sim heartbeat (a completed tick == the sim thread was reachable this pass; during an
// autosave world-write world_stream_tick BLOCKS on CoreSuspender so this stamp stops advancing --
// exactly the stall the watchdog detects), runs the pause reconcile, and samples autosave_request.
void pause_push_tick();

// pause_busy_watchdog_tick: called from ws_cursor_loop (~25 Hz, NEVER takes CoreSuspender, so it
// keeps running while the core is blocked). Detects heartbeat staleness and broadcasts
// {"type":"busy","state":"start|clear",...}. See spec §4.4.
void pause_busy_watchdog_tick();

// ---- WT03(b) leave-grace watchdog --------------------------------------------------------------
// pause_leave_watchdog_tick: called from ws_cursor_loop. Tracks each player's socket-count->0
// edge, starts a grace timer, cancels on reconnect (refresh keeps the same B09(a) name so it
// reappears in the roster), and fires pause_on_player_left after the grace expires.
void pause_leave_watchdog_tick();

// ---- tunables (defaults + test-the-test overrides, driven by GET /pause-config) -----------------
void pause_set_merge_window_ms(int ms);       // WT01 kMergeWindowMs (default 400; 0 = test-the-test)
void pause_set_autopause_enabled(bool on);    // WT03(b) master toggle (default on)
void pause_set_autopause_grace_ms(int ms);    // WT03(b) grace (default 5000; 0 = test-the-test)
void pause_set_busy_threshold_ms(int ms);     // WT03(d2) stall threshold (default 1500)
// crash #4 hardening: when ON, only the host session may LEAVE pause (unpause/toggle-to-unpause).
// Default OFF for back-compat; the range era wants it ON (untrusted spectators can't unpause the
// host's world). Settable via GET /pause-config?hostunpause=on|off, like autopause.
void pause_set_host_unpause_only(bool on);
std::string pause_config_json();              // current config snapshot for the debug route

// Persist the two DURABLE host pause flags (hostUnpauseOnly, autopause) to a small text file in
// DF's working directory so a host's choice survives a DF restart (item 5). pause_persist_flags()
// is called by the /pause-config route after a hostunpause/autopause change; pause_load_persisted_flags()
// is called once at capture-stream-start to restore them. Both are plain file I/O -- no DF/core
// access, safe to call from the httplib thread or the plugin command thread. Best-effort: a write
// or read failure just means the flags fall back to their compiled defaults (reset on restart).
void pause_persist_flags();
void pause_load_persisted_flags();

} // namespace dwf
