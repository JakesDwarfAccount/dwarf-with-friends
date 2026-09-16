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
#include <cstdint>
#include <string>

#include "camera.h"

namespace dwf {

// WS2 map data: a viewport window read through the stable map APIs, emitted as "wire:1" JSON.

// live per-player fetch: origin = camera.x/y/z
std::string build_map_json_for_camera(const Camera& cam, int width, int height, std::string* err);

// the CURRENT host viewport window (origin = window_x/y/z), written to <out_dir>/map.json
bool dump_map_window(const std::string& out_dir, int width, int height, std::string* err);

} // namespace dwf
