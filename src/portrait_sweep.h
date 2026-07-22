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

// DF 53.x creates portrait_texpos lazily when it displays a unit sheet. This sweep restores
// automatic portraits by calling DF's OWN one-argument portrait generator directly on the render
// thread (exe-pinned and SEH-latched in unit_portrait.cpp). It never opens or impersonates a
// view sheet, never calls viewscreen logic/render, and never holds renderer or interface state
// across frames — the rejected mechanisms stay rejected. The sweep itself only paces work (one
// unit per update tick at most) and keeps honest per-outcome accounting.

// Reset all sweep state when the loaded world changes.
void portrait_sweep_observe_world(uintptr_t world_identity);

// Record a portrait-less streamed unit. Deduplicated internally.
void portrait_sweep_note_unit(int32_t unit_id, bool fort_priority);

// Paced update hook: dispatches at most ONE unit's native generation to the render thread,
// without blocking DF's update thread. Hard-gated on the save barrier and the fault latch.
void portrait_sweep_tick();

// Record an explicit browser request; jumps the queue and retries prior failures once.
void portrait_sweep_request_unit(int32_t unit_id);

// Lifecycle symmetry (save/unload/shutdown). No native state is ever held across frames; any
// queued callback re-validates the save barrier and its unit id before acting.
void portrait_sweep_abort_active();

// Runtime controls for `capture-portrait-sweep on|off|limit N`. The limit is a session cap on
// attempted generations (0 = unlimited) used to canary a fresh deployment.
void portrait_sweep_set_enabled(bool enabled);
void portrait_sweep_set_limit(int limit);

// Forget attempted/failed units so the next unit scan re-offers everything still at
// texpos 0 (manual `capture-portrait-sweep rearm`).
void portrait_sweep_rearm();

// One-line human status for the console command.
std::string portrait_sweep_status();

} // namespace dwf
