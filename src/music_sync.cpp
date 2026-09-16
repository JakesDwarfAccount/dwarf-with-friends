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

#include "music_sync.h"

#include "httplib.h"
#include "sound_route.h"
#include "websocket.h"

#include <chrono>
#include <mutex>

namespace dwf {
namespace music {
namespace {

std::mutex g_mu;
State g_state;
bool g_seeded = false;

} // namespace

int64_t now_ms() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               clock::now().time_since_epoch())
        .count();
}

std::string frame_json(bool siege, int season, int first_year) {
    std::lock_guard<std::mutex> lk(g_mu);
    int64_t t = now_ms();
    std::string auto_track = select_auto_track(siege, season, first_year);
    if (!g_seeded) {
        // start the clock now, or elapsed is a huge bogus value from start_ms == 0
        g_state = set_auto(auto_track, t);
        g_seeded = true;
    } else {
        g_state = advance_auto(g_state, auto_track, t);
    }
    return state_json(g_state, t);
}

bool apply_manual(const std::string& track) {
    if (!is_valid_track(track)) return false;
    std::lock_guard<std::mutex> lk(g_mu);
    g_state = set_manual(track, now_ms());
    g_seeded = true;
    return true;
}

void apply_auto(bool siege, int season, int first_year) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_state = set_auto(select_auto_track(siege, season, first_year), now_ms());
    g_seeded = true;
}

namespace {

bool peer_is_host(const httplib::Request& req) {
    return request_has_host_authority(req);
}

std::string scan_track(const std::string& body) {
    const std::string key = "\"track\"";
    size_t k = body.find(key);
    if (k == std::string::npos) return "";
    size_t i = body.find(':', k + key.size());
    if (i == std::string::npos) return "";
    ++i;
    while (i < body.size() && (body[i] == ' ' || body[i] == '\t')) ++i;
    if (i >= body.size() || body[i] != '"') return "";
    ++i;
    std::string out;
    while (i < body.size() && body[i] != '"') { out.push_back(body[i]); ++i; }
    return out;
}

bool scan_auto_true(const std::string& body) {
    const std::string key = "\"auto\"";
    size_t k = body.find(key);
    if (k == std::string::npos) return false;
    size_t i = body.find(':', k + key.size());
    if (i == std::string::npos) return false;
    ++i;
    while (i < body.size() && (body[i] == ' ' || body[i] == '\t')) ++i;
    return body.compare(i, 4, "true") == 0;
}

} // namespace
} // namespace music

void register_music_route(httplib::Server& server) {
    server.Post("/music", [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        if (!music::peer_is_host(req)) {
            res.status = 403;
            res.set_content("{\"ok\":false,\"error\":\"host only\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        if (music::scan_auto_true(req.body)) {
            // live triggers are unknown on this thread; the next frame_json corrects within a tick
            music::apply_auto(false, 0, -1);
            res.set_content("{\"ok\":true,\"manual\":false}\n",
                            "application/json; charset=utf-8");
            return;
        }
        std::string track = music::scan_track(req.body);
        if (!music::apply_manual(track)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"unknown track\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content(std::string("{\"ok\":true,\"manual\":true,\"track\":\"") + track + "\"}\n",
                        "application/json; charset=utf-8");
    });
}

} // namespace dwf
