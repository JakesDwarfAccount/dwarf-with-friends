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

// One frame's 26 viewport tile-layer arrays. `bytes` holds them in WIRE_VERSION 1 canonical order,
// each [u8 elem_size][dim_x*dim_y little-endian elements]; a null or faulting layer is all zeros.
struct TileLayerDump {
    int dim_x = 0;
    int dim_y = 0;
    int origin_x = 0;
    int origin_y = 0;
    int z = 0;
    std::vector<uint8_t> bytes;
    bool ok = false;
};

// Windows-only. `frame` and `layers` come from the same tick, so they describe the same viewport.
bool capture_frame_with_tile_layers(const Camera& camera, CapturedFrame& frame,
                                    TileLayerDump& layers, std::string* err = nullptr);
// Cached variant. `seq` increments only when a newly rendered frame is returned, so it backs an ETag.
bool capture_camera_jpeg_cached(const std::string& player, const Camera& camera,
                                std::vector<uint8_t>& jpeg, uint64_t& seq,
                                std::string* err = nullptr);
std::recursive_mutex& capture_state_mutex();

} // namespace dwf
