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

// Set from DFHack's pre-save callback before DF begins serializing world memory.
void save_barrier_begin();

// Called from plugin_onupdate on DF's core thread. Clears only after DF's save request and
// save viewscreen have both disappeared for several completed update frames.
void save_barrier_update();

// Safe from HTTP/Lua worker threads.
bool save_barrier_active();

// Lifecycle reset for a newly loaded/unloaded world.
void save_barrier_reset();

} // namespace dwf
