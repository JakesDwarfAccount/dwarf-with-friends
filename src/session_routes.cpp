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

#include "session_routes.h"

#include "attribution.h"
#include "auth.h"
#include "client_state.h"
#include "curses_palette.h"
#include "diagnostics.h"
#include "http_server.h"
#include "interaction.h"
#include "json_util.h"
#include "pause_arbiter.h"
#include "request_origin.h"
#include "sdl_capture.h"
#include "web_assets.h"
#include <filesystem>
#include <system_error>
#include "websocket.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace dwf {
namespace {

std::string camera_json(const std::string& player, const Camera& camera) {
    return "{\"player\":" + json_string(player) +
           ",\"x\":" + std::to_string(camera.x) +
           ",\"y\":" + std::to_string(camera.y) +
           ",\"z\":" + std::to_string(camera.z) +
           ",\"zoom\":" + std::to_string(camera.zoom_factor >= 0 ? camera.zoom_factor : 100) +
           ",\"zoomExplicit\":" + (camera.zoom_factor >= 0 ? std::string("true") : std::string("false")) +
           "}\n";
}

// A stable fingerprint of the served index.html's ?v= busters, computed identically by
// dwf-join.js's clientAssetsHash(); a mismatch is the soft "assets updated" warning.
std::string assets_fingerprint() {
    // Keyed on index.html's (mtime, size), not on the process lifetime: a hot web deploy while DF
    // keeps running would otherwise leave every player warned on every refresh, forever.
    static std::string cached;
    static long long cached_mtime = -1;
    static long long cached_size = -1;
    const std::string idx_path = std::string(web_root()) + "/index.html";
    long long mtime = -1, size = -1;
    {
        std::error_code ec;
        auto st = std::filesystem::status(idx_path, ec);
        if (!ec && std::filesystem::is_regular_file(st)) {
            auto t = std::filesystem::last_write_time(idx_path, ec);
            if (!ec) mtime = (long long)t.time_since_epoch().count();
            auto sz = std::filesystem::file_size(idx_path, ec);
            if (!ec) size = (long long)sz;
        }
    }
    if (!cached.empty() && mtime == cached_mtime && size == cached_size)
        return cached;
    cached_mtime = mtime;
    cached_size = size;
    const std::string html = index_html();
    std::vector<std::string> toks;
    for (size_t i = 0; i + 2 < html.size(); ++i) {
        if ((html[i] == '?' || html[i] == '&') && html[i + 1] == 'v' && html[i + 2] == '=') {
            size_t j = i + 3;
            std::string t;
            while (j < html.size()) {
                char c = html[j];
                if (c == '&' || c == '"' || c == '\'' || c == ' ' || c == '\t' ||
                    c == '\r' || c == '\n' || c == '>')
                    break;
                t.push_back(c);
                ++j;
            }
            if (!t.empty()) toks.push_back(t);
            i = j;
        }
    }
    std::sort(toks.begin(), toks.end());
    toks.erase(std::unique(toks.begin(), toks.end()), toks.end());
    std::string joined;
    for (size_t i = 0; i < toks.size(); ++i) { if (i) joined.push_back('|'); joined += toks[i]; }
    // FNV-1a 32-bit (matches the client's fnv1a()).
    uint32_t h = 2166136261u;
    for (char c : joined) { h ^= (unsigned char)c; h *= 16777619u; }
    char hex[16];
    std::snprintf(hex, sizeof(hex), "%08x", (unsigned)h);
    cached = hex;
    return cached;
}

} // namespace

