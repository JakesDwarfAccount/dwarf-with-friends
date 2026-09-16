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

// world_stream.h -- the protocol v1 global map read/push pass and its per-connection stream state.

#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

#include "websocket.h"   // V1MapInfo

namespace dwf {

// Run the v1 global read pass for this tick. Takes `capture_mu` and only then the CoreSuspender --
// the same lock order as /mapdata; reversing it deadlocks.
void world_stream_tick(std::recursive_mutex& capture_mu,
                       const std::function<std::string(const std::string&)>& presence_fn);

// Close this gate on SC_WORLD_UNLOADED: the push worker must not take capture/CoreSuspender locks
// while DF is tearing the world down.
void world_stream_set_world_loaded(bool loaded);

// hello_ack map info: map size (tiles w/h, z levels) + the live world_seq.
V1MapInfo world_stream_map_info(std::recursive_mutex& capture_mu);

// /diag's "v1" object: global world_seq + per-player v1 stream stats.
std::string world_stream_diag_json();

void world_stream_forget(const std::string& player);

} // namespace dwf
