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
#include <string>
namespace dwf {

// Options for the render-buffer feasibility dumps (§6.6 agent, 2026-07-06).
// Defaults reproduce the original T0 behaviour exactly.
struct TileDumpOptions {
    bool have_camera = false;   // false -> host camera (read_host_camera)
    int x = 0, y = 0, z = 0;    // explicit camera when have_camera
    bool with_atlas = true;     // atlas is ~129k files; skip for repeated/sweep dumps
    bool with_ground_truth = true;  // skip the PNG encode for fast sweep dumps
};

// Dumps one live frame's 26 tile-layer arrays + the full texpos->SDL_Surface atlas to
// <out_dir>/frame.bin, <out_dir>/atlas/*, and a JPEG-path ground_truth.png for the same tick.
// Runs the DF reads on the render thread. Returns false + err on failure.
bool dump_tile_frame(const std::string& out_dir, std::string* err);

// Extended variant: arbitrary camera, optional atlas/ground-truth, and a meta.json sidecar
// (camera, dims, sim tick, capture ms) so sweep drivers can index dumps.
bool dump_tile_frame_ex(const std::string& out_dir, const TileDumpOptions& opt, std::string* err);

} // namespace dwf
