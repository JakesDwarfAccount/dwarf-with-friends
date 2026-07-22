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

// world_stream.h -- protocol v1 GLOBAL single read pass (W-A foundation spec, WA-9).
//
// The v1 wire replaces the N-per-player JSON builds (A7: 321 ms/s of CoreSuspender with a
// SINGLE player) with ONE scan + ONE encode + N cheap distributions per tick. This module
// owns GlobalMapState (world_seq / block signatures / ver / changelog) and the per-connection
// v1 stream state (interest window, sent_ver, pending set), and runs the per-tick algorithm
// (§WA-9.3): interest-union sig scan under ONE suspender, ver/world_seq bump + changelog,
// encode-once shared across connections, per-connection BLOCK_SET + AUX assembly.
//
// The legacy per-player path (build_map_delta_for_camera in tile_map_dump.cpp) served
// non-v1 connections until the wave's default flip (WA-14); WA-15 removed it, so this is
// now the ONLY map-push path.

#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

#include "websocket.h"   // V1MapInfo

namespace dwf {

// Run the v1 global read pass for THIS tick. Called once per ws_push_loop iteration (the
// only thing it does, WA-15). `capture_mu` is http_server's capture_state_mutex (the v1
// pass takes it + CoreSuspender in the same lock order as /mapdata). `presence_fn(player)`
// returns the presence[] JSON array body for that player's AUX (built by http_server's
// presence_json, which touches only the client snapshot). No-op when there are zero v1
// connections.
void world_stream_tick(std::recursive_mutex& capture_mu,
                       const std::function<std::string(const std::string&)>& presence_fn);

// DFHack lifecycle handoff. Closing the gate on SC_WORLD_UNLOADED prevents the push worker from
// taking capture/CoreSuspender locks while DF is tearing the world down. Each edge also requests
// a push-thread-owned cache reset; SC_WORLD_LOADED reopens the gate for the new world.
void world_stream_set_world_loaded(bool loaded);

// hello_ack (§0.5) map info: current map size (tiles w/h, z levels) + the live world_seq.
// Reads Maps under `capture_mu` + CoreSuspender (size cached after first read). Registered
// with set_v1_map_info() so the transport can fill hello_ack off the sim thread.
V1MapInfo world_stream_map_info(std::recursive_mutex& capture_mu);

// /diag additions (§WA-9.3e): global world_seq + per-player v1 stream stats. Returns a JSON
// object body (no surrounding braces stripped) the /diag handler splices in.
std::string world_stream_diag_json();

// Drop a fully-disconnected player's v1 diag row (called from the push loop's prune).
void world_stream_forget(const std::string& player);

} // namespace dwf
