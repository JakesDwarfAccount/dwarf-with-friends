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

#include "http_server.h"
#include "interaction.h"

#include "Core.h"

#include "announcements.h"
#include "art_desc.h"        // B246: /engraving-info -- DF art data for an engraved tile
#include "attribution.h"
#include "auth.h"
#include "building_zone.h"
#include "burrows_panel.h"
#include "chat.h"
#include "client_state.h"
#include "console_routes.h"
#include "diagnostics.h"
#include "write_guards.h"   // W23: GET /write-guards + host-only /console-config
#include "flight_recorder.h" // ground-truth pipeline Pillar 2: /recorder/start|stop|status
#include "fort_admin.h"
#include "hauling.h"
#include "hospital.h"
#include "hud.h"
#include "sdl_capture.h"
#include "sound_route.h"
#include "httplib.h"
#include "image_encoder.h"
#include "info_panel.h"
#include "interaction.h"
#include "json_util.h"
#include "menu_oracle.h"
#include "diplo.h"
#include "native_popup.h"
#include "pause_arbiter.h"
#include "oracle_routes.h"
#include "route_helpers.h"
#include "session_routes.h"
#include "kitchen_panel.h"
#include "labor.h"
#include "lever_link.h"
#include "lua_bridge.h"
#include "notifications.h"
#include "placement.h"
#include "standing_orders.h"
#include "stone_use.h"
#include "trade_depot.h"
#include "unit_sheet.h"
#include "unit_portrait.h"
#include "unit_sprites.h"
#include "vote.h"
#include "sprite_map.h"
#include "squads.h"
#include "status_truth.h"
#include "status_harvest.h"
#include "stockpile_panel.h"
#include "tile_dump.h"
#include "tile_map_dump.h"
#include "web_assets.h"
#include "websocket.h"
#include "work_orders.h"
#include "missions.h"
#include "worldmap_panel.h"
#include "world_stream.h"

#include "DataDefs.h"
#include "TileTypes.h"

#include "modules/Buildings.h"
#include "modules/Items.h"
#include "modules/Maps.h"
#include "modules/Units.h"

