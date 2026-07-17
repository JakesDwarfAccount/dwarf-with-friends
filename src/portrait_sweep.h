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

namespace dwf {

// PORTRAITS-ROOT (B128): DF 53.x generates unit portrait textures LAZILY -- a unit's
// portrait_texpos stays 0 for the whole session until a unit view sheet is rendered for
// that unit (natively or via the plugin's guarded view-sheet emulation). Before this
// sweep, portraits therefore only existed for units the HOST had personally viewed in
// the Steam UI. The sweep triggers DF's own generator for every streamed unit at world
// load and for each new arrival: one unit per paced step, deferring whenever the host
// interface actually has a sheet open, so browser players get native busts with zero
// native-view dependency.

// Reset all sweep state when the loaded world changes.
void portrait_sweep_observe_world(uintptr_t world_identity);

// Offer a unit for portrait generation. Called during the world_stream unit scan (under
// CoreSuspender) for units whose portrait_texpos is still 0. Deduplicated internally;
// fort-controlled units are generated before everything else.
void portrait_sweep_note_unit(int32_t unit_id, bool fort_priority);

// Run at most one paced generation step. Called from the stream push tick AFTER the
// CoreSuspender scan lock is released (same slot as bake_sweep_tick). Never runs a step
// while the map bake sweep still has camera steps queued.
void portrait_sweep_tick();

// Forget attempted/failed units so the next unit scan re-offers everything still at
// texpos 0 (manual `capture-portrait-sweep rearm`).
void portrait_sweep_rearm();

// One-line human status for the console command.
std::string portrait_sweep_status();

} // namespace dwf
