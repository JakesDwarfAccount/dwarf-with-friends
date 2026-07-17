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

// W2 (wave-4 wire batch) -- the per-player FOLLOW TARGET.
//
// Before this there was NO follow state anywhere on the server: `/stock-item-action?action=follow`
// was a one-shot camera jump, and unit-following lived entirely in the browser
// (dwf-unit-hud-notifications.js `unitFollowId` + its 250ms recentre loop). So the item and
// unit sheets' camera tile could never take its native _ACTIVE (green) sprite -- nothing on the
// wire said "you are following this".
//
// This is deliberately PLAIN STATE, not a camera loop. It records what the player DECLARED they are
// following; the recentring itself stays where it already works (the client's follow tick). Putting
// a follow loop on the server's per-frame camera path would mean reading DF memory for every player
// every frame -- AGENTS.md hard rule 5, the CoreSuspender starvation trap -- for a job the client
// already does correctly.
//
// Cleared by the POST /camera handler on any player-initiated pan (http_server.cpp) -- exactly DF's
// own rule: pan the view and the follow breaks. A follow tick's own recentre passes `follow=1` to
// POST /camera so it does not cancel itself. Also cleared with the player's camera on disconnect.
struct FollowTarget {
    std::string kind;   // "unit" | "item"; empty == not following anything
    int32_t id = -1;
};

void set_player_follow(const std::string& player, const std::string& kind, int32_t id);
void forget_player_follow(const std::string& player);
FollowTarget player_follow(const std::string& player);
bool player_is_following(const std::string& player, const std::string& kind, int32_t id);

bool camera_for_player(const std::string& player, Camera& camera, std::string* err = nullptr);
// Warm the cross-thread host-camera cache (x/y/z only). Call from contexts that already
// hold safe DF access (the v1 suspended section, capture_shifted on the render thread) so
// camera_for_player's unknown-player fallback never has to marshal onto the render thread.
void note_host_camera(const Camera& camera);
void set_player_camera(const std::string& player, const Camera& camera);
void forget_player_camera(const std::string& player);
// In-session RENAME: carry a player's name-keyed camera (view + zoom + smooth cursor) and follow
// target from oldName to newName. Called after the WS registry rename so the renamed connection's
// view does not snap to the host camera (a brand-new name would seed one). No-op if oldName has no
// stored state; overwrites any stale orphan already under newName. See websocket.cpp rename handler.
void rename_player_state(const std::string& oldName, const std::string& newName);
bool zoom_player_camera(const std::string& player, const std::string& direction,
                        Camera& camera, std::string* err = nullptr);
bool set_player_placement_mode(const std::string& player, bool active,
                               Camera& camera, std::string* err = nullptr);
bool set_player_placement_cursor(const std::string& player, int hx, int hy,
                                 int frame_w, int frame_h, bool dragging,
                                 int drag_x, int drag_y, int build_w, int build_h,
                                 Camera& camera, std::string* err = nullptr);

// Smooth sub-tile cursor from a WebSocket {"type":"cursor"} message. Stores the precise
// WORLD position (tile x/y/z + fractional in-tile fx/fy) for this player and refreshes the
// presence heartbeat. Cheap + lock-guarded: does NOT touch DF/core (unlike the camera
// getters), so it is safe to call from a WS worker thread. No-op-safe if the player has no
// camera yet (a default one is created; cursors carry their own world coords regardless).
void set_player_precise_cursor(const std::string& player, int x, int y, int z,
                               float fx, float fy, bool dragging);
std::vector<ClientCamera> client_camera_snapshot();

// Process-wide monotonic clock in milliseconds. Used to stamp Camera::last_active_ms
// and to age out stale presence cursors; both sides must read the SAME clock.
long long now_monotonic_ms();

} // namespace dwf
