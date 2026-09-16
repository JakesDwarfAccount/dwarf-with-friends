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

#include "sound_route.h"

#include "diagnostics.h"
#include "httplib.h"
#include "music_sync.h"
#include "websocket.h"

#include <chrono>
#include <fstream>
#include <mutex>
#include <string>

namespace dwf {
namespace sound {
namespace {

// relative to DF's working directory
constexpr const char* kConfigPath = "dfhack-config/dfcapture.json";

std::mutex g_cfg_mu;
bool g_cfg_audio_remote = true;   // DEFAULT ON until the config says otherwise
std::chrono::steady_clock::time_point g_cfg_stamp{};
bool g_cfg_have = false;

} // namespace

bool audio_remote_enabled() {
    using clock = std::chrono::steady_clock;
    std::lock_guard<std::mutex> lk(g_cfg_mu);
    auto now = clock::now();
    // 3 s TTL: a host toggle takes effect without a plugin reload
    if (g_cfg_have &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - g_cfg_stamp).count() < 3000)
        return g_cfg_audio_remote;
    bool val = true;   // DEFAULT ON: a MISSING file leaves this true
    try {
        std::ifstream in(kConfigPath, std::ios::binary);
        if (in) {
            std::string text((std::istreambuf_iterator<char>(in)),
                             std::istreambuf_iterator<char>());
            val = scan_audio_remote(text);
        }
    } catch (...) {
        val = true;    // unreadable/corrupt file -> default ON, not off
    }
    g_cfg_audio_remote = val;
    g_cfg_stamp = now;
    g_cfg_have = true;
    return val;
}

namespace {

bool read_file_bytes(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) return false;
    std::streamoff len = in.tellg();
    if (len < 0) return false;
    out.resize(static_cast<size_t>(len));
    in.seekg(0, std::ios::beg);
    if (len > 0) in.read(&out[0], len);
    return static_cast<bool>(in) || in.eof();
}

bool peer_is_host_tab(const httplib::Request& req) {
    return request_has_host_authority(req);
}

} // namespace
} // namespace sound

void register_sound_route(httplib::Server& server) {
    server.Get("/sound-info", [](const httplib::Request& req, httplib::Response& res) {
        bool remote_cfg = sound::audio_remote_enabled();
        bool loopback = sound::peer_is_host_tab(req);
        bool allowed = sound::remote_allowed(loopback, remote_cfg);
        res.set_header("Cache-Control", "no-store");
        res.set_content(std::string("{\"audio\":true,\"allowed\":") +
                            (allowed ? "true" : "false") + ",\"remote\":" +
                            (remote_cfg ? "true" : "false") + ",\"loopback\":" +
                            (loopback ? "true" : "false") + "}\n",
                        "application/json; charset=utf-8");
    });

    server.Get(R"(/sound/(.+))", [](const httplib::Request& req, httplib::Response& res) {
        std::string capture = req.matches.size() > 1 ? req.matches[1].str() : std::string();

        sound::PathResolve pr = sound::resolve_sound_path(capture);
        if (!pr.ok) {
            res.status = 404;   // traversal / non-ogg / malformed -- never leak which
            res.set_header("Cache-Control", "no-store");
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }

        if (!sound::remote_allowed(sound::peer_is_host_tab(req),
                                   sound::audio_remote_enabled())) {
            res.status = 403;
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":false,\"error\":\"remote audio disabled by host\"}\n",
                            "application/json; charset=utf-8");
            return;
        }

        std::string body;
        if (!sound::read_file_bytes(std::string(sound::kSoundBaseDir) + pr.rel, body)) {
            res.status = 404;   // valid-shaped path but the file isn't in this install
            res.set_header("Cache-Control", "no-store");
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }

        // install audio never changes within a run
        res.set_header("Cache-Control", "max-age=31536000, immutable");
        // DO NOT set res.status, and never make this a set_mount_point: httplib computes 200 vs
        // 206 from req.ranges after we return, and a forced 200 breaks <audio> seeking.
        res.set_content(std::move(body), "audio/ogg");
    });

    register_music_route(server);
}

} // namespace dwf
