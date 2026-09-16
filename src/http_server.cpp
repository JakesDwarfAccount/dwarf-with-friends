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
#include "api_response.h"
#include "art_desc.h"        // /engraving-info -- DF art data for an engraved tile
#include "attribution.h"
#include "auth.h"
#include "building_zone.h"
#include "burrows_panel.h"
#include "chat.h"
#include "client_state.h"
#include "console_routes.h"
#include "diagnostics.h"
#include "write_guards.h"   // GET /write-guards + host-only /console-config
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
#include "texpos_conformance.h"
#include "route_helpers.h"
#include "request_origin.h"
#include "save_barrier.h"
#include "session_routes.h"
#include "kitchen_panel.h"
#include "labor.h"
#include "lever_link.h"
#include "machines.h"
#include "siege_engines.h"
#include "lua_bridge.h"
#include "notifications.h"
#include "placement.h"
#include "standing_orders.h"
#include "stone_use.h"
#include "trade_depot.h"
#include "unit_sheet.h"
#include "unit_portrait.h"
#include "unit_sprites.h"
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
#include <map>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
// Safe here: httplib.h above has already pulled in <winsock2.h>, so windows.h cannot drag in the
// conflicting legacy <winsock.h>.
#include <windows.h>
#endif

namespace dwf {
namespace {

std::mutex g_server_mutex;
std::unique_ptr<httplib::Server> g_server;
std::thread g_server_thread;
std::thread g_ws_push_thread;              // WebSocket map-push loop
std::thread g_ws_cursor_thread;            // WebSocket smooth-cursor broadcast loop
std::atomic<bool> g_running(false);
int g_port = DEFAULT_STREAM_PORT;
std::string g_bind_address = DEFAULT_BIND_ADDRESS;

// --- crash-evidence counters ---------------------------------------------------
// All relaxed atomics, on paths that already do far heavier work. Nothing here writes to dwf.log.
std::atomic<long long> g_server_start_ms{0};      // diag_steady_ms() at start_server()
std::atomic<uint64_t> g_push_iters{0};            // ws_push_loop iterations since load
std::atomic<uint64_t> g_cursor_iters{0};          // ws_cursor_loop iterations since load
std::atomic<uint64_t> g_http_requests{0};         // requests that reached the router
std::atomic<bool> g_http_listen_running{false};   // true between listen_after_bind enter/exit
// Valid until stop_server() joins it, and the push loop -- the only reader -- is always joined
// BEFORE that, so it can never observe a stale handle.
std::atomic<void*> g_http_thread_handle{nullptr};

// Deliberately NOT under CoreSuspender: suspending DF's sim thread once a minute just to print a
// diagnostic is the starvation trap. A torn integer in a log line corrupts and stalls nothing.
int32_t df_frame_counter_unsafe() {
    auto world = df::global::world;
    return world ? world->frame_counter : -1;
}
bool df_paused_unsafe() {
    return df::global::pause_state && *df::global::pause_state;
}

// Greppable crash-tail marks in dwf.log: THREAD-ENTER / THREAD-EXIT, HEARTBEAT,
// STALL / STALL-CLEARED, SHUTDOWN-CLEAN.
constexpr int kHeartbeatSecs = 60;
constexpr int kStallSecs = 15;   // longer than a slow autosave, so a save reads as a save and a
                                 // death reads as a death

// ---- SPRITE SHEET INDEX + ETAG CACHE (cold-load) ----------------------------------------------
// Neither cache may change WHICH file wins, and a 304 still only ever means byte-identical content.

const char* const kSpriteImgDirs[] = {
    "data/vanilla/vanilla_environment/graphics/images",
    "data/vanilla/vanilla_plants_graphics/graphics/images",
    "data/vanilla/vanilla_creatures_graphics/graphics/images",
    // extinct-creature sheets: the only home of per-species corpse art for extinct species
    "data/vanilla/vanilla_creatures_extinct_graphics/graphics/images",
    // gems.png / smallgems.png ship in the descriptors module, not vanilla_items
    "data/vanilla/vanilla_descriptors_graphics/graphics/images",
    "data/vanilla/vanilla_buildings_graphics/graphics/images",
    "data/vanilla/vanilla_items_graphics/graphics/images",
    // the designation-overlay glyphs (designations.png) live here
    "data/vanilla/vanilla_interface/graphics/images",
};

std::string ascii_lower(std::string s) {
    for (char& c : s) c = (char)std::tolower((unsigned char)c);
    return s;
}

struct FileStamp {
    uint64_t mtime = 0;
    uint64_t size = 0;
    bool operator==(const FileStamp& o) const { return mtime == o.mtime && size == o.size; }
};

// Existence + (mtime, size) without opening the file. False = not a readable regular file.
bool stat_file(const std::string& path, FileStamp& out) {
#ifdef _WIN32
    WIN32_FILE_ATTRIBUTE_DATA a;
    if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &a))
        return false;
    if (a.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        return false;
    out.mtime = ((uint64_t)a.ftLastWriteTime.dwHighDateTime << 32) | a.ftLastWriteTime.dwLowDateTime;
    out.size = ((uint64_t)a.nFileSizeHigh << 32) | a.nFileSizeLow;
    return true;
#else
    (void)path; (void)out;
    return false;
#endif
}

// Indexes every "*.png" in `dir`, plus one level of subdirectories at the top level, matching what
// the route's validator allows. emplace() never overwrites, so the first dir to supply a name keeps it.
void index_png_dir(const std::string& dir, const std::string& prefix, bool recurse,
                   std::map<std::string, std::string>& out) {
#ifdef _WIN32
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((dir + "/*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE)
        return;
    do {
        std::string entry = fd.cFileName;
        if (entry == "." || entry == "..")
            continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (recurse)
                index_png_dir(dir + "/" + entry, prefix + ascii_lower(entry) + "/", false, out);
            continue;
        }
        std::string lower = ascii_lower(entry);
        if (lower.size() > 4 && lower.compare(lower.size() - 4, 4, ".png") == 0)
            out.emplace(prefix + lower, dir + "/" + entry);
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    (void)dir; (void)prefix; (void)recurse; (void)out;
#endif
}

const std::map<std::string, std::string>& sprite_png_index() {
    // Magic static, built once on the first sheet request: DF's own install does not change while
    // the plugin is loaded.
    static const std::map<std::string, std::string> index = [] {
        std::map<std::string, std::string> m;
        for (const char* dir : kSpriteImgDirs)
            index_png_dir(dir, std::string(), true, m);
        std::ostringstream note;
        note << "sprite-img index: " << m.size() << " sheets across "
             << (sizeof(kSpriteImgDirs) / sizeof(kSpriteImgDirs[0])) << " vanilla graphics dirs";
        diagnostics_log(note.str());
        return m;
    }();
    return index;
}

// Resolve a validated request name to a file path, preserving the old probe's precedence
// exactly. Empty string = nothing to serve (the caller 404s).
std::string resolve_sprite_png(const std::string& name) {
    const auto& index = sprite_png_index();
    auto it = index.find(ascii_lower(name));
    if (it != index.end())
        return it->second;

    FileStamp st;
    // An empty index means the walk found nothing. Never let that 404 a file the old linear probe
    // would have opened: fall back to that probe, in its original order.
    if (index.empty()) {
        for (const char* dir : kSpriteImgDirs) {
            std::string path = std::string(dir) + "/" + name;
            if (stat_file(path, st))
                return path;
        }
    }
    // The mounted web root is last and stays a LIVE probe: generated atlas sheets are written
    // there at runtime.
    std::string web = std::string(web_root()) + "/" + name;
    if (stat_file(web, st))
        return web;
    return std::string();
}

std::mutex g_sprite_etag_mutex;
std::unordered_map<std::string, std::pair<FileStamp, std::string>> g_sprite_etag;

// The remembered ETag for `path`, but only while the file's (mtime, size) is exactly what it was
// when we hashed it. No I/O. False = we must read and hash the file.
bool sprite_cached_etag(const std::string& path, const FileStamp& stamp, std::string& etag) {
    std::lock_guard<std::mutex> lock(g_sprite_etag_mutex);
    auto it = g_sprite_etag.find(path);
    if (it == g_sprite_etag.end() || !(it->second.first == stamp))
        return false;
    etag = it->second.second;
    return true;
}

void sprite_remember_etag(const std::string& path, const FileStamp& stamp,
                          const std::string& etag) {
    std::lock_guard<std::mutex> lock(g_sprite_etag_mutex);
    g_sprite_etag[path] = std::make_pair(stamp, etag);
}

bool read_whole_file(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f)
        return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

// ---- SESSION META TABLES ----------------------------------------------------------------------
// A failure returns the error shape, never a valid-but-empty table: empty and broken look the same.
ApiResult<std::string> build_tiletype_meta_json() {
    using namespace DFHack;
    try {
        std::ostringstream js;
        js << "{\"wire\":1,\"tiletypes\":[";
        bool first = true;

        // 1000 is a safe upper bound over the enum; empty keys are skipped.
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
        return ApiResult<std::string>::success(js.str());
    } catch (const std::exception& e) {
        diagnostics_log(std::string("tiletype_meta exception: ") + e.what());
        return ApiResult<std::string>::failure(500, "tiletype_meta_unavailable", e.what());
    } catch (...) {
        diagnostics_log("tiletype_meta: unknown exception");
        return ApiResult<std::string>::failure(500, "tiletype_meta_unavailable",
                                               "unknown exception building tiletype metadata");
    }
}

// A failure returns the ApiResult error shape for the same reason build_tiletype_meta_json does.
ApiResult<std::string> build_item_type_meta_json() {
    using namespace DFHack;
    try {
        std::ostringstream js;
        js << "{\"wire\":1,\"item_types\":[";
        bool first = true;

        for (int v = 0; v < 1000; ++v) {
            std::string key = ENUM_KEY_STR(item_type, static_cast<df::item_type>(v));
            if (key.empty()) continue;  // skip empty keys

            if (!first) js << ",";
            first = false;
            js << "[" << v << ",\"" << key << "\"]";
        }

        js << "]}";
        return ApiResult<std::string>::success(js.str());
    } catch (const std::exception& e) {
        diagnostics_log(std::string("item_type_meta exception: ") + e.what());
        return ApiResult<std::string>::failure(500, "item_type_meta_unavailable", e.what());
    } catch (...) {
        diagnostics_log("item_type_meta: unknown exception");
        return ApiResult<std::string>::failure(500, "item_type_meta_unavailable",
                                               "unknown exception building item type metadata");
    }
}

// Input-kick primitives for the /stream push loop: any successful mutating handler bumps
// g_input_generation and wakes every stream loop's wait_for early, so the pushed frame reflects
// the player's action immediately instead of waiting out the pacing interval.
std::mutex g_stream_wake_mutex;
std::condition_variable g_stream_wake_cv;
std::atomic<uint64_t> g_input_generation{0};

// The presence array spliced into every AUX frame and /mapdata. ws_roster_players is the
// authoritative entry set; an entry may lack x/y when the cursor is idle, so consumers must guard.
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
        // chat_escape, not json_string's DF2UTF transcode: a non-ASCII roster name has to match the
        // raw registered identity, or self-detection and follow targeting break for unicode names.
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
        // POSITION comes from the camera authority (POST /camera, or a WS `cam` message writing the
        // same authority); DIMS come from the v1 CAM snapshot -- zoom-aware, never hud.viewport.
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

// Emits WORLD coords -- integer tile plus fractional in-tile offset -- so each viewer rebuilds the
// pixel in its own window. Cursors age out on a SHORT window, independent of the presence heartbeat.
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

[[maybe_unused]] std::string clients_json() {
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

// Authorization is NEVER inferred from a filename extension: a new .json or .jpg route stays gated
// until it is deliberately added to the PUBLIC list. The WS wire is gated separately, at the hello.
namespace {

bool join_public_path(const std::string& method, const std::string& path) {
    if (method == "OPTIONS") return true;                       // CORS preflight carries no cookie
    if (path == "/" || path == "/view" || path == "/health" ||
        path == "/version" || path == "/join")
        return true;
    static const char* kPublicPrefixes[] = { "/js/", "/css/", "/fonts/" };
    for (const char* prefix : kPublicPrefixes)
        if (path.rfind(prefix, 0) == 0) return true;
    static const char* kPublicFiles[] = {
        "/index.html", "/building_map.json", "/creatures_map.json", "/flow_map.json",
        "/grass_colors.json", "/interface_map.json", "/item_map.json",
        "/material_map.json", "/overlay_map.json", "/plant_map.json",
        "/portraits_map.json", "/shadow_cell_map.json", "/spatter_map.json",
        "/tiletype_token_map.json", "/tree_map.json",
    };
    for (const char* file : kPublicFiles) if (path == file) return true;
    return false;
}

bool local_diagnostic_path(const std::string& path) {
    static const char* kExact[] = {
        "/diag", "/host-state", "/zoom-probe", "/frame.jpg", "/tiledump",
        "/menu-oracle", "/statustruth", "/statusharvest",
        "/recorder/start", "/recorder/stop", "/recorder/status",
        "/texpos-conformance",
    };
    for (const char* candidate : kExact) if (path == candidate) return true;
    return false;
}

// An existence check against the three mounted roots, not an extension allowlist: a dynamic route
// does not become save-safe because its name ends in ".json". Auth still runs after this.
bool save_barrier_disk_read(const std::string& method, const std::string& path) {
    if (method != "GET" && method != "HEAD") return false;

    // /view reads the mounted index and substitutes the build stamp; / and /index.html redirect
    // there in the pre-routing hook. None reads DF state.
    if (path == "/" || path == "/index.html" || path == "/view") return true;

    static const char* kSaveSafeCatalogs[] = {
        "/sprites/map.json",
        "/tiletype_meta.json",
        "/item_type_meta.json",
    };
    for (const char* catalog : kSaveSafeCatalogs)
        if (path == catalog) return true;

    // Routed, read-only asset handlers whose bodies come from files on disk.
    if (path.rfind("/sprites/img/", 0) == 0 || path.rfind("/sound/", 0) == 0)
        return true;

    struct Mount { const char* prefix; const char* root; };
    const Mount mounts[] = {
        {"/asset", "data/vanilla/vanilla_interface/graphics/images"},
        {"/dfart", "data/art"},
        {"/", web_root()},
    };
    for (const Mount& mount : mounts) {
        if (path.rfind(mount.prefix, 0) != 0) continue;
        std::string sub_path = "/" + path.substr(std::strlen(mount.prefix));
        if (!httplib::detail::is_valid_path(sub_path)) continue;
        std::string disk_path = std::string(mount.root) + sub_path;
        if (!disk_path.empty() && disk_path.back() == '/') disk_path += "index.html";
        if (httplib::detail::is_file(disk_path)) return true;
    }
    return false;
}

// Percent-decode. The client stores the cookie with encodeURIComponent, which never emits '+', so
// '+' is left literal; a bad or short escape passes through unchanged rather than throwing.
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
    // DF's CP437 bitmap atlas and its other interface art. The SHIPPING font does NOT depend on
    // this mount. Traversal-safe by handle_file_request's ".." rejection; no-ops if data/art is absent.
    server.set_mount_point("/dfart", "data/art");
    server.set_mount_point("/", web_root());

    // httplib knows no font MIME types, so a .ttf served from the "/" mount would go out with NO
    // Content-Type header at all. Name it explicitly for web/fonts/df-curses.ttf.
    server.set_file_extension_and_mimetype_mapping("ttf", "font/ttf");

    // Install the auth gate BEFORE any route runs. No-op when no passphrase is set.
    server.set_pre_routing_handler([](const httplib::Request& req, httplib::Response& res) -> bool {
        g_http_requests.fetch_add(1, std::memory_order_relaxed);   // one relaxed add
        // Reject DF-backed reads and every mutation while DF serializes a save. Disk-only GET/HEAD
        // stays available: a 503 for a script a cold browser is loading leaves a half-booted page.
        if (save_barrier_active() && !save_barrier_disk_read(req.method, req.path)) {
            res.status = 503;
            res.set_header("Cache-Control", "no-store");
            res.set_header("Retry-After", "2");
            res.set_content("{\"ok\":false,\"busy\":true,\"reason\":\"save-barrier\",\"error\":\"Dwarf Fortress is saving; try again when saving finishes\"}\n",
                            "application/json; charset=utf-8");
            return true;
        }
        // Force the entry point through /view, the ONLY path that substitutes the build stamp. The
        // "/" static mount beats a Get handler in httplib, so this has to happen pre-routing.
        if (req.method == "GET" && (req.path == "/" || req.path == "/index.html")) {
            res.set_header("Cache-Control", "no-store");
            res.set_redirect("/view");
            return true;
        }
        // Development oracles and crash diagnostics are useful on the host, but are not product
        // APIs. Hide them from LAN/tunnel players even when those players know the join password.
        if (local_diagnostic_path(req.path) && !request_has_host_authority(req)) {
            res.status = 404;
            res.set_header("Cache-Control", "no-store");
            res.set_content("not found\n", "text/plain; charset=utf-8");
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

    // httplib's static mount has no conditional-request support at all, so this hook attaches a
    // content-hash ETag and answers If-None-Match with a 304. no-cache: revalidate, transfer on change.
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
    register_mission_routes(server);   // Missions/raids: /missions, /mission-create, /mission-rescue
    register_standing_orders_routes(server);
    register_stone_use_routes(server);
    // HTTP-only target picker + link job queue.
    register_lever_link_routes(server);
    register_machine_routes(server);   // read-only machine/power networks
    register_siege_engine_routes(server); // W3b siege engines: /siege-engine + action/resting-facing
    register_trade_depot_routes(server);
    register_hospital_routes(server);   // Wave 3.3 hospital/health routes
    register_menu_oracle_routes(server); // crash-safe render-thread native menu snapshot
    register_status_truth_routes(server); // bubble-vs-DF-sheet cross-check oracle: GET /statustruth
    register_status_harvest_routes(server); // GET /statusharvest
    register_flight_recorder_routes(server); // ground-truth Pillar 2 corpus capture: /recorder/start|stop|status
    register_sound_route(server);        // GET /sound/(.+) + /sound-info capability probe
    register_chat_routes(server);        // multiplayer chat: GET /chat scrollback
    register_popup_routes(server);       // Native popup mirror: GET /popup + /popup/dismiss
    register_diplo_routes(server);       // Petitions/diplomacy detector + meeting mirror:
    // The console routes are gated on the dfhack_console host setting, DEFAULT OFF, and when ON
    // they serve ANY authed player. Containment is the server-side blocklist in console_policy.h.
    register_console_routes(server);
    // GET /write-guards + GET|POST /console-config, auth-covered like the console routes and, like
    // them, must stay above the catch-all.
    guards::register_write_guard_routes(server);
    register_art_desc_routes(server);   // Statue/engraving art: GET /engraving-info (read-only)

    // Every register_*_routes call MUST stay above the POST ".*" catch-all at the end of this
    // function: httplib dispatches in registration order.
    register_session_routes(server);       // /, /view, /version, /join, /camera, /save, ...
    register_oracle_routes(server);        // /frame.jpg, /tiledump, /zoom-probe, /host-state
    register_texpos_conformance_routes(server); // /texpos-conformance
    register_placement_routes(server);     // /designate, /build-*, /stockpile, /zone, /placement-*
    register_building_zone_routes(server); // /building-*, /workshop-*, /zone-*, /farm-plot*, /zones
    register_stockpile_routes(server);     // /stockpile-*
    register_labor_routes(server);         // /labor, /labor-*
    register_unit_routes(server);          // /unit, /unit-portrait, /unit-sprite*, /unit-nickname,
                                           //   /task-cancel, /task-action, /livestock-action
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
        // The vendored httplib exposes only the single-arg set_chunked_content_provider with a
        // void-returning provider, so loop control is sink.done() + return, never a boolean.
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

    // Live per-player map-data JSON. Reads only stable sim structures under CoreSuspender, never
    // the render arrays.
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

        // &w=&h= sizes the window in tiles (clamped); the origin stays at the camera, preserving the
        // world = camera + grid_index contract. Absent w/h sizes to the real DF viewport.
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

        // Take the capture-state mutex BEFORE CoreSuspender so the lock order matches the
        // /frame.jpg render path and can never form a cycle. The builder suspends internally.
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

        // Splice the presence array in just before the map object's closing brace, so the tile
        // reader -- which has no player identity -- stays unchanged.
        if (!json.empty() && json.back() == '}') {
            json.pop_back();
            json += ",\"players\":" + presence_json(player) + "}";
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    // Connection and keepalive health per player, plus the "v1" object carrying per-connection
    // transport cost and v1SuspenderMsPerSec -- the one global CoreSuspender hold that costs DF.

    server.Get("/diag", [](const httplib::Request&, httplib::Response& res) {
        std::ostringstream out;
        LuaBridgeHealth lua_health = lua_bridge_health_snapshot();
        out.setf(std::ios::fixed);
        out.precision(2);
        out << "{\"players\":[";
        int ov_conns = 0;
        bool first = true;
        std::vector<std::string> players = ws_connected_players();
        for (const std::string& player : players) {
            // Keepalive health: RTT from server PING/PONG + inbound-silence age.
            long long rttMs = -1, lastInboundAgeMs = -1;
            bool health = ws_player_health(player, rttMs, lastInboundAgeMs);
            // Same ghost gate as the presence roster: a wedged connection the writer never reaped
            // is not a live player, so /diag agrees with the lobby instead of showing phantoms.
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
            // True while a native modal popup is mirrored -- the reason a web unpause is refused.
            << ",\"popupBlocked\":" << (popup_blocked() ? "true" : "false")
            // True while the native diplomacy dialog is open -- the other reason a web unpause is
            // refused.
            << ",\"diploBlocked\":" << (diplo_meeting_open() ? "true" : "false")
            << ",\"luaBridge\":{\"calls\":" << lua_health.calls
            << ",\"successes\":" << lua_health.successes
            << ",\"callFailures\":" << lua_health.call_failures
            << ",\"signatureFailures\":" << lua_health.signature_failures << "}"
            << ",\"wsDrops\":" << ws_drop_counters_json()
            << ",\"v1\":" << world_stream_diag_json() << "}";
        res.set_header("Cache-Control", "no-store");
        res.set_content(out.str(), "application/json; charset=utf-8");
    });

    // Token -> sheet/col/row, parsed once from DF's own graphics raws and static per plugin run.
    server.Get("/sprites/map.json", [](const httplib::Request& req, httplib::Response& res) {
        // Cache the body and its content-hash ETag on first serve, then answer If-None-Match with
        // a 304. A failed parse is never cached as a browsable body.
        const ApiResult<std::string>& result = sprite_map_json();
        if (!result.ok) {
            send_api_error(result, res);
            return;
        }
        static const std::string etag = content_etag(result.value);
        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(result.value, "application/json; charset=utf-8");
    });

    // Enum metadata so the browser can resolve binary wire values back to enum strings. Cached
    // static per plugin run.
    server.Get("/tiletype_meta.json", [](const httplib::Request& req, httplib::Response& res) {
        static const ApiResult<std::string> cached = build_tiletype_meta_json();
        if (!cached.ok) {
            send_api_error(cached, res);
            return;
        }
        static const std::string etag = "\"dwf-tiletype-v1\"";
        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(cached.value, "application/json; charset=utf-8");
    });

    server.Get("/item_type_meta.json", [](const httplib::Request& req, httplib::Response& res) {
        static const ApiResult<std::string> cached = build_item_type_meta_json();
        if (!cached.ok) {
            send_api_error(cached, res);
            return;
        }
        static const std::string etag = "\"dwf-itemtype-v1\"";
        res.set_header("Cache-Control", "public, max-age=86400");
        res.set_header("ETag", etag);
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        res.set_content(cached.value, "application/json; charset=utf-8");
    });

    // Serves a sheet by basename, optionally ONE subdirectory deep. Only
    // [A-Za-z0-9_]+(/[A-Za-z0-9_]+)?\.png is accepted, so there is no "." at all and no traversal.
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

        std::string path = resolve_sprite_png(name);
        FileStamp stamp;
        if (path.empty() || !stat_file(path, stamp)) {
            res.status = 404;
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }

        // Revalidate by content rather than treating a prior response as fresh for a day: localhost
        // would otherwise keep an obsolete sheet while a tunnel origin fetches a new copy.
        std::string etag, bytes;
        bool have_bytes = false;
        if (!sprite_cached_etag(path, stamp, etag)) {
            if (!read_whole_file(path, bytes)) {
                res.status = 404;
                res.set_content("not found\n", "text/plain; charset=utf-8");
                return;
            }
            have_bytes = true;
            etag = content_etag(bytes);
            sprite_remember_etag(path, stamp, etag);
        }

        res.set_header("Cache-Control", "no-cache");
        res.set_header("ETag", etag);
        // The point of the cache: a matching ETag returns here after one stat and two map lookups.
        if (req.get_header_value("If-None-Match") == etag) {
            res.status = 304;
            return;
        }
        if (!have_bytes && !read_whole_file(path, bytes)) {
            res.status = 404;
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_content(bytes.data(), bytes.size(), "image/png");
    });

    // Catch-all unmatched POST -> a real, fast 404 JSON. httplib stops at the first regex_match in
    // REGISTRATION order, so ".*" is safe only while it is the LAST POST route added.
    server.Post(".*", [](const httplib::Request&, httplib::Response& res) {
        res.status = 404;
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":false,\"error\":\"not found\"}\n",
                        "application/json; charset=utf-8");
    });
}

// Is the HTTP listen thread still there? On Windows a zero-timeout wait on its handle returns
// WAIT_TIMEOUT while it is parked in accept() and WAIT_OBJECT_0 once it has terminated.
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

// The once-a-minute proof of life: one file open/write/close per 60 s, and everything it prints was
// already sitting in an atomic, so the beat never touches DF's lock. Returns the line it wrote.
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
      << " wsDrops=" << ws_drop_counters_json()
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
    // A crash tail showing ENTER with no EXIT and no SHUTDOWN-CLEAN means this thread was still up
    // when the process died.
    diagnostics_log("THREAD-ENTER push-loop");
    auto interval = std::chrono::milliseconds(33);       // ~30Hz sampling of the live sim
    // Deadline-based scheduling: wait until (deadline += interval), not a fresh interval each loop,
    // so the true period stays ~33ms. If a build overruns, snap the deadline forward, never spin.
    auto next_deadline = std::chrono::steady_clock::now();
    // Free-run diagnostics: prove the loop actually ticks ~30x/s independent of client input.
    int dbg_iters = 0, dbg_players = 0;
    auto dbg_last = std::chrono::steady_clock::now();
    // 60 s crash-evidence heartbeat. Baselines for the per-beat deltas.
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
        g_push_iters.fetch_add(1, std::memory_order_relaxed);   // liveness counter
        {
            auto nowd = std::chrono::steady_clock::now();
            if (nowd - dbg_last >= std::chrono::seconds(1)) {
                diagnostics_log_v("push-loop: " + std::to_string(dbg_iters) + " iters/s, avgPlayers=" +
                    std::to_string(connected.empty() ? 0 : dbg_players / std::max(1, dbg_iters)) +
                    ", connectedNow=" + std::to_string(connected.size()));
                dbg_iters = 0; dbg_players = 0; dbg_last = nowd;
            }
            // Unconditional -- an idle, paused fort still beats, because silence is the signal --
            // but only once per kHeartbeatSecs, so it can never spam.
            if (nowd - hb_last >= std::chrono::seconds(kHeartbeatSecs)) {
                uint64_t p = g_push_iters.load(), c = g_cursor_iters.load();
                uint64_t f = ws_frames_sent_total(), r = g_http_requests.load();
                diagnostics_log("HEARTBEAT " + heartbeat_line(connected.size(), p - hb_push0,
                                                              c - hb_cursor0, f - hb_frames0,
                                                              r - hb_reqs0));
                hb_push0 = p; hb_cursor0 = c; hb_frames0 = f; hb_reqs0 = r; hb_last = nowd;
            }
        }

        // The v1 GLOBAL read pass: one signature scan, one encode, N cheap distributions per tick,
        // and the only map-push path. Same lock order as /mapdata (capture mutex -> CoreSuspender).
        { DiagPhase _p("world_stream_tick");
          world_stream_tick(capture_state_mutex(),
                            [](const std::string& p) { return presence_json(p); }); }

        // Placed AFTER world_stream_tick so a save-stalled tick does NOT advance the heartbeat --
        // that stall is exactly what the saving-indicator watchdog detects.
        { DiagPhase _p("pause_push_tick"); pause_push_tick(); }

        // <=1 Hz sample of world.status.popups; announcement_alert is local host UI, never mirrored.
        { DiagPhase _p("popup_push_tick"); popup_push_tick(); }

        // <=1 Hz, suspender-free compare of the burrow revision every /burrow-* write bumps, so
        // another player's burrow paint appears without you reopening the panel.
        { DiagPhase _p("burrow_push_tick"); burrow_push_tick(); }

        // kDiploTickEnabled is this tick's kill switch; /diplo stays request-driven either way.
        // Each DiagPhase clears `inside` on return, so a phase named in a STALL line is truly wedged.
        if (kDiploTickEnabled) { DiagPhase _p("diplo_push_tick"); diplo_push_tick(); }
    }
    diagnostics_log("THREAD-EXIT push-loop iters=" + std::to_string(g_push_iters.load()) +
                    " (g_running=false: normal stop)");
}

// Lives on the cursor loop because that loop NEVER takes CoreSuspender: it keeps running, and can
// still write a log line, exactly when the push loop is wedged inside DF.
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
        g_cursor_iters.fetch_add(1, std::memory_order_relaxed);   // liveness counter

        for (const auto& snap : client_camera_snapshot()) {
            const std::string& player = snap.player;
            if (ws_connection_count_for(player) == 0) continue;   // only players with a socket
            std::string arr = cursors_json(player);
            if (arr.size() <= 2) continue;                        // "[]" -> nothing to send
            broadcast_to_player(player, "{\"type\":\"cursors\",\"players\":" + arr + "}");
        }

        // These watchdogs live HERE because this loop never takes CoreSuspender, so they keep
        // flowing while the core is blocked writing an autosave. Both are core-free.
        pause_busy_watchdog_tick();
        pause_leave_watchdog_tick();

        push_stall_watchdog_tick();

        // Core-free, at ~1 Hz (every 25th pass): the leave grace is seconds, so a sub-second
        // cadence would add nothing but registry-lock churn.
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

    // WsHttpServer intercepts `Upgrade: websocket` on the SAME listen socket and delegates every
    // other request to base HTTP handling, so register_routes / bind / listen are unchanged.
    auto server = make_ws_server();
    register_routes(*server);

    // Provide hello_ack map dims + world_seq to the transport (DF read under the
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
    // reset the crash-evidence clocks/counters for this server run.
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
        // Wake accepted sockets BEFORE httplib drains its worker queue: stop() only closes the
        // listen socket, and an idle keep-alive can hold a pool worker for five seconds.
        g_running = false;
        ws_server_begin_shutdown(*g_server);
        g_server->stop();
        server = std::move(g_server);
        thread = std::move(g_server_thread);
    }

    // Unblock the push loop and every WS worker parked in recv(), then join the push thread.
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
    g_http_thread_handle.store(nullptr, std::memory_order_relaxed);   // handle is dead now
    g_running = false;

    // The orderly-stop mark with this run's totals. plugin_shutdown writes the final
    // SHUTDOWN-CLEAN line after it.
    long long start = g_server_start_ms.load(std::memory_order_relaxed);
    diagnostics_log("SERVER-STOP all threads joined: up=" +
                    std::to_string(start ? (diag_steady_ms() - start) / 1000 : 0) + "s pushIters=" +
                    std::to_string(g_push_iters.load()) + " cursorIters=" +
                    std::to_string(g_cursor_iters.load()) + " wsFrames=" +
                    std::to_string(ws_frames_sent_total()) + " httpReqs=" +
                    std::to_string(g_http_requests.load()));
}

} // namespace dwf
