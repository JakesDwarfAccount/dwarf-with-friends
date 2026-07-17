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

#include "bake_sweep.h"

#include "camera.h"
#include "diagnostics.h"
#include "sdl_capture.h"

#include <algorithm>
#include <chrono>
#include <deque>
#include <mutex>
#include <set>
#include <string>
#include <tuple>
#include <vector>

namespace dwf {
namespace {

constexpr int kMaxStepsPerTick = 1;
// 10 private renders/s is a 25% ceiling against the measured ~40 shared render/s limit.
constexpr std::chrono::milliseconds kMinStepInterval(100);

std::mutex g_mu;
std::deque<Camera> g_steps;
bool g_auto_pending = false;
bool g_auto_done = false;
bool g_manual_pending = false;
uintptr_t g_world_identity = 0;
std::chrono::steady_clock::time_point g_last_step{};

int clamp_origin(int value, int viewport, int map_extent) {
    const int max_origin = std::max(0, map_extent - std::max(1, viewport));
    return std::max(0, std::min(value, max_origin));
}

std::vector<Camera> plan_boxes(const std::vector<BakeSweepPoint>& points,
                               int viewport_w, int viewport_h,
                               int map_w, int map_h) {
    viewport_w = std::max(1, viewport_w);
    viewport_h = std::max(1, viewport_h);
    std::set<std::tuple<int, int, int>> unique;
    for (const auto& p : points) {
        if (p.x >= 0 && p.y >= 0 && p.z >= 0)
            unique.emplace(p.z, p.y, p.x);
    }

    std::vector<BakeSweepPoint> remaining;
    remaining.reserve(unique.size());
    for (const auto& p : unique)
        remaining.push_back({std::get<2>(p), std::get<1>(p), std::get<0>(p)});

    std::vector<Camera> boxes;
    std::vector<bool> covered(remaining.size(), false);
    for (size_t i = 0; i < remaining.size(); ++i) {
        if (covered[i]) continue;
        const BakeSweepPoint& seed = remaining[i];
        Camera box;
        box.x = clamp_origin(seed.x - viewport_w / 2, viewport_w, map_w);
        box.y = clamp_origin(seed.y - viewport_h / 2, viewport_h, map_h);
        box.z = seed.z;
        for (size_t j = i; j < remaining.size(); ++j) {
            const BakeSweepPoint& p = remaining[j];
            if (p.z == box.z && p.x >= box.x && p.x < box.x + viewport_w &&
                p.y >= box.y && p.y < box.y + viewport_h) {
                covered[j] = true;
            }
        }
        boxes.push_back(box);
    }
    return boxes;
}

} // namespace

void bake_sweep_arm_auto() {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_auto_done)
        g_auto_pending = true;
}

void bake_sweep_arm_manual() {
    std::lock_guard<std::mutex> lock(g_mu);
    g_manual_pending = true;
}

void bake_sweep_observe_world(uintptr_t world_identity) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (world_identity == 0 || world_identity == g_world_identity)
        return;
    g_world_identity = world_identity;
    g_steps.clear();
    g_auto_done = false;
    g_auto_pending = true;
}

bool bake_sweep_needs_candidates() {
    std::lock_guard<std::mutex> lock(g_mu);
    return g_auto_pending || g_manual_pending;
}

void bake_sweep_submit_candidates(const std::vector<BakeSweepPoint>& points,
                                  int viewport_w, int viewport_h,
                                  int map_w, int map_h) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_auto_pending && !g_manual_pending)
        return;

    g_steps.clear();
    for (const Camera& box : plan_boxes(points, viewport_w, viewport_h, map_w, map_h))
        g_steps.push_back(box);
    g_auto_pending = false;
    g_manual_pending = false;
    g_auto_done = true;
}

bool bake_sweep_active() {
    std::lock_guard<std::mutex> lock(g_mu);
    return !g_steps.empty() || g_auto_pending || g_manual_pending;
}

void bake_sweep_tick(std::recursive_mutex& capture_mu) {
    Camera target;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        if (g_steps.empty())
            return;
        const auto now = std::chrono::steady_clock::now();
        if (g_last_step.time_since_epoch().count() != 0 &&
            now - g_last_step < kMinStepInterval)
            return;
        target = g_steps.front();
    }

    std::string err;
    bool completed = false;
    {
        std::lock_guard<std::recursive_mutex> capture_lock(capture_mu);
        for (int step = 0; step < kMaxStepsPerTick; ++step) {
            completed = bake_sweep_render_step(target, &err);
            break;
        }
    }

    std::lock_guard<std::mutex> lock(g_mu);
    g_last_step = std::chrono::steady_clock::now();
    if (completed && !g_steps.empty() &&
        g_steps.front().x == target.x && g_steps.front().y == target.y &&
        g_steps.front().z == target.z) {
        g_steps.pop_front();
    } else if (!err.empty()) {
        diagnostics_log_v("bake-sweep: deferred " + err);
    }
}

} // namespace dwf
