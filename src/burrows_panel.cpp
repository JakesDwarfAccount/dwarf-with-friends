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

#include "burrows_panel.h"

#include "api_response.h"
#include "Core.h"
#include "client_state.h"
#include "common_util.h"
#include "curses_palette.h"
#include "http_server.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "websocket.h"

#include "modules/Burrows.h"
#include "modules/Maps.h"
#include "modules/Units.h"

#include "df/alert_state_infost.h"
#include "df/alert_statest.h"
#include "df/burrow.h"
#include "df/burrow_infost.h"
#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/map_block.h"
#include "df/plotinfost.h"
#include "df/unit.h"
#include "df/world.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_burrows_mutex;

template <typename Fn>
bool run_burrows_locked(Fn&& fn) {
    return run_panel_locked(g_burrows_mutex, std::forward<Fn>(fn));
}

// --------------------------------------------- burrow revision + change broadcast

// Only this plugin's own write routes bump the seq: a burrow edited in the host's native DF
// window does not, so those edits reach clients on the next refetch, never by broadcast.
std::atomic<uint64_t> g_burrow_seq{0};
std::mutex g_burrow_sync_mutex;
std::set<std::string> g_burrow_synced;   // players told the current seq (late-join bookkeeping)
uint64_t g_burrow_broadcast_seq = 0;     // last seq we actually pushed

uint64_t current_burrow_seq() { return g_burrow_seq.load(); }
void bump_burrow_seq() { g_burrow_seq.fetch_add(1); }

df::burrow* find_burrow(int32_t id) {
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo)
        return nullptr;
    for (auto burrow : plotinfo->burrows.list) {
        if (burrow && burrow->id == id)
            return burrow;
    }
    return nullptr;
}

// `pixel` is already a tile-grid index into the client's rendered window; `frame` is that
// window's tile width or height, never DF's own native viewport.
int burrow_pixel_to_tile(int pixel, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, pixel));
}

// Civilian alert is not a df::burrow flag: a burrow is a civ-alert destination iff its id is in
// the sorted `burrows` vector of plotinfo->alerts.list[0], which DF creates lazily.
df::alert_statest* get_civ_alert_state() {
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo)
        return nullptr;
    auto& alerts = plotinfo->alerts;
    while (alerts.list.size() < 2) {
        auto* item = df::allocate<df::alert_statest>();
        if (!item)
            return alerts.list.empty() ? nullptr : alerts.list[0];
        item->id = alerts.next_id++;
        item->name = "civ-alert";
        alerts.list.push_back(item);
    }
    return alerts.list[0];
}

bool burrow_is_civalert(int32_t burrow_id) {
    auto* alert = get_civ_alert_state();
    if (!alert)
        return false;
    return std::find(alert->burrows.begin(), alert->burrows.end(), burrow_id) !=
           alert->burrows.end();
}

bool set_burrow_civalert(int32_t burrow_id, bool on, std::string* err) {
    auto* alert = get_civ_alert_state();
    if (!alert) { if (err) *err = "civilian alert state unavailable"; return false; }
    auto& v = alert->burrows;
    auto it = std::lower_bound(v.begin(), v.end(), burrow_id);
    bool present = it != v.end() && *it == burrow_id;
    if (on && !present)
        v.insert(it, burrow_id);
    else if (!on && present)
        v.erase(it);
    return true;
}

// --------------------------------------- symbol / colour (the native burrow symbol picker)

// v50 renders a burrow from symbol_index plus texture_r/g/b and texture_br/bg/bb. Never write
// solid_texpos, blended_texpos or `tile`: DF derives those render caches from the fields above.
constexpr int kBurrowSymbolCount = 23;  // CUSTOM_SYMBOL cells in graphics_interface.txt
constexpr int kCursesColors = dwf::curses::kColors;

using BurrowRgb = dwf::curses::Rgb;
inline bool curses_rgb(int index, BurrowRgb& out) { return dwf::curses::rgb(index, out); }

int clamp_int(int value, int lo, int hi) { return std::max(lo, std::min(hi, value)); }

