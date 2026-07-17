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

// WS2 map-data pivot (crash-safe). Reads a viewport window via the STABLE map
// APIs (Maps::getBlock + MapExtras::MapCache + world->units/buildings) -- NEVER
// the graphic_viewportst render arrays. Produces "wire:1" JSON.
//
// This is the deliberate alternative to approach A (render-buffer scraping):
// it touches only stable simulation structures under the core suspender, so
// the SIGSEGV fault class that crashed approach A cannot occur here.

// Convenience wrapper for a live per-player fetch: origin = camera.x/y/z.
// Same crash-safe reader; returns "" + err on failure.
std::string build_map_json_for_camera(const Camera& cam, int width, int height, std::string* err);

// Existing command path: builds the CURRENT host viewport window
// (origin = window_x/y/z) and writes it to <out_dir>/map.json.
// Returns false + err on failure. Null/edge blocks are skipped, never faulted.
bool dump_map_window(const std::string& out_dir, int width, int height, std::string* err);

} // namespace dwf