// ---- session HTTP routes ------------------------------------------------------------------------
void register_session_routes(httplib::Server& server) {
    // GET /version -- build stamp plus whether a join password is required. PUBLIC: the join screen
    // fetches it before it has a credential.
    server.Get("/version", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        // DF's live 16-colour curses palette rides the public handshake. Empty when gps is
        // unavailable (headless), and the client then keeps its own default palette.
        std::string extra = ",\"palette\":" + dwf::curses::palette_json();
        // What this build actually implements, so a page newer than the DLL disables the control
        // instead of posting into a 400. Names are additive and never recycled.
        extra += ",\"serverFeatures\":[\"stockpile-link-exchange\",\"hauling-stop-rename\"]";
        res.set_content(auth::version_json(assets_fingerprint(), extra) + "\n",
                        "application/json; charset=utf-8");
    });

        // PUBLIC, and every attempt is accepted while auth is disabled so the no-password default
        // never blocks. httplib folds query and form bodies into req.params, so no JSON parse here.
    auto join_handler = [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        std::string pass = req.has_param("password") ? req.get_param_value("password")
                                                     : std::string();
        bool ok = !auth::enabled() || auth::check(pass);
        res.status = ok ? 200 : 401;
        res.set_content(std::string("{\"ok\":") + (ok ? "true" : "false") +
                            ",\"authRequired\":" + (auth::enabled() ? "true" : "false") + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/join", join_handler);
    server.Post("/join", join_handler);

    server.Get("/", [](const httplib::Request&, httplib::Response& res) {
        res.set_redirect("/view");
    });

    server.Get("/view", [](const httplib::Request&, httplib::Response& res) {
        // Never let the browser cache the page itself: a stale index.html keeps loading old JS.
        // The versioned <script>/<link> URLs are what keep the assets fresh.
        res.set_header("Cache-Control", "no-store, must-revalidate");
        std::string html = index_html();
        const std::string ph = "__DFCAPTURE_BUILD__";
        const std::string stamp = auth::build_stamp();
        for (size_t at = html.find(ph); at != std::string::npos;
             at = html.find(ph, at + stamp.size()))
            html.replace(at, ph.size(), stamp);
        res.set_content(html, "text/html; charset=utf-8");
    });

    server.Get("/health", [](const httplib::Request&, httplib::Response& res) {
        res.set_content("{\"ok\":true,\"service\":\"dwf\"}\n",
                        "application/json; charset=utf-8");
    });

    server.Get("/state", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(diagnostics_json(player, camera, diagnostics_snapshot()),
                        "application/json; charset=utf-8");
    });

    auto reset_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        forget_player_camera(player);
        diagnostics_reset();

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content(camera_json(player, camera), "application/json; charset=utf-8");
    };
    server.Get("/reset", reset_handler);
    server.Post("/reset", reset_handler);

    server.Get("/camera", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"" + err + "\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content(camera_json(player, camera), "application/json; charset=utf-8");
    });

    server.Post("/camera", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }

        bool has_absolute = req.has_param("x") || req.has_param("y") || req.has_param("z");
        if (has_absolute) {
            query_int(req, "x", camera.x);
            query_int(req, "y", camera.y);
            query_int(req, "z", camera.z);
        } else {
            int dx = 0;
            int dy = 0;
            int dz = 0;
            query_int(req, "dx", dx);
            query_int(req, "dy", dy);
            query_int(req, "dz", dz);
            camera.x += dx;
            camera.y += dy;
            camera.z += dz;
        }

        if (camera.z < 0)
            camera.z = 0;
        if (!clamp_camera(camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n",
                            "text/plain; charset=utf-8");
            return;
        }

        // A player-initiated pan BREAKS a follow -- DF's own rule. The follow tick's own recentres
        // pass follow=1 so they do not cancel the lock they are servicing.
        const bool is_follow_recentre = req.has_param("follow") &&
            (req.get_param_value("follow") == "1" || req.get_param_value("follow") == "true");
        if (!is_follow_recentre)
            forget_player_follow(player);

        set_player_camera(player, camera);
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content(camera_json(player, camera), "application/json; charset=utf-8");
    });

    // Declares or releases this player's follow target. Pure plugin state: it never touches DF, so
    // it cannot starve the sim. The recentring itself stays in the client's follow tick.
    auto follow_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string kind = req.has_param("kind") ? req.get_param_value("kind") : std::string();
        int id = -1;
        query_int(req, "id", id);
        if (id < 0 || (kind != "unit" && kind != "item")) {
            forget_player_follow(player);
            kind.clear();
            id = -1;
        } else {
            set_player_follow(player, kind, id);
        }
        FollowTarget target = player_follow(player);
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"kind\":" + json_string(target.kind) +
                        ",\"id\":" + std::to_string(target.id) +
                        ",\"wireBatch\":" + json_string(kWireBatchMarker) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/follow", follow_handler);
    server.Post("/follow", follow_handler);

    auto zoom_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string direction = req.has_param("dir") ? req.get_param_value("dir") : "reset";
        Camera camera;
        std::string err;
        if (!zoom_player_camera(player, direction, camera, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content(camera_json(player, camera), "application/json; charset=utf-8");
    };
    server.Get("/zoom", zoom_handler);
    server.Post("/zoom", zoom_handler);

    // GET /attrib -> the AttributionRegistry. Pure plugin memory, no core access.
    server.Get("/attrib", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        res.set_content(attrib_json(), "application/json; charset=utf-8");
    });

    // Every /action is a pause-family action. Routing through the arbiter is what merges concurrent
    // toggles and attributes each applied transition; the arbiter owns the SetPauseState apply.
    auto action_handler = [](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("action")) {
            res.status = 400;
            res.set_content("missing action\n", "text/plain; charset=utf-8");
            return;
        }

        // The same loopback-peer test the WS uses, on this request's real peer address.
        const bool is_host = request_has_host_authority(req);
        PauseDecision d = pause_request(query_player(req), req.get_param_value("action"), is_host);
        res.set_header("Cache-Control", "no-store");
        if (!d.ok) {
            res.status = 400;
            res.set_content("action failed: " + d.err + "\n", "text/plain; charset=utf-8");
            return;
        }
        std::ostringstream out;
        out << "{\"ok\":true,\"paused\":" << (d.paused_now ? "true" : "false")
            << ",\"merged\":" << (d.merged ? "true" : "false")
            << ",\"by\":" << json_string(d.by) << "}\n";
        res.set_content(out.str(), "application/json; charset=utf-8");
    };
    server.Get("/action", action_handler);
    server.Post("/action", action_handler);

    // POST /save requests a DF quicksave without exiting; there is deliberately no load counterpart.
    // Success means "save requested" -- the saving banner comes from the busy watchdog, not here.
    auto save_handler = [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        std::string err;
        if (!save_world_on_core_thread(&err)) {
            // 409: a valid authenticated request refused by world state.
            res.status = 409;
            res.set_content("{\"ok\":false,\"err\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Post("/save", save_handler);

    // Host-only via the same loopback-peer test, and the value is persisted to auth::kPasswordFile
    // so it survives a restart. Changing a live password makes every existing cookie stale.
    auto join_password_handler = [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        if (!request_has_host_authority(req)) {
            res.status = 403;
            res.set_content("{\"ok\":false,\"err\":\"host only\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        const bool off = req.has_param("off") &&
            (req.get_param_value("off") == "1" || req.get_param_value("off") == "on" ||
             req.get_param_value("off") == "true");
        std::string pass = off ? std::string()
            : (req.has_param("password") ? req.get_param_value("password") : std::string());
        auth::set_password(pass);   // apply now (trims; ""=disabled)
        std::string err;
        if (!auth::persist_password(pass, &err)) {
            // Applied in memory but not persisted; the live authRequired state is still correct.
            res.status = 500;
            res.set_content("{\"ok\":false,\"err\":" + json_string(err) +
                                ",\"authRequired\":" + (auth::enabled() ? "true" : "false") + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content(std::string("{\"ok\":true,\"authRequired\":") +
                            (auth::enabled() ? "true" : "false") + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Post("/join-password", join_password_handler);

    // Sets any provided knob and returns the current config -- how the oracle drives its known-bad
    // runs without a rebuild.
    server.Get("/pause-config", [](const httplib::Request& req, httplib::Response& res) {
        const bool changes_config = req.has_param("window") || req.has_param("grace") ||
            req.has_param("busy") || req.has_param("autopause") || req.has_param("hostunpause");
        if (changes_config && !request_has_host_authority(req)) {
            res.status = 403;
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":false,\"err\":\"host only\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        int v = 0;
        if (query_int(req, "window", v)) pause_set_merge_window_ms(v);
        if (query_int(req, "grace", v)) pause_set_autopause_grace_ms(v);
        if (query_int(req, "busy", v)) pause_set_busy_threshold_ms(v);
        bool host_flag_changed = false;   // only the two DURABLE host flags trigger a persist
        if (req.has_param("autopause")) {
            std::string a = req.get_param_value("autopause");
            pause_set_autopause_enabled(a == "on" || a == "1" || a == "true");
            host_flag_changed = true;
        }
        if (req.has_param("hostunpause")) {   // crash #4 gate; range era wants this ON
            std::string a = req.get_param_value("hostunpause");
            pause_set_host_unpause_only(a == "on" || a == "1" || a == "true");
            host_flag_changed = true;
        }
        // Persist only on an actual host-flag change, so the test-the-test knobs never touch disk.
        if (host_flag_changed) pause_persist_flags();
        res.set_header("Cache-Control", "no-store");
        res.set_content(pause_config_json(), "application/json; charset=utf-8");
    });
}

} // namespace dwf