// A negative symbol, fg or bg means "leave that facet of the burrow as it is".
void apply_burrow_symbol(df::burrow* burrow, int symbol, int fg, int bg) {
    if (!burrow)
        return;
    if (symbol >= 0)
        burrow->symbol_index = clamp_int(symbol, 0, kBurrowSymbolCount - 1);
    if (fg >= 0) {
        int idx = clamp_int(fg, 0, kCursesColors - 1);
        burrow->fg_color = static_cast<int16_t>(idx);
        BurrowRgb rgb{};
        if (curses_rgb(idx, rgb)) {
            burrow->texture_r = static_cast<uint8_t>(rgb.r);
            burrow->texture_g = static_cast<uint8_t>(rgb.g);
            burrow->texture_b = static_cast<uint8_t>(rgb.b);
        }
    }
    if (bg >= 0) {
        int idx = clamp_int(bg, 0, kCursesColors - 1);
        burrow->bg_color = static_cast<int16_t>(idx);
        BurrowRgb rgb{};
        if (curses_rgb(idx, rgb)) {
            burrow->texture_br = static_cast<uint8_t>(rgb.r);
            burrow->texture_bg = static_cast<uint8_t>(rgb.g);
            burrow->texture_bb = static_cast<uint8_t>(rgb.b);
        }
    }
}

ApiResult<bool> set_burrow_symbol(int32_t id, int symbol, int fg, int bg) {
    ApiError failure;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) {
            failure = {404, "burrow_not_found", "burrow not found"};
            return false;
        }
        apply_burrow_symbol(burrow, symbol, fg, bg);
        bump_burrow_seq();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

struct BurrowRect { int x; int y; int w; int h; };

constexpr size_t kMaxBurrowRects = 8192;  // response cap; merged rows stay far below it

// listBlocks walks 16x16 blocks, so one burrow row arrives as several touching runs.
void merge_row_runs(std::vector<BurrowRect>& rects) {
    std::sort(rects.begin(), rects.end(), [](const BurrowRect& a, const BurrowRect& b) {
        return a.y != b.y ? a.y < b.y : a.x < b.x;
    });
    std::vector<BurrowRect> merged;
    merged.reserve(rects.size());
    for (const auto& r : rects) {
        if (!merged.empty() && merged.back().y == r.y && merged.back().x + merged.back().w == r.x)
            merged.back().w += r.w;
        else
            merged.push_back(r);
    }
    rects.swap(merged);
}

// World-coordinate rects for one z, deliberately never clipped to a window: the client's overlay
// planner culls what it cannot see, and a rect the server withholds is an invisible burrow.
std::vector<BurrowRect> burrow_tile_rects_on_z(df::burrow* burrow, int z) {
    std::vector<BurrowRect> rects;
    if (!burrow)
        return rects;

    std::vector<df::map_block*> blocks;
    DFHack::Burrows::listBlocks(&blocks, burrow);
    for (auto block : blocks) {
        if (!block || block->map_pos.z != z)
            continue;
        int bx = block->map_pos.x, by = block->map_pos.y;
        for (int ty = 0; ty < 16; ++ty) {
            int run_start = -1;
            for (int tx = 0; tx <= 16; ++tx) {
                bool present = tx < 16 &&
                    DFHack::Burrows::isAssignedBlockTile(burrow, block, df::coord2d(tx, ty));
                if (present) {
                    if (run_start < 0) run_start = tx;
                } else if (run_start >= 0) {
                    rects.push_back({bx + run_start, by + ty, tx - run_start, 1});
                    run_start = -1;
                }
            }
        }
    }
    merge_row_runs(rects);
    if (rects.size() > kMaxBurrowRects)
        rects.resize(kMaxBurrowRects);
    return rects;
}

void append_burrow_rects_json(std::ostringstream& body, const std::vector<BurrowRect>& rects) {
    body << "[";
    for (size_t i = 0; i < rects.size(); ++i) {
        if (i) body << ",";
        const auto& r = rects[i];
        body << "{\"x\":" << r.x << ",\"y\":" << r.y << ",\"w\":" << r.w << ",\"h\":" << r.h << "}";
    }
    body << "]";
}

