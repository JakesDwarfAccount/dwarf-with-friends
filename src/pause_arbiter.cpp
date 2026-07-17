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

#include "pause_arbiter.h"

#include "diplo.h"
#include "interaction.h"
#include "json_util.h"
#include "native_popup.h"
#include "websocket.h"

#include "Core.h"
#include "DataDefs.h"
#include "df/global_objects.h"
#include "df/plotinfost.h"

#include <atomic>
#include <chrono>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>

namespace dwf {

namespace {

long long steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// ---- arbiter bookkeeping (all guarded by g_pause_mutex) ----------------------------------------
std::mutex g_pause_mutex;
bool g_target = false;             // arbiter's model of pause_state
bool g_target_init = false;        // lazily initialized from the live pause_state on first use
long long g_last_ms = 0;           // steady_ms of the last APPLIED transition
std::string g_last_actor = "host"; // who is credited with the current pause state
bool g_leave_reversible = false;   // last apply was a leave-pause -> skip rule 3 for 1st opposing
std::string g_pending_leave_player;// set by the (core-free) cursor thread, applied by push tick

// ---- tunables (multi-thread readable) ----------------------------------------------------------
std::atomic<int> g_merge_window_ms{400};
std::atomic<bool> g_autopause_enabled{true};
std::atomic<int> g_autopause_grace_ms{5000};
std::atomic<int> g_busy_threshold_ms{1500};
std::atomic<bool> g_host_unpause_only{false};   // crash #4 gate: only host may leave pause (default OFF)

// ---- saving/busy heartbeat ---------------------------------------------------------------------
std::atomic<long long> g_heartbeat_ms{0};   // stamped by pause_push_tick each completed tick
std::atomic<bool> g_autosave_seen{false};   // last-sampled plotinfo->main.autosave_request

// -----------------------------------------------------------------------------------------------
bool read_pause_state(bool& out) {
    if (!df::global::pause_state) return false;   // no game loaded
    out = *df::global::pause_state;               // stable process-lifetime bool global
    return true;
}

// Apply the target pause_state through the EXISTING core-thread action path (run_suspended ->
// World::SetPauseState). Never called on ws_cursor_loop (that loop must stay CoreSuspender-free);
// only from pause_request (HTTP worker) or pause_push_tick (push loop).
bool apply_pause_state(bool desired, std::string* err) {
    return action_on_core_thread(desired ? "pause" : "play", err);
}

void broadcast_all(const std::string& text) {
    for (const auto& p : ws_connected_players())
        broadcast_to_player(p, text);
}

void broadcast_pause(bool paused, const std::string& by, const char* reason,
                     const std::string& who) {
    std::ostringstream m;
    m << "{\"type\":\"pause\",\"paused\":" << (paused ? "true" : "false")
      << ",\"by\":" << json_string(by)
      << ",\"reason\":\"" << reason << "\"";
    if (!who.empty())
        m << ",\"who\":" << json_string(who);
    m << "}";
    broadcast_all(m.str());
}

// Caller must hold g_pause_mutex.
void ensure_init_locked() {
    if (g_target_init) return;
    bool p = false;
    if (read_pause_state(p)) {
        g_target = p;
        g_target_init = true;
        g_last_actor = "host";
        g_last_ms = steady_ms();
    }
}

// Caller must hold g_pause_mutex. Applies + broadcasts a leave-pause (already-paused -> no-op).
void apply_leave_pause_locked(const std::string& leaver) {
    bool actual = false;
    if (!read_pause_state(actual)) return;   // no world -> no crash, no pause
    if (!g_target_init) { g_target = actual; g_target_init = true; }
    if (actual) { g_target = actual; return; }   // already paused: no-op, no broadcast
    std::string err;
    if (!apply_pause_state(true, &err)) return;
    g_target = true;
    g_last_ms = steady_ms();
    g_last_actor = "server";
    g_leave_reversible = true;   // people should SEE it and be able to resume at once (skip rule 3)
    broadcast_pause(true, "server", "leave", leaver);
}

} // namespace

// ================================================================================================
// WT01 request resolution
// ================================================================================================
PauseDecision pause_request(const std::string& player, const std::string& kind, bool is_host) {
    PauseDecision d;
    std::lock_guard<std::mutex> lk(g_pause_mutex);

    ensure_init_locked();
    if (!g_target_init) {   // no world / pause_state unavailable (matrix cell 9)
        d.ok = false;
        d.err = "pause state unavailable";
        return d;
    }

    bool desired;
    if (kind == "pause") {
        desired = true;
    } else if (kind == "unpause" || kind == "play" || kind == "resume") {
        desired = false;
    } else if (kind == "toggle" || kind == "toggle-pause") {
        desired = !g_target;
    } else {
        d.ok = false;
        d.err = "unsupported pause kind";
        d.paused_now = g_target;
        d.by = g_last_actor;
        return d;
    }

    // Host-only-unpause gate (crash #4 hardening): when enabled, only the host session may LEAVE
    // pause. Any request that resolves to desired==false (unpause/play/resume, OR a toggle while
    // currently paused) from a non-host session is refused with a clear reason. Pausing
    // (desired==true) stays open to everyone. Evaluated on the RESOLVED target so a toggle that
    // would pause is still allowed for non-hosts, but a toggle that would unpause is not. Gate is
    // default OFF, so is_host is irrelevant until an operator sets hostunpause=on (range era).
    if (g_host_unpause_only.load() && !desired && !is_host) {
        d.ok = false;
        d.err = "unpause is host-only";
        d.paused_now = g_target;
        d.by = g_last_actor;
        return d;
    }

    // WT28/B218 popup gate: while a native BOX popup is mirrored (popup_push_tick), the sim is
    // genuinely hard-paused by the popup itself -- DF sets *pause_state for BOX announcements, so
    // an unpause would not actually resume anything and would desync the arbiter's model. Refuse
    // with a clear reason so the client explains WHY instead of appearing broken; the forced pause
    // is deliberate signal and is KEPT until someone dismisses the popup (any web player can, via
    // the mirrored modal's POST /popup/dismiss). Pausing stays open to everyone. NOTE: this gate
    // fires ONLY for genuine BOX popups -- popup_blocked() no longer reflects the host's local
    // Alerts/report window (that is local UI and never blocks browser unpause; see native_popup.h).
    if (!desired && popup_blocked()) {
        d.ok = false;
        d.err = "a native announcement popup is open - dismiss it first";
        d.paused_now = g_target;
        d.by = g_last_actor;
        return d;
    }

    // B225 diplomacy gate, same shape as the popup gate above: while the native diplomacy
    // meeting dialog is open the sim is wedged by the meeting itself (DFHack's own
    // World::ReadPauseState counts main_interface.diplomacy.open as paused) -- an unpause
    // would not resume anything and would desync the arbiter's model. Refuse with a clear
    // reason. v1: the meeting is ADVANCED at the host PC (the browser mirror is read-only
    // until the advance transition is established -- see src/diplo.cpp's banner).
    if (!desired && diplo_meeting_open()) {
        d.ok = false;
        d.err = "a diplomacy meeting is underway - it must be advanced at the host PC";
        d.paused_now = g_target;
        d.by = g_last_actor;
        return d;
    }

    const long long now = steady_ms();
    d.by = g_last_actor;
    d.paused_now = g_target;

    // Rule 2: desired == target -> no-op, absorbed (two players hitting the same button; or the
    // second space-bar toggle after the first already applied resolves to the SAME target).
    if (desired == g_target) {
        d.merged = true;
        d.applied = false;
        return d;
    }

    // Rule 3: opposing request from a DIFFERENT player inside the merge window -> presumed a stale
    // race (they acted on the pre-transition state they were still seeing) -> SUPPRESS. Skipped
    // for the first opposing request after a leave-pause (g_leave_reversible).
    const int win = g_merge_window_ms.load();
    if (!g_leave_reversible && (now - g_last_ms) < win && player != g_last_actor) {
        d.merged = true;
        d.applied = false;
        return d;
    }

    // Rule 4: apply.
    std::string err;
    if (!apply_pause_state(desired, &err)) {
        d.ok = false;
        d.err = err.empty() ? "pause apply failed" : err;
        return d;
    }
    g_target = desired;
    g_last_ms = now;
    g_last_actor = player;
    g_leave_reversible = false;
    d.applied = true;
    d.merged = false;
    d.paused_now = desired;
    d.by = player;
    broadcast_pause(desired, player, "player", "");
    return d;
}

// ================================================================================================
// Reconcile vs the native host / DF auto-pauses
// ================================================================================================
void pause_reconcile_tick() {
    std::lock_guard<std::mutex> lk(g_pause_mutex);
    bool actual = false;
    if (!read_pause_state(actual)) return;   // no world

    if (!g_target_init) {
        g_target = actual;
        g_target_init = true;
        g_last_actor = "host";
        g_last_ms = steady_ms();
        return;
    }
    if (actual != g_target) {
        g_target = actual;
        g_last_actor = "host";
        g_last_ms = steady_ms();
        g_leave_reversible = false;
        broadcast_pause(actual, "host", "external", "");
    }
}

// ================================================================================================
// WT03(b) auto-pause on leave -- CORE-FREE half (runs on ws_cursor_loop): only records intent.
// ================================================================================================
void pause_on_player_left(const std::string& player) {
    if (!g_autopause_enabled.load()) return;
    std::lock_guard<std::mutex> lk(g_pause_mutex);
    // Do NOT apply here: ws_cursor_loop must never take CoreSuspender (it carries the busy
    // watchdog, which has to keep flowing while the core is blocked during a save). Record the
    // leaver; pause_push_tick (push loop, core-adjacent) does the actual SetPauseState.
    g_pending_leave_player = player;
}

// ================================================================================================
// Saving/busy heartbeat + reconcile + autosave sample -- runs ONCE per ws_push_loop iteration.
// ================================================================================================
void pause_push_tick() {
    // Heartbeat: reaching here means world_stream_tick returned, i.e. the sim thread was
    // reachable this pass. During an autosave world-write world_stream_tick BLOCKS on its
    // CoreSuspender, so this stamp stops advancing -- exactly the stall the watchdog detects.
    g_heartbeat_ms.store(steady_ms());

    // Native-host / DF-external reconcile (cheap: one stable-global bool read under g_pause_mutex).
    pause_reconcile_tick();

    // Apply any pending leave-pause recorded by the cursor thread (core-adjacent apply here).
    std::string leaver;
    {
        std::lock_guard<std::mutex> lk(g_pause_mutex);
        if (!g_pending_leave_player.empty()) {
            leaver = g_pending_leave_player;
            g_pending_leave_player.clear();
        }
    }
    if (!leaver.empty()) {
        std::lock_guard<std::mutex> lk(g_pause_mutex);
        apply_leave_pause_locked(leaver);
    }

    // Autosave flag sample @ <=5 Hz under a BOUNDED suspender: skips instantly if the core is
    // blocked (a save), so this never stalls the push loop; the last-seen flag latches across
    // skips. plotinfo is heap + freeable on world unload, so this read MUST be suspended.
    static long long last_autosave_sample = 0;
    const long long now = steady_ms();
    if (now - last_autosave_sample >= 200) {
        last_autosave_sample = now;
        DFHack::ConditionalCoreSuspender suspend;
        if (suspend) {
            bool on = df::global::plotinfo && df::global::plotinfo->main.autosave_request;
            g_autosave_seen.store(on);
        }
    }
}

// ================================================================================================
// WT03(d2) busy watchdog -- runs on ws_cursor_loop (core-free).
// ================================================================================================
void pause_busy_watchdog_tick() {
    // Single-thread state (ws_cursor_loop only).
    static bool busy_active = false;
    static long long stall_hb = 0;        // heartbeat value captured at stall detection
    static long long busy_start_wall = 0; // wall clock at stall start (for stallMs)
    static long long last_bcast = 0;

    const long long now = steady_ms();
    const long long hb = g_heartbeat_ms.load();
    const bool have_conns = ws_connection_count() > 0;
    const long long thresh = g_busy_threshold_ms.load();

    if (!busy_active) {
        if (have_conns && hb != 0 && (now - hb) > thresh) {
            busy_active = true;
            stall_hb = hb;
            busy_start_wall = now;
            last_bcast = now;
            std::ostringstream m;
            m << "{\"type\":\"busy\",\"state\":\"start\",\"autosave\":"
              << (g_autosave_seen.load() ? "true" : "false")
              << ",\"ms\":" << (now - hb) << "}";
            broadcast_all(m.str());
        }
        return;
    }

    // Active stall: recover when the heartbeat advances past the value we captured.
    if (hb != stall_hb) {
        busy_active = false;
        std::ostringstream m;
        m << "{\"type\":\"busy\",\"state\":\"clear\",\"stallMs\":" << (now - busy_start_wall) << "}";
        broadcast_all(m.str());
        return;
    }
    if (!have_conns) {   // everyone left mid-stall: drop state silently (no one to notify)
        busy_active = false;
        return;
    }
    if (now - last_bcast >= 2000) {   // still stalled: re-broadcast every 2 s with a fresh age
        last_bcast = now;
        std::ostringstream m;
        m << "{\"type\":\"busy\",\"state\":\"start\",\"autosave\":"
          << (g_autosave_seen.load() ? "true" : "false")
          << ",\"ms\":" << (now - hb) << "}";
        broadcast_all(m.str());
    }
}

// ================================================================================================
// WT03(b) leave-grace watchdog -- runs on ws_cursor_loop (core-free).
// ================================================================================================
void pause_leave_watchdog_tick() {
    static std::set<std::string> prev;           // roster seen last tick
    static std::map<std::string, long long> pending;  // leaver -> fire deadline (steady_ms)

    const long long now = steady_ms();
    const int grace = g_autopause_grace_ms.load();

    const auto vec = ws_connected_players();
    std::set<std::string> cur(vec.begin(), vec.end());

    // Reconnect (incl. B09(a) same-name refresh) cancels a pending leave silently.
    for (const auto& n : cur) pending.erase(n);

    // New leaves: present last tick, absent now, not already pending.
    for (const auto& n : prev) {
        if (!cur.count(n) && !pending.count(n))
            pending[n] = now + grace;
    }

    // Fire expired leaves.
    for (auto it = pending.begin(); it != pending.end(); ) {
        if (cur.count(it->first)) { it = pending.erase(it); continue; }   // defensive: reconnected
        if (now >= it->second) {
            const std::string n = it->first;
            it = pending.erase(it);
            pause_on_player_left(n);   // records intent; push tick applies (grace-gated already)
        } else {
            ++it;
        }
    }

    prev = std::move(cur);
}

// ================================================================================================
// Tunables
// ================================================================================================
void pause_set_merge_window_ms(int ms)     { g_merge_window_ms.store(ms < 0 ? 0 : ms); }
void pause_set_autopause_enabled(bool on)  { g_autopause_enabled.store(on); }
void pause_set_autopause_grace_ms(int ms)  { g_autopause_grace_ms.store(ms < 0 ? 0 : ms); }
void pause_set_busy_threshold_ms(int ms)   { g_busy_threshold_ms.store(ms < 0 ? 0 : ms); }
void pause_set_host_unpause_only(bool on)   { g_host_unpause_only.store(on); }

// Durable host-flags file (DF cwd), alongside the join-password file. Two `key=on|off` lines.
static const char* kHostFlagsFile = "dwf_host_flags.txt";

void pause_persist_flags() {
    std::ofstream f(kHostFlagsFile, std::ios::trunc);
    if (!f) return;   // best-effort: a failed write just means the flags reset on next restart
    f << "hostunpause=" << (g_host_unpause_only.load() ? "on" : "off") << "\n"
      << "autopause=" << (g_autopause_enabled.load() ? "on" : "off") << "\n";
}

void pause_load_persisted_flags() {
    std::ifstream f(kHostFlagsFile);
    if (!f) return;   // no file yet -> keep compiled defaults (hostunpause off, autopause on)
    std::string line;
    while (std::getline(f, line)) {
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = line.substr(0, eq);
        std::string v = line.substr(eq + 1);
        while (!v.empty() && (unsigned char)v.back() <= ' ') v.pop_back();   // trim trailing WS/CR
        while (!k.empty() && (unsigned char)k.back() <= ' ') k.pop_back();
        const bool on = (v == "on" || v == "1" || v == "true");
        if (k == "hostunpause") g_host_unpause_only.store(on);
        else if (k == "autopause") g_autopause_enabled.store(on);
    }
}

std::string pause_config_json() {
    std::string by;
    bool paused;
    {
        std::lock_guard<std::mutex> lk(g_pause_mutex);
        by = g_last_actor;
        paused = g_target;
    }
    std::ostringstream m;
    m << "{\"mergeWindowMs\":" << g_merge_window_ms.load()
      << ",\"autopause\":" << (g_autopause_enabled.load() ? "true" : "false")
      << ",\"graceMs\":" << g_autopause_grace_ms.load()
      << ",\"busyThresholdMs\":" << g_busy_threshold_ms.load()
      << ",\"hostUnpauseOnly\":" << (g_host_unpause_only.load() ? "true" : "false")
      << ",\"paused\":" << (paused ? "true" : "false")
      << ",\"by\":" << json_string(by) << "}\n";
    return m.str();
}

} // namespace dwf
