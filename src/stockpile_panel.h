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

#include "httplib.h"

#include <cstdint>
#include <string>

namespace dwf {

std::string stockpile_info_json_on_core_thread(int32_t id);
bool rename_stockpile_on_core_thread(int32_t id, const std::string& name);
bool remove_stockpile_on_core_thread(int32_t id);
bool set_stockpile_links_only_on_core_thread(int32_t id, bool on);
bool set_stockpile_storage_on_core_thread(int32_t id, int barrels, int bins, int wheelbarrows);
bool set_stockpile_link_on_core_thread(int32_t id, int32_t target_id, const std::string& mode,
                                       bool on, std::string* err);
bool finish_stockpile_repaint_on_core_thread(int32_t old_id, int32_t new_id,
                                             int32_t& final_id, std::string* err);
// Exact-mask repaint support (mode=replace): carves the '0' cells of a row-major '0'/'1' bitmap
// out of the freshly created replacement pile (carve-only; construct-time exclusions preserved).
bool carve_stockpile_extent_mask_on_core_thread(int32_t id, int x1, int y1, int x2, int y2,
                                                int z, const std::string& mask,
                                                std::string* err);

// Registers this module's HTTP routes (moved verbatim from http_server.cpp's
// register_routes monolith -- B212, 2026-07-13).
void register_stockpile_routes(httplib::Server& server);

} // namespace dwf
