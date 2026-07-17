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
#include "frame.h"

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace dwf {

bool read_host_camera(Camera& camera, std::string* err = nullptr);
bool clamp_camera(Camera& camera, std::string* err = nullptr);
bool effective_capture_viewport_dims(const Camera& camera, int& width_tiles,
                                     int& height_tiles, std::string* err = nullptr);
bool capture_camera_frame(const Camera& camera, CapturedFrame& frame, std::string* err = nullptr);
bool capture_camera_jpeg(const Camera& camera, std::vector<uint8_t>& jpeg, std::string* err = nullptr);

// One guarded, render-thread host-camera step for the portrait bake sweep. The caller must
// hold capture_state_mutex(); this function always restores window_x/y/z before returning.
bool bake_sweep_render_step(const Camera& target, std::string* err = nullptr);

// WS2 T0 gate: one frame's 26 current-frame viewport tile-layer arrays, copied at the
// validated post-render moment inside the capture path. `bytes` holds the 26 blocks in the
// WIRE_VERSION 1 canonical order, each block = [u8 elem_size][dim_x*dim_y raw little-endian
// elements]; a layer whose source pointer is null or faults is written as all-zero elements.
struct TileLayerDump {
    int dim_x = 0;
    int dim_y = 0;
    int origin_x = 0;
    int origin_y = 0;
    int z = 0;
    std::vector<uint8_t> bytes;
    bool ok = false;
};

// Runs the capture on the render thread with all viewport guards (window coords,
// ViewportZoomGuard, render_map_for_current_window, live-fort gate). At the validated
// post-render moment it copies the 26 layer arrays into `layers` (SEH-guarded, null-checked)
// and returns the same-tick rendered frame in `frame` for a ground-truth image. Windows-only.
bool capture_frame_with_tile_layers(const Camera& camera, CapturedFrame& frame,
                                    TileLayerDump& layers, std::string* err = nullptr);
// Cached variant: serves the player's previous JPEG when the camera is unchanged and the
// simulation hasn't ticked (or within the adaptive render throttle window), and falls back
// to the last good frame when a capture is skipped (host interaction, load/save gates).
// `seq` increments only when a newly rendered frame is returned, so it can back an ETag.
bool capture_camera_jpeg_cached(const std::string& player, const Camera& camera,
                                std::vector<uint8_t>& jpeg, uint64_t& seq,
                                std::string* err = nullptr);
std::recursive_mutex& capture_state_mutex();

} // namespace dwf
