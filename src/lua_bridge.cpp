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

#include "lua_bridge.h"

#include "Core.h"
#include "LuaTools.h"
#include "console_policy.h"
#include "diagnostics.h"
#include "save_barrier.h"
#include "sdl_capture.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstring>
#include <initializer_list>
#include <mutex>
#include <sstream>
#include <thread>
#include <tuple>
#include <utility>

using namespace DFHack;

namespace dwf {
namespace {

constexpr const char* LUA_MODULE = "plugins.dwf";

std::recursive_mutex g_lua_bridge_mutex;
std::atomic<uint64_t> g_lua_calls{0};
std::atomic<uint64_t> g_lua_successes{0};
std::atomic<uint64_t> g_lua_call_failures{0};
std::atomic<uint64_t> g_lua_signature_failures{0};

struct RetSlot {
    char type;       // b=boolean, n=number, s=string, t=table
    bool nilable;
};

const char* return_type_name(char type) {
    switch (type) {
    case 'b': return "boolean";
    case 'n': return "number";
    case 's': return "string";
    case 't': return "table";
    default: return "unknown";
    }
}

bool validate_returns(lua_State* L, const char* function_name,
                      std::initializer_list<RetSlot> slots, std::string* err) {
    int index = -static_cast<int>(slots.size());
    int position = 1;
    for (const RetSlot& slot : slots) {
        int actual = lua_type(L, index);
        bool matches = slot.nilable && actual == LUA_TNIL;
        if (!matches) {
            switch (slot.type) {
            case 'b': matches = actual == LUA_TBOOLEAN; break;
            case 'n': matches = actual == LUA_TNUMBER; break;
            case 's': matches = actual == LUA_TSTRING; break;
            case 't': matches = actual == LUA_TTABLE; break;
            default: matches = false; break;
            }
        }
        if (!matches) {
            if (err) {
                *err = std::string(function_name) + ": return #" + std::to_string(position) +
                    " expected " + return_type_name(slot.type) + (slot.nilable ? " or nil" : "") +
                    ", got " + lua_typename(L, actual);
            }
            return false;
        }
        ++index;
        ++position;
    }
    return true;
}

bool function_is(const char* function_name, std::initializer_list<const char*> names) {
    for (const char* name : names) {
        if (std::strcmp(function_name, name) == 0) return true;
    }
    return false;
}

bool validate_named_returns(lua_State* L, const char* function_name, int returns,
                            std::string* err) {
    if (function_is(function_name, {
            "building_catalog", "build_materials", "place_candidates",
            "stockpile_cat_groups", "stockpile_item_list", "stockpile_settings_snapshot",
            "hauling_stop_settings_snapshot", "hauling_stop_item_list", "workshop_info",
            "burial_coffin_info", "zone_locations_json", "location_detail_json",
            "list_orders", "order_catalog", "order_catalog_by_shop", "order_presets",
            "condition_targets", "order_workshops", "condition_materials",
            "suggested_conditions", "console_catalog", "hw_trade_state",
            "hw_justice_state", "hw_widget_dump", "hw_trade_action", "hw_justice_action"})) {
        return returns == 1 && validate_returns(L, function_name, {{'s', true}}, err);
    }
    if (function_is(function_name, {
            "stockpile_set_preset", "stockpile_toggle_item", "stockpile_toggle_all", "hauling_stop_toggle_item",
            "hauling_stop_toggle_all", "hauling_stop_set_preset", "workshop_add_job",
            "workshop_job_action", "workshop_worker_action", "workshop_workers_clear",
            "workshop_profile_set", "burial_coffin_action", "queue_memorial_slab",
            "zone_location_action", "location_action", "import_order_preset", "cancel_order",
            "adjust_order", "add_item_condition", "edit_item_condition",
            "add_order_condition", "remove_condition", "set_order_max_workshops",
            "set_order_workshop", "reorder_order"})) {
        return returns == 2 && validate_returns(L, function_name, {{'b', false}, {'s', true}}, err);
    }
    if (function_is(function_name, {"create_stockpile", "create_zone", "missions_rescue_stuck"})) {
        return returns == 2 && validate_returns(L, function_name, {{'n', false}, {'s', true}}, err);
    }
    if (std::strcmp(function_name, "place_building") == 0) {
        return returns == 5 && validate_returns(L, function_name,
            {{'n', false}, {'n', false}, {'s', true}, {'t', true}, {'s', true}}, err);
    }
    if (std::strcmp(function_name, "create_order") == 0) {
        return returns == 3 && validate_returns(L, function_name,
            {{'b', false}, {'s', true}, {'t', true}}, err);
    }
    if (std::strcmp(function_name, "console_run") == 0) {
        return returns == 2 && validate_returns(L, function_name, {{'n', false}, {'s', false}}, err);
    }
    if (std::strcmp(function_name, "repair_incomplete_stockpile_settings") == 0) {
        return returns == 2 && validate_returns(L, function_name, {{'n', false}, {'n', false}}, err);
    }
    if (std::strcmp(function_name, "hw_flags") == 0) {
        return returns == 1 && validate_returns(L, function_name, {{'t', false}}, err);
    }
    if (err) *err = std::string(function_name) + ": no registered Lua return signature";
    return false;
}

template <typename Fn>
bool run_lua_locked(Fn&& fn) {
    std::lock_guard<std::recursive_mutex> module_lock(g_lua_bridge_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    // A request can enter HTTP just before DF raises its save callback and then wait here for the
    // core. Re-check after acquiring the core lock so it cannot execute in the post-save cleanup
    // boundary even if it passed the outer HTTP barrier before the save began.
    if (save_barrier_active()) return false;
    return fn();
}

// BUGFIX (cursor/selection misalignment): was clamping/rescaling against
// effective_capture_viewport_dims (DF's own tiny native viewport) instead of the client's own
// frame_w/frame_h -- see interaction.cpp's pixel_to_tile_coord banner for the root cause. px is
// already a plain tile-grid index into the client's rendered window (0..frame-1); clamp against
// that window, never DF's native viewport size.
int pixel_to_tile(int pixel, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, pixel));
}

bool pixel_rect_to_world_tiles(const Camera& camera, int px, int py, int px2, int py2,
                               int frame_w, int frame_h, int& x1, int& y1,
                               int& x2, int& y2, std::string* err) {
    // Availability probe only (best-effort "is DF's capture path alive").
    int probe_w = 0, probe_h = 0;
    if (!effective_capture_viewport_dims(camera, probe_w, probe_h, err) ||
            frame_w <= 0 || frame_h <= 0) {
        if (err && err->empty())
            *err = "viewport/frame unavailable";
        return false;
    }

    int tx1 = pixel_to_tile(std::min(px, px2), frame_w);
    int ty1 = pixel_to_tile(std::min(py, py2), frame_h);
    int tx2 = pixel_to_tile(std::max(px, px2), frame_w);
    int ty2 = pixel_to_tile(std::max(py, py2), frame_h);

    x1 = camera.x + tx1;
    y1 = camera.y + ty1;
    x2 = camera.x + tx2;
    y2 = camera.y + ty2;
    return true;
}

std::string lua_output_text(DFHack::buffered_color_ostream& out) {
    std::string text;
    for (const auto& frag : out.fragments())
        text += frag.second;
    return text;
}

template <typename Args, typename ResultFn>
bool call_lua(const char* function_name, Args&& args, int returns,
              ResultFn&& result_fn, std::string* err) {
    g_lua_calls.fetch_add(1, std::memory_order_relaxed);
    DFHack::buffered_color_ostream lua_out;
    bool signature_ok = false;
    std::string signature_error;
    bool called = Lua::CallLuaModuleFunction(lua_out, LUA_MODULE, function_name,
                                             std::forward<Args>(args), returns,
        [&](lua_State* L) {
            signature_ok = validate_named_returns(L, function_name, returns, &signature_error);
            if (signature_ok) result_fn(L);
        });
    if (!called) {
        g_lua_call_failures.fetch_add(1, std::memory_order_relaxed);
        if (err) {
            std::string details = lua_output_text(lua_out);
            *err = details.empty()
                ? std::string("lua bridge call failed: ") + function_name
                : details;
        }
        return false;
    }
    if (!signature_ok) {
        g_lua_signature_failures.fetch_add(1, std::memory_order_relaxed);
        if (err) *err = signature_error;
        diagnostics_log("lua-bridge signature mismatch: " + signature_error);
        return false;
    }
    g_lua_successes.fetch_add(1, std::memory_order_relaxed);
    return true;
}

std::string json_returning_lua(const char* function_name, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua(function_name, std::make_tuple(), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

std::string json_returning_lua_int(const char* function_name, int32_t id, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua(function_name, std::make_tuple(id), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

bool bool_error_lua_int(const char* function_name, int32_t id, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua(function_name, std::make_tuple(id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? std::string(function_name) + " failed" : result_err;
    return result_ok;
}

bool bool_error_lua_int_string(const char* function_name, int32_t id,
                               const std::string& value, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua(function_name, std::make_tuple(id, value), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? std::string(function_name) + " failed" : result_err;
    return result_ok;
}

} // namespace

LuaBridgeHealth lua_bridge_health_snapshot() {
    LuaBridgeHealth health;
    health.calls = g_lua_calls.load(std::memory_order_relaxed);
    health.successes = g_lua_successes.load(std::memory_order_relaxed);
    health.call_failures = g_lua_call_failures.load(std::memory_order_relaxed);
    health.signature_failures = g_lua_signature_failures.load(std::memory_order_relaxed);
    return health;
}

std::string building_catalog_json_via_lua(std::string* err) {
    return json_returning_lua("building_catalog", err);
}

std::string build_materials_json_via_lua(const std::string& token, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("build_materials", std::make_tuple(token), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

std::string place_candidates_json_via_lua(const std::string& token, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("place_candidates", std::make_tuple(token), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

bool place_building_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                            int frame_w, int frame_h, const std::string& token,
                            int direction, const std::string& options, int selected_item_id,
                            int& out_count, int& out_id, std::string* err,
                            std::vector<int32_t>* out_ids) {
    return run_lua_locked([&]() -> bool {
        int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        if (!pixel_rect_to_world_tiles(camera, px, py, px2, py2, frame_w, frame_h,
                                       x1, y1, x2, y2, err))
            return false;

        int result_count = 0;
        int result_id = -1;
        std::string result_err;
        std::string audit_json;
        diagnostics_log("build-place lua token=" + token + " rect=" +
                        std::to_string(x1) + "," + std::to_string(y1) + ".." +
                        std::to_string(x2) + "," + std::to_string(y2) +
                        " z=" + std::to_string(camera.z));
        // 5 returns: count(-5), first-id(-4), err(-3), created-id table(-2), invariant audit(-1).
        // WP-C reads the id
        // list to attribute EVERY tile of a multi-tile placement; error paths return 3 values, so
        // the padded trailing values are nil and out_ids/audit simply stay empty.
        bool ok = call_lua("place_building",
            std::make_tuple(x1, y1, x2, y2, camera.z, token, direction, options, selected_item_id), 5,
            [&](lua_State* L) {
                if (lua_isnumber(L, -5))
                    result_count = static_cast<int>(lua_tointeger(L, -5));
                if (lua_isnumber(L, -4))
                    result_id = static_cast<int>(lua_tointeger(L, -4));
                if (lua_isstring(L, -3))
                    result_err = lua_tostring(L, -3);
                if (out_ids && lua_istable(L, -2)) {
                    int n = static_cast<int>(lua_rawlen(L, -2));
                    for (int i = 1; i <= n; ++i) {
                        lua_rawgeti(L, -2, i);
                        if (lua_isnumber(L, -1))
                            out_ids->push_back(static_cast<int32_t>(lua_tointeger(L, -1)));
                        lua_pop(L, 1);
                    }
                }
                if (lua_isstring(L, -1))
                    audit_json = lua_tostring(L, -1);
            }, err);
        if (!ok)
            return false;
        if (!audit_json.empty())
            diagnostics_log("build-place invariant-audit token=" + token + " state=" + audit_json);
        out_count = result_count;
        out_id = result_id;
        if (result_count <= 0 || result_id < 0) {
            if (err) *err = result_err.empty() ? "building placement failed" : result_err;
            return false;
        }
        return true;
    });
}

bool create_stockpile_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                              int frame_w, int frame_h, const std::string& preset,
                              int& out_id, std::string* err) {
    return run_lua_locked([&]() -> bool {
        int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        if (!pixel_rect_to_world_tiles(camera, px, py, px2, py2, frame_w, frame_h,
                                       x1, y1, x2, y2, err))
            return false;

        int result_id = -1;
        std::string result_err;
        bool ok = call_lua("create_stockpile",
            std::make_tuple(x1, y1, x2, y2, camera.z, preset), 2,
            [&](lua_State* L) {
                if (lua_isnumber(L, -2))
                    result_id = static_cast<int>(lua_tointeger(L, -2));
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
        if (!ok)
            return false;
        out_id = result_id;
        if (result_id < 0) {
            if (err) *err = result_err.empty() ? "stockpile creation failed" : result_err;
            return false;
        }
        return true;
    });
}

bool create_zone_via_lua(const Camera& camera, int px, int py, int px2, int py2,
                         int frame_w, int frame_h, const std::string& zone_type,
                         int& out_id, std::string* err) {
    return run_lua_locked([&]() -> bool {
        int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        if (!pixel_rect_to_world_tiles(camera, px, py, px2, py2, frame_w, frame_h,
                                       x1, y1, x2, y2, err))
            return false;

        int result_id = -1;
        std::string result_err;
        bool ok = call_lua("create_zone",
            std::make_tuple(x1, y1, x2, y2, camera.z, zone_type), 2,
            [&](lua_State* L) {
                if (lua_isnumber(L, -2))
                    result_id = static_cast<int>(lua_tointeger(L, -2));
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
        if (!ok)
            return false;
        out_id = result_id;
        if (result_id < 0) {
            if (err) *err = result_err.empty() ? "zone creation failed" : result_err;
            return false;
        }
        return true;
    });
}

// Same lua-side "create_stockpile" as create_stockpile_via_lua, but takes an already-resolved
// WORLD tile rectangle (no pixel/viewport conversion). Used by /stockpile-repaint mode=replace
// (stockpile_panel.cpp), which receives the exact repaint footprint world-addressed from the
// client and must not depend on where the requesting player's camera happens to be.
bool create_stockpile_at_world_rect_via_lua(int x1, int y1, int x2, int y2, int z,
                                            const std::string& preset, int& out_id,
                                            std::string* err) {
    return run_lua_locked([&]() -> bool {
        int result_id = -1;
        std::string result_err;
        bool ok = call_lua("create_stockpile",
            std::make_tuple(x1, y1, x2, y2, z, preset), 2,
            [&](lua_State* L) {
                if (lua_isnumber(L, -2))
                    result_id = static_cast<int>(lua_tointeger(L, -2));
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
        if (!ok)
            return false;
        out_id = result_id;
        if (result_id < 0) {
            if (err) *err = result_err.empty() ? "stockpile creation failed" : result_err;
            return false;
        }
        return true;
    });
}

bool create_zone_at_world_rect_via_lua(int x1, int y1, int x2, int y2, int z,
                                       const std::string& zone_type, int& out_id,
                                       std::string* err) {
    return run_lua_locked([&]() -> bool {
        int result_id = -1;
        std::string result_err;
        bool ok = call_lua("create_zone",
            std::make_tuple(x1, y1, x2, y2, z, zone_type), 2,
            [&](lua_State* L) {
                if (lua_isnumber(L, -2))
                    result_id = static_cast<int>(lua_tointeger(L, -2));
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
        if (!ok)
            return false;
        out_id = result_id;
        if (result_id < 0) {
            if (err) *err = result_err.empty() ? "zone creation failed" : result_err;
            return false;
        }
        return true;
    });
}

std::string stockpile_groups_via_lua(const std::string& cat, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("stockpile_cat_groups", std::make_tuple(cat), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

std::string stockpile_items_via_lua(int32_t id, const std::string& cat,
                                    const std::string& group, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("stockpile_item_list", std::make_tuple(id, cat, group), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

std::string stockpile_settings_snapshot_via_lua(int32_t id, std::string* err) {
    return json_returning_lua_int("stockpile_settings_snapshot", id, err);
}

bool stockpile_toggle_item_via_lua(int32_t id, const std::string& cat,
                                   const std::string& group, int idx, bool on,
                                   std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("stockpile_toggle_item", std::make_tuple(id, cat, group, idx, on), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "toggle failed" : result_err;
    return result_ok;
}

bool stockpile_toggle_all_via_lua(int32_t id, const std::string& cat,
                                  const std::string& group, bool on,
                                  std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("stockpile_toggle_all", std::make_tuple(id, cat, group, on), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "toggle-all failed" : result_err;
    return result_ok;
}

// ---- B231: hauling-stop desired items -------------------------------------------------------
// Thin (route_id, stop_id) twins of the stockpile settings calls above. The Lua they reach
// (dwf.lua: hauling_stop_*) resolves the stop and hands it to the SAME sp_* primitives the
// stockpile editor uses, because df::hauling_stop.settings IS a df::stockpile_settings.
std::string hauling_stop_settings_snapshot_via_lua(int32_t route_id, int32_t stop_id,
                                                   std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hauling_stop_settings_snapshot", std::make_tuple(route_id, stop_id), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1)) json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

std::string hauling_stop_items_via_lua(int32_t route_id, int32_t stop_id, const std::string& cat,
                                       const std::string& group, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hauling_stop_item_list", std::make_tuple(route_id, stop_id, cat, group), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1)) json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

bool hauling_stop_toggle_item_via_lua(int32_t route_id, int32_t stop_id, const std::string& cat,
                                      const std::string& group, int idx, bool on,
                                      std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hauling_stop_toggle_item",
            std::make_tuple(route_id, stop_id, cat, group, idx, on), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1)) result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok) return false;
    if (!result_ok && err) *err = result_err.empty() ? "toggle failed" : result_err;
    return result_ok;
}

bool stockpile_set_preset_via_lua(int32_t id, const std::string& preset,
                                  const std::string& mode, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("stockpile_set_preset", std::make_tuple(id, preset, mode), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1)) result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok) return false;
    if (!result_ok && err) *err = result_err.empty() ? "preset failed" : result_err;
    return result_ok;
}

bool hauling_stop_toggle_all_via_lua(int32_t route_id, int32_t stop_id, const std::string& cat,
                                     const std::string& group, bool on, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hauling_stop_toggle_all",
            std::make_tuple(route_id, stop_id, cat, group, on), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1)) result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok) return false;
    if (!result_ok && err) *err = result_err.empty() ? "toggle-all failed" : result_err;
    return result_ok;
}

bool repair_stockpile_settings_via_lua(int& out_holders, int& out_categories, std::string* err) {
    return run_lua_locked([&]() -> bool {
        return call_lua("repair_incomplete_stockpile_settings", std::make_tuple(), 2,
            [&](lua_State* L) {
                out_holders = static_cast<int>(lua_tointeger(L, -2));
                out_categories = static_cast<int>(lua_tointeger(L, -1));
            }, err);
    });
}

bool hauling_stop_set_preset_via_lua(int32_t route_id, int32_t stop_id, const std::string& preset,
                                     const std::string& mode, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hauling_stop_set_preset",
            std::make_tuple(route_id, stop_id, preset, mode), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1)) result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok) return false;
    if (!result_ok && err) *err = result_err.empty() ? "preset failed" : result_err;
    return result_ok;
}

std::string workshop_info_json_via_lua(int32_t id, std::string* err) {
    return json_returning_lua_int("workshop_info", id, err);
}

bool workshop_add_job_via_lua(int32_t id, const std::string& task, int32_t unit_id, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("workshop_add_job", std::make_tuple(id, task, unit_id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1)) result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok) return false;
    if (!result_ok && err) *err = result_err.empty() ? "add task failed" : result_err;
    return result_ok;
}

bool workshop_job_action_via_lua(int32_t id, int32_t job_id, const std::string& action,
                                 std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("workshop_job_action", std::make_tuple(id, job_id, action), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "workshop job action failed" : result_err;
    return result_ok;
}

bool workshop_worker_action_via_lua(int32_t id, int32_t unit_id, bool assign,
                                    std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("workshop_worker_action", std::make_tuple(id, unit_id, assign), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "worker action failed" : result_err;
    return result_ok;
}

bool workshop_workers_clear_via_lua(int32_t id, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("workshop_workers_clear", std::make_tuple(id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "clear workers failed" : result_err;
    return result_ok;
}

std::string burial_coffin_info_json_via_lua(int32_t id, std::string* err) {
    return json_returning_lua_int("burial_coffin_info", id, err);
}

bool burial_coffin_action_via_lua(int32_t id, const std::string& action, std::string* err) {
    return bool_error_lua_int_string("burial_coffin_action", id, action, err);
}

bool queue_memorial_slab_via_lua(int32_t unit_id, std::string* err) {
    return bool_error_lua_int("queue_memorial_slab", unit_id, err);
}

bool workshop_profile_set_via_lua(int32_t id, const std::string& field, int32_t value,
                                  std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("workshop_profile_set", std::make_tuple(id, field, value), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "profile set failed" : result_err;
    return result_ok;
}

std::string zone_locations_json_via_lua(int32_t zone_id, std::string* err) {
    return json_returning_lua_int("zone_locations_json", zone_id, err);
}

bool zone_location_action_via_lua(int32_t zone_id, const std::string& action,
                                  const std::string& kind, int32_t location_id,
                                  std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("zone_location_action",
            std::make_tuple(zone_id, action, kind, location_id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "zone location action failed" : result_err;
    return result_ok;
}

// B229: location detail + location actions (occupation assignment, temple deity, craft guild).
std::string location_detail_json_via_lua(int32_t location_id, std::string* err) {
    return json_returning_lua_int("location_detail_json", location_id, err);
}

bool location_action_via_lua(int32_t location_id, const std::string& action,
                             const std::string& kind, int32_t unit_id, std::string* err) {
    bool result_ok = false;
    std::string result_err;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("location_action",
            std::make_tuple(location_id, action, kind, unit_id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_err = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_err.empty() ? "location action failed" : result_err;
    return result_ok;
}

std::string order_json_via_lua(const char* function_name, std::string* err) {
    diagnostics_log(std::string("orders endpoint begin: ") + function_name);
    std::string json = json_returning_lua(function_name, err);
    if (json.empty()) {
        diagnostics_log(std::string("orders endpoint failed: ") + function_name +
                        ": " + (err ? *err : ""));
    } else {
        diagnostics_log(std::string("orders endpoint end: ") + function_name +
                        " bytes=" + std::to_string(json.size()));
    }
    return json;
}

std::string order_json_via_lua_str(const char* function_name, const std::string& arg,
                                   std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua(function_name, std::make_tuple(arg), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

bool create_order_via_lua(const std::string& key, int32_t amount,
                          const std::string& frequency, int32_t workshop_id,
                          std::string* msg, std::string* err, std::vector<int32_t>* out_ids) {
    bool result_ok = false;
    std::string result_msg;
    // 3 returns: ok(-3), msg(-2), created-id table(-1). WP-C/WT06 reads the id list to stamp
    // attribution; older callers that pass no out_ids simply ignore the extra return.
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("create_order", std::make_tuple(key, amount, frequency, workshop_id), 3,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -3) != 0;
                if (lua_isstring(L, -2))
                    result_msg = lua_tostring(L, -2);
                if (out_ids && lua_istable(L, -1)) {
                    int n = static_cast<int>(lua_rawlen(L, -1));
                    for (int i = 1; i <= n; ++i) {
                        lua_rawgeti(L, -1, i);
                        if (lua_isnumber(L, -1))
                            out_ids->push_back(static_cast<int32_t>(lua_tointeger(L, -1)));
                        lua_pop(L, 1);
                    }
                }
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok) {
        if (err) *err = result_msg.empty() ? "create order failed" : result_msg;
        return false;
    }
    if (msg) *msg = result_msg;
    return true;
}

bool import_order_preset_via_lua(const std::string& name, std::string* msg,
                                 std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("import_order_preset", std::make_tuple(name), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok) {
        if (err) *err = result_msg.empty() ? "import failed" : result_msg;
        return false;
    }
    if (msg) *msg = result_msg;
    return true;
}

bool cancel_order_via_lua(int32_t id, std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("cancel_order", std::make_tuple(id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "cancel failed" : result_msg;
    return result_ok;
}

bool adjust_order_via_lua(int32_t id, int32_t amount, const std::string& frequency,
                          std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("adjust_order", std::make_tuple(id, amount, frequency), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "adjust failed" : result_msg;
    return result_ok;
}

bool add_item_condition_via_lua(int32_t id, const std::string& compare, int32_t value,
                                const std::string& item, const std::string& material,
                                const std::string& adjective, std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("add_item_condition",
            std::make_tuple(id, compare, value, item, material, adjective), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "add condition failed" : result_msg;
    return result_ok;
}

// B285 wave-2: edit a stock condition IN PLACE. Same shape as add; `index` addresses the entry.
bool edit_item_condition_via_lua(int32_t id, int32_t index, const std::string& compare,
                                 int32_t value, const std::string& item,
                                 const std::string& material, const std::string& adjective,
                                 std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("edit_item_condition",
            std::make_tuple(id, index, compare, value, item, material, adjective), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "edit condition failed" : result_msg;
    return result_ok;
}

bool add_order_condition_via_lua(int32_t id, int32_t other_id, const std::string& type,
                                 std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("add_order_condition", std::make_tuple(id, other_id, type), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "add dependency failed" : result_msg;
    return result_ok;
}

bool remove_condition_via_lua(int32_t id, const std::string& kind, int32_t index,
                              std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("remove_condition", std::make_tuple(id, kind, index), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "remove condition failed" : result_msg;
    return result_ok;
}

bool set_order_max_workshops_via_lua(int32_t id, int32_t max_workshops,
                                     std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("set_order_max_workshops", std::make_tuple(id, max_workshops), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "update failed" : result_msg;
    return result_ok;
}

bool set_order_workshop_via_lua(int32_t id, int32_t workshop_id, std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("set_order_workshop", std::make_tuple(id, workshop_id), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "update failed" : result_msg;
    return result_ok;
}

bool reorder_order_via_lua(int32_t id, int32_t direction, std::string* err) {
    bool result_ok = false;
    std::string result_msg;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("reorder_order", std::make_tuple(id, direction), 2,
            [&](lua_State* L) {
                result_ok = lua_toboolean(L, -2) != 0;
                if (lua_isstring(L, -1))
                    result_msg = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    if (!result_ok && err)
        *err = result_msg.empty() ? "reorder failed" : result_msg;
    return result_ok;
}

// ---- B228 missions: DFHack's own stuck-squad repair --------------------------------------------

bool mission_rescue_stuck_via_lua(int& out_rescued, std::string& out_text, std::string* err) {
    int rescued = 0;
    std::string text;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("missions_rescue_stuck", std::make_tuple(), 2,
            [&](lua_State* L) {
                if (lua_isnumber(L, -2))
                    rescued = static_cast<int>(lua_tointeger(L, -2));
                if (lua_isstring(L, -1))
                    text = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    // rescued < 0 is the lua side reporting a refusal (nothing stuck / nothing returning); the
    // message is in `text` and the caller surfaces it verbatim rather than inventing one.
    if (rescued < 0) {
        if (err) *err = text.empty() ? "stuck-squad rescue refused" : text;
        return false;
    }
    out_rescued = rescued;
    out_text = text;
    diagnostics_log("missions: fix/stuck-squad rescued=" + std::to_string(rescued));
    return true;
}

// ---- WT26 DFHack command console --------------------------------------------------------------

std::string console_catalog_json_via_lua(std::string* err) {
    return json_returning_lua("console_catalog", err);
}

bool console_run_via_lua(const std::string& command, int& out_status, std::string& out_text,
                         std::string* err) {
    // *** THE GATE, RE-APPLIED AT THE BRIDGE. *** console_routes.cpp already refused a blocked
    // command with a 403 before we got here; this second call to the SAME table
    // (dwf::console::command_denied -- there is only one) makes it structurally impossible for
    // any future C++ caller of this bridge to reach dfhack.run_command_silent without the gate. It
    // takes no host/loopback parameter, so the host is bound by it exactly as a friend is.
    console::Denial gate = console::command_denied(command);
    if (gate.denied) {
        if (err) *err = gate.reason;
        diagnostics_log("console: DENIED (bridge backstop) '" + command + "': " + gate.reason);
        return false;
    }

    diagnostics_log("console: run '" + command + "'");
    int status = -1;
    std::string text;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("console_run", std::make_tuple(command), 2,
            [&](lua_State* L) {
                if (lua_isnumber(L, -2))
                    status = static_cast<int>(lua_tointeger(L, -2));
                if (lua_isstring(L, -1))
                    text = lua_tostring(L, -1);
            }, err);
    });
    if (!ok)
        return false;
    out_status = status;
    out_text = text;
    diagnostics_log("console: done '" + command + "' status=" + std::to_string(status) +
                    " bytes=" + std::to_string(text.size()));
    return true;
}

// ---- HOST-WRITES (B226/B227) --------------------------------------------------------------------
// All four entries return the Lua side's self-describing JSON (ok/error/guarded/retry). The
// justice drive is a multi-frame state machine: hw_justice_action returns {"retry":true} whenever
// it needs native frames to run (widget arrange, deferred unit-list builds), so the drive loop
// below releases the core suspension between steps and sleeps a beat. One drive at a time,
// globally -- two players convicting at once through one shared native UI would interleave input.

namespace {
std::mutex g_hostwrites_drive_mutex;

std::string hostwrites_json_string_call(const char* function_name,
                                        std::tuple<std::string, std::string, std::string, std::string> args,
                                        std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua(function_name, std::move(args), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}
} // namespace

std::string trade_state_json_via_lua(std::string* err) {
    return json_returning_lua("hw_trade_state", err);
}

std::string justice_state_json_via_lua(std::string* err) {
    return json_returning_lua("hw_justice_state", err);
}

std::string hostwrites_widgets_json_via_lua(const std::string& root, std::string* err) {
    std::string json;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hw_widget_dump", std::make_tuple(root), 1,
            [&](lua_State* L) {
                if (lua_isstring(L, -1))
                    json = lua_tostring(L, -1);
            }, err);
    });
    return ok ? json : "";
}

bool hostwrite_flag_enabled_via_lua(const std::string& flag, std::string* err) {
    bool enabled = false;
    bool ok = run_lua_locked([&]() -> bool {
        return call_lua("hw_flags", std::make_tuple(), 1,
            [&](lua_State* L) {
                if (!lua_istable(L, -1))
                    return;
                lua_getfield(L, -1, flag.c_str());
                enabled = lua_isboolean(L, -1) && lua_toboolean(L, -1) != 0;
                lua_pop(L, 1);
            }, err);
    });
    return ok && enabled;
}

std::string trade_action_json_via_lua(const std::string& action, const std::string& arg1,
                                      const std::string& arg2, const std::string& arg3,
                                      std::string* err) {
    std::lock_guard<std::mutex> drive_lock(g_hostwrites_drive_mutex);
    diagnostics_log("hostwrites: trade action '" + action + "' a1=" + arg1 + " a2=" + arg2 +
                    " a3=" + arg3);
    std::string json = hostwrites_json_string_call(
        "hw_trade_action", std::make_tuple(action, arg1, arg2, arg3), err);
    if (!json.empty())
        diagnostics_log("hostwrites: trade '" + action + "' -> " + json.substr(0, 200));
    return json;
}

std::string justice_action_json_via_lua(const std::string& action, int32_t crime_id,
                                        int32_t unit_id, std::string* err) {
    std::lock_guard<std::mutex> drive_lock(g_hostwrites_drive_mutex);
    diagnostics_log("hostwrites: justice '" + action + "' crime=" + std::to_string(crime_id) +
                    " unit=" + std::to_string(unit_id));
    // ~40 steps x 150ms = up to ~6s of native frames for the whole drive; each Lua call is one
    // input step at most, and the suspension is dropped between calls so DF renders/arranges.
    static const int kMaxSteps = 40;
    std::string json;
    for (int step = 0; step < kMaxSteps; ++step) {
        bool final = (step == kMaxSteps - 1);
        json.clear();
        bool ok = run_lua_locked([&]() -> bool {
            return call_lua("hw_justice_action",
                std::make_tuple(action, crime_id, unit_id, final ? 1 : 0), 1,
                [&](lua_State* L) {
                    if (lua_isstring(L, -1))
                        json = lua_tostring(L, -1);
                }, err);
        });
        if (!ok)
            return "";
        if (json.find("\"retry\":true") == std::string::npos)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
    }
    diagnostics_log("hostwrites: justice '" + action + "' -> " + json.substr(0, 200));
    return json;
}

} // namespace dwf
