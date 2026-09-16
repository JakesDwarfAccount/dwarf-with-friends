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

#include <string>

namespace dwf {

// False (no seq consumed, no broadcast) when `text` is empty after trimming. Rate-limiting is the
// CALLER's concern -- WsConnection::chat_rate_ok -- so a flood never reaches the shared ring lock.
bool chat_post(const std::string& from, const std::string& text);

void chat_system(const std::string& text);

// Call about once a second: the leave grace and the silent first-tick seed assume that cadence.
void chat_presence_tick();

// GET /chat[?since=N] -- the whole ring, or only the lines with seq > N.
void register_chat_routes(httplib::Server& server);

// ---- offline selftest (capture-chat-selftest command) --------------------------------------
// Trim + clamp to kMaxLen without splitting a trailing UTF-8 sequence; false iff the result is empty.
bool chat_sanitize(const std::string& in, std::string& out);

bool chat_selftest();

// Byte-through escaper for text that is ALREADY UTF-8 (chat lines, player names): json_util's
// json_escape runs a CP437 transcode that would corrupt it.
std::string chat_escape(const std::string& raw);

} // namespace dwf
