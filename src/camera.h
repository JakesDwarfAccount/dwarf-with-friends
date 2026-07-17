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

namespace dwf {

struct Camera {
    int x = 0;
    int y = 0;
    int z = 0;
    int zoom_factor = -1; // -1 inherits the fixed reference zoom; otherwise percent scale.

    int placement_mode = 0;
    int hover_px = -1;
    int hover_py = -1;
    int ui_frame_w = 0;
    int ui_frame_h = 0;
    int drag_active = 0;
    int drag_px = -1;
    int drag_py = -1;
    int build_w = 0;
    int build_h = 0;

    // Smooth sub-tile cursor (Figma-style), fed by WebSocket {"type":"cursor"} messages.
    // Stored as WORLD coords: integer tile (cur_x,cur_y,cur_z) + fractional in-tile offset
    // (cur_fx,cur_fy in 0..1), so it is camera-independent and every viewer can place it in
    // its own window. cur_active_ms == 0 => this player has no smooth cursor yet; a separate
    // (shorter) staleness window than presence ages it out when the pointer stops moving.
    int cur_x = 0;
    int cur_y = 0;
    int cur_z = 0;
    float cur_fx = 0.0f;
    float cur_fy = 0.0f;
    int cur_drag = 0;
    long long cur_active_ms = 0;

    // Multiplayer presence: monotonic ms of this player's last cursor/camera activity,
    // so /mapdata can drop stale (disconnected) cursors. 0 == never stamped.
    long long last_active_ms = 0;
};

} // namespace dwf
