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

// AttributionRegistry (WP-C foundation, wants-WT-spec §1.3).
//
// Records "which player created this thing" for the four kinds of web-issued mutations that
// return a stable DF id: buildings (workshops/furnaces/furniture), stockpiles, zones, and
// manager work orders. Pure plugin memory behind one mutex -- NO DF reads live in this module.
// The map exists only to be surfaced by GET /attrib, which the client merges into inspect
// panels + the work-orders list by id. Attribution is best-effort coordination metadata among
// cooperating players, NOT security.
//
// World-change safety: ids are only unique per world. attrib_note_world(save_dir) is called by
// each stamp site with the current save directory (read safely by the caller); a different key
// wipes the map first, so a mid-session world switch can never make a stale id lie across worlds.
// Persistence is v1 = session-only (cleared on plugin unload / DF restart).

#include <cstdint>
#include <string>

namespace dwf {

enum class AttribKind { Building, Order, Stockpile, Zone };

// Record player as the creator of (kind, id). id < 0 is ignored (a failed create never stamps).
void attrib_stamp(AttribKind kind, int32_t id, const std::string& player);

// Look up the creator of (kind, id). Returns false (and leaves player_out untouched) when unknown.
bool attrib_lookup(AttribKind kind, int32_t id, std::string& player_out);

// {"world":"...","buildings":{"12":"guest"},"orders":{...},"stockpiles":{...},"zones":{...}}
std::string attrib_json();

// Reconcile the active world key. If save_dir differs from the last seen key, the whole map is
// cleared BEFORE the caller's stamp lands (so cross-world id reuse can't alias). Empty save_dir
// (no world loaded) is treated as "keep current key" -- never wipes on a transient nil.
void attrib_note_world(const std::string& save_dir);

} // namespace dwf