#include "df/building.h"
#include "df/building_civzonest.h"
#include "df/building_type.h"
#include "df/global_objects.h"
#include "df/item.h"
#include "df/map_block.h"
#include "df/unit.h"
#include "df/world.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace dwf {
namespace {

std::mutex g_server_mutex;
std::unique_ptr<httplib::Server> g_server;
std::thread g_server_thread;
std::thread g_ws_push_thread;              // WebSocket map-push loop (FIX 2)
std::thread g_ws_cursor_thread;            // WebSocket smooth-cursor broadcast loop
std::atomic<bool> g_running(false);
int g_port = DEFAULT_STREAM_PORT;
std::string g_bind_address = DEFAULT_BIND_ADDRESS;

// --- WT24: crash-evidence counters ---------------------------------------------------
// All relaxed atomics, all incremented on paths that already do far heavier work (a socket
// write, a 33 ms sleep). Nothing here logs; the 60 s heartbeat, the stall watchdog and the
// shutdown mark are the only writers to dwf.log.
std::atomic<long long> g_server_start_ms{0};      // diag_steady_ms() at start_server()
std::atomic<uint64_t> g_push_iters{0};            // ws_push_loop iterations since load
std::atomic<uint64_t> g_cursor_iters{0};          // ws_cursor_loop iterations since load
std::atomic<uint64_t> g_http_requests{0};         // requests that reached the router
std::atomic<bool> g_http_listen_running{false};   // true between listen_after_bind enter/exit
// Native handle of the HTTP listen thread. On Windows a zero-timeout wait on it is the ONLY
// cheap check that distinguishes "parked in accept()" (alive) from "the thread is gone"
// (which a plain bool flag can never see -- a thread that dies abnormally never clears it).
// Valid until stop_server() joins, and the push loop -- the only reader -- is always joined
// BEFORE that join, so it can never observe a stale handle.
std::atomic<void*> g_http_thread_handle{nullptr};

// The heartbeat's DF read: df::global::world->frame_counter and the pause flag. Deliberately
// NOT under CoreSuspender -- suspending DF's sim thread once a minute just to print a
// diagnostic is exactly the trap AGENTS.md warns about. These are plain reads of two
// long-lived DF globals (an int32 and a bool); worst case is a torn/one-frame-stale integer
// in a log line, which cannot corrupt anything and cannot stall the game.
int32_t df_frame_counter_unsafe() {
    auto world = df::global::world;
    return world ? world->frame_counter : -1;
}
bool df_paused_unsafe() {
    return df::global::pause_state && *df::global::pause_state;
}

// A crash tail is only readable if the marks are greppable. Prefixes used in dwf.log:
//   THREAD-ENTER / THREAD-EXIT   one line per plugin thread, at its real entry/exit
//   HEARTBEAT                    one line per 60 s from the push loop, always, even idle
//   STALL / STALL-CLEARED        the cursor loop (which never touches DF) catching a wedged
//                                push loop and naming the stage it is wedged inside
//   SHUTDOWN-CLEAN               dwf stopped on purpose (see dwf.cpp)
constexpr int kHeartbeatSecs = 60;
constexpr int kStallSecs = 15;   // > a slow autosave; a save-stalled tick is reported once,
                                 // then STALL-CLEARED with its duration, so a save reads as a
                                 // save and a death reads as a death.

// WA-5: content-hash ETag (FNV-1a/64 over the body + implicit length via the byte stream),
// quoted per RFC 7232. A different body -> a different ETag with overwhelming probability, so
// a returned 304 always means byte-identical content (correctness over cleverness: a wrong
// 304 is far worse than a missed one, and a content hash can never claim "unchanged" for a
// body that actually changed). Used by the static-asset file hook + /sprites/map.json below.
std::string content_etag(const std::string& body) {
    uint64_t h = 1469598103934665603ull;
    for (unsigned char c : body) { h ^= c; h *= 1099511628211ull; }
    std::ostringstream o;
    o << '"' << std::hex << h << '"';
    return o.str();
}

// ---- SESSION META TABLES (WA-5) ---------------------------------------------------------------
// Build the tiletype_meta.json: {"wire":1,"tiletypes":[[tt,"TTNAME","SHAPE","MAT","SPECIAL"],...]}
// Iterates all df::tiletype enum values, skips those with empty keys, caches the result.
std::string build_tiletype_meta_json() {
    using namespace DFHack;
    try {
        std::ostringstream js;
        js << "{\"wire\":1,\"tiletypes\":[";
        bool first = true;

        // Iterate df::tiletype enum values 0..max. We use a reasonable upper bound since
        // we check for empty keys. DFHack enums are documented to fit within ~500 for tiletype.
        for (int tt_int = 0; tt_int < 1000; ++tt_int) {
            std::string tt_key = ENUM_KEY_STR(tiletype, static_cast<df::tiletype>(tt_int));
            if (tt_key.empty()) continue;  // skip empty keys

            df::tiletype tt_val = static_cast<df::tiletype>(tt_int);
            df::tiletype_shape shp = tileShape(tt_val);
            df::tiletype_material tmat = tileMaterial(tt_val);
            df::tiletype_special spc = tileSpecial(tt_val);

            std::string shp_key = ENUM_KEY_STR(tiletype_shape, shp);
            std::string tmat_key = ENUM_KEY_STR(tiletype_material, tmat);
            std::string spc_key = ENUM_KEY_STR(tiletype_special, spc);

            if (!first) js << ",";
            first = false;
            js << "[" << tt_int << ",\"" << tt_key << "\",\"" << shp_key
               << "\",\"" << tmat_key << "\",\"" << spc_key << "\"]";
        }

        js << "]}";
        return js.str();
    } catch (const std::exception& e) {
        diagnostics_log(std::string("tiletype_meta exception: ") + e.what());
        return "{\"wire\":1,\"tiletypes\":[]}";
    } catch (...) {
        diagnostics_log("tiletype_meta: unknown exception");
        return "{\"wire\":1,\"tiletypes\":[]}";
    }
}

// Build the item_type_meta.json: {"wire":1,"item_types":[[v,"KEY"],...]}
// Iterates all df::item_type enum values, skips those with empty keys.
std::string build_item_type_meta_json() {
    using namespace DFHack;
    try {
        std::ostringstream js;
        js << "{\"wire\":1,\"item_types\":[";
        bool first = true;

        // Iterate df::item_type enum values. DFHack has ~200-300 item types.
        for (int v = 0; v < 1000; ++v) {
            std::string key = ENUM_KEY_STR(item_type, static_cast<df::item_type>(v));
            if (key.empty()) continue;  // skip empty keys

            if (!first) js << ",";
            first = false;
            js << "[" << v << ",\"" << key << "\"]";
        }

        js << "]}";
        return js.str();
    } catch (const std::exception& e) {
        diagnostics_log(std::string("item_type_meta exception: ") + e.what());
        return "{\"wire\":1,\"item_types\":[]}";
    } catch (...) {
        diagnostics_log("item_type_meta: unknown exception");
        return "{\"wire\":1,\"item_types\":[]}";
    }
}

// Input-kick primitives for the /stream push loop: any successful mutating handler bumps
// g_input_generation and wakes every stream loop's wait_for early, so the pushed frame reflects
// the player's action immediately instead of waiting out the pacing interval.
std::mutex g_stream_wake_mutex;
std::condition_variable g_stream_wake_cv;
std::atomic<uint64_t> g_input_generation{0};

// ---- PERF DIAGNOSTICS ---------------------------------------------------------------
// WA-15: the legacy per-player build-cost ring (DiagSample/g_diag/diag_record/diag_forget)
// that fed /diag's "players" array was removed along with the legacy per-player push loop
// that wrote it -- protocol v1's own per-connection diagnostics (scanBlocks/dirtyBlocks/
// encodedBlocks/pendingBlocks/inflightFrames/rttMs/trickle*, plus v1SuspenderMsPerSec) live
// in world_stream.cpp's "v1" object instead (world_stream_diag_json(), WA-9). The /diag
// handler below now reports live connection/keepalive health straight off the registry
// (ws_connected_players/ws_connection_count_for/ws_player_health) rather than a stale
// build-sample cache.

// Multiplayer presence roster (WT-spec WP-A section 1.2): build the players array spliced into
// every AUX frame + /mapdata. ws_roster_players is the authoritative entry set: healthy
// sockets plus a five-second server-side disconnect grace. A reconnect re-adopts the same row;
// a socket silent past the 45-second keepalive deadline is removed after grace even if teardown
// is delayed. Camera/cursor data remains a join against the mutex-guarded client snapshot.
// Reads no DF state and is safe outside CoreSuspender. Entries may lack x/y when the cursor is
// idle; consumers must guard numeric coordinates. /diag remains socket-oriented and uses this
// keepalive cutoff directly rather than the anti-flicker roster.
static const long long kRosterGhostMs = 45000;

std::string presence_json(const std::string& self) {
    static const long long kPresenceStaleMs = 8000;
    std::ostringstream body;
    auto clients = client_camera_snapshot();
    long long now = now_monotonic_ms();
    std::vector<std::string> roster = ws_roster_players();   // liveness + anti-flicker grace
    body << "[";
    bool first = true;
    for (const auto& name : roster) {
        const Camera* cam = nullptr;
        for (const auto& c : clients) if (c.player == name) { cam = &c.camera; break; }
        if (!first) body << ",";
        first = false;
        // R2: byte-clean name emit (chat_escape, not json_string's DF2UTF transcode) so a non-ASCII
        // roster name matches the raw registered identity + the client's adopted hello_ack.player --
        // otherwise "self" detection (p.name === player) and follow targeting break for unicode names.
        body << "{\"name\":\"" << chat_escape(name) << "\""
             << ",\"self\":" << (name == self ? 1 : 0);
        // Cursor block (unchanged rule): only when the cursor is live + fresh.
        bool cursorLive = false;
        if (cam && cam->hover_px >= 0 && cam->hover_py >= 0 &&
            !(cam->last_active_ms > 0 && now - cam->last_active_ms > kPresenceStaleMs)) {
            cursorLive = true;
            body << ",\"x\":" << (cam->x + cam->hover_px)
                 << ",\"y\":" << (cam->y + cam->hover_py)
                 << ",\"z\":" << cam->z;
            if (cam->drag_active && cam->drag_px >= 0 && cam->drag_py >= 0) {
                body << ",\"drag\":1"
                     << ",\"dx\":" << (cam->x + cam->drag_px)
                     << ",\"dy\":" << (cam->y + cam->drag_py);
            }
        }
        // View window, composed EXACTLY like the interest window that drives this player's
        // streamed frame (world_stream.cpp ~:648, §0.8): POSITION from the POST /camera authority
        // (the client_state camera). As of the -wscam1 fix a browser's WS `cam` message can ALSO
        // carry position and write that same authority (the primary transport now; HTTP POST is the
        // socket-down fallback), so the authority is current regardless of channel. The conn
        // snapshot's own xyz is still only a last resort for a pure-WS probe that never set a
        // position. DIMS come from the v1 connection's CAM snapshot (zoom-aware, the real visible span --
        // never hud.viewport, B25). Conn-snapshot xyz is a last resort for a client that never
        // touched /camera (pure WS probes). Elevation consumers read camz.
        int cx, cy, cz, cw, ch;
        bool conn_cam = ws_cam_for_player(name, cx, cy, cz, cw, ch);
        if (cam) {
            body << ",\"camx\":" << cam->x << ",\"camy\":" << cam->y << ",\"camz\":" << cam->z;
            if (conn_cam) body << ",\"camw\":" << cw << ",\"camh\":" << ch;
        } else if (conn_cam) {
            body << ",\"camx\":" << cx << ",\"camy\":" << cy << ",\"camz\":" << cz
                 << ",\"camw\":" << cw << ",\"camh\":" << ch;
        }
        long long rtt = -1, age = -1;
        (void)ws_player_health(name, rtt, age);          // rtt stays -1 when unknown
        body << ",\"rtt\":" << rtt;
        if (!cursorLive) body << ",\"idle\":1";
        body << "}";
    }
    body << "]";
    return body.str();
}

// Smooth-cursor broadcast: build the array of every OTHER player's precise sub-tile cursor
// for the viewer `self`. Emits WORLD coords -- integer tile (x,y,z) + fractional in-tile
// offset (fx,fy) -- so each viewer reconstructs the on-screen pixel in its own window and
// interpolates client-side. Cursors age out on a SHORT window (they stop updating the moment
// the pointer stills), independent of the longer presence heartbeat. Reads only the
// mutex-guarded client snapshot; no DF/core access.
std::string cursors_json(const std::string& self) {
    static const long long kCursorStaleMs = 2000;
    std::ostringstream body;
    body.setf(std::ios::fixed);
    body.precision(3);
    auto clients = client_camera_snapshot();
    long long now = now_monotonic_ms();
    body << "[";
    bool first = true;
    for (const auto& c : clients) {
        const Camera& cam = c.camera;
        if (c.player == self) continue;                                     // others only
        if (cam.cur_active_ms <= 0) continue;                               // no smooth cursor
        if (now - cam.cur_active_ms > kCursorStaleMs) continue;             // stale -> drop
        if (!first) body << ",";
        first = false;
        body << "{\"name\":" << json_string(c.player)
             << ",\"x\":" << cam.cur_x
             << ",\"y\":" << cam.cur_y
             << ",\"z\":" << cam.cur_z
             << ",\"fx\":" << cam.cur_fx
             << ",\"fy\":" << cam.cur_fy;
        if (cam.cur_drag) body << ",\"drag\":1";
        body << "}";
    }
    body << "]";
    return body.str();
}

std::string clients_json() {
    std::ostringstream body;
    auto clients = client_camera_snapshot();
    body << "{\"count\":" << clients.size() << ",\"clients\":[";
    for (size_t i = 0; i < clients.size(); ++i) {
        if (i) body << ",";
        body << "{\"player\":" << json_string(clients[i].player)
             << ",\"camera\":{\"x\":" << clients[i].camera.x
             << ",\"y\":" << clients[i].camera.y
             << ",\"z\":" << clients[i].camera.z
             << ",\"zoom\":" << (clients[i].camera.zoom_factor >= 0 ? clients[i].camera.zoom_factor : 100)
             << ",\"zoomExplicit\":" << (clients[i].camera.zoom_factor >= 0 ? "true" : "false")
             << "}}";
    }
    body << "]}\n";
    return body.str();
}

// ---- JOIN SECURITY: request auth gate (ship-blocker, PROJECT-CLOSEOUT Phase 5) ----------------
// When a join passphrase is configured (auth::enabled()), every request that isn't part of the
// PUBLIC bundle needed to render the join screen must present the shared passphrase. The client
// keeps it in the `dfcap_auth` cookie, which the browser attaches automatically to fetch, <img>,
// <script> and every other same-origin load -- so no per-call-site plumbing and no gap for a
// resource load that can't set a header. The WS wire is gated separately at the hello (websocket
// .cpp) since the /ws upgrade is intercepted below httplib routing.
//
// PUBLIC (never gated): the CORS preflight; the shell HTML; the static client bundle (anything
// with a static-asset extension -- .js/.css/.json/.png/... ); /health; /version; /join. Game
// STATE (/mapdata, /unit, /panel, /hud, /diag, ...) and every MUTATION (/designate, /camera,
// /build-place, ...) have no static extension, so they fall through to "gated". Unit sprite PNGs
// are static-extension (public) -- generated dwarf textures aren't a friends-tier secret; the
// protected surface is live game state + orders.
namespace {

bool join_public_path(const std::string& method, const std::string& path) {
    if (method == "OPTIONS") return true;                       // CORS preflight carries no cookie
    if (path == "/" || path == "/view" || path == "/health" ||
        path == "/version" || path == "/join")
        return true;
    // Static-asset extension => part of the client bundle / non-sensitive static data.
    static const char* kExt[] = {
        ".js", ".css", ".json", ".png", ".html", ".ico", ".svg", ".jpg", ".jpeg",
        ".gif", ".woff", ".woff2", ".map", ".wasm", ".webmanifest", ".txt",
    };
    // Compare against the path only (query already stripped by httplib into req.params).
    for (const char* ext : kExt) {
        const size_t el = std::strlen(ext);
        if (path.size() >= el && path.compare(path.size() - el, el, ext) == 0)
            return true;
    }
    return false;
}

// Percent-decode (the client stores the credential cookie via encodeURIComponent, which %XX-encodes
// punctuation and spaces but never emits '+', so '+' is left literal). Bad/short escapes pass
// through unchanged rather than throwing.
std::string url_decode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            int hi = hex(s[i + 1]), lo = hex(s[i + 2]);
            if (hi >= 0 && lo >= 0) { out.push_back((char)((hi << 4) | lo)); i += 2; continue; }
        }
        out.push_back(s[i]);
    }
    return out;
}

