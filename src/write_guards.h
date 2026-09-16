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

// The C++ binding of the dfcapture-hostwrites.json guard mechanism -- the same file dwf.lua's
// hw_flags reads. There is one flag file and one reader convention; never add a second.

#pragma once

#include <string>

namespace httplib { class Server; struct Request; }

namespace dwf {
namespace guards {

// The flag names (single source for C++ call sites; the Lua side spells its own).
constexpr const char* kConsoleFlag = "dfhack_console";

// FAIL CLOSED: only a boundary-clean literal `true` enables. Absent key, malformed colon, `false`,
// `"true"`, `TRUE`, `1`, `truex` all scan off. (sound_route.h's audio scan fails OPEN -- not this.)
inline bool scan_hostwrite_flag(const std::string& text, const std::string& flag) {
    const std::string key = "\"" + flag + "\"";
    size_t k = text.find(key);
    if (k == std::string::npos) return false;                 // key absent -> OFF
    size_t i = k + key.size();
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t')) ++i;
    if (i >= text.size() || text[i] != ':') return false;     // malformed -> OFF
    ++i;
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' ||
                               text[i] == '\n')) ++i;
    const size_t after = i + 4;
    if (after < text.size()) {
        const char c = text[after];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '_')
            return false;                                     // `truex` etc. -> OFF
    }
    return text.compare(i, 4, "true") == 0;
}

// Missing or unreadable file -> false. The text is cached on a short TTL, so a host toggle takes
// effect within seconds without a plugin reload.
bool hostwrite_enabled(const std::string& flag);

// The same refusal shape dwf.lua's hw_guarded emits, so clients treat Lua- and C++-guarded routes
// identically. `what` names the refused action; `why` is the one-sentence host-facing reason.
std::string guarded_refusal_json(const std::string& flag, const std::string& what,
                                 const std::string& why);

// True iff the request comes from the host's own browser tab (request_origin.h's shared classifier).
bool request_is_host_tab(const httplib::Request& req);

// Register above the catch-all so auth pre-routing covers these routes.
void register_write_guard_routes(httplib::Server& server);

} // namespace guards
} // namespace dwf
