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

#include "client_state.h"

#include "sdl_capture.h"
#include "surface_z.h"

#include "Core.h"
#include "TileTypes.h"
#include "modules/Maps.h"

#include "df/building.h"
#include "df/building_type.h"
#include "df/coord.h"
#include "df/global_objects.h"
#include "df/tiletype.h"
#include "df/tiletype_material.h"
#include "df/tiletype_shape_basic.h"
#include "df/world.h"

#include <algorithm>
#include <chrono>
#include <mutex>
#include <unordered_map>

namespace dwf {
namespace {

std::mutex g_client_mutex;
std::unordered_map<std::string, Camera> g_player_cameras;

// W2: per-player follow target (see FollowTarget in client_state.h). Guarded by the same mutex as
// the cameras because set_player_camera clears it -- one lock, no ordering to get wrong.
std::unordered_map<std::string, FollowTarget> g_player_follow;

// Host-camera cache (crash fix 2026-07-09). camera_for_player's unknown-player fallback
// used to marshal read_host_camera() onto the render thread from the v1 push loop and the
// per-conn writers. When that first marshaled read lands behind render-thread work stalled
// on capture_mu / the v1 CoreSuspender bursts, it times out (3s), is retried EVERY tick
// (failure is never cached), and the repeated main-thread park/unpark churn while captures
// mutate DF window state ends in DF's own renderer AVing -- observed twice at the identical
// DF.exe offset on the sprite-range world (~300 suspender-ms/s), reproduced in seconds by
// any camera-less proto1 join; the same join with a pre-set camera streams flawlessly.
// The cache is warmed from world_stream_tick's suspended section and capture_shifted (both
// already hold safe DF access), so the fallback below almost never touches DF at all.
std::mutex g_host_cam_mutex;
Camera g_host_cam;
bool g_host_cam_valid = false;

int surface_z_for_initial_camera(int x, int y, df::world* world) {
    if (!world || x < 0 || y < 0)
        return 0;
    for (int z = static_cast<int>(world->map.z_count) - 1; z >= 0; --z) {
        auto tile = DFHack::Maps::getTileType(df::coord(x, y, z));
        if (!tile)
            continue;
        auto shape = DFHack::tileShapeBasic(DFHack::tileShape(*tile));
        if (shape == df::tiletype_shape_basic::Open || shape == df::tiletype_shape_basic::None)
            continue;
        if (surface_z_skips_canopy(*tile))
            continue;
        return z;
    }
    return 0;
}

bool seed_first_join_camera(Camera& camera) {
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    auto world = df::global::world;
    if (!world)
        return false;

    constexpr int kInitialHalfWidth = 40;
    constexpr int kInitialHalfHeight = 25;
    for (auto building : world->buildings.all) {
        if (!building || building->getType() != df::building_type::Wagon)
            continue;
        camera.x = building->centerx - kInitialHalfWidth;
        camera.y = building->centery - kInitialHalfHeight;
        camera.z = building->z;
        return true;
    }

    int center_x = std::max(0, static_cast<int>(world->map.x_count) / 2);
    int center_y = std::max(0, static_cast<int>(world->map.y_count) / 2);
    camera.x = center_x - kInitialHalfWidth;
    camera.y = center_y - kInitialHalfHeight;
    camera.z = surface_z_for_initial_camera(center_x, center_y, world);
    return true;
}

} // namespace

long long now_monotonic_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

bool camera_for_player(const std::string& player, Camera& camera, std::string* err) {
    {
        std::lock_guard<std::mutex> lock(g_client_mutex);
        auto it = g_player_cameras.find(player);
        if (it != g_player_cameras.end()) {
            camera = it->second;
            return true;
        }
    }

    // A player who has never moved gets an embark-oriented camera. Existing entries above
    // remain authoritative, so reconnecting players keep their independently saved view.
    if (!seed_first_join_camera(camera)) {
        bool have_host = false;
        {
            std::lock_guard<std::mutex> lock(g_host_cam_mutex);
            if (g_host_cam_valid) {
                camera = g_host_cam;
                have_host = true;
            }
        }
        if (!have_host) {
            // Cold cache: no v1 tick or capture has run yet this world (e.g. GET /camera right
            // after plugin start). A single marshaled read is acceptable here -- the wedge above
            // needs the repeated-per-tick retry loop, which the cache now prevents.
            if (!read_host_camera(camera, err))
                return false;
            note_host_camera(camera);
        }
    }
    if (!clamp_camera(camera, err))
        return false;

    {
        std::lock_guard<std::mutex> lock(g_client_mutex);
        g_player_cameras[player] = camera;
    }
    return true;
}

void note_host_camera(const Camera& camera) {
    std::lock_guard<std::mutex> lock(g_host_cam_mutex);
    g_host_cam.x = camera.x;
    g_host_cam.y = camera.y;
    g_host_cam.z = camera.z;
    g_host_cam_valid = true;
}

void set_player_camera(const std::string& player, const Camera& camera) {
    std::lock_guard<std::mutex> lock(g_client_mutex);
    Camera& stored = g_player_cameras[player];
    long long keep = stored.last_active_ms;
    stored = camera;
    // A camera move is presence activity; preserve any newer stamp already stored.
    stored.last_active_ms = std::max(keep, now_monotonic_ms());
}

void forget_player_camera(const std::string& player) {
    std::lock_guard<std::mutex> lock(g_client_mutex);
    g_player_cameras.erase(player);
    g_player_follow.erase(player);
}

void rename_player_state(const std::string& oldName, const std::string& newName) {
    if (oldName == newName || newName.empty()) return;
    std::lock_guard<std::mutex> lock(g_client_mutex);
    auto camIt = g_player_cameras.find(oldName);
    if (camIt != g_player_cameras.end()) {
        // Carry the whole Camera (position, zoom_factor, placement + smooth-cursor fields, and the
        // last_active_ms presence heartbeat) so the renamed player keeps their exact view.
        g_player_cameras[newName] = camIt->second;
        g_player_cameras.erase(camIt);
    }
    auto folIt = g_player_follow.find(oldName);
    if (folIt != g_player_follow.end()) {
        g_player_follow[newName] = folIt->second;
        g_player_follow.erase(folIt);
    }
}

// W2: follow-target store. All four are O(1) hash lookups under the existing mutex -- they never
// touch DF, so they are safe to call from any HTTP worker thread without a CoreSuspender.
void set_player_follow(const std::string& player, const std::string& kind, int32_t id) {
    std::lock_guard<std::mutex> lock(g_client_mutex);
    if (id < 0 || (kind != "unit" && kind != "item")) {
        g_player_follow.erase(player);
        return;
    }
    FollowTarget& target = g_player_follow[player];
    target.kind = kind;
    target.id = id;
}

void forget_player_follow(const std::string& player) {
    std::lock_guard<std::mutex> lock(g_client_mutex);
    g_player_follow.erase(player);
}

FollowTarget player_follow(const std::string& player) {
    std::lock_guard<std::mutex> lock(g_client_mutex);
    auto it = g_player_follow.find(player);
    return it == g_player_follow.end() ? FollowTarget{} : it->second;
}

bool player_is_following(const std::string& player, const std::string& kind, int32_t id) {
    if (id < 0)
        return false;
    FollowTarget target = player_follow(player);
    return target.id == id && target.kind == kind;
}

bool zoom_player_camera(const std::string& player, const std::string& direction,
                        Camera& camera, std::string* err) {
    Camera current;
    if (!camera_for_player(player, current, err))
        return false;

    std::lock_guard<std::mutex> lock(g_client_mutex);
    Camera& stored = g_player_cameras[player];
    if (direction == "reset") {
        stored.zoom_factor = -1;
    } else {
        int zoom = stored.zoom_factor >= 0 ? stored.zoom_factor : 100;
        if (direction == "in") {
            zoom -= 20;
        } else if (direction == "out") {
            zoom += 20;
        } else {
            if (err) *err = "bad zoom direction";
            return false;
        }
        stored.zoom_factor = std::max(40, std::min(300, zoom));
    }
    camera = stored;
    return true;
}

bool set_player_placement_mode(const std::string& player, bool active,
                               Camera& camera, std::string* err) {
    Camera current;
    if (!camera_for_player(player, current, err))
        return false;

    std::lock_guard<std::mutex> lock(g_client_mutex);
    Camera& stored = g_player_cameras[player];
    stored.placement_mode = active ? 1 : 0;
    if (!active) {
        stored.hover_px = -1;
        stored.hover_py = -1;
        stored.drag_active = 0;
        stored.drag_px = -1;
        stored.drag_py = -1;
    }
    camera = stored;
    return true;
}

bool set_player_placement_cursor(const std::string& player, int hx, int hy,
                                 int frame_w, int frame_h, bool dragging,
                                 int drag_x, int drag_y, int build_w, int build_h,
                                 Camera& camera, std::string* err) {
    Camera current;
    if (!camera_for_player(player, current, err))
        return false;

    std::lock_guard<std::mutex> lock(g_client_mutex);
    Camera& stored = g_player_cameras[player];
    stored.hover_px = hx;
    stored.hover_py = hy;
    stored.ui_frame_w = std::max(0, frame_w);
    stored.ui_frame_h = std::max(0, frame_h);
    stored.drag_active = dragging ? 1 : 0;
    stored.drag_px = drag_x;
    stored.drag_py = drag_y;
    stored.build_w = std::max(0, build_w);
    stored.build_h = std::max(0, build_h);
    stored.last_active_ms = now_monotonic_ms();   // presence heartbeat
    camera = stored;
    return true;
}

void set_player_precise_cursor(const std::string& player, int x, int y, int z,
                               float fx, float fy, bool dragging) {
    // Clamp the fractional offset defensively so a bad client can never push a wild value
    // into the render math on other clients.
    if (fx < 0.0f) fx = 0.0f; else if (fx > 1.0f) fx = 1.0f;
    if (fy < 0.0f) fy = 0.0f; else if (fy > 1.0f) fy = 1.0f;

    std::lock_guard<std::mutex> lock(g_client_mutex);
    Camera& stored = g_player_cameras[player];   // creates a default camera if none yet
    stored.cur_x = x;
    stored.cur_y = y;
    stored.cur_z = z;
    stored.cur_fx = fx;
    stored.cur_fy = fy;
    stored.cur_drag = dragging ? 1 : 0;
    long long now = now_monotonic_ms();
    stored.cur_active_ms = now;
    stored.last_active_ms = std::max(stored.last_active_ms, now);   // presence heartbeat
}

std::vector<ClientCamera> client_camera_snapshot() {
    std::vector<ClientCamera> out;
    std::lock_guard<std::mutex> lock(g_client_mutex);
    out.reserve(g_player_cameras.size());
    for (const auto& entry : g_player_cameras)
        out.push_back(ClientCamera{entry.first, entry.second});
    return out;
}

} // namespace dwf
