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

// Host-side squad emblem roll: triggers native's own random-emblem generator for squads no
// browser client will ever cause native to draw.
#pragma once

#include <string>

namespace dwf {

// Idempotent: a squad that already has a baked emblem is never touched, and
// concurrent callers serialize (the first roll persists; the rest see it baked and skip).
// Must NOT be called with the core suspended: the roll is marshalled to the render thread, and a
// suspended core cannot drain that queue. Returns the number of squads rolled.
int squad_emblem_ensure_native_roll(std::string* err = nullptr);

} // namespace dwf
