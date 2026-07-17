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

#include <string>

#include "ColorText.h"

namespace dwf {

constexpr int DEFAULT_STREAM_PORT = 8765;
// Target client refresh rate. The per-player frame cache and adaptive render throttle in
// capture_camera_jpeg_cached() keep the render-thread cost bounded, so a higher poll rate
// only costs cheap cache hits / HTTP 304s when nothing changed.
constexpr int DEFAULT_STREAM_FPS = 24;
constexpr const char* DEFAULT_BIND_ADDRESS = "127.0.0.1";

bool start_server(int port, const std::string& bind_address, std::string* err = nullptr);
void stop_server();
bool server_running();
std::string server_url();
std::string server_url(const std::string& bind_address, int port);
// Wakes every in-flight /stream push loop early (input-kick), so a player's action shows up in
// the next pushed frame instead of waiting out the pacing interval. Safe to call from any thread.
void notify_player_input();

} // namespace dwf
