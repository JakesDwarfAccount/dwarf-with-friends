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

#include "auth.h"

#include <cstdio>
#include <fstream>
#include <mutex>

#include "wire_v1.h"   // kSelftestFixtureCrc (wire identity half of the build stamp)

// Git short hash injected by CMake (target_compile_definitions). Falls back to "dev" for builds
// where git isn't available (e.g. the git-archive deploy mirror). The literal is stringized by
// CMake as e.g. -DDFCAPTURE_GIT_HASH=\"23092973d\".
#ifndef DFCAPTURE_GIT_HASH
#define DFCAPTURE_GIT_HASH "dev"
#endif

namespace dwf {
namespace auth {

namespace {

std::mutex g_mu;
std::string g_password;   // "" => auth disabled

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && (unsigned char)s[b] <= ' ') ++b;
    while (e > b && (unsigned char)s[e - 1] <= ' ') --e;
    return s.substr(b, e - b);
}

// Constant-time equality. Folds the length difference into the accumulator so the only thing a
// timing side channel can observe is "lengths differ" (acceptable for a shared friends-tier
// passphrase); the byte comparison itself never short-circuits on the first mismatch.
bool ct_equal(const std::string& a, const std::string& b) {
    unsigned char diff = (unsigned char)((a.size() ^ b.size()) & 0xff);
    // Also fold higher length bits so a 256-vs-1 length delta can't alias to 0.
    diff |= (unsigned char)(((a.size() ^ b.size()) >> 8) != 0);
    const size_t n = a.size() > b.size() ? a.size() : b.size();
    for (size_t i = 0; i < n; ++i) {
        unsigned char ca = i < a.size() ? (unsigned char)a[i] : 0;
        unsigned char cb = i < b.size() ? (unsigned char)b[i] : 0;
        diff |= (unsigned char)(ca ^ cb);
    }
    return diff == 0;
}

} // namespace

void set_password(const std::string& passphrase) {
    std::string p = trim(passphrase);
    std::lock_guard<std::mutex> lk(g_mu);
    g_password = p;
}

bool enabled() {
    std::lock_guard<std::mutex> lk(g_mu);
    return !g_password.empty();
}

bool check(const std::string& candidate) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_password.empty()) return false;   // disabled: callers gate on enabled() first
    return ct_equal(candidate, g_password);
}

bool persist_password(const std::string& passphrase, std::string* err) {
    std::string p = trim(passphrase);
    std::ofstream f(kPasswordFile, std::ios::trunc);
    if (!f) {
        if (err) *err = std::string("cannot open ") + kPasswordFile + " for writing";
        return false;
    }
    if (!p.empty()) f << p << "\n";   // empty passphrase => empty file => disabled on next load
    f.flush();
    if (!f.good()) {
        if (err) *err = std::string("write failed: ") + kPasswordFile;
        return false;
    }
    return true;
}

std::string git_hash() {
    return std::string(DFCAPTURE_GIT_HASH);
}

std::string build_stamp() {
    char crc[16];
    std::snprintf(crc, sizeof(crc), "0x%08x", (unsigned)wire::kSelftestFixtureCrc);
    return std::string(crc) + "-" + git_hash();
}

std::string version_json(const std::string& assets, const std::string& extra_fields) {
    char crc[16];
    std::snprintf(crc, sizeof(crc), "0x%08x", (unsigned)wire::kSelftestFixtureCrc);
    std::string out = "{\"crc\":\"";
    out += crc;
    out += "\",\"git\":\"";
    out += git_hash();
    out += "\",\"build\":\"";
    out += build_stamp();
    out += "\",\"authRequired\":";
    out += enabled() ? "true" : "false";
    if (!assets.empty()) {
        out += ",\"assets\":\"";
        out += assets;
        out += "\"";
    }
    out += extra_fields;   // e.g. ",\"palette\":[[r,g,b],...]" -- built DF-side by the route
    out += "}";
    return out;
}

} // namespace auth
} // namespace dwf