ApiResult<std::string> build_burrows_json(const std::string& player, const Camera& camera,
                                          bool have_camera, int32_t detail_id) {
    std::ostringstream body;
    bool ok = run_burrows_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) return false;

        body << "{\"player\":" << json_string(player)
             << ",\"z\":" << (have_camera ? camera.z : -1)
             << ",\"worldRects\":true"
             << ",\"seq\":" << current_burrow_seq()
             << ",\"palette\":" << dwf::curses::palette_json()
             << ",\"burrows\":[";
        bool first = true;
        for (auto burrow : plotinfo->burrows.list) {
            if (!burrow)
                continue;
            std::string name = DFHack::Burrows::getName(burrow);
            if (!first) body << ",";
            first = false;
            body << "{\"id\":" << burrow->id
                 << ",\"name\":" << json_string(name)
                 << ",\"memberCount\":" << static_cast<int>(burrow->units.size())
                 << ",\"symbolIndex\":" << burrow->symbol_index
                 << ",\"fgColor\":" << burrow->fg_color
                 << ",\"bgColor\":" << burrow->bg_color
                 << ",\"rgb\":[" << static_cast<int>(burrow->texture_r) << ","
                                 << static_cast<int>(burrow->texture_g) << ","
                                 << static_cast<int>(burrow->texture_b) << "]"
                 << ",\"bgRgb\":[" << static_cast<int>(burrow->texture_br) << ","
                                   << static_cast<int>(burrow->texture_bg) << ","
                                   << static_cast<int>(burrow->texture_bb) << "]"
                 << ",\"suspended\":" << (burrow->flags.bits.suspended ? "true" : "false")
                 << ",\"limitWorkshops\":" << (burrow->flags.bits.limit_workshops ? "true" : "false")
                 << ",\"civAlert\":" << (burrow_is_civalert(burrow->id) ? "true" : "false")
                 << ",\"rects\":";
            if (have_camera)
                append_burrow_rects_json(body, burrow_tile_rects_on_z(burrow, camera.z));
            else
                body << "[]";
            body << "}";
        }
        body << "],\"members\":[";
        if (detail_id >= 0) {
            auto burrow = find_burrow(detail_id);
            if (burrow) {
                bool m_first = true;
                for (int32_t unit_id : burrow->units) {
                    auto unit = df::unit::find(unit_id);
                    if (!m_first) body << ",";
                    m_first = false;
                    body << "{\"unitId\":" << unit_id
                         << ",\"name\":" << json_string(unit ? DFHack::Units::getReadableName(unit) : "")
                         << ",\"profession\":" << json_string(unit ? DFHack::Units::getProfessionName(unit) : "")
                         << ",\"professionColor\":" << (unit ? static_cast<int>(DFHack::Units::getProfessionColor(unit)) : -1)
                         << "}";
                }
            }
        }
        body << "],\"detailId\":" << detail_id << "}\n";
        return true;
    });
    if (!ok) return ApiResult<std::string>::failure(
        503, "burrows_unavailable", "burrows are unavailable");
    return ApiResult<std::string>::success(body.str());
}

ApiResult<int32_t> create_burrow(const std::string& name) {
    int32_t new_id = -1;
    ApiError failure;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "world_unavailable", "world unavailable"};
            return false;
        }
        auto burrow = df::allocate<df::burrow>();
        if (!burrow) {
            failure = {500, "burrow_allocation_failed", "could not allocate burrow"};
            return false;
        }
        burrow->id = plotinfo->burrows.next_id++;
        burrow->name = name;
        // Symbol cycles by id; 11 and 3 are df::burrow's own declared fg/bg colour indices.
        apply_burrow_symbol(burrow, burrow->id % kBurrowSymbolCount, 11, 3);
        plotinfo->burrows.list.push_back(burrow);
        new_id = burrow->id;
        bump_burrow_seq();
        return true;
    });
    if (!ok) return ApiResult<int32_t>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<int32_t>::success(new_id);
}

