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

#include "request_origin.h"

#include <cstddef>
#include <string>

namespace httplib { class Server; }

namespace dwf {
namespace sound {

// serving root, relative to DF's working directory
constexpr const char* kSoundBaseDir = "data/sound/";

struct PathResolve {
    bool ok = false;
    std::string rel;       // sanitized path under kSoundBaseDir; valid only when ok
    int status = 404;      // always 404 when !ok -- never leak why a path was refused
};

inline PathResolve resolve_sound_path(const std::string& cap) {
    PathResolve r;
    if (cap.empty() || cap.size() > 512) return r;
    if (cap.front() == '/') return r;                       // no absolute paths
    for (char c : cap) {
        unsigned char u = static_cast<unsigned char>(c);
        if (u < 0x20) return r;                             // control chars / embedded NUL
        if (c == '\\' || c == ':') return r;                // backslash / drive / ADS
    }
    if (cap.find("..") != std::string::npos) return r;      // parent-dir traversal
    // case-insensitive ".ogg" suffix -- the only extension ever served
    const std::string ext = ".ogg";
    if (cap.size() < ext.size()) return r;
    for (size_t i = 0; i < ext.size(); ++i) {
        char c = cap[cap.size() - ext.size() + i];
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        if (c != ext[i]) return r;
    }
    r.ok = true;
    r.rel = cap;
    r.status = 200;
    return r;
}

inline bool remote_allowed(bool peer_is_host, bool audio_remote_cfg) {
    return peer_is_host || audio_remote_cfg;
}

// A loopback peer address alone does NOT mean the host's own browser: cloudflared/ngrok/ssh -L
// terminate on the host, so every tunnelled remote peer looks loopback too.
inline bool host_header_is_local(const std::string& host) {
    return origin_host_header_is_local(host);
}
inline bool request_is_local_host(bool peer_is_loopback, bool has_forwarded_header,
                                  const std::string& host_header) {
    return origin_has_host_authority(classify_request_origin(
        peer_is_loopback, has_forwarded_header, host_header));
}

inline bool scan_audio_remote(const std::string& text) {
    const std::string key = "\"audio_remote\"";
    size_t k = text.find(key);
    if (k == std::string::npos) return true;                // key absent -> default ON
    size_t i = k + key.size();
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t')) ++i;
    if (i >= text.size() || text[i] != ':') return true;    // malformed (no colon) -> default ON
    ++i;
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' ||
                              text[i] == '\n')) ++i;
    return text.compare(i, 5, "false") != 0;                // ONLY an explicit `false` disables
}

// DEFAULT ON: a missing, unreadable or malformed dfcapture.json resolves to true.
bool audio_remote_enabled();

} // namespace sound

// Registers GET /sound/(.+) and GET /sound-info.
void register_sound_route(httplib::Server& server);

} // namespace dwf
