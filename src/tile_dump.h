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

struct TileDumpOptions {
    bool have_camera = false;   // false -> host camera (read_host_camera)
    int x = 0, y = 0, z = 0;    // explicit camera when have_camera
    bool with_atlas = true;     // the atlas is huge; skip it for repeated/sweep dumps
    bool with_ground_truth = true;  // skip the PNG encode for fast sweep dumps
};

// Dumps one live frame's 26 tile-layer arrays + the texpos->SDL_Surface atlas to <out_dir> as
// frame.bin, atlas/*, ground_truth.png and meta.json. The DF reads run on the render thread.
bool dump_tile_frame_ex(const std::string& out_dir, const TileDumpOptions& opt, std::string* err);

} // namespace dwf
