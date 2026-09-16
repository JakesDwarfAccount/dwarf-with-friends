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

// Pause arbiter: debounce/merge, auto-pause-on-leave, and the saving/world-busy indicator.

#include <string>

namespace dwf {

struct PauseDecision {
    bool applied = false;      // did this request actually change pause_state?
    bool paused_now = false;   // the pause_state after this request resolved
    bool merged = false;       // request absorbed by debounce/merge -- not an error
    std::string by;            // the actor currently credited with the pause state
    bool ok = true;            // false only on the "no world / pause_state unavailable" path
    std::string err;           // set when !ok
};

// kind: "pause"|"unpause"|"play"|"resume"|"toggle"|"toggle-pause". `is_host` is ignored unless the
// host-only-unpause gate is on, and then it only gates requests that would LEAVE pause.
PauseDecision pause_request(const std::string& player, const std::string& kind, bool is_host);

// Reconcile against DF's live pause_state (the host's spacebar, DF's own auto-pauses).
void pause_reconcile_tick();

// Auto-pause after a player's last socket dropped and the grace window expired; never unpauses.
void pause_on_player_left(const std::string& player);

// ---- Saving / world-busy indicator (heartbeat + watchdog) -----------------------------

// Call once per ws_push_loop pass and AFTER world_stream_tick: the heartbeat it stamps only means
// "the sim was reachable" because world_stream_tick has already returned from its suspender.
void pause_push_tick();

// Must NEVER take the CoreSuspender: it runs on ws_cursor_loop so it keeps going while the core is
// blocked, which is exactly the stall it detects.
void pause_busy_watchdog_tick();

// ---- Leave-grace watchdog --------------------------------------------------------------
void pause_leave_watchdog_tick();

// ---- tunables (defaults + test-the-test overrides, driven by GET /pause-config) -----------------
void pause_set_merge_window_ms(int ms);       // g_merge_window_ms (default 400; 0 = test-the-test)
void pause_set_autopause_enabled(bool on);    // master toggle (default on)
void pause_set_autopause_grace_ms(int ms);    // grace (default 5000; 0 = test-the-test)
void pause_set_busy_threshold_ms(int ms);     // stall threshold (default 1500)
// when ON, only the host session may LEAVE pause (unpause/toggle-to-unpause). Default OFF.
void pause_set_host_unpause_only(bool on);
std::string pause_config_json();              // current config snapshot for the debug route

// Persist hostUnpauseOnly + autopause to a file in DF's working directory. Plain file I/O, no
// DF/core access; best-effort, so a failure just falls back to the compiled defaults.
void pause_persist_flags();
void pause_load_persisted_flags();

} // namespace dwf
