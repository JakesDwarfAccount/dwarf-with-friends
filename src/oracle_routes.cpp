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

#include "oracle_routes.h"

#include "client_state.h"
#include "diagnostics.h"
#include "json_util.h"
#include "sdl_capture.h"
#include "tile_dump.h"

#include <cstdint>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <sstream>
#include <string>
#include <vector>

namespace dwf {

namespace {
std::atomic<bool> g_tiledump_active{false};

bool safe_dump_name(const std::string& name) {
    if (name.empty() || name.size() > 64) return false;
    for (unsigned char ch : name)
        if (!(std::isalnum(ch) || ch == '-' || ch == '_')) return false;
    return true;
}

uintmax_t directory_bytes(const std::filesystem::path& root) {
    uintmax_t total = 0;
    std::error_code ec;
    for (std::filesystem::recursive_directory_iterator it(root, ec), end; !ec && it != end;
         it.increment(ec))
        if (it->is_regular_file(ec)) total += it->file_size(ec);
    return ec ? UINTMAX_MAX : total;
}
} // namespace

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_oracle_routes(httplib::Server& server) {
    server.Get("/host-state", [](const httplib::Request&, httplib::Response& res) {
        HostState state;
        std::string err;
        if (!host_state_on_render_thread(state, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + ",\"state\":" +
                                host_state_json(state) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(host_state_json(state), "application/json; charset=utf-8");
    });

    server.Get("/zoom-probe", [](const httplib::Request&, httplib::Response& res) {
        ViewportProbe probe;
        std::string err;
        if (!viewport_probe_on_render_thread(probe, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) +
                                ",\"probe\":" + viewport_probe_json(probe) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(viewport_probe_json(probe), "application/json; charset=utf-8");
    });

    // DELIBERATE RELEASE-BINARY TEST ORACLE -- KEEP (W4). The browser does not consume this JPEG
    // route; tools/harness/gate_parity.py does. It is the only renderer-parity oracle that can
    // run unattended: the window oracle requires a visible native DF window and changes DF's
    // own camera. Removing /frame.jpg or the capture_camera_jpeg*/encode_jpeg path behind it
    // removes automated tile-renderer parity coverage, even though normal browser play still works.
    server.Get("/frame.jpg", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera unavailable: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        std::vector<uint8_t> jpeg;
        uint64_t seq = 0;
        if (!capture_camera_jpeg_cached(player, camera, jpeg, seq, &err)) {
            res.status = 503;
            res.set_content("capture failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        std::ostringstream cam_header;
        cam_header << camera.x << "," << camera.y << "," << camera.z;
        std::string etag = "\"" + std::to_string(seq) + "\"";

        res.set_header("Cache-Control", "no-store");
        res.set_header("ETag", etag);
        res.set_header("X-Dwf-Camera", cam_header.str());
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(reinterpret_cast<const char*>(jpeg.data()), jpeg.size(), "image/jpeg");
    });

    // Render-buffer feasibility probe (§6.6, 2026-07-07): screentexpos dump over HTTP.
    // MUST run on an httplib worker thread (same context as /frame.jpg) -- running the dump
    // from a dfhack-run console command DEADLOCKS DF: console commands hold the core
    // suspension, and the render-thread native map re-render blocks against the suspended
    // main thread (observed hang 2026-07-07 01:23, dwf.log "camera ok; capturing").
    server.Get("/tiledump", [](const httplib::Request& req, httplib::Response& res) {
        TileDumpOptions opt;
        if (req.has_param("x") && req.has_param("y") && req.has_param("z")) {
            opt.have_camera = true;
            opt.x = std::atoi(req.get_param_value("x").c_str());
            opt.y = std::atoi(req.get_param_value("y").c_str());
            opt.z = std::atoi(req.get_param_value("z").c_str());
        }
        // The full atlas is roughly 129k files / 500 MiB and remains a maintainer command, not an
        // HTTP operation. A local browser dump is deliberately one viewport only.
        if (req.get_param_value("atlas") == "1") {
            res.status = 400;
            res.set_content("{\"ok\":false,\"err\":\"atlas export is not available over HTTP\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        opt.with_atlas = false;
        opt.with_ground_truth = req.get_param_value("gt") != "0";
        const std::string name = req.has_param("dir") ? req.get_param_value("dir") : "latest";
        res.set_header("Cache-Control", "no-store");
        if (!safe_dump_name(name)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"err\":\"bad dir\"}\n", "application/json");
            return;
        }
        bool expected = false;
        if (!g_tiledump_active.compare_exchange_strong(expected, true)) {
            res.status = 409;
            res.set_content("{\"ok\":false,\"err\":\"a tiledump is already running\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        struct ActiveGuard { ~ActiveGuard() { g_tiledump_active.store(false); } } active_guard;
        const std::filesystem::path root =
            std::filesystem::path("dfhack-config") / "dwf-diagnostics" / "tiledumps";
        const std::filesystem::path output = root / name;
        std::error_code cleanup_error;
        std::filesystem::remove_all(output, cleanup_error);
        const std::string dir = output.generic_string();
        std::string err;
        const auto started = std::chrono::steady_clock::now();
        bool ok = dump_tile_frame_ex(dir, opt, &err);
        const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - started);
        constexpr uintmax_t kMaxDumpBytes = 64u * 1024u * 1024u;
        if (ok && directory_bytes(output) > kMaxDumpBytes) {
            ok = false;
            err = "dump exceeded 64 MiB output cap";
        }
        if (ok && elapsed > std::chrono::seconds(30)) {
            ok = false;
            err = "dump exceeded 30 second wall-time cap";
        }
        if (!ok) std::filesystem::remove_all(output, cleanup_error);
        std::ostringstream body;
        body << "{\"ok\":" << (ok ? "true" : "false");
        if (!ok) body << ",\"err\":" << json_string(err);
        body << ",\"dir\":" << json_string(dir) << "}\n";
        res.status = ok ? 200 : 503;
        res.set_content(body.str(), "application/json; charset=utf-8");
    });
}

} // namespace dwf