ApiResult<bool> rename_burrow(int32_t id, const std::string& name) {
    ApiError failure;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) {
            failure = {404, "burrow_not_found", "burrow not found"};
            return false;
        }
        burrow->name = name;
        bump_burrow_seq();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> set_burrow_member(int32_t id, int32_t unit_id, bool enable) {
    ApiError failure;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) {
            failure = {404, "burrow_not_found", "burrow not found"};
            return false;
        }
        auto unit = df::unit::find(unit_id);
        if (!unit) {
            failure = {404, "unit_not_found", "unit not found"};
            return false;
        }
        DFHack::Burrows::setAssignedUnit(burrow, unit, enable);
        bump_burrow_seq();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> apply_burrow_action(int32_t id, const std::string& action) {
    ApiError failure;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) {
            failure = {404, "burrow_not_found", "burrow not found"};
            return false;
        }
        if (action == "suspend") { burrow->flags.bits.suspended = 1; bump_burrow_seq(); return true; }
        if (action == "resume") { burrow->flags.bits.suspended = 0; bump_burrow_seq(); return true; }
        if (action == "civalert-on" || action == "civalert-off") {
            std::string error;
            if (!set_burrow_civalert(id, action == "civalert-on", &error)) {
                failure = {400, "civ_alert_update_failed",
                    error.empty() ? "civilian alert update failed" : error};
                return false;
            }
            bump_burrow_seq();
            return true;
        }
        if (action == "workshops-limit") { burrow->flags.bits.limit_workshops = 1; bump_burrow_seq(); return true; }
        if (action == "workshops-all") { burrow->flags.bits.limit_workshops = 0; bump_burrow_seq(); return true; }
        failure = {400, "unknown_burrow_action", "unknown burrow action: " + action};
        return false;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> delete_burrow(int32_t id) {
    ApiError failure;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "world_unavailable", "world unavailable"};
            return false;
        }
        auto burrow = find_burrow(id);
        if (!burrow) {
            failure = {404, "burrow_not_found", "burrow not found"};
            return false;
        }

        DFHack::Burrows::clearTiles(burrow);
        DFHack::Burrows::clearUnits(burrow);

        auto& alerts = plotinfo->alerts;
        if (!alerts.list.empty() && alerts.list[0]) {
            auto& v = alerts.list[0]->burrows;
            auto it = std::find(v.begin(), v.end(), id);
            if (it != v.end()) {
                v.erase(it);
                if (v.empty())
                    alerts.civ_alert_idx = 0;
            }
        }

        auto& list = plotinfo->burrows.list;
        auto it = std::find(list.begin(), list.end(), burrow);
        if (it == list.end()) {
            failure = {500, "burrow_not_tracked", "burrow is not tracked by the fortress"};
            return false;
        }
        list.erase(it);
        delete burrow;
        bump_burrow_seq();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<int> paint_burrow(const Camera& camera, int frame_w, int frame_h, int32_t id,
                            int px, int py, int px2, int py2, bool add) {
    ApiError failure;
    int changed = 0;
    const bool ok = run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) {
            failure = {404, "burrow_not_found", "burrow not found"};
            return false;
        }

        // The probe is only a "is DF's capture path alive" gate: px/py scale against
        // frame_w/frame_h, never against probe_w/probe_h.
        int probe_w = 0, probe_h = 0;
        std::string viewport_error;
        if (!effective_capture_viewport_dims(camera, probe_w, probe_h, &viewport_error)) {
            failure = {503, "viewport_unavailable",
                viewport_error.empty() ? "viewport unavailable" : viewport_error};
            return false;
        }

        int tx1 = burrow_pixel_to_tile(std::min(px, px2), frame_w);
        int ty1 = burrow_pixel_to_tile(std::min(py, py2), frame_h);
        int tx2 = burrow_pixel_to_tile(std::max(px, px2), frame_w);
        int ty2 = burrow_pixel_to_tile(std::max(py, py2), frame_h);
        int wx1 = camera.x + tx1, wy1 = camera.y + ty1;
        int wx2 = camera.x + tx2, wy2 = camera.y + ty2;

        for (int y = wy1; y <= wy2; ++y) {
            for (int x = wx1; x <= wx2; ++x) {
                df::coord pos(x, y, camera.z);
                if (DFHack::Burrows::setAssignedTile(burrow, pos, add))
                    ++changed;
            }
        }
        if (changed)
            bump_burrow_seq();
        return true;
    });
    if (!ok) return ApiResult<int>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<int>::success(changed);
}

} // namespace

