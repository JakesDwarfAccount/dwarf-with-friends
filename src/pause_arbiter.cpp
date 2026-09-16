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

#include "common_util.h"
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

// ---- arbiter bookkeeping (all guarded by g_pause_mutex) ----------------------------------------
std::mutex g_pause_mutex;
bool g_target = false;             // arbiter's model of pause_state
bool g_target_init = false;        // lazily initialized from the live pause_state on first use
long long g_last_ms = 0;           // steady_ms of the last APPLIED transition
std::string g_last_actor = "host"; // who is credited with the current pause state
bool g_leave_reversible = false;   // after a leave-pause, do not suppress the first opposing request
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

bool read_pause_state(bool& out) {
    if (!df::global::pause_state) return false;   // no game loaded
    out = *df::global::pause_state;               // stable process-lifetime bool global
    return true;
}

// Applies the target through the core-thread action path. Never call it on ws_cursor_loop: that
// loop must stay CoreSuspender-free.
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

// Caller must hold g_pause_mutex.
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
    g_leave_reversible = true;   // people should SEE it and be able to resume at once
    broadcast_pause(true, "server", "leave", leaver);
}

} // namespace

// ---- request resolution ------------------------------------------------------------------------
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

    // Host-only-unpause gate, evaluated on the RESOLVED target: a toggle that would pause stays
    // open to non-hosts, a toggle that would unpause does not.
    if (g_host_unpause_only.load() && !desired && !is_host) {
        d.ok = false;
        d.err = "unpause is host-only";
        d.paused_now = g_target;
        d.by = g_last_actor;
        return d;
    }

    // DF hard-pauses itself for a BOX popup, so unpausing would resume nothing and desync the
    // arbiter's model. popup_blocked() covers genuine BOX popups only, never the host's Alerts window.
    if (!desired && popup_blocked()) {
        d.ok = false;
        d.err = "a native announcement popup is open - dismiss it first";
        d.paused_now = g_target;
        d.by = g_last_actor;
        return d;
    }

    // The native diplomacy dialog wedges the sim the same way a BOX popup does: DFHack's own
    // ReadPauseState counts diplomacy.open as paused, so an unpause would resume nothing.
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

    if (desired == g_target) {
        d.merged = true;
        d.applied = false;
        return d;
    }

    // An opposing request from a different player inside the merge window is a stale race -- they
    // acted on the pre-transition state they were still seeing -- so suppress it.
    const int win = g_merge_window_ms.load();
    if (!g_leave_reversible && (now - g_last_ms) < win && player != g_last_actor) {
        d.merged = true;
        d.applied = false;
        return d;
    }

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

// ---- reconcile against the native host and DF's own auto-pauses ----------------------------------
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

// ---- auto-pause on leave: the core-free half, on ws_cursor_loop ----------------------------------
void pause_on_player_left(const std::string& player) {
    if (!g_autopause_enabled.load()) return;
    std::lock_guard<std::mutex> lk(g_pause_mutex);
    // Do NOT apply here: ws_cursor_loop must never take CoreSuspender -- it carries the busy
    // watchdog, which has to keep flowing while the core is blocked during a save.
    g_pending_leave_player = player;
}

// ---- heartbeat, reconcile and autosave sample: once per ws_push_loop iteration -------------------
void pause_push_tick() {
    // Reaching here means world_stream_tick returned. During an autosave world-write it blocks on
    // its CoreSuspender and this stamp stops advancing -- the stall the watchdog detects.
    g_heartbeat_ms.store(steady_ms());

    pause_reconcile_tick();

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

    // Bounded suspender: it skips instantly while the core is blocked, so the push loop never
    // stalls. plotinfo is heap and freed on world unload, so this read MUST be suspended.
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

// ---- busy watchdog, on ws_cursor_loop (core-free) ------------------------------------------------
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

// ---- leave-grace watchdog, on ws_cursor_loop (core-free) -----------------------------------------
void pause_leave_watchdog_tick() {
    static std::set<std::string> prev;           // roster seen last tick
    static std::map<std::string, long long> pending;  // leaver -> fire deadline (steady_ms)

    const long long now = steady_ms();
    const int grace = g_autopause_grace_ms.load();

    const auto vec = ws_connected_players();
    std::set<std::string> cur(vec.begin(), vec.end());

    // Reconnect (incl. a same-name refresh) cancels a pending leave silently.
    for (const auto& n : cur) pending.erase(n);

    for (const auto& n : prev) {
        if (!cur.count(n) && !pending.count(n))
            pending[n] = now + grace;
    }

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

// ---- tunables ------------------------------------------------------------------------------------
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
