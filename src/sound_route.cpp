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
#include "music_sync.h"  // register_music_route() -- POST /music host control, wired here so
                         // http_server.cpp (entangled with in-flight agents) needs no edit
#include "websocket.h"   // peer_ip_is_loopback()

#include <chrono>
#include <fstream>
#include <mutex>
#include <string>

namespace dwf {
namespace sound {
namespace {

// dfhack-config/dfcapture.json is relative to the DF working directory -- the SAME convention
// web_assets.cpp uses for the web root and http_server.cpp uses for the /asset mount. The WS4
// plan (2026-07-04-ws4-hosting.md, Task 1) owns this file; until host_config.cpp lands, this is
// a self-contained flat scanner (C++ is the only writer, so a full JSON parser is overkill).
constexpr const char* kConfigPath = "dfhack-config/dfcapture.json";

std::mutex g_cfg_mu;
bool g_cfg_audio_remote = true;   // DEFAULT ON (2026-07-09) until the config says otherwise
std::chrono::steady_clock::time_point g_cfg_stamp{};   // default-constructed == "never read"
bool g_cfg_have = false;

// scan_audio_remote now lives in sound_route.h as an inline pure function (fixture-tested):
// DEFAULT ON, only an explicit `"audio_remote": false` disables.

} // namespace

bool audio_remote_enabled() {
    using clock = std::chrono::steady_clock;
    std::lock_guard<std::mutex> lk(g_cfg_mu);
    auto now = clock::now();
    // 3 s TTL: a host toggle takes effect within 3 s without a plugin reload, and a burst of
    // /sound GETs re-reads the tiny config at most once every 3 s.
    if (g_cfg_have &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - g_cfg_stamp).count() < 3000)
        return g_cfg_audio_remote;
    bool val = true;   // DEFAULT ON: a MISSING file leaves this true (fresh installs stream audio)
    try {
        std::ifstream in(kConfigPath, std::ios::binary);
        if (in) {
            std::string text((std::istreambuf_iterator<char>(in)),
                             std::istreambuf_iterator<char>());
            val = scan_audio_remote(text);   // header inline: default ON, explicit false disables
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

// Read a whole install file into memory. Largest single serving file ~= 20 MB (ambiance songs);
// typical track 4-8 MB, transient -- the same whole-file-into-RAM model httplib's own mount uses
// (detail::read_file). Returns false (leaving `out` untouched) when the file is missing.
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

// Tunnel-aware host detection for the licensing gate (see request_is_local_host's banner in the
// header): loopback peer + no proxy forwarding header + a loopback-ish Host header. cloudflared
// terminates on the host and dials 127.0.0.1, so a bare loopback-peer test would wave every
// TUNNELED remote friend through as "the host" (adversarial-review finding #1).
bool peer_is_host_tab(const httplib::Request& req) {
    return request_has_host_authority(req);
}

} // namespace
} // namespace sound

void register_sound_route(httplib::Server& server) {
    // GET /sound-info -- capability probe. 200 on this DLL; an OLD DLL has no such route and
    // 404s, which is exactly how the client detects "host needs a plugin update" and shows the
    // dormant note instead of erroring. `allowed` = would THIS peer be served audio right now.
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

    // GET /sound/(.+) -- serve one install .ogg. Leaves res.status UNSET on success so httplib
    // emits 200 (full) or 206 (ranged seek) itself and slices the body for the requested range
    // (httplib.h:3698). Setting res.status here would force 200 and break <audio> seeking -- the
    // whole reason this is a route, not a set_mount_point("/sound", "data/sound").
    server.Get(R"(/sound/(.+))", [](const httplib::Request& req, httplib::Response& res) {
        std::string capture = req.matches.size() > 1 ? req.matches[1].str() : std::string();

        sound::PathResolve pr = sound::resolve_sound_path(capture);
        if (!pr.ok) {
            res.status = 404;   // traversal / non-ogg / malformed -- never leak which
            res.set_header("Cache-Control", "no-store");
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }

        // Licensing gate: a remote peer (incl. a TUNNELED one arriving over loopback -- see
        // peer_is_host_tab) is served only when the host opted in (audio_remote).
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

        // Immutable: install audio never changes within a run, so let the browser keep it for a
        // year and never re-fetch (350 MB of re-transfers over a tunnel is the cost to avoid).
        res.set_header("Cache-Control", "max-age=31536000, immutable");
        // DO NOT set res.status -- httplib computes 200/206 from req.ranges after we return.
        res.set_content(std::move(body), "audio/ogg");
    });

    // PARITY V2 correction #1: synced, server-authoritative music. POST /music (host-only) lets
    // the host drive the ONE canonical track for everyone; the state rides env.music in the aux
    // stream. Registered here (not http_server.cpp) so the entangled file needs no edit.
    register_music_route(server);
}

} // namespace dwf
