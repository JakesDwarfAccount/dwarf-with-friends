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

// Self-contained helpers that belong to no single module: the monotonic clock, recursive
// mkdir, and base64. Header-only, so sharing adds no link surface.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <string>

#ifdef _WIN32
#include <direct.h>
#endif

namespace dwf {

inline long long steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Creates every missing component of `p`. Windows-only; a no-op elsewhere.
inline void mkdirs(const std::string& p) {
#ifdef _WIN32
    std::string cur;
    for (char c : p) {
        cur.push_back(c);
        if (c == '/' || c == '\\') _mkdir(cur.c_str());
    }
    _mkdir(p.c_str());
#else
    (void)p;
#endif
}

// RFC 4648 base64 with padding. websocket.cpp's ws_crypto_selftest() checks this against the
// RFC 6455 Sec-WebSocket-Accept known-answer vectors; that self-test is authoritative.
inline std::string base64(const uint8_t* d, size_t n) {
    static const char kAlphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((n + 2) / 3) * 4);
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = uint32_t(d[i]) << 16;
        if (i + 1 < n) v |= uint32_t(d[i + 1]) << 8;
        if (i + 2 < n) v |= uint32_t(d[i + 2]);
        out.push_back(kAlphabet[(v >> 18) & 63]);
        out.push_back(kAlphabet[(v >> 12) & 63]);
        out.push_back(i + 1 < n ? kAlphabet[(v >> 6) & 63] : '=');
        out.push_back(i + 2 < n ? kAlphabet[v & 63] : '=');
    }
    return out;
}

} // namespace dwf