// Extract the dfcap_auth value from a raw Cookie header ("a=1; dfcap_auth=secret; b=2").
std::string cookie_value(const std::string& cookie_header, const std::string& name) {
    const std::string key = name + "=";
    size_t pos = 0;
    while (pos < cookie_header.size()) {
        // Skip leading spaces/semicolons.
        while (pos < cookie_header.size() &&
               (cookie_header[pos] == ' ' || cookie_header[pos] == ';'))
            ++pos;
        size_t end = cookie_header.find(';', pos);
        if (end == std::string::npos) end = cookie_header.size();
        const std::string pair = cookie_header.substr(pos, end - pos);
        if (pair.size() >= key.size() && pair.compare(0, key.size(), key) == 0)
            return pair.substr(key.size());
        pos = end + 1;
    }
    return std::string();
}

} // namespace

void register_routes(httplib::Server& server) {
    server.set_mount_point("/asset", "data/vanilla/vanilla_interface/graphics/images");
    // D1 (native font): DF's UI text is a CP437 bitmap cell atlas -- data/art/curses_640x300.png,
    // 128x192 px = a 16x16 glyph grid = 8x12 px per cell, 1-bit white glyphs on a magenta key
    // (the file named by [FONT:] in data/init/init_default.txt). The /asset mount above cannot
    // reach it. The SHIPPING font does NOT depend on this mount -- tools/ws2/build_df_font.mjs
    // traces the atlas into web/fonts/df-curses.ttf at build time, which the client loads as an
    // ordinary @font-face over the "/" mount. This mount exists so the atlas (and DF's other
    // interface art: scrollbar.png, tabs.png, sort.png, border.png) is reachable from the browser
    // at all -- it is what makes a future runtime-generated face possible without shipping art,
    // and it is useful to DFChrome-style code generally.
    // Traversal-safe by the same mechanism as /asset: handle_file_request rejects any sub-path
    // containing ".." (detail::is_valid_path), so this cannot escape data/art. Read-only: httplib
    // mounts serve GET/HEAD only. Silently no-ops (returns false) if the folder is absent -- e.g.
    // a dev running the plugin outside a real DF install.
    server.set_mount_point("/dfart", "data/art");
    server.set_mount_point("/", web_root());

    // httplib knows no font MIME types, so a .ttf served from the "/" mount would go out with NO
    // Content-Type header at all. Name it explicitly for web/fonts/df-curses.ttf (D1).
    server.set_file_extension_and_mimetype_mapping("ttf", "font/ttf");

    // Install the auth gate BEFORE any route runs (backported set_pre_routing_handler). No-op when
    // no passphrase is set (dev-default open behavior).
    server.set_pre_routing_handler([](const httplib::Request& req, httplib::Response& res) -> bool {
        g_http_requests.fetch_add(1, std::memory_order_relaxed);   // WT24: one relaxed add
        // STALE-TAB GATE (2026-07-17): force the game entry point through /view, which is the ONLY
        // path that substitutes the __DFCAPTURE_BUILD__ stamp. A GET("/") redirect route exists in
        // session_routes.cpp but is DEAD -- the "/" static mount wins cpp-httplib routing precedence
        // (handle_file_request runs before Get handlers), so "/" and "/index.html" were served raw:
        // no stamp -> compareBuild permanently "unknown" -> the stale-tab banner could never fire,
        // AND no Cache-Control -> the browser cached the unstamped page and could boot old JS against
        // a redeployed server (the owner's mystery "refresh fixes it" glitches). Redirect here, in the
        // pre-routing hook, so it runs BEFORE the file mount; no-store so the redirect itself is never
        // cached. Pairs with the client session-pin drift gate (dwf-join.js compareSessionPin).
        if (req.method == "GET" && (req.path == "/" || req.path == "/index.html")) {
            res.set_header("Cache-Control", "no-store");
            res.set_redirect("/view");
            return true;
        }
        if (!auth::enabled()) return false;                     // wide-open dev default
        if (join_public_path(req.method, req.path)) return false;
        std::string cred = url_decode(cookie_value(req.get_header_value("Cookie"), "dfcap_auth"));
        if (!cred.empty() && auth::check(cred)) return false;   // authorized
        res.status = 401;
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":false,\"error\":\"join password required\"}\n",
                        "application/json; charset=utf-8");
        return true;                                            // short-circuit routing
    });

    // WA-5: httplib's built-in static-file mount serves the full body on every request with
    // no conditional-request support at all (no ETag / no If-None-Match / no Last-Modified),
    // so the web client re-downloads every unchanged JS/CSS/PNG/JSON asset in full on each
    // reload. This hook fires for every file served from a mount point AFTER httplib has read
    // the bytes into res.body (see Server::handle_file_request), letting us attach a
    // content-hash ETag and answer a matching If-None-Match with an empty 304. `no-cache`
    // (store-but-always-revalidate) is the conservative correct policy: the browser revalidates
    // on every load and only skips the transfer when the bytes are byte-identical, so there is
    // no staleness risk even for a file like index.html that references versioned sub-assets.
    server.set_file_request_handler([](const httplib::Request& req, httplib::Response& res) {
        if (res.status != 200) return;                 // only decorate a real file hit
        std::string etag = content_etag(res.body);
        res.set_header("Cache-Control", "no-cache");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            res.body.clear();                          // 304 carries no body
        }
    });

    register_work_order_routes(server);
    register_squad_routes(server);
    register_reports_routes(server);
    register_fort_admin_routes(server);
    register_burrows_routes(server);
    register_hauling_routes(server);
    register_kitchen_routes(server);
    register_worldmap_routes(server);
    register_mission_routes(server);   // B228 missions/raids: /missions, /mission-create, /mission-rescue
    register_standing_orders_routes(server);
    register_stone_use_routes(server);
    // LEVER-LINKING task #18 flagged hunk: HTTP-only target picker + link job queue.
    register_lever_link_routes(server);
    register_trade_depot_routes(server);
    register_hospital_routes(server);   // Wave 3.3 hospital/health routes
    register_menu_oracle_routes(server); // B37 crash-safe render-thread native menu snapshot
    register_status_truth_routes(server); // B280 bubble-vs-DF-sheet cross-check oracle: GET /statustruth
    register_status_harvest_routes(server); // NATIVE-STATUS-BUBBLE §3.A screen-array harvest: GET /statusharvest
    register_flight_recorder_routes(server); // ground-truth Pillar 2 corpus capture: /recorder/start|stop|status
    register_sound_route(server);        // P1 audio: GET /sound/(.+) + /sound-info capability probe
    register_chat_routes(server);        // WP-D multiplayer chat: GET /chat scrollback
    register_vote_routes(server);        // WT14 fortress-elevation vote: /vote + start/cast/close
    register_popup_routes(server);       // WT28/B218 native popup mirror: GET /popup + /popup/dismiss
    register_diplo_routes(server);       // B225 petitions/diplomacy detector + meeting mirror:
                                         // GET /diplo + POST /diplo-request-priority
    // WT26 browser DFHack command console: GET /console/commands + POST /console/run. W23: both
    // routes are gated on the dfhack_console host setting, DEFAULT OFF (dfcapture-hostwrites.json;
    // see console_routes.cpp). When ON they serve ANY AUTHED PLAYER -- NOT host-only. Containment
    // is the server-side blocklist in src/console_policy.h, which binds the host exactly as it
    // binds a friend. Neither path has a static extension nor is in join_public_path, so the
    // pre-routing auth gate above already refuses unauthed callers.
    register_console_routes(server);
    // W23 guard surface: GET /write-guards (read-only flag state for guard-aware clients) +
    // GET|POST /console-config (host-tab-only toggle of dfhack_console). Auth-covered like the
    // console routes; must stay above the catch-all.
    guards::register_write_guard_routes(server);
    register_art_desc_routes(server);   // B246 statue/engraving art: GET /engraving-info (read-only)

    // B212 (2026-07-13): the ~150 route registrations that used to live inline below this point
    // (register_routes had grown to 2,749 lines -- the repo's #1 merge-conflict site, in 49 of
    // the last 200 commits) now live with their domain modules, finishing the register_*_routes()
    // split that the 18 calls above started. Handler bodies moved VERBATIM; the registered route
    // surface and every route's behavior are unchanged (verified by a before/after registration
    // inventory diff). NOTE: every register_*_routes call MUST stay above the POST ".*" catch-all
    // at the end of this function -- httplib dispatches in registration order.
    register_session_routes(server);       // /, /view, /version, /join, /camera, /save, ...
    register_oracle_routes(server);        // /frame.jpg, /tiledump, /zoom-probe, /host-state
    register_placement_routes(server);     // /designate, /build-*, /stockpile, /zone, /placement-*
    register_building_zone_routes(server); // /building-*, /workshop-*, /zone-*, /farm-plot*, /zones
    register_stockpile_routes(server);     // /stockpile-*
    register_labor_routes(server);         // /labor, /labor-*
    register_unit_routes(server);          // /unit, /unit-portrait, /unit-sprite*, /unit-nickname,
                                           //   /task-cancel, /livestock-action
    register_info_panel_routes(server);    // /panel
    register_interaction_routes(server);   // /inspect, /hover, /tile-occupants, /stock-item-action
    register_notification_routes(server);  // /notifications, /notification-action

    auto stream_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        auto last_seq = std::make_shared<uint64_t>(0);
        auto last_sent = std::make_shared<std::chrono::steady_clock::time_point>(
            std::chrono::steady_clock::now());
        auto interval = std::chrono::milliseconds(1000 / DEFAULT_STREAM_FPS);

        res.set_header("Cache-Control", "no-store");
        res.set_header("Connection", "close");
        res.set_header("Content-Type", "multipart/x-mixed-replace; boundary=dwf");
        // NOTE: the vendored httplib.h in third_party/cpp-httplib only exposes the single-arg
        // set_chunked_content_provider(provider, resource_releaser = {}) with a void-returning
        // provider (size_t offset, DataSink&) -- there is no (content_type, provider) overload and
        // no bool return. So, same as the pre-existing handler this replaces, loop control is via
        // sink.done() + return (never a boolean), and Content-Type stays on the header set above.
        res.set_chunked_content_provider(
            [player, last_seq, last_sent, interval](size_t, httplib::DataSink& sink) mutable {
                if (!g_running.load() || !sink.is_writable()) {
                    sink.done();
                    return;
                }

                // Pace to the target fps, but wake instantly on any player input.
                uint64_t gen_before = g_input_generation.load();
                {
                    std::unique_lock<std::mutex> lk(g_stream_wake_mutex);
                    g_stream_wake_cv.wait_for(lk, interval, [&] {
                        return g_input_generation.load() != gen_before || !g_running.load();
                    });
                }
                if (!g_running.load()) {
                    sink.done();
                    return;
                }

                Camera camera;
                std::string err;
                if (!camera_for_player(player, camera, &err)) {
                    sink.done();
                    return;
                }

                std::vector<uint8_t> jpeg;
                uint64_t seq = 0;
                if (!capture_camera_jpeg_cached(player, camera, jpeg, seq, &err)) {
                    sink.done();
                    return;
                }

                auto now = std::chrono::steady_clock::now();
                if (seq == *last_seq) {
                    // Nothing changed. Heartbeat only if the tunnel has been silent a while.
                    if (now - *last_sent > std::chrono::seconds(15)) {
                        static const char kHb[] =
                            "--dwf\r\nContent-Type: text/plain\r\n"
                            "X-Dwf-Heartbeat: 1\r\nContent-Length: 2\r\n\r\nok\r\n";
                        sink.write(kHb, sizeof(kHb) - 1);
                        *last_sent = now;
                    }
                    return;
                }

                std::ostringstream header;
                header << "--dwf\r\n"
                       << "Content-Type: image/jpeg\r\n"
                       << "Content-Length: " << jpeg.size() << "\r\n"
                       << "X-Dwf-Camera: " << camera.x << "," << camera.y << "," << camera.z << "\r\n"
                       << "X-Dwf-Seq: " << seq << "\r\n\r\n";
                std::string h = header.str();
                sink.write(h.data(), h.size());
                sink.write(reinterpret_cast<const char*>(jpeg.data()), jpeg.size());
                sink.write("\r\n", 2);
                *last_seq = seq;
                *last_sent = now;
            });
    };

    server.Get("/stream", stream_handler);

    server.Get("/hud", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        HudState hud;
        if (!hud_on_render_thread(camera, hud, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(hud_json(player, hud), "application/json; charset=utf-8");
    });

    // Live per-player map-data (wire:1 tile JSON). Reads only stable sim structures
    // (Maps / MapCache / units / buildings) under CoreSuspender -- the crash-safe
    // reader proven by capture-mapdump -- never the render arrays.
    server.Get("/mapdata", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        // FIX 1 -- window sizing. When the tile client passes &w=&h= (tile counts derived
        // from its canvas so the map's aspect matches the browser and fills it), honor
        // them (clamped). Origin stays at the camera (DF top-left), so the grid<->world
        // contract that /designate, /inspect, /hover, /placement-cursor and the presence
        // splice all rely on (world = camera + grid_index) is preserved. Absent w/h keeps
        // the legacy behavior: size to the REAL DF viewport (zoom-aware, reads
        // gps->main_viewport only -- no core suspend / render thread).
        int view_w = 0;
        int view_h = 0;
        int req_w = 0;
        int req_h = 0;
        bool has_w = query_int(req, "w", req_w);
        bool has_h = query_int(req, "h", req_h);
        if (has_w && has_h && req_w > 0 && req_h > 0) {
            view_w = clamp_window_dim(req_w);
            view_h = clamp_window_dim(req_h);
        } else if (!effective_capture_viewport_dims(camera, view_w, view_h, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        // SAFE CONTEXT: mirror the proven inspect/hover ordering (interaction.cpp
        // run_suspended) -- take the capture-state mutex BEFORE CoreSuspender so the
        // lock order matches the /frame.jpg render path and can never form a cycle.
        // build_map_json_for_camera acquires CoreSuspender internally (reentrant),
        // and touches NO other mutex, so it cannot deadlock with the capture path.
        std::string json;
        {
            std::lock_guard<std::recursive_mutex> lock(capture_state_mutex());
            json = build_map_json_for_camera(camera, view_w, view_h, &err);
        }
        if (json.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        // Splice the multiplayer-presence array in just before the map object's closing
        // brace (build_map_json_* always returns a `...}` object). Cheap string surgery
        // keeps the tile reader (which has no player identity) unchanged.
        if (!json.empty() && json.back() == '}') {
            json.pop_back();
            json += ",\"players\":" + presence_json(player) + "}";
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    // PERF DIAGNOSTICS: curl-able snapshot of connection/keepalive health per connected
    // player + overall, plus the "v1" object (world_stream_diag_json()) which carries the
    // real per-connection transport cost (scanBlocks/dirtyBlocks/encodedBlocks/
    // pendingBlocks/inflightFrames/rttMs/trickle*) and v1SuspenderMsPerSec -- the ONE
    // global CoreSuspender hold that actually costs DF anything now (WA-9). WA-15: this
    // used to also report the legacy per-player build-cost ring (buildMs/pushesPerSec/
    // blocksSkippedPct); that ring's source (the legacy push loop) is gone, so those
    // fields are gone with it -- this reads straight off the live connection registry
    // instead of a stale build-sample cache.

    server.Get("/diag", [](const httplib::Request&, httplib::Response& res) {
        std::ostringstream out;
        out.setf(std::ios::fixed);
        out.precision(2);
        out << "{\"players\":[";
        int ov_conns = 0;
        bool first = true;
        std::vector<std::string> players = ws_connected_players();
        for (const std::string& player : players) {
            // WA-3 keepalive health: RTT from server PING/PONG + inbound-silence age.
            long long rttMs = -1, lastInboundAgeMs = -1;
            bool health = ws_player_health(player, rttMs, lastInboundAgeMs);
            // Same ghost gate as the presence roster: a wedged connection the writer thread never
            // reaped (inbound silent past the 45 s window) is not a live player -- drop it so /diag
            // agrees with the lobby/roster instead of showing phantom uuid entries.
            if (health && lastInboundAgeMs >= 0 && lastInboundAgeMs > kRosterGhostMs) continue;
            int conns = (int)ws_connection_count_for(player);
            ov_conns += conns;
            if (!first) out << ",";
            first = false;
            out << "{\"player\":" << json_string(player)
                << ",\"connections\":" << conns
                << ",\"rttMs\":" << rttMs
                << ",\"lastInboundAgeMs\":" << lastInboundAgeMs << "}";
        }
        out << "],\"overall\":{"
            << "\"connections\":" << ov_conns
            << ",\"players\":" << players.size() << "}"
            // WT28/B218: true while a native modal popup is mirrored -- the reason a web
            // unpause is being refused (the client explains instead of appearing broken).
            << ",\"popupBlocked\":" << (popup_blocked() ? "true" : "false")
            // B225: true while the native diplomacy meeting dialog is open (sim-blocking per
            // DFHack World::ReadPauseState) -- the reason a web unpause is being refused.
            << ",\"diploBlocked\":" << (diplo_meeting_open() ? "true" : "false")
            << ",\"v1\":" << world_stream_diag_json() << "}";
        res.set_header("Cache-Control", "no-store");
        res.set_content(out.str(), "application/json; charset=utf-8");
    });

    // Premium sprite lookup (token -> sheet/col/row), parsed once from DF's own
    // graphics raws. Static per plugin run, so a long browser cache is fine.
    server.Get("/sprites/map.json", [](const httplib::Request& req, httplib::Response& res) {
        // Parsed once from DF's graphics raws (static per plugin run) -- cache the body and its
        // content-hash ETag on first serve (after DF is loaded), then answer If-None-Match with
        // a 304 (WA-5) instead of re-sending the whole map. Same conditional pattern the
        // /tiletype_meta.json / /item_type_meta.json / /frame.jpg routes already use.
        static const std::string body = sprite_map_json();
        static const std::string etag = content_etag(body);
        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(body, "application/json; charset=utf-8");
    });

    // Session meta tables for protocol v1 (WA-5). Enum metadata (tiletype and item_type)
    // for the browser client to resolve binary wire values back to enum strings.
    // Cached static per plugin run; long-lived ETag headers.
    // WA-5 follow-up: these emitted an ETag but ignored If-None-Match, so a repeat GET always
    // re-sent the full (tiny but non-zero) body instead of a 304 -- same conditional-request
    // pattern /frame.jpg already implements above.
    server.Get("/tiletype_meta.json", [](const httplib::Request& req, httplib::Response& res) {
        static const std::string cached = build_tiletype_meta_json();
        static const std::string etag = "\"dwf-tiletype-v1\"";
        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(cached, "application/json; charset=utf-8");
    });

    server.Get("/item_type_meta.json", [](const httplib::Request& req, httplib::Response& res) {
        static const std::string cached = build_item_type_meta_json();
        static const std::string etag = "\"dwf-itemtype-v1\"";
        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(cached, "application/json; charset=utf-8");
    });

    // Serve a DF sprite-sheet PNG by basename, optionally ONE subdirectory level deep (e.g.
    // "ogres/ogres.png" -- DF stores some large-creature sheets as FILE:images/<subdir>/<x>.png).
    // SECURITY: only [A-Za-z0-9_]+(/[A-Za-z0-9_]+)?\.png is accepted -- at most one '/', every path
    // segment non-empty alnum/underscore, so no "." at all (=> no ".."), no absolute path, no
    // nested traversal. Anything else 404s. Searches vanilla graphics dirs first, then the
    // mounted dwf web root for generated atlas sheets.
    server.Get(R"(/sprites/img/(.+))", [](const httplib::Request& req, httplib::Response& res) {
        std::string name = req.matches.size() > 1 ? req.matches[1].str() : std::string();
        bool ok = name.size() > 4 && name.compare(name.size() - 4, 4, ".png") == 0;
        if (ok) {
            size_t stem = name.size() - 4;   // chars before ".png"
            int slashes = 0;
            bool seg_has_char = false;
            for (size_t i = 0; i < stem; ++i) {
                char c = name[i];
                if (c == '/') {
                    if (!seg_has_char || ++slashes > 1) { ok = false; break; }  // empty seg / >1 level
                    seg_has_char = false;
                } else if (std::isalnum((unsigned char)c) || c == '_') {
                    seg_has_char = true;
                } else { ok = false; break; }
            }
            if (ok && !seg_has_char) ok = false;   // trailing '/' => empty basename
        }
        if (!ok) {
            res.status = 404;
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }

        static const char* kImgDirs[] = {
            "data/vanilla/vanilla_environment/graphics/images",
            "data/vanilla/vanilla_plants_graphics/graphics/images",
            "data/vanilla/vanilla_creatures_graphics/graphics/images",
            // corpsefix window #12: prehistoric/extinct creature sheets (cambrian trilobites,
            // cretaceous carnotaurus, etc.) live in their own graphics module -- without this
            // dir the per-species corpse/creature art for extinct species 404'd.
            "data/vanilla/vanilla_creatures_extinct_graphics/graphics/images",
            // corpsefix window #12: gems.png / smallgems.png (the entire cut-gem sprite class)
            // ship in the descriptors graphics module, not vanilla_items -- without this dir every
            // cut gem drew the invisible/missing box.
            "data/vanilla/vanilla_descriptors_graphics/graphics/images",
            "data/vanilla/vanilla_buildings_graphics/graphics/images",
            "data/vanilla/vanilla_items_graphics/graphics/images",
            // Interface sheet dir: the designation-overlay glyphs (designations.png)
            // live here, so the tile client can load them through the same getSheet().
            "data/vanilla/vanilla_interface/graphics/images",
        };
        // Every sheet URL is stable across web deploys. Revalidate by content rather than
        // treating a prior response as fresh for a day: localhost otherwise keeps an obsolete
        // (including blank) vanilla sheet while a tunnel separate origin fetches a new copy.
        auto serve_png = [&req, &res](const std::string& path) -> bool {
            std::ifstream f(path, std::ios::binary);
            if (!f)
                return false;
            std::ostringstream ss;
            ss << f.rdbuf();
            std::string bytes = ss.str();
            std::string etag = content_etag(bytes);
            res.set_header("Cache-Control", "no-cache");
            res.set_header("ETag", etag);
            if (req.get_header_value("If-None-Match") == etag) {
                res.status = 304;
                return true;
            }
            res.set_content(bytes.data(), bytes.size(), "image/png");
            return true;
        };

        for (const char* dir : kImgDirs) {
            if (serve_png(std::string(dir) + "/" + name))
                return;
        }
        if (serve_png(std::string(web_root()) + "/" + name))
            return;
        res.status = 404;
        res.set_content("not found\n", "text/plain; charset=utf-8");
    });

    // Catch-all unmatched POST -> a real, fast 404 JSON response (WD-13's finding: GETs to an
    // unregistered path already 404 cleanly through cpp-httplib's own routing fallback, but an
    // unmatched POST here got no response at all -- the client's postMaybePending() 4s-abort
    // workaround exists specifically because of this). httplib's Server::dispatch_request
    // tries every registered pattern for the method in REGISTRATION order and stops at the
    // first regex_match, so a ".*" pattern is safe to register here as long as it is the LAST
    // POST route added (every specific route above -- including everything registered by the
    // register_*_routes() helpers earlier in this function -- gets first refusal). This turns
    // every POST that isn't one of ours into a guaranteed, quick, well-formed error instead of
    // whatever hung/dropped the connection before.
    server.Post(".*", [](const httplib::Request&, httplib::Response& res) {
        res.status = 404;
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":false,\"error\":\"not found\"}\n",
                        "application/json; charset=utf-8");
    });
}

// --- FIX 2: WebSocket map-push loop -------------------------------------------------
// Replaces the ~2/sec GET /mapdata poll with an instant server->client push. Reuses the
// SAME per-player change signal as the /stream handler (the input-kick CV
// g_stream_wake_cv + g_input_generation): a push fires the instant the player acts,
// otherwise it paces at the stream fps, and only sends when the map actually changed
// (detected by hashing the produced JSON per player). The pushed payload is byte-for-
// byte what GET /mapdata returns -- same window sizing (per-player w/h), same presence
// splice, same lock order (capture_state_mutex -> CoreSuspender) -- so WS frames and
// polled frames are identical and the client feeds both into one draw path.
// WA-15: the legacy per-player DELTA state (PlayerDeltaState: block-signature cache,
// last-built window, payload hash) is gone -- protocol v1's world_stream owns ALL
// per-connection push state now (world_stream.cpp's per-connection stream state).
// WT24: is the HTTP listen thread still there? Cheap and non-blocking. On Windows a
// zero-timeout wait on the thread handle returns WAIT_TIMEOUT while the thread runs (parked
// in accept()) and WAIT_OBJECT_0 once it has terminated -- including a death we never asked
// for. Elsewhere we can only report the flag the thread sets itself.
const char* http_thread_liveness() {
#ifdef _WIN32
    void* h = g_http_thread_handle.load(std::memory_order_relaxed);
    if (!h) return "none";
    DWORD w = ::WaitForSingleObject(reinterpret_cast<HANDLE>(h), 0);
    if (w == WAIT_TIMEOUT) return "alive";
    if (w == WAIT_OBJECT_0)
        return g_http_listen_running.load(std::memory_order_relaxed) ? "DEAD(unexpected)" : "exited";
    return "unknown";
#else
    return g_http_listen_running.load(std::memory_order_relaxed) ? "alive" : "exited";
#endif
}

// WT24: the once-a-minute proof of life. ONE file open/write/close per 60 s -- the whole
// point of the design is that everything it prints was already sitting in an atomic, so an
// idle, paused fort pays nothing between beats and the beat itself never touches DF's lock.
// Returns the line it wrote (for the shutdown mark to reuse the same shape).
std::string heartbeat_line(size_t players, uint64_t push_delta, uint64_t cursor_delta,
                           uint64_t frame_delta, uint64_t req_delta) {
    long long start = g_server_start_ms.load(std::memory_order_relaxed);
    long long up_s = start ? (diag_steady_ms() - start) / 1000 : 0;
    PhaseSnapshot ph = diag_phase_snapshot();
    long long in_ms = ph.inside ? (diag_steady_ms() - ph.entered_ms) : 0;

    std::ostringstream o;
    o << "up=" << up_s << "s"
      << " tick=" << df_frame_counter_unsafe()
      << " paused=" << (df_paused_unsafe() ? 1 : 0)
      << " players=" << players
      << " wsFrames=+" << frame_delta << "/" << ws_frames_sent_total()
      << " pushIters=+" << push_delta
      << " cursorIters=+" << cursor_delta
      << " httpReqs=+" << req_delta
      << " push=" << (push_delta > 0 ? "alive" : "STALLED")
      << " cursor=" << (cursor_delta > 0 ? "alive" : "STALLED")
      << " http=" << http_thread_liveness()
      << " phase=" << ph.name << "/" << ph.seq
      << (ph.inside ? "/INSIDE" : "/done");
    if (ph.inside && in_ms > 1000) o << "/" << (in_ms / 1000) << "s";
    return o.str();
}

void ws_push_loop() {
    // WT24: thread ENTER/EXIT marks. A crash tail that shows ENTER with no EXIT and no
    // SHUTDOWN-CLEAN means this thread was still up when the process died.
    diagnostics_log("THREAD-ENTER push-loop");
    // FRAME-RATE FIX (pre-v1 history, still the shape of this loop): free-run at ~30Hz and
    // wake early on player input so an action's next frame isn't stuck behind the interval.
    auto interval = std::chrono::milliseconds(33);       // ~30Hz sampling of the live sim
    // DEADLINE-BASED scheduling for CONSTANT 30fps: wait until (deadline += interval), not a
    // fresh `interval` each loop, so the true period stays ~33ms even once a tick's build time
    // is added in. If we ever fall behind (build > interval), snap the deadline forward so we
    // don't spin trying to catch up.
    auto next_deadline = std::chrono::steady_clock::now();
    // Free-run diagnostics: prove the loop actually ticks ~30x/s independent of client input.
    int dbg_iters = 0, dbg_players = 0;
    auto dbg_last = std::chrono::steady_clock::now();
    // WT24: 60 s crash-evidence heartbeat. Baselines for the per-beat deltas.
    auto hb_last = std::chrono::steady_clock::now();
    uint64_t hb_push0 = g_push_iters.load(), hb_cursor0 = g_cursor_iters.load();
    uint64_t hb_frames0 = ws_frames_sent_total(), hb_reqs0 = g_http_requests.load();
    while (g_running.load()) {
        uint64_t gen_before = g_input_generation.load();
        next_deadline += interval;
        auto now0 = std::chrono::steady_clock::now();
        if (next_deadline < now0) next_deadline = now0;   // fell behind: don't accumulate debt
        {
            std::unique_lock<std::mutex> lk(g_stream_wake_mutex);
            g_stream_wake_cv.wait_until(lk, next_deadline, [&] {
                return g_input_generation.load() != gen_before || !g_running.load();
            });
        }
        if (!g_running.load()) break;

        auto connected = ws_connected_players();
        ++dbg_iters; dbg_players += (int)connected.size();
        g_push_iters.fetch_add(1, std::memory_order_relaxed);   // WT24 liveness counter
        {
            auto nowd = std::chrono::steady_clock::now();
            if (nowd - dbg_last >= std::chrono::seconds(1)) {
                diagnostics_log_v("push-loop: " + std::to_string(dbg_iters) + " iters/s, avgPlayers=" +
                    std::to_string(connected.empty() ? 0 : dbg_players / std::max(1, dbg_iters)) +
                    ", connectedNow=" + std::to_string(connected.size()));
                dbg_iters = 0; dbg_players = 0; dbg_last = nowd;
            }
            // WT24: the heartbeat. Unconditional (an idle, paused fort still beats -- silence
            // is what we are trying to make meaningful), but only once per kHeartbeatSecs, so
            // it can never spam a paused game the way a per-frame trace would.
            if (nowd - hb_last >= std::chrono::seconds(kHeartbeatSecs)) {
                uint64_t p = g_push_iters.load(), c = g_cursor_iters.load();
                uint64_t f = ws_frames_sent_total(), r = g_http_requests.load();
                diagnostics_log("HEARTBEAT " + heartbeat_line(connected.size(), p - hb_push0,
                                                              c - hb_cursor0, f - hb_frames0,
                                                              r - hb_reqs0));
                hb_push0 = p; hb_cursor0 = c; hb_frames0 = f; hb_reqs0 = r; hb_last = nowd;
            }
        }

        // WA-9/WA-15: protocol-v1 GLOBAL read pass -- ONE sig scan + ONE encode + N cheap
        // distributions for every v1 connection this tick (no-op with zero v1 clients). This
        // is now the ONLY map-push path (the legacy per-player build+send loop that used to
        // run here was removed). Same lock order as /mapdata (capture mutex -> CoreSuspender).
        //
        // WT24: every stage below is wrapped in a DiagPhase breadcrumb (atomics only, no I/O).
        // If DF dies or wedges inside one of them, the heartbeat / stall line names the stage,
        // and the WER dump's stack says where inside it. This is the "where" half of the
        // evidence -- B234 was exactly this shape (a tick walking a live native modal).
        { DiagPhase _p("world_stream_tick");
          world_stream_tick(capture_state_mutex(),
                            [](const std::string& p) { return presence_json(p); }); }

        // WP-B: heartbeat stamp + pause reconcile + autosave sample + deferred leave-pause apply.
        // Placed AFTER world_stream_tick so a save-stalled tick (which blocks inside
        // world_stream_tick on CoreSuspender) does NOT advance the heartbeat -- that stall is what
        // the saving-indicator watchdog on ws_cursor_loop detects.
        { DiagPhase _p("pause_push_tick"); pause_push_tick(); }

        // WT14: fortress-elevation vote -- <=1 Hz native-offer detection sample (bounded
        // ConditionalCoreSuspender, same posture as pause_push_tick's autosave sample),
        // auto open/close edges, state broadcasts, and late-join sync.
        { DiagPhase _p("vote_push_tick"); vote_push_tick(); }

        // WT28/B218: native popup mirror -- <=1 Hz sample of world.status.popups (mega/BOX only;
        // announcement_alert is local host UI and is deliberately NOT mirrored -- see native_popup.h),
        // change broadcasts {"type":"popup",...}, and sticky late-join sync.
        { DiagPhase _p("popup_push_tick"); popup_push_tick(); }

        // B238: burrow change push -- a <=1 Hz, DF-free (no suspender) compare of the burrow
        // revision that every /burrow-* write route bumps. Broadcasts {"type":"burrows","seq":N}
        // on change + sticky late-join sync, so another player's burrow paint appears on your map
        // without you reopening the panel. Burrows had NO push before this.
        { DiagPhase _p("burrow_push_tick"); burrow_push_tick(); }

        // B225: petitions/diplomacy detector + meeting mirror -- <=1 Hz sample of
        // plotinfo.petitions / plotinfo.dipscript_popups / main_interface.diplomacy,
        // change-only broadcasts {"type":"diplo",...}, and sticky late-join sync.
        //
        // ★ DISABLED 2026-07-14 (B234): DF died with HEAP CORRUPTION (0xc0000374 in ntdll,
        //   09:59:51 local) ~55 min after win39, while the owner was sitting in the native
        //   "Make requests for next year's caravan" screen -- i.e. exactly the
        //   main_interface.diplomacy / dipscript / markup_text structures this tick walks.
        //   A tick that reads a LIVE native modal's word vectors is the prime suspect, and
        //   heap corruption is the one class that can also poison a save. The detector is
        //   off until B234 root-causes it; /diplo (request-driven) still answers, so nothing
        //   else regresses -- only the auto-detect plaques go dark.
        // Each DiagPhase guard clears `inside` when its stage returns, so between ticks we are
        // inside nothing: a "phase .../INSIDE" in a heartbeat or a STALL line therefore always
        // means genuinely wedged in that stage, never "idling between stages".
        if (kDiploTickEnabled) { DiagPhase _p("diplo_push_tick"); diplo_push_tick(); }
    }
    diagnostics_log("THREAD-EXIT push-loop iters=" + std::to_string(g_push_iters.load()) +
                    " (g_running=false: normal stop)");
}

// Smooth-cursor broadcast loop. Runs at a fixed ~25/s (independent of the map-push loop,
// which only fires on map changes): cursors move constantly while the map is static, so
// they need their own steady tick. Each pass pushes every player with a live socket a tiny
// {"type":"cursors","players":[...]} of the OTHER players' precise cursors. Empty ticks are
// skipped -- the client ages out a cursor it stops hearing about, so nobody's cursor lingers.
// WT24: push-loop stall watchdog. Lives on the cursor loop for the same reason the saving
// indicator does -- this loop NEVER takes CoreSuspender, so it keeps running (and keeps being
// able to WRITE A LOG LINE) exactly when the push loop is wedged inside DF. That makes it the
// only thread that can name the stage a hang died in. State is function-local statics: only
// this thread touches them.
void push_stall_watchdog_tick() {
    static bool reported = false;          // one line per stall episode, never a spam loop
    static uint64_t last_seq = 0;
    static uint64_t last_iters = 0;
    static long long last_move_ms = 0;

    long long now = diag_steady_ms();
    PhaseSnapshot ph = diag_phase_snapshot();
    uint64_t iters = g_push_iters.load(std::memory_order_relaxed);

    if (ph.seq != last_seq || iters != last_iters) {   // the push loop moved
        if (reported) {
            diagnostics_log("STALL-CLEARED push-loop moved again after " +
                            std::to_string((now - last_move_ms) / 1000) + "s (phase=" + ph.name +
                            ") -- a long autosave looks exactly like this; a crash does not clear.");
            reported = false;
        }
        last_seq = ph.seq; last_iters = iters; last_move_ms = now;
        return;
    }
    if (last_move_ms == 0) { last_move_ms = now; return; }   // first pass: arm the clock
    if (reported) return;
    if (now - last_move_ms < kStallSecs * 1000LL) return;

    reported = true;
    diagnostics_log("STALL push-loop has not advanced for " +
                    std::to_string((now - last_move_ms) / 1000) + "s -- " +
                    (ph.inside ? std::string("WEDGED INSIDE phase=") + ph.name
                               : std::string("parked between ticks after phase=") + ph.name) +
                    " seq=" + std::to_string(ph.seq) +
                    " iters=" + std::to_string(iters) +
                    " players=" + std::to_string(ws_connection_count()));
}

void ws_cursor_loop() {
    diagnostics_log("THREAD-ENTER cursor-loop");
    auto interval = std::chrono::milliseconds(40);   // ~25 Hz
    while (g_running.load()) {
        std::this_thread::sleep_for(interval);
        if (!g_running.load()) break;
        g_cursor_iters.fetch_add(1, std::memory_order_relaxed);   // WT24 liveness counter

        for (const auto& snap : client_camera_snapshot()) {
            const std::string& player = snap.player;
            if (ws_connection_count_for(player) == 0) continue;   // only players with a socket
            std::string arr = cursors_json(player);
            if (arr.size() <= 2) continue;                        // "[]" -> nothing to send
            broadcast_to_player(player, "{\"type\":\"cursors\",\"players\":" + arr + "}");
        }

        // WP-B: the saving-indicator + leave-grace watchdogs live HERE precisely because this loop
        // NEVER takes CoreSuspender (spec §0/§4.4) -- so it keeps flowing (and can keep detecting +
        // broadcasting) even while the core is blocked writing an autosave. Both are core-free:
        // the busy watchdog only reads an atomic heartbeat + broadcasts; the leave watchdog only
        // reads the socket roster + records intent (the actual SetPauseState is deferred to the
        // push loop's pause_push_tick).
        pause_busy_watchdog_tick();
        pause_leave_watchdog_tick();

        // WT24: same posture, same reason -- catch a push loop wedged inside DF and name the
        // stage in the log. Core-free: reads two atomics and (only on an edge) writes one line.
        push_stall_watchdog_tick();

        // WP-D: join/leave chat lines. Core-free (reads the socket roster, broadcasts text). Runs
        // at ~1 Hz (every 25th 40ms pass) -- the leave grace is seconds, so sub-second cadence adds
        // nothing but registry-lock churn.
        static int chat_presence_div = 0;
        if (++chat_presence_div >= 25) { chat_presence_div = 0; chat_presence_tick(); }
    }
    diagnostics_log("THREAD-EXIT cursor-loop iters=" + std::to_string(g_cursor_iters.load()) +
                    " (g_running=false: normal stop)");
}

} // namespace

void notify_player_input() {
    g_input_generation.fetch_add(1);
    g_stream_wake_cv.notify_all();
}

std::string server_url(const std::string& bind_address, int port) {
    std::string host = bind_address == "0.0.0.0" ? "127.0.0.1" : bind_address;
    return "http://" + host + ":" + std::to_string(port) + "/view";
}

std::string server_url() {
    std::lock_guard<std::mutex> lock(g_server_mutex);
    return server_url(g_bind_address, g_port);
}

bool server_running() {
    return g_running.load();
}

bool start_server(int port, const std::string& bind_address, std::string* err) {
    std::lock_guard<std::mutex> lock(g_server_mutex);
    if (g_server) {
        if (err) *err = "server is already running";
        return false;
    }

    // FIX 2: WsHttpServer overrides process_and_close_socket to intercept `Upgrade:
    // websocket` on the SAME listen socket; every non-WS request is delegated to base
    // HTTP handling. It IS a httplib::Server, so register_routes / bind / listen are
    // unchanged. The "/ws" push route is installed by make_ws_server().
    auto server = make_ws_server();
    register_routes(*server);

    // WA-8/9: provide hello_ack map dims + world_seq to the transport (DF read under the
    // capture lock, off the sim thread).
    set_v1_map_info([] { return world_stream_map_info(capture_state_mutex()); });

    if (!server->bind_to_port(bind_address.c_str(), port)) {
        if (err) *err = "failed to bind " + bind_address + ":" + std::to_string(port);
        return false;
    }

    g_port = port;
    g_bind_address = bind_address;
    g_running = true;
    g_server = std::move(server);
    // WT24: reset the crash-evidence clocks/counters for this server run.
    g_server_start_ms.store(diag_steady_ms(), std::memory_order_relaxed);
    g_push_iters.store(0); g_cursor_iters.store(0); g_http_requests.store(0);
    diagnostics_log("SERVER-START bind=" + bind_address + ":" + std::to_string(port));
    g_server_thread = std::thread([] {
        diagnostics_log("THREAD-ENTER http-listen");
        g_http_listen_running.store(true, std::memory_order_relaxed);
        g_server->listen_after_bind();
        g_http_listen_running.store(false, std::memory_order_relaxed);
        diagnostics_log("THREAD-EXIT http-listen (listen_after_bind returned)");
        g_running = false;
    });
    // Captured while the thread is alive and never joined until after the push loop (its only
    // reader) has been joined, so the heartbeat's liveness probe can never see a stale handle.
    g_http_thread_handle.store(reinterpret_cast<void*>(g_server_thread.native_handle()),
                               std::memory_order_relaxed);
    g_ws_push_thread = std::thread(ws_push_loop);
    g_ws_cursor_thread = std::thread(ws_cursor_loop);
    return true;
}

void stop_server() {
    std::unique_ptr<httplib::Server> server;
    std::thread thread;
    {
        std::lock_guard<std::mutex> lock(g_server_mutex);
        if (!g_server)
            return;
        g_server->stop();
        server = std::move(g_server);
        thread = std::move(g_server_thread);
    }

    // FIX 2: unblock the push loop (its wait_for) and every WS worker parked in recv(),
    // then join the push thread before returning.
    g_running = false;
    { std::lock_guard<std::mutex> lk(g_stream_wake_mutex); }
    g_stream_wake_cv.notify_all();
    ws_close_all();
    if (g_ws_push_thread.joinable())
        g_ws_push_thread.join();
    if (g_ws_cursor_thread.joinable())   // steady 25Hz loop; exits within one interval
        g_ws_cursor_thread.join();

    if (thread.joinable())
        thread.join();
    stop_flight_recorder();   // joins the capture thread; no-op when no recording session ran
    g_http_thread_handle.store(nullptr, std::memory_order_relaxed);   // WT24: handle is dead now
    g_running = false;

    // WT24: the server's own orderly-stop mark, with the run's totals. plugin_shutdown writes
    // the final SHUTDOWN-CLEAN line after this (see dwf.cpp) -- that last line is what a
    // crash tail is read against.
    long long start = g_server_start_ms.load(std::memory_order_relaxed);
    diagnostics_log("SERVER-STOP all threads joined: up=" +
                    std::to_string(start ? (diag_steady_ms() - start) / 1000 : 0) + "s pushIters=" +
                    std::to_string(g_push_iters.load()) + " cursorIters=" +
                    std::to_string(g_cursor_iters.load()) + " wsFrames=" +
                    std::to_string(ws_frames_sent_total()) + " httpReqs=" +
                    std::to_string(g_http_requests.load()));
}

} // namespace dwf
