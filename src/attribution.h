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

// Which player created a building, stockpile, zone or work order. Session-only plugin memory
// behind one mutex; it holds no DF reads, and it is coordination metadata, NOT security.

#include <cstdint>
#include <string>

namespace dwf {

enum class AttribKind { Building, Order, Stockpile, Zone };

// Record player as the creator of (kind, id). id < 0 is ignored (a failed create never stamps).
void attrib_stamp(AttribKind kind, int32_t id, const std::string& player);

// {"world":"...","buildings":{"12":"guest"},"orders":{...},"stockpiles":{...},"zones":{...}}
std::string attrib_json();

// Call before stamping: ids are unique only per world, so a changed save_dir clears the map
// first. An empty save_dir keeps the current key rather than wiping on a transient nil.
void attrib_note_world(const std::string& save_dir);

} // namespace dwf
