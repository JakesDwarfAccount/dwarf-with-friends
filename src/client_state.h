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

#include "camera.h"

#include <string>
#include <vector>

namespace dwf {

struct ClientCamera {
    std::string player;
    Camera camera;
};

// Plain per-player state, not a camera loop: the recentring runs in the client's follow tick.
// POST /camera clears it on any pan that does not carry `follow=1` (session_routes.cpp).
struct FollowTarget {
    std::string kind;   // "unit" | "item"; empty == not following anything
    int32_t id = -1;
};

void set_player_follow(const std::string& player, const std::string& kind, int32_t id);
void forget_player_follow(const std::string& player);
FollowTarget player_follow(const std::string& player);
bool player_is_following(const std::string& player, const std::string& kind, int32_t id);

bool camera_for_player(const std::string& player, Camera& camera, std::string* err = nullptr);
// Warm the cross-thread host-camera cache from a context that already holds safe DF access; while
// it is cold, camera_for_player's unknown-player fallback marshals onto the render thread.
void note_host_camera(const Camera& camera);
void set_player_camera(const std::string& player, const Camera& camera);
void forget_player_camera(const std::string& player);
// In-session RENAME: carries the camera, zoom, smooth cursor and follow target to the new name.
void rename_player_state(const std::string& oldName, const std::string& newName);
bool zoom_player_camera(const std::string& player, const std::string& direction,
                        Camera& camera, std::string* err = nullptr);
bool set_player_placement_mode(const std::string& player, bool active,
                               Camera& camera, std::string* err = nullptr);
bool set_player_placement_cursor(const std::string& player, int hx, int hy,
                                 int frame_w, int frame_h, bool dragging,
                                 int drag_x, int drag_y, int build_w, int build_h,
                                 Camera& camera, std::string* err = nullptr);

// Touches no DF state, unlike the camera getters, so it is safe on a WS worker thread.
void set_player_precise_cursor(const std::string& player, int x, int y, int z,
                               float fx, float fy, bool dragging);
std::vector<ClientCamera> client_camera_snapshot();

long long now_monotonic_ms();

} // namespace dwf
