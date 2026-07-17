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

#include "portrait_sweep.h"

#include "bake_sweep.h"
#include "diagnostics.h"
#include "unit_portrait.h"

#include <chrono>
#include <deque>
#include <mutex>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace dwf {
namespace {

// One generation step per second: a step costs one view-sheet logic + one isolated
// offscreen render on the render thread (~50-200 ms), so a tighter pace would visibly
// stutter the live 30 fps stream. A ~100-citizen fort is fully baked in under 2 minutes
// of connected streaming; the browser's per-sheet auto-generate (B159) still serves any
// sheet the players actually open immediately, out of band.
constexpr std::chrono::milliseconds kMinStepInterval(1000);
// While the host genuinely has a view sheet open, every step would skip; back off
// instead of re-testing the same contention every second.
constexpr std::chrono::milliseconds kBusyBackoff(3000);
// A unit whose generation genuinely fails (not contention) is retried this many times
// -- spread out by requeueing at the back -- then dropped until a rearm.
constexpr int kMaxAttempts = 3;

std::mutex g_mu;
uintptr_t g_world_identity = 0;
std::deque<int32_t> g_queue_fort;
std::deque<int32_t> g_queue_rest;
std::unordered_set<int32_t> g_seen;
std::unordered_map<int32_t, int> g_attempts;
int g_generated = 0;
int g_failed = 0;
int g_busy_skips = 0;
bool g_drain_logged = false;
std::chrono::steady_clock::time_point g_last_step{};
std::chrono::steady_clock::time_point g_backoff_until{};

} // namespace

void portrait_sweep_observe_world(uintptr_t world_identity) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (world_identity == 0 || world_identity == g_world_identity)
        return;
    g_world_identity = world_identity;
    g_queue_fort.clear();
    g_queue_rest.clear();
    g_seen.clear();
    g_attempts.clear();
    g_generated = 0;
    g_failed = 0;
    g_busy_skips = 0;
    g_drain_logged = false;
    g_backoff_until = {};
}

void portrait_sweep_note_unit(int32_t unit_id, bool fort_priority) {
    if (unit_id < 0)
        return;
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_seen.insert(unit_id).second)
        return;
    if (fort_priority)
        g_queue_fort.push_back(unit_id);
    else
        g_queue_rest.push_back(unit_id);
    g_drain_logged = false;
}

void portrait_sweep_tick() {
    int32_t unit_id = -1;
    bool from_fort = false;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        if (g_queue_fort.empty() && g_queue_rest.empty()) {
            if (!g_drain_logged && (g_generated > 0 || g_failed > 0)) {
                g_drain_logged = true;
                diagnostics_log("PORTRAIT-SWEEP drained: generated=" +
                                std::to_string(g_generated) +
                                " failed=" + std::to_string(g_failed) +
                                " busySkips=" + std::to_string(g_busy_skips));
            }
            return;
        }
        const auto now = std::chrono::steady_clock::now();
        if (g_last_step.time_since_epoch().count() != 0 &&
            now - g_last_step < kMinStepInterval)
            return;
        if (g_backoff_until.time_since_epoch().count() != 0 && now < g_backoff_until)
            return;
        from_fort = !g_queue_fort.empty();
        unit_id = from_fort ? g_queue_fort.front() : g_queue_rest.front();
        (from_fort ? g_queue_fort : g_queue_rest).pop_front();
    }

    // Serialize against the map bake sweep: both run offscreen renders, and stacking
    // them in the same push tick doubles the render-thread stall right after load.
    if (bake_sweep_active()) {
        std::lock_guard<std::mutex> lock(g_mu);
        (from_fort ? g_queue_fort : g_queue_rest).push_front(unit_id);
        g_last_step = std::chrono::steady_clock::now();
        return;
    }

    CapturedFrame frame;
    int32_t texpos = -1;
    std::string source;
    std::string err;
    bool busy = false;
    bool ok = unit_portrait_on_render_thread(unit_id,
                                             /*allow_icon_fallbacks=*/false,
                                             /*allow_view_sheet_generation=*/true,
                                             frame, texpos, source, &err, &busy);

    std::lock_guard<std::mutex> lock(g_mu);
    g_last_step = std::chrono::steady_clock::now();
    if (ok) {
        ++g_generated;
        return;
    }
    if (busy) {
        // Contention with a real open sheet -- requeue without burning an attempt.
        ++g_busy_skips;
        (from_fort ? g_queue_fort : g_queue_rest).push_back(unit_id);
        g_backoff_until = g_last_step + kBusyBackoff;
        return;
    }
    int attempts = ++g_attempts[unit_id];
    if (attempts < kMaxAttempts) {
        (from_fort ? g_queue_fort : g_queue_rest).push_back(unit_id);
    } else {
        ++g_failed;
        diagnostics_log_v("PORTRAIT-SWEEP unit " + std::to_string(unit_id) +
                          " dropped after " + std::to_string(attempts) +
                          " attempts: " + err);
    }
}

void portrait_sweep_rearm() {
    std::lock_guard<std::mutex> lock(g_mu);
    g_queue_fort.clear();
    g_queue_rest.clear();
    g_seen.clear();
    g_attempts.clear();
    g_drain_logged = false;
    g_backoff_until = {};
}

std::string portrait_sweep_status() {
    std::lock_guard<std::mutex> lock(g_mu);
    std::ostringstream ss;
    ss << "portrait sweep: queued=" << (g_queue_fort.size() + g_queue_rest.size())
       << " (fort=" << g_queue_fort.size() << ")"
       << " generated=" << g_generated
       << " failed=" << g_failed
       << " busySkips=" << g_busy_skips;
    return ss.str();
}

} // namespace dwf