void burrow_push_tick() {
    static long long last_pass = 0;
    const long long now = steady_ms();
    if (now - last_pass < 1000)
        return;
    last_pass = now;

    const uint64_t seq = current_burrow_seq();
    if (seq == 0)
        return;   // seq 0 = nothing has ever changed

    const std::string frame = "{\"type\":\"burrows\",\"seq\":" + std::to_string(seq) + "}";

    bool changed = false;
    {
        std::lock_guard<std::mutex> lock(g_burrow_sync_mutex);
        if (g_burrow_broadcast_seq != seq) {
            g_burrow_broadcast_seq = seq;
            changed = true;
        }
    }
    auto connected = ws_connected_players();
    if (changed) {
        for (const auto& p : connected)
            broadcast_to_player(p, frame);
        std::lock_guard<std::mutex> lock(g_burrow_sync_mutex);
        g_burrow_synced.clear();
        g_burrow_synced.insert(connected.begin(), connected.end());
        return;
    }

    // Late-join sync.
    std::vector<std::string> to_sync;
    {
        std::lock_guard<std::mutex> lock(g_burrow_sync_mutex);
        std::set<std::string> live(connected.begin(), connected.end());
        for (auto it = g_burrow_synced.begin(); it != g_burrow_synced.end();)
            it = live.count(*it) ? std::next(it) : g_burrow_synced.erase(it);
        for (const auto& p : connected)
            if (!g_burrow_synced.count(p)) { to_sync.push_back(p); g_burrow_synced.insert(p); }
    }
    for (const auto& p : to_sync)
        broadcast_to_player(p, frame);
}

void register_burrows_routes(httplib::Server& server) {
    server.Get("/burrows", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int detail = -1;
        query_int(req, "detail", detail);
        Camera camera;
        std::string cam_err;
        bool have_camera = camera_for_player(player, camera, &cam_err);
        const auto result = build_burrows_json(player, camera, have_camera, detail);
        if (!result.ok) { send_api_error(result, res); return; }
        set_no_store_json(res, result.value);
    });

    auto create_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string name = req.has_param("name") ? req.get_param_value("name") : "New Burrow";
        if (name.size() > 64) name.resize(64);
        const auto result = create_burrow(name);
        if (!result.ok) { send_api_error(result, res); return; }
        set_no_store_json(res, "{\"ok\":true,\"id\":" + std::to_string(result.value) + "}\n");
    };
    server.Post("/burrow-create", create_handler);

    auto rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("name")) {
            json_error(res, 400, "missing id/name");
            return;
        }
        std::string name = req.get_param_value("name");
        if (name.size() > 64) name.resize(64);
        const auto result = rename_burrow(id, name);
        if (!result.ok) { send_api_error(result, res); return; }
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Post("/burrow-rename", rename_handler);

    auto member_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit_id = -1;
        if (!query_int(req, "id", id) || !query_int(req, "unit", unit_id)) {
            json_error(res, 400, "missing id/unit");
            return;
        }
        int on = 1;
        query_int(req, "on", on);
        const auto result = set_burrow_member(id, unit_id, on != 0);
        if (!result.ok) { send_api_error(result, res); return; }
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Post("/burrow-unit", member_handler);

    auto action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("action")) {
            json_error(res, 400, "missing id/action");
            return;
        }
        const auto result = apply_burrow_action(id, req.get_param_value("action"));
        if (!result.ok) { send_api_error(result, res); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Post("/burrow-action", action_handler);

    auto symbol_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            json_error(res, 400, "missing id");
            return;
        }
        int symbol = -1, fg = -1, bg = -1;
        query_int(req, "symbol", symbol);
        query_int(req, "fg", fg);
        query_int(req, "bg", bg);
        if (symbol < 0 && fg < 0 && bg < 0) {
            json_error(res, 400, "nothing to set (want symbol/fg/bg)");
            return;
        }
        const auto result = set_burrow_symbol(id, symbol, fg, bg);
        if (!result.ok) { send_api_error(result, res); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Post("/burrow-symbol", symbol_handler);

    auto delete_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            json_error(res, 400, "missing id");
            return;
        }
        const auto result = delete_burrow(id);
        if (!result.ok) { send_api_error(result, res); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Post("/burrow-delete", delete_handler);

    auto paint_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int id = -1;
        int px = 0, py = 0, px2 = 0, py2 = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "id", id) ||
                !parse_frame_rect(req, px, py, px2, py2, frame_w, frame_h)) {
            json_error(res, 400, "missing id/px/py/w/h");
            return;
        }
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "add";
        bool add = mode != "erase";

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            json_error(res, 503, err.empty() ? "camera unavailable" : err);
            return;
        }

        const auto result = paint_burrow(camera, frame_w, frame_h, id, px, py, px2, py2, add);
        if (!result.ok) { send_api_error(result, res); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true,\"id\":" + std::to_string(id) +
                                ",\"count\":" + std::to_string(result.value) + "}\n");
    };
    server.Post("/burrow-paint", paint_handler);
}

} // namespace dwf
