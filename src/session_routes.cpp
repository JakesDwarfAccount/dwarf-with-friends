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

// VERSION-MISMATCH GATE (soft tier): a stable fingerprint of the served index.html's asset busters
// (the ?v= tokens on its <script>/<link> tags). Sorted + unique + FNV-1a, computed identically on
// the client (dwf-join.js clientAssetsHash). When the build stamp matches but this differs,
// the client shows a soft "assets updated" warning instead of the hard stale-tab banner. Computed
// once (index.html is fixed per server run) and cached.
std::string assets_fingerprint() {
    // ★ B239 (2026-07-14): the cache MUST invalidate when index.html changes on disk.
    //   It used to be `static bool done` -- computed once per server run, cached forever. A HOT WEB
    //   DEPLOY (copying web/ to <DF>/hack/dfcapture-web while DF keeps running -- which is the normal
    //   way we ship client-only fixes) then left the server quoting a fingerprint from startup while
    //   a freshly-loaded page correctly computed the NEW one. They could never agree, so every player
    //   got "Some assets were updated - a refresh is recommended" on EVERY refresh, forever, and no
    //   amount of refreshing could clear it (07-14).
    //   Worse than noise: this gate is what legitimately warns about a genuinely stale tab (B210).
    //   A gate that cries wolf is a gate nobody reads. Key the cache on (mtime, size) of the file.
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
    // Collect ?v= / &v= token values.
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

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_session_routes(httplib::Server& server) {
    // GET /version -- build/version stamp + whether a join password is required. PUBLIC (the join
    // screen fetches it before it has a credential). Also the client's stale-tab probe.
    server.Get("/version", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        // Text-color spec §3.2: ship DF's live 16-color curses palette (gps->uccolor) on the
        // public handshake the client already fetches once at load, so every native color index
        // the client renders resolves to the exact RGB DF paints. Empty ("[]") when gps is
        // unavailable (headless) -> the client keeps its default palette. Same bytes /burrows ships.
        std::string extra = ",\"palette\":" + dwf::curses::palette_json();
        res.set_content(auth::version_json(assets_fingerprint(), extra) + "\n",
                        "application/json; charset=utf-8");
    });

    // POST/GET /join -- validate a candidate passphrase so the join screen can give immediate
    // right/wrong feedback before the client sets its cookie + connects. PUBLIC. Constant-time
    // compare in auth::check(). When auth is disabled every attempt is accepted (ok:true) so the
    // dev-default flow (no password) never blocks. The password arrives as a `password=` field --
    // either a query param or an application/x-www-form-urlencoded POST body (httplib folds both
    // into req.params), so it never has to be JSON-parsed here.
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
        // Never let the browser cache the page itself. Otherwise a stale index.html keeps
        // loading old (cached) JS even after an update -- which is how an already-removed
        // feature can appear to "persist" across reloads and even across browsers. The
        // versioned <script>/<link> URLs in index.html handle freshness of the assets.
        res.set_header("Cache-Control", "no-store, must-revalidate");
        // VERSION-MISMATCH GATE: stamp this build's id into the page so a freshly loaded tab always
        // agrees with /version + hello_ack, while a stale tab keeps its old stamp (-> refresh banner
        // once the server is redeployed). EVERY occurrence, not just the first (B210: since win31,
        // index.html's explanatory comment spelled the placeholder token out literally, so the old
        // first-occurrence replace stamped the COMMENT and left the real script-tag assignment as
        // the raw placeholder -> the client's compareBuild() saw "unknown" and the stale-tab banner
        // silently died). A no-op if the placeholder is absent.
        // tools/harness/view_stamp_test.mjs guards this loop AND the real web/index.html shape.
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

        // W2: a player-initiated pan BREAKS a follow -- DF's own rule. The follow tick's own
        // recentres pass `follow=1` so they do not cancel the lock they are servicing. Older
        // clients never send it, so their behaviour is unchanged (they hold no follow target).
        const bool is_follow_recentre = req.has_param("follow") &&
            (req.get_param_value("follow") == "1" || req.get_param_value("follow") == "true");
        if (!is_follow_recentre)
            forget_player_follow(player);

        set_player_camera(player, camera);
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content(camera_json(player, camera), "application/json; charset=utf-8");
    });

    // W2: declare / release this player's camera-follow target. `kind=unit|item` + `id=N` sets it;
    // `id=-1` (or any other kind) clears it. Pure state -- it never touches DF, so it costs nothing
    // and cannot starve the simulation (AGENTS.md hard rule 5). The recentring itself stays in the
    // client's existing follow tick; this route is only what makes the state VISIBLE on the wire, so
    // /unit and /stock-item-action can honestly answer "are you following this?"
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

    // WP-C (§1.3): GET /attrib -> the AttributionRegistry as {world, buildings, orders,
    // stockpiles, zones}. Pure plugin memory, no core access; the client merges these by id into
    // inspect panels + the work-orders list. Additive JSON only -- zero binary-wire surface.
    server.Get("/attrib", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        res.set_content(attrib_json(), "application/json; charset=utf-8");
    });

    // WP-B: every server-side /action is a pause-family action (pause/play/resume/unpause/
    // toggle-pause). Route through the pause arbiter so concurrent toggles debounce/merge (WT01)
    // and each applied transition is attributed + broadcast to all players. The arbiter owns the
    // SetPauseState apply (via the same action_on_core_thread path). Response gains additive
    // "paused"/"merged"/"by" fields; old clients ignore them and still see {"ok":true}.
    auto action_handler = [](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("action")) {
            res.status = 400;
            res.set_content("missing action\n", "text/plain; charset=utf-8");
            return;
        }

        // isHostClient() signal for the host-only-unpause gate: the SAME loopback-peer test the
        // WS uses, applied to this HTTP request's real peer address (nothing the client can spoof).
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

    // FRIEND-GROUP SAVE (SAVE-ONLY). POST /save triggers a DF quicksave WITHOUT
    // exiting (interaction.cpp's save_world_on_core_thread, the quicksave.lua autosave-request
    // pathway). Any authenticated player may request it. Auth is already enforced upstream by the
    // pre-routing gate, so an unauthenticated request never reaches here. There is deliberately NO
    // load counterpart. The saving banner is driven entirely
    // by the WP-B busy watchdog broadcast once DF's world write stalls the push loop -- not by this
    // route -- so success here only means "save requested", not "save finished".
    auto save_handler = [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        std::string err;
        if (!save_world_on_core_thread(&err)) {
            // 409 Conflict: a valid authenticated request refused by world state (no world /
            // wrong mode / save already running).
            res.status = 409;
            res.set_content("{\"ok\":false,\"err\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Post("/save", save_handler);

    // HOST JOIN-PASSWORD (host-only; staged, window #12). POST /join-password sets / changes /
    // clears the shared join passphrase from the host UI -- the point-and-click twin of the
    // `capture-join-password` console command. HOST-ONLY via the SAME loopback-peer test the
    // pause host-unpause gate uses (peer_ip_is_loopback on the request's real TCP peer --
    // nothing a client can spoof); the pre-routing auth gate already rejected any unauthenticated
    // request upstream. The new value is applied immediately (auth::set_password) AND persisted to
    // auth::kPasswordFile (auth::persist_password) so it survives a DF restart, matching the file
    // the console command's `reload` reads. Params: `password=<p>` sets it; `off=1` (or an omitted/
    // empty password) clears it. Response {"ok":true,"authRequired":bool}. A non-loopback peer gets
    // 403 -> the web client falls back to showing the console-command instructions inline. NOTE:
    // when a password is CHANGED while auth was already on, the host's own cookie becomes stale on
    // the next request (same as the console `capture-join-password newpass` path) -> the join
    // screen re-prompts for the new passphrase; expected, not a bug.
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
            // Applied in memory but NOT persisted (disk/permission issue). Report it so the UI can
            // warn, but the live authRequired state is still correct for this session.
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

    // WP-B tunables / test-the-test surface. GET /pause-config[?window=&grace=&busy=&autopause=on|off]
    // sets any provided knob and returns the current config. Drives the oracle's known-bad runs
    // (merge-window=0, grace=0, busy-threshold perturbed) without a rebuild.
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
        // Persist hostUnpauseOnly/autopause so a host's choice survives a DF restart (item 5).
        // Guarded on an actual host-flag change so the oracle's window/grace/busy test-the-test
        // knobs never touch disk.
        if (host_flag_changed) pause_persist_flags();
        res.set_header("Cache-Control", "no-store");
        res.set_content(pause_config_json(), "application/json; charset=utf-8");
    });
}

} // namespace dwf
