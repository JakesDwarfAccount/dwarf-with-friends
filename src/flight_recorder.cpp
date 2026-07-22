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

#include "flight_recorder.h"
#include "flight_recorder_v3.h"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <future>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <zlib.h>

#include "diagnostics.h"
#include "json_util.h"

#include "Core.h"
#include "DataDefs.h"
#include "VersionInfo.h"
#include "modules/Gui.h"
#include "modules/Units.h"
#include "modules/DFSDL.h"

#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/graphic_viewportst.h"
#include "df/job.h"
#include "df/job_item.h"
#include "df/job_reqst.h"
#include "df/manager_order.h"
#include "df/manager_order_condition_item.h"
#include "df/map_renderer.h"
#include "df/texture_handlerst.h"
#include "df/tile_pagest.h"
#include "df/unit.h"
#include "df/unit_personality.h"
#include "df/unit_soul.h"
#include "df/world.h"

namespace dwf {

namespace {

// ---------------------------------------------------------------------------------------------
// Small self-contained helpers (kept local; websocket.cpp's base64 is in its own TU's anon ns).

const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64(const uint8_t* d, size_t n) {
    std::string out;
    out.reserve(((n + 2) / 3) * 4);
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = uint32_t(d[i]) << 16;
        if (i + 1 < n) v |= uint32_t(d[i + 1]) << 8;
        if (i + 2 < n) v |= uint32_t(d[i + 2]);
        out.push_back(kB64[(v >> 18) & 63]);
        out.push_back(kB64[(v >> 12) & 63]);
        out.push_back(i + 1 < n ? kB64[(v >> 6) & 63] : '=');
        out.push_back(i + 2 < n ? kB64[v & 63] : '=');
    }
    return out;
}

// zlib-deflate a raw buffer. Returns empty on failure (caller then emits the plane raw).
std::vector<uint8_t> deflate_buf(const uint8_t* d, size_t n) {
    uLongf cap = compressBound(static_cast<uLong>(n));
    std::vector<uint8_t> out(cap);
    if (compress2(out.data(), &cap, d, static_cast<uLong>(n), Z_BEST_SPEED) != Z_OK)
        return {};
    out.resize(cap);
    return out;
}

inline uint64_t fnv1a(uint64_t h, const uint8_t* d, size_t n) {
    for (size_t i = 0; i < n; ++i) { h ^= d[i]; h *= 1099511628211ULL; }
    return h;
}

// ---------------------------------------------------------------------------------------------
// One captured plane: a straight byte copy of a DF screen array, tagged for the decoder.

struct Plane {
    const char* name;            // stable id, e.g. "gps.screen", "vp.designation"
    int elem;                    // bytes per cell element (8 for gps.screen, 4 for texpos...)
    std::vector<uint8_t> bytes;  // raw little-endian copy, column-major (idx = x*dim_y + y)
};

struct UnitSlice {               // rich mode: the /statusharvest field set, per visible unit
    int32_t id, x, y, z;
    int32_t hunger, thirst, sleepiness, paralysis, fever;
    int32_t unconscious, stunned, winded, webbed, nausea;
    int32_t longterm_stress, mood, soldier_mood, job;
    uint8_t on_ground, projectile, has_mood;
};

struct ItemFilterSlice {
    int32_t compare_type = -1, compare_val = 0;
    int32_t item_type = -1, item_subtype = -1, mat_type = -1, mat_index = -1;
    uint32_t flags1 = 0, flags2 = 0, flags3 = 0, flags4 = 0, flags5 = 0;
    std::string reaction_class, reaction_product;
    int32_t metal_ore = -1, min_dimension = -1, reaction_id = -1;
    int32_t tool_use = -1, dye_color = -1, quantity = -1, reagent_index = -1;
    std::vector<int32_t> contains;
};

struct WorkOrderSlice {
    bool open = false;
    int32_t id = -1, job_type = -1, item_type = -1, item_subtype = -1;
    int32_t mat_type = -1, mat_index = -1;
    std::vector<ItemFilterSlice> requested_items;
    std::vector<ItemFilterSlice> suggestions;
    std::vector<ItemFilterSlice> existing;
};

struct Record {
    int64_t t_ms = 0;
    int32_t frame = 0;
    uint32_t ui_tick = 0;                    // map_renderer.cur_tick_count (blink phase clock)
    bool gps_top_in_use = false;             // binds the optional seven-plane top UI stack
    bool rich = false;
    int32_t win_x = 0, win_y = 0, win_z = 0;
    int32_t mouse_x = 0, mouse_y = 0;
    int32_t dimx = 0, dimy = 0;              // gps text grid dims
    int32_t vp_dim_x = 0, vp_dim_y = 0;      // viewport dims (when vp planes recorded)
    int32_t map_dim_x = 0, map_dim_y = 0;    // native viewport dims (always, for visibility)
    std::vector<std::string> focus;          // DFHack focus strings = screen identity tag
    std::vector<Plane> planes;
    std::vector<UnitSlice> units;            // rich mode only
    std::vector<int32_t> unit_status_texpos; // rich: live UNIT_STATUS row -> texture id
    WorkOrderSlice work_order;               // rich: native condition-editor state
    uint64_t ui_hash = 0;                    // v3: exact plane hash, serialized as fixed hex
    recorder_v3::State v3;                   // v3: render/core/render-validated bounded slices
};

ItemFilterSlice copy_condition(const df::manager_order_condition_item& c);
ItemFilterSlice copy_job_item(const df::job_item& c);

// ---------------------------------------------------------------------------------------------
// Recorder state. One recorder per plugin instance; /recorder/start while running is a 409.

struct Recorder {
    std::mutex control;                      // guards start/stop transitions
    std::thread worker;
    std::atomic<bool> running{false};
    // config (written under `control` before the worker starts, read-only after)
    bool rich = false;
    bool with_vp = false;
    int hz = 10;
    int state_hz = 0;
    uint64_t max_bytes = 512ULL * 1024ULL * 1024ULL;
    std::string path;
    // counters (relaxed atomics -- status/diagnostics only)
    std::atomic<uint64_t> records{0};
    std::atomic<uint64_t> skips{0};
    std::atomic<uint64_t> misses{0};         // aggregate render + enrichment failures
    std::atomic<uint64_t> render_misses{0};
    std::atomic<uint64_t> enrichment_misses{0};
    std::atomic<uint64_t> bytes_written{0};
    std::atomic<int64_t> last_record_ms{0};
    std::atomic<int32_t> last_frame{0};
    std::atomic<uint64_t> state_only_attempts{0};
    std::atomic<uint64_t> state_only_records{0};
    std::atomic<uint64_t> render_stamp_mismatches{0};
    std::array<std::atomic<uint64_t>, 8> slice_attempts{};
    std::array<std::atomic<uint64_t>, 8> slice_ok{};
    std::array<std::atomic<uint64_t>, 8> slice_busy{};
    std::array<std::atomic<uint64_t>, 8> slice_invalid_identity{};
    std::array<std::atomic<uint64_t>, 8> slice_fault{};
    std::array<std::atomic<uint64_t>, 8> slice_cap_exceeded{};
    std::array<std::atomic<uint64_t>, 8> slice_render_mismatch{};
    std::array<std::atomic<uint64_t>, 8> slice_max_bytes{};
};

Recorder g_rec;

constexpr std::array<const char*, 8> kSliceIds = {
    "route_context.v1", "unit_selected.v1", "stock_item_selected.v1",
    "place_selected.v1", "building_selected.v1", "squad_ui.v1", "world_ui.v1",
    "control_palette.v1",
};

std::array<const recorder_v3::SliceMeta*, 8> slice_metas(const recorder_v3::State& state) {
    return {&state.route.meta, &state.unit.meta, &state.stock_item.meta, &state.place.meta,
            &state.building.meta, &state.squad.meta, &state.world.meta, &state.palette.meta};
}

void count_slice_results(const recorder_v3::State& state) {
    const auto metas = slice_metas(state);
    for (size_t i = 0; i < metas.size(); ++i) {
        const recorder_v3::SliceMeta& meta = *metas[i];
        if (meta.status == recorder_v3::SliceStatus::not_applicable) continue;
        g_rec.slice_attempts[i].fetch_add(1, std::memory_order_relaxed);
        if (meta.status == recorder_v3::SliceStatus::ok)
            g_rec.slice_ok[i].fetch_add(1, std::memory_order_relaxed);
        else if (meta.status == recorder_v3::SliceStatus::busy)
            g_rec.slice_busy[i].fetch_add(1, std::memory_order_relaxed);
        else if (meta.status == recorder_v3::SliceStatus::invalid_identity)
            g_rec.slice_invalid_identity[i].fetch_add(1, std::memory_order_relaxed);
        else if (meta.status == recorder_v3::SliceStatus::fault)
            g_rec.slice_fault[i].fetch_add(1, std::memory_order_relaxed);
        if (meta.reason == "cap_exceeded")
            g_rec.slice_cap_exceeded[i].fetch_add(1, std::memory_order_relaxed);
        if (meta.reason == "render_mismatch")
            g_rec.slice_render_mismatch[i].fetch_add(1, std::memory_order_relaxed);
    }
}

void update_slice_max_bytes(const std::string& json) {
    size_t slice = 0, start = std::string::npos;
    int depth = 0;
    bool quoted = false, escaped = false;
    for (size_t i = 0; i < json.size() && slice < kSliceIds.size(); ++i) {
        const char c = json[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') quoted = false;
            continue;
        }
        if (c == '"') { quoted = true; continue; }
        if (c == '{') {
            if (depth++ == 0) start = i;
        } else if (c == '}' && depth > 0 && --depth == 0 && start != std::string::npos) {
            const uint64_t bytes = i - start + 1;
            uint64_t current = g_rec.slice_max_bytes[slice].load(std::memory_order_relaxed);
            while (current < bytes && !g_rec.slice_max_bytes[slice].compare_exchange_weak(
                       current, bytes, std::memory_order_relaxed)) {}
            ++slice;
            start = std::string::npos;
        }
    }
}

std::filesystem::path path_from_utf8(const std::string& value) {
    return std::filesystem::path(std::u8string(value.begin(), value.end()));
}

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------------------------
// The screen pass runs on DF's render thread. It hashes first and copies only on change, with
// no CoreSuspender and no capture_state_mutex (taking that mutex in a render callback can deadlock
// against capture_camera_frame, whose worker holds it while waiting for the render callback).

struct VpPlane { const char* name; const void* arr; int elem; };

// Stable texture-selection planes for the text/UI grid. `lower` and `anchored` are not
// derivable from screentexpos: DF's renderer composes controls from all of these arrays.
// Keep their names and generated graphic fields together so the hash and copy paths cannot
// silently drift apart.
std::vector<VpPlane> gps_texture_planes(df::graphic* gps, bool top) {
    if (!gps) return {};
    std::vector<VpPlane> planes = {
        {"gps.texpos",            gps->screentexpos,            int(sizeof(long))},
        {"gps.texpos_lower",      gps->screentexpos_lower,      int(sizeof(long))},
        {"gps.texpos_anchored",   gps->screentexpos_anchored,   int(sizeof(long))},
        {"gps.texpos_anchored_x", gps->screentexpos_anchored_x, int(sizeof(long))},
        {"gps.texpos_anchored_y", gps->screentexpos_anchored_y, int(sizeof(long))},
        {"gps.texpos_flag",       gps->screentexpos_flag,       4},
    };
    if (top) {
        planes.insert(planes.end(), {
            {"gps.texpos_top_lower",      gps->screentexpos_top_lower,      int(sizeof(long))},
            {"gps.texpos_top_anchored",   gps->screentexpos_top_anchored,   int(sizeof(long))},
            {"gps.texpos_top",            gps->screentexpos_top,            int(sizeof(long))},
            {"gps.texpos_top_anchored_x", gps->screentexpos_top_anchored_x, int(sizeof(long))},
            {"gps.texpos_top_anchored_y", gps->screentexpos_top_anchored_y, int(sizeof(long))},
            {"gps.texpos_top_flag",       gps->screentexpos_top_flag,       4},
        });
    }
    return planes;
}

std::vector<VpPlane> viewport_planes(df::graphic_viewportst* vp) {
    if (!vp) return {};
    return {
        {"vp.background",       vp->screentexpos_background,       4},
        {"vp.floor_flag",       vp->screentexpos_floor_flag,       8},
        {"vp.background_two",   vp->screentexpos_background_two,   4},
        {"vp.liquid_flag",      vp->screentexpos_liquid_flag,      4},
        {"vp.spatter_flag",     vp->screentexpos_spatter_flag,     4},
        {"vp.spatter",          vp->screentexpos_spatter,          4},
        {"vp.ramp_flag",        vp->screentexpos_ramp_flag,        8},
        {"vp.shadow_flag",      vp->screentexpos_shadow_flag,      4},
        {"vp.building_one",     vp->screentexpos_building_one,     4},
        {"vp.item",             vp->screentexpos_item,             4},
        {"vp.vehicle",          vp->screentexpos_vehicle,          4},
        {"vp.vermin",           vp->screentexpos_vermin,           4},
        {"vp.left_creature",    vp->screentexpos_left_creature,    4},
        {"vp.creature",         vp->screentexpos,                  4},
        {"vp.right_creature",   vp->screentexpos_right_creature,   4},
        {"vp.building_two",     vp->screentexpos_building_two,     4},
        {"vp.projectile",       vp->screentexpos_projectile,       4},
        {"vp.high_flow",        vp->screentexpos_high_flow,        4},
        {"vp.top_shadow",       vp->screentexpos_top_shadow,       4},
        {"vp.signpost",         vp->screentexpos_signpost,         4},
        {"vp.designation",      vp->screentexpos_designation,      4},
        {"vp.interface",        vp->screentexpos_interface,        4},
        {"vp.upleft_creature",  vp->screentexpos_upleft_creature,  4},
        {"vp.up_creature",      vp->screentexpos_up_creature,      4},
        {"vp.upright_creature", vp->screentexpos_upright_creature, 4},
        {"vp.tree_plus_one",    vp->core_tree_species_plus_one,    2},
    };
}

void hash_plane(uint64_t& h, const void* arr, size_t bytes) {
    const uint8_t present = arr ? 1 : 0;
    h = fnv1a(h, &present, 1);
    if (arr) h = fnv1a(h, reinterpret_cast<const uint8_t*>(arr), bytes);
}

bool sample_screen(uint64_t previous_hash, uint64_t previous_route_stamp, bool force_state,
                   bool rich, bool with_vp, Record& out, uint64_t& out_hash,
                   uint64_t& out_route_stamp, bool& out_changed, bool& out_state_only) {
    df::graphic* gps = df::global::gps;
    df::world* world = df::global::world;
    if (!gps || !world || !gps->screen) return false;

    const int dimx = gps->dimx, dimy = gps->dimy;
    if (dimx <= 0 || dimy <= 0) return false;
    const size_t cells = size_t(dimx) * size_t(dimy);
    df::graphic_viewportst* vp = gps->main_viewport;
    const bool valid_vp = vp && vp->dim_x > 0 && vp->dim_y > 0;
    const size_t vp_cells = valid_vp ? size_t(vp->dim_x) * size_t(vp->dim_y) : 0;
    std::vector<VpPlane> vp_planes = with_vp && valid_vp ? viewport_planes(vp)
                                                         : std::vector<VpPlane>{};
    const uint8_t top = gps->top_in_use ? 1 : 0;
    std::vector<VpPlane> gps_tex_planes = gps_texture_planes(gps, top != 0);
    if (top && !gps->screen_top) return false;
    for (const VpPlane& p : gps_tex_planes)
        if (!p.arr) return false;

    uint64_t h = 1469598103934665603ULL;
    h = fnv1a(h, reinterpret_cast<const uint8_t*>(&dimx), sizeof(dimx));
    h = fnv1a(h, reinterpret_cast<const uint8_t*>(&dimy), sizeof(dimy));
    hash_plane(h, gps->screen, cells * 8);
    for (const VpPlane& p : gps_tex_planes) hash_plane(h, p.arr, cells * p.elem);
    h = fnv1a(h, &top, 1);
    if (top) {
        hash_plane(h, gps->screen_top, cells * 8);
    }
    if (with_vp) {
        const int vp_x = valid_vp ? vp->dim_x : 0;
        const int vp_y = valid_vp ? vp->dim_y : 0;
        h = fnv1a(h, reinterpret_cast<const uint8_t*>(&vp_x), sizeof(vp_x));
        h = fnv1a(h, reinterpret_cast<const uint8_t*>(&vp_y), sizeof(vp_y));
        for (const VpPlane& p : vp_planes) hash_plane(h, p.arr, vp_cells * p.elem);
    }

    out_hash = h;
    out_route_stamp = previous_route_stamp;
    if (rich) {
        out.focus = DFHack::Gui::getCurFocus(true);
        out.ui_hash = h;
        recorder_v3::capture_render(out.v3, out.focus, h, dimx, dimy, top);
        out_route_stamp = out.v3.route.route_stamp;
    }
    const bool ui_or_route_changed = h != previous_hash ||
        (rich && out_route_stamp != previous_route_stamp);
    out_state_only = rich && !ui_or_route_changed && force_state &&
        recorder_v3::has_applicable_slice(out.v3);
    out_changed = ui_or_route_changed || out_state_only;
    if (!out_changed) return true;

    out.t_ms = now_ms();
    out.rich = rich;
    out.frame = world->frame_counter;
    out.ui_tick = df::global::map_renderer ? df::global::map_renderer->cur_tick_count : 0;
    out.gps_top_in_use = top != 0;
    out.dimx = dimx;
    out.dimy = dimy;
    out.win_x = df::global::window_x ? *df::global::window_x : -1;
    out.win_y = df::global::window_y ? *df::global::window_y : -1;
    out.win_z = df::global::window_z ? *df::global::window_z : -1;
    out.mouse_x = gps->mouse_x;
    out.mouse_y = gps->mouse_y;
    if (valid_vp) {
        out.map_dim_x = vp->dim_x;
        out.map_dim_y = vp->dim_y;
    }
    if (!rich) out.focus = DFHack::Gui::getCurFocus(true);
    if (rich) {
        if (df::texture_handlerst* tex = df::global::texture) {
            for (df::tile_pagest* page : tex->page) {
                if (!page || page->token != "UNIT_STATUS") continue;
                out.unit_status_texpos.assign(page->texpos.begin(), page->texpos.end());
                break;
            }
        }
        // The condition editor and its suggestion vector are render-owned UI state. Copy them
        // here, while the render callback owns that thread. The worker later resolves the stable
        // order id under ConditionalCoreSuspender and copies only simulation-owned order data.
        // Splitting ownership this way avoids the impossible "park render, then suspend core"
        // handshake: DF's simulation thread can be waiting for render before it yields the core.
        if (df::gamest* game = df::global::game) {
            auto& conditions = game->main_interface.info.work_orders.conditions;
            if (conditions.open && conditions.wq) {
                WorkOrderSlice& w = out.work_order;
                w.open = true;
                w.id = conditions.wq->id;
                // df-structures 80a6267 declares this as vector<T>, but DF 0.53.15 stores
                // vector<T*>. Native construction and rendering both use pointer elements. Keep
                // this compatibility view local until the authoritative XML correction lands.
                // Copy the three-pointer vector representation instead of type-punning two
                // vector specializations, which violates GCC's strict-aliasing rules.
                struct SuggestionPtrRange {
                    df::manager_order_condition_item** begin;
                    df::manager_order_condition_item** end;
                    df::manager_order_condition_item** capacity;
                } suggestions{};
                static_assert(sizeof(conditions.suggested_item_condition) ==
                                  sizeof(suggestions),
                              "unexpected release vector layout");
                std::memcpy(&suggestions, &conditions.suggested_item_condition,
                            sizeof(suggestions));
                for (auto it = suggestions.begin; it != suggestions.end; ++it) {
                    const df::manager_order_condition_item* c = *it;
                    if (c) w.suggestions.push_back(copy_condition(*c));
                }
            }
        }
    }

    auto copy_plane = [&](const char* name, const void* arr, int elem, size_t n_cells) {
        if (!arr) return;
        Plane p;
        p.name = name;
        p.elem = elem;
        p.bytes.assign(reinterpret_cast<const uint8_t*>(arr),
                       reinterpret_cast<const uint8_t*>(arr) + n_cells * elem);
        out.planes.push_back(std::move(p));
    };
    copy_plane("gps.screen", gps->screen, 8, cells);
    for (const VpPlane& p : gps_tex_planes) copy_plane(p.name, p.arr, p.elem, cells);
    if (top) {
        copy_plane("gps.screen_top", gps->screen_top, 8, cells);
    }
    if (!vp_planes.empty()) {
        out.vp_dim_x = vp->dim_x;
        out.vp_dim_y = vp->dim_y;
        for (const VpPlane& p : vp_planes) copy_plane(p.name, p.arr, p.elem, vp_cells);
    }
    return true;
}

// The render grid can be resized while a request is queued. Keep the SEH frame free of
// unwindable locals and convert any stale-array access into a missed tick, never a DF crash.
bool sample_screen_seh(uint64_t previous_hash, uint64_t previous_route_stamp, bool force_state,
                       bool rich, bool with_vp, Record& out, uint64_t& out_hash,
                       uint64_t& out_route_stamp, bool& out_changed, bool& out_state_only) {
#ifdef _WIN32
    __try {
#endif
        return sample_screen(previous_hash, previous_route_stamp, force_state, rich, with_vp, out,
                             out_hash, out_route_stamp, out_changed, out_state_only);
#ifdef _WIN32
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
#endif
}

struct ScreenRequest {
    std::promise<void> done;
    uint64_t previous_hash = 0, previous_route_stamp = 0, hash = 0, route_stamp = 0;
    std::atomic<bool> cancelled{false};
    bool force_state = false, rich = false, with_vp = false, ok = false, changed = false;
    bool state_only = false;
    Record record;
};

bool sample_screen_on_render_thread(uint64_t previous_hash, uint64_t previous_route_stamp,
                                    bool force_state, bool rich, bool with_vp, Record& out,
                                    uint64_t& out_hash, uint64_t& out_route_stamp,
                                    bool& out_changed, bool& out_state_only) {
    auto request = std::make_shared<ScreenRequest>();
    request->previous_hash = previous_hash;
    request->previous_route_stamp = previous_route_stamp;
    request->force_state = force_state;
    request->rich = rich;
    request->with_vp = with_vp;
    auto future = request->done.get_future();
    DFHack::runOnRenderThread([request]() {
        if (request->cancelled.load(std::memory_order_acquire)) return;
        try {
            request->ok = sample_screen_seh(
                request->previous_hash, request->previous_route_stamp, request->force_state,
                request->rich, request->with_vp, request->record, request->hash,
                request->route_stamp, request->changed, request->state_only);
        } catch (...) {
            request->ok = false;
        }
        request->done.set_value();
    });
    if (future.wait_for(std::chrono::milliseconds(1500)) != std::future_status::ready) {
        request->cancelled.store(true, std::memory_order_release);
        return false;
    }
    future.get();
    if (!request->ok) return false;
    out_hash = request->hash;
    out_route_stamp = request->route_stamp;
    out_changed = request->changed;
    out_state_only = request->state_only;
    out = std::move(request->record);
    return true;
}

// Render validation is scheduled only after ConditionalCoreSuspender has been destroyed. Reusing
// the hash-gated sampler with the candidate stamps avoids a second grid copy: an exact match returns
// after recomputing the hashes and fixed-size v3 route scalars.
bool validate_rich_record_on_render_thread(const Record& candidate, bool with_vp) {
    Record validation;
    uint64_t ui_hash = candidate.ui_hash;
    uint64_t route_stamp = candidate.v3.route.route_stamp;
    bool changed = false, state_only = false;
    if (!sample_screen_on_render_thread(candidate.ui_hash, candidate.v3.route.route_stamp, false,
                                        true, with_vp, validation, ui_hash, route_stamp,
                                        changed, state_only))
        return false;
    return !changed && !state_only && ui_hash == candidate.ui_hash &&
           route_stamp == candidate.v3.route.route_stamp &&
           recorder_v3::route_equal(candidate.v3, validation.v3);
}

ItemFilterSlice copy_condition(const df::manager_order_condition_item& c) {
    ItemFilterSlice s;
    s.compare_type = static_cast<int32_t>(c.compare_type); s.compare_val = c.compare_val;
    s.item_type = static_cast<int32_t>(c.item_type); s.item_subtype = c.item_subtype;
    s.mat_type = c.mat_type; s.mat_index = c.mat_index;
    s.flags1 = c.flags1.whole; s.flags2 = c.flags2.whole; s.flags3 = c.flags3.whole;
    s.flags4 = c.flags4; s.flags5 = c.flags5;
    s.reaction_class = c.reaction_class;
    s.reaction_product = c.has_material_reaction_product;
    s.metal_ore = c.metal_ore; s.min_dimension = c.min_dimension;
    s.contains = c.contains; s.reaction_id = c.reaction_id;
    s.tool_use = static_cast<int32_t>(c.has_tool_use); s.dye_color = c.dye_color;
    return s;
}

ItemFilterSlice copy_job_item(const df::job_item& c) {
    ItemFilterSlice s;
    s.item_type = static_cast<int32_t>(c.item_type); s.item_subtype = c.item_subtype;
    s.mat_type = c.mat_type; s.mat_index = c.mat_index;
    s.flags1 = c.flags1.whole; s.flags2 = c.flags2.whole; s.flags3 = c.flags3.whole;
    s.flags4 = c.flags4; s.flags5 = c.flags5;
    s.reaction_class = c.reaction_class;
    s.reaction_product = c.has_material_reaction_product;
    s.metal_ore = c.metal_ore; s.min_dimension = c.min_dimension;
    s.contains = c.contains; s.reaction_id = c.reaction_id;
    s.tool_use = static_cast<int32_t>(c.has_tool_use); s.dye_color = c.dye_color;
    s.quantity = c.quantity; s.reagent_index = c.reagent_index;
    return s;
}

bool enrich_rich_record(Record& out) {
    const bool v3_ok = recorder_v3::enrich_core(out.v3);
    df::world* world = df::global::world;
    if (world && out.map_dim_x > 0 && out.map_dim_y > 0) {
        for (df::unit* u : world->units.active) {
            if (!u || !DFHack::Units::isAlive(u) || u->pos.z != out.win_z) continue;
            if (u->pos.x < out.win_x || u->pos.x >= out.win_x + out.map_dim_x ||
                u->pos.y < out.win_y || u->pos.y >= out.win_y + out.map_dim_y + 1)
                continue;
            UnitSlice s{};
            s.id = u->id;
            s.x = u->pos.x; s.y = u->pos.y; s.z = u->pos.z;
            s.hunger = u->counters2.hunger_timer;
            s.thirst = u->counters2.thirst_timer;
            s.sleepiness = u->counters2.sleepiness_timer;
            s.paralysis = u->counters2.paralysis;
            s.fever = u->counters2.fever;
            s.unconscious = u->counters.unconscious;
            s.stunned = u->counters.stunned;
            s.winded = u->counters.winded;
            s.webbed = u->counters.webbed;
            s.nausea = u->counters.nausea;
            s.longterm_stress = u->status.current_soul
                                    ? u->status.current_soul->personality.longterm_stress : 0;
            s.mood = static_cast<int32_t>(u->mood);
            s.soldier_mood = static_cast<int32_t>(u->counters.soldier_mood);
            s.job = u->job.current_job ? static_cast<int32_t>(u->job.current_job->job_type) : -1;
            s.on_ground = u->flags1.bits.on_ground ? 1 : 0;
            s.projectile = u->flags1.bits.projectile ? 1 : 0;
            s.has_mood = u->flags1.bits.has_mood ? 1 : 0;
            out.units.push_back(s);
        }
    }

    if (!world || !out.work_order.open) return v3_ok;
    df::manager_order* order = nullptr;
    for (df::manager_order* candidate : world->manager_orders.all) {
        if (candidate && candidate->id == out.work_order.id) {
            order = candidate;
            break;
        }
    }
    if (!order) {
        out.work_order = WorkOrderSlice{};
        return v3_ok;
    }
    WorkOrderSlice& w = out.work_order;
    w.id = order->id; w.job_type = static_cast<int32_t>(order->job_type);
    w.item_type = static_cast<int32_t>(order->item_type); w.item_subtype = order->item_subtype;
    w.mat_type = order->mat_type; w.mat_index = order->mat_index;
    if (order->items) {
        for (df::job_item* item : order->items->elements)
            if (item) w.requested_items.push_back(copy_job_item(*item));
    }
    for (df::manager_order_condition_item* c : order->item_conditions)
        if (c) w.existing.push_back(copy_condition(*c));
    return v3_ok;
}

bool enrich_rich_record_seh(Record& out) {
#ifdef _WIN32
    __try {
#endif
        return enrich_rich_record(out);
#ifdef _WIN32
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
#endif
}

// The render callback has completed before this function runs. It already copied render-owned
// focus, texture, and condition-suggestion state. Acquire the core only for the short copy of
// simulation-owned unit and manager-order vectors. Never wait on a render callback while holding
// this suspender (the tile-dump deadlock law), and retry on the next changed-frame tick if busy.
bool suspended_enrich_rich_record(Record& out) {
    DFHack::ConditionalCoreSuspender suspend;
    if (!suspend) {
        recorder_v3::mark_core_busy(out.v3);
        return false;
    }
    if (enrich_rich_record_seh(out)) return true;
    recorder_v3::mark_core_fault(out.v3);
    return false;
}

// Serialize a record to one JSONL line. Runs OUTSIDE all locks.
void serialize_filter(std::ostringstream& o, const ItemFilterSlice& s) {
    o << "{\"compare_type\":" << s.compare_type << ",\"compare_val\":" << s.compare_val
      << ",\"item_type\":" << s.item_type << ",\"item_subtype\":" << s.item_subtype
      << ",\"mat_type\":" << s.mat_type << ",\"mat_index\":" << s.mat_index
      << ",\"flags1\":" << s.flags1 << ",\"flags2\":" << s.flags2
      << ",\"flags3\":" << s.flags3 << ",\"flags4\":" << s.flags4
      << ",\"flags5\":" << s.flags5
      << ",\"reaction_class\":" << json_string(s.reaction_class)
      << ",\"reaction_product\":" << json_string(s.reaction_product)
      << ",\"metal_ore\":" << s.metal_ore << ",\"min_dimension\":" << s.min_dimension
      << ",\"contains\":[";
    for (size_t i = 0; i < s.contains.size(); ++i) {
        if (i) o << ',';
        o << s.contains[i];
    }
    o << "],\"reaction_id\":" << s.reaction_id << ",\"tool_use\":" << s.tool_use
      << ",\"dye_color\":" << s.dye_color;
    if (s.quantity >= 0) o << ",\"quantity\":" << s.quantity;
    if (s.reagent_index >= 0) o << ",\"reagent_index\":" << s.reagent_index;
    o << '}';
}

std::string serialize(const Record& r) {
    std::ostringstream o;
    o << "{\"v\":3,\"t_ms\":" << r.t_ms << ",\"frame\":" << r.frame
      << ",\"ui_tick\":" << r.ui_tick
      << ",\"gps_top_in_use\":" << (r.gps_top_in_use ? "true" : "false")
      << ",\"focus\":[";
    for (size_t i = 0; i < r.focus.size(); ++i) {
        if (i) o << ',';
        o << json_string(r.focus[i]);
    }
    o << "],\"window\":{\"x\":" << r.win_x << ",\"y\":" << r.win_y << ",\"z\":" << r.win_z << "}"
      << ",\"mouse\":{\"x\":" << r.mouse_x << ",\"y\":" << r.mouse_y << "}"
      << ",\"dims\":{\"x\":" << r.dimx << ",\"y\":" << r.dimy << "}";
    if (r.map_dim_x > 0)
        o << ",\"map_dims\":{\"x\":" << r.map_dim_x << ",\"y\":" << r.map_dim_y << "}";
    if (r.vp_dim_x > 0)
        o << ",\"vp_dims\":{\"x\":" << r.vp_dim_x << ",\"y\":" << r.vp_dim_y << "}";
    o << ",\"planes\":[";
    for (size_t i = 0; i < r.planes.size(); ++i) {
        const Plane& p = r.planes[i];
        if (i) o << ',';
        std::vector<uint8_t> z = deflate_buf(p.bytes.data(), p.bytes.size());
        o << "{\"name\":\"" << p.name << "\",\"elem\":" << p.elem
          << ",\"raw_len\":" << p.bytes.size();
        if (!z.empty())
            o << ",\"zb64\":\"" << base64(z.data(), z.size()) << "\"}";
        else   // deflate failed (shouldn't happen); ship raw so the record is never silently lossy
            o << ",\"b64\":\"" << base64(p.bytes.data(), p.bytes.size()) << "\"}";
    }
    o << "]";
    if (r.rich) {
        o << ",\"ui_hash\":" << json_string(recorder_v3::uint64_hex(r.ui_hash))
          << ",\"route_stamp\":" << json_string(recorder_v3::uint64_hex(r.v3.route.route_stamp))
          << ",\"slices\":" << recorder_v3::serialize_slices(r.v3);
    }
    if (!r.units.empty()) {
        o << ",\"units\":[";
        for (size_t i = 0; i < r.units.size(); ++i) {
            const UnitSlice& s = r.units[i];
            if (i) o << ',';
            o << "{\"id\":" << s.id << ",\"x\":" << s.x << ",\"y\":" << s.y << ",\"z\":" << s.z
              << ",\"hunger_timer\":" << s.hunger << ",\"thirst_timer\":" << s.thirst
              << ",\"sleepiness_timer\":" << s.sleepiness << ",\"paralysis\":" << s.paralysis
              << ",\"fever\":" << s.fever << ",\"unconscious\":" << s.unconscious
              << ",\"stunned\":" << s.stunned << ",\"winded\":" << s.winded
              << ",\"webbed\":" << s.webbed << ",\"nausea\":" << s.nausea
              << ",\"longterm_stress\":" << s.longterm_stress << ",\"mood\":" << s.mood
              << ",\"soldier_mood\":" << s.soldier_mood << ",\"job\":" << s.job
              << ",\"on_ground\":" << int(s.on_ground) << ",\"projectile\":" << int(s.projectile)
              << ",\"has_mood\":" << int(s.has_mood) << "}";
        }
        o << "]";
    }
    if (!r.unit_status_texpos.empty()) {
        o << ",\"unit_status_texpos\":[";
        for (size_t i = 0; i < r.unit_status_texpos.size(); ++i) {
            if (i) o << ',';
            o << r.unit_status_texpos[i];
        }
        o << ']';
    }
    if (r.work_order.open) {
        const WorkOrderSlice& w = r.work_order;
        o << ",\"work_order\":{\"open\":true,\"id\":" << w.id
          << ",\"job_type\":" << w.job_type << ",\"item_type\":" << w.item_type
          << ",\"item_subtype\":" << w.item_subtype << ",\"mat_type\":" << w.mat_type
          << ",\"mat_index\":" << w.mat_index;
        auto emit_filters = [&](const char* name, const std::vector<ItemFilterSlice>& filters) {
            o << ",\"" << name << "\":[";
            for (size_t i = 0; i < filters.size(); ++i) {
                if (i) o << ',';
                serialize_filter(o, filters[i]);
            }
            o << ']';
        };
        emit_filters("requested_items", w.requested_items);
        emit_filters("suggestions", w.suggestions);
        emit_filters("existing", w.existing);
        o << '}';
    }
    o << "}\n";
    return o.str();
}

void capture_loop(std::string path, bool rich, bool with_vp, int hz, int state_hz,
                  uint64_t max_bytes) {
    diagnostics_log("THREAD-ENTER flight-recorder: " + path);
    std::ofstream out(path_from_utf8(path), std::ios::binary);
    if (!out.is_open()) {
        diagnostics_log("flight-recorder: FAILED to open " + path + " -- recorder stopping");
        g_rec.running.store(false);
        return;
    }

    DFHack::Core& core = DFHack::Core::getInstance();
    const std::string df_version = core.vinfo ? core.vinfo->getVersion() : "unknown";
    const std::string manifest =
        std::string("{\"v\":3,\"kind\":\"manifest\",\"format\":\"dwf-flight-recorder-jsonl\"") +
        ",\"build\":" + json_string(DFCAPTURE_GIT_HASH) +
        ",\"df_version\":" + json_string(df_version) +
        ",\"started_ms\":" + std::to_string(now_ms()) +
        ",\"mode\":\"" + (rich ? "rich" : "cheap") + "\"" +
        ",\"vp\":" + (with_vp ? "true" : "false") +
        ",\"hz\":" + std::to_string(hz) +
        ",\"executable_sha256\":" + json_string(recorder_v3::kExecutableSha256) +
        ",\"df_structures_commit\":" + json_string(recorder_v3::kDfStructuresCommit) +
        ",\"slice_plan_id\":" + json_string(recorder_v3::kSlicePlanId) +
        ",\"enabled_slices\":" + (rich ? recorder_v3::enabled_slices_json() : "[]") +
        ",\"state_hz\":" + std::to_string(state_hz) + "}\n";
    out.write(manifest.data(), static_cast<std::streamsize>(manifest.size()));
    out.flush();
    if (!out.good()) {
        diagnostics_log("flight-recorder: FAILED to write manifest -- recorder stopping");
        g_rec.running.store(false);
        return;
    }
    g_rec.bytes_written.store(manifest.size(), std::memory_order_relaxed);

    // Deadline pacing, same shape as ws_push_loop: constant period, snap forward if behind.
    const auto interval = std::chrono::milliseconds(1000 / std::max(1, hz));
    auto next_deadline = std::chrono::steady_clock::now();
    uint64_t hash = 0, route_stamp = 0;
    auto next_state_deadline = std::chrono::steady_clock::now();

    while (g_rec.running.load()) {
        next_deadline += interval;
        auto now0 = std::chrono::steady_clock::now();
        if (next_deadline < now0) next_deadline = now0;
        std::this_thread::sleep_until(next_deadline);
        if (!g_rec.running.load()) break;

        Record rec;
        bool changed = false;
        bool state_only = false;
        uint64_t next_hash = hash, next_route_stamp = route_stamp;
        const auto sample_time = std::chrono::steady_clock::now();
        const bool force_state = rich && state_hz > 0 && sample_time >= next_state_deadline;
        if (force_state)
            next_state_deadline = sample_time + std::chrono::milliseconds(1000 / state_hz);
        bool ok = sample_screen_on_render_thread(hash, route_stamp, force_state, rich, with_vp,
                                                 rec, next_hash, next_route_stamp, changed,
                                                 state_only);

        if (!ok) {
            g_rec.misses.fetch_add(1, std::memory_order_relaxed);
            g_rec.render_misses.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        if (!changed) { g_rec.skips.fetch_add(1, std::memory_order_relaxed); continue; }
        if (state_only) g_rec.state_only_attempts.fetch_add(1, std::memory_order_relaxed);

        // Screen + UI-owned focus/texture/suggestion metadata were copied together on render.
        // Cheap mode needs no suspension. Rich mode then briefly suspends simulation to copy only
        // unit and manager-order vectors; it never parks or waits on render while core-suspended.
        const bool enriched = !rich || suspended_enrich_rich_record(rec);
        if (!enriched) {
            // Keep the old stamps so an unchanged next tick retries. The v3 frame is still useful:
            // its explicit busy/fault envelope is a queryable evidence gap, never an inferred join.
            g_rec.misses.fetch_add(1, std::memory_order_relaxed);
            g_rec.enrichment_misses.fetch_add(1, std::memory_order_relaxed);
        }
        bool render_valid = true;
        if (rich) {
            render_valid = validate_rich_record_on_render_thread(rec, with_vp);
            if (!render_valid) {
                recorder_v3::mark_render_mismatch(rec.v3);
                g_rec.misses.fetch_add(1, std::memory_order_relaxed);
                g_rec.render_misses.fetch_add(1, std::memory_order_relaxed);
                g_rec.render_stamp_mismatches.fetch_add(1, std::memory_order_relaxed);
            }
        }
        if (enriched && render_valid) {
            hash = next_hash;
            route_stamp = next_route_stamp;
        }
        if (rich) {
            count_slice_results(rec.v3);
            update_slice_max_bytes(recorder_v3::serialize_slices(rec.v3));
        }

        std::string line = serialize(rec);
        const uint64_t written = g_rec.bytes_written.load(std::memory_order_relaxed);
        if (line.size() > max_bytes - std::min(max_bytes, written)) {
            diagnostics_log("flight-recorder: session size limit reached at " +
                            std::to_string(written) + " bytes; recorder stopping");
            g_rec.running.store(false);
            break;
        }
        out.write(line.data(), static_cast<std::streamsize>(line.size()));
        out.flush();   // corpus survives a DF crash -- that's half the point of a flight recorder
        if (!out.good()) {
            diagnostics_log("flight-recorder: write/flush FAILED -- recorder stopping");
            g_rec.running.store(false);
            break;
        }
        g_rec.records.fetch_add(1, std::memory_order_relaxed);
        g_rec.bytes_written.fetch_add(line.size(), std::memory_order_relaxed);
        g_rec.last_record_ms.store(rec.t_ms, std::memory_order_relaxed);
        g_rec.last_frame.store(rec.frame, std::memory_order_relaxed);
        if (state_only) g_rec.state_only_records.fetch_add(1, std::memory_order_relaxed);
    }
    out.close();
    diagnostics_log("flight-recorder: stopped, records=" + std::to_string(g_rec.records.load()) +
                    " skips=" + std::to_string(g_rec.skips.load()) +
                    " bytes=" + std::to_string(g_rec.bytes_written.load()));
    diagnostics_log("THREAD-EXIT flight-recorder");
}

std::string status_json() {
    std::ostringstream o;
    o << "{\"running\":" << (g_rec.running.load() ? "true" : "false")
      << ",\"mode\":\"" << (g_rec.rich ? "rich" : "cheap") << "\""
      << ",\"vp\":" << (g_rec.with_vp ? "true" : "false")
      << ",\"hz\":" << g_rec.hz
      << ",\"state_hz\":" << g_rec.state_hz
      << ",\"max_bytes\":" << g_rec.max_bytes
      << ",\"file\":" << json_string(g_rec.path)
      << ",\"records\":" << g_rec.records.load()
      << ",\"skips\":" << g_rec.skips.load()
      << ",\"misses\":" << g_rec.misses.load()
      << ",\"render_misses\":" << g_rec.render_misses.load()
      << ",\"enrichment_misses\":" << g_rec.enrichment_misses.load()
      << ",\"bytes_written\":" << g_rec.bytes_written.load()
      << ",\"last_record_ms\":" << g_rec.last_record_ms.load()
      << ",\"last_frame\":" << g_rec.last_frame.load()
      << ",\"state_only_attempts\":" << g_rec.state_only_attempts.load()
      << ",\"state_only_records\":" << g_rec.state_only_records.load()
      << ",\"render_stamp_mismatches\":" << g_rec.render_stamp_mismatches.load()
      << ",\"slice_counters\":{";
    for (size_t i = 0; i < kSliceIds.size(); ++i) {
        if (i) o << ',';
        o << json_string(kSliceIds[i]) << ":{\"attempts\":" << g_rec.slice_attempts[i].load()
          << ",\"ok\":" << g_rec.slice_ok[i].load()
          << ",\"busy\":" << g_rec.slice_busy[i].load()
          << ",\"invalid_identity\":" << g_rec.slice_invalid_identity[i].load()
          << ",\"fault\":" << g_rec.slice_fault[i].load()
          << ",\"cap_exceeded\":" << g_rec.slice_cap_exceeded[i].load()
          << ",\"render_mismatch\":" << g_rec.slice_render_mismatch[i].load()
          << ",\"max_serialized_bytes\":" << g_rec.slice_max_bytes[i].load() << '}';
    }
    o << "}}";
    return o.str();
}

} // namespace

void stop_flight_recorder() {
    std::lock_guard<std::mutex> lock(g_rec.control);
    if (!g_rec.running.load() && !g_rec.worker.joinable()) return;
    g_rec.running.store(false);
    if (g_rec.worker.joinable()) g_rec.worker.join();
}

void register_flight_recorder_routes(httplib::Server& server) {
    server.Get("/recorder/start", [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        std::lock_guard<std::mutex> lock(g_rec.control);
        if (g_rec.running.load()) {
            res.status = 409;
            res.set_content("{\"ok\":false,\"err\":\"already running\"}", "application/json");
            return;
        }
        if (g_rec.worker.joinable()) g_rec.worker.join();   // reap a finished previous session

        g_rec.rich = (req.get_param_value("mode") == "rich");
        g_rec.with_vp = (req.get_param_value("vp") == "1");
        int hz = 10;
        if (req.has_param("hz")) {
            try { hz = std::stoi(req.get_param_value("hz")); } catch (...) {}
        }
        g_rec.hz = std::min(30, std::max(1, hz));   // 30 Hz cap: never sample above render rate
        int state_hz = 0;
        bool state_hz_valid = true;
        if (req.has_param("state_hz")) {
            try { state_hz = std::stoi(req.get_param_value("state_hz")); }
            catch (...) { state_hz_valid = false; }
        }
        const bool qualification = req.get_param_value("qualification") == "1";
        if (!state_hz_valid || state_hz < 0 || state_hz > 2 ||
            (state_hz > 0 && (!g_rec.rich || !qualification))) {
            res.status = 400;
            res.set_content(
                "{\"ok\":false,\"err\":\"state_hz must be 0, or 1..2 in rich qualification mode\"}",
                "application/json");
            return;
        }
        g_rec.state_hz = state_hz;
        int max_mb = 512;
        if (req.has_param("max_mb")) {
            try { max_mb = std::stoi(req.get_param_value("max_mb")); } catch (...) {}
        }
        max_mb = std::min(4096, std::max(1, max_mb));
        g_rec.max_bytes = uint64_t(max_mb) * 1024ULL * 1024ULL;

        std::string dir = req.has_param("dir") ? req.get_param_value("dir")
                                               : std::string("dfcapture-recordings");
        std::error_code ec;
        std::filesystem::create_directories(path_from_utf8(dir), ec);
        if (ec) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"err\":\"cannot create dir: " + json_escape(dir) +
                            "\"}", "application/json");
            return;
        }
        char stamp[32];
        const int64_t started_ms = now_ms();
        std::time_t t = static_cast<std::time_t>(started_ms / 1000);
        std::tm tmv{};
#ifdef _WIN32
        localtime_s(&tmv, &t);
#else
        localtime_r(&t, &tmv);
#endif
        std::strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", &tmv);
        g_rec.path = dir + "/dwf-rec-" + stamp + "-" + std::to_string(started_ms % 1000) +
                     (g_rec.rich ? "-rich" : "-cheap") + ".jsonl";

        g_rec.records.store(0); g_rec.skips.store(0); g_rec.misses.store(0);
        g_rec.render_misses.store(0); g_rec.enrichment_misses.store(0);
        g_rec.bytes_written.store(0); g_rec.last_record_ms.store(0); g_rec.last_frame.store(0);
        g_rec.state_only_attempts.store(0); g_rec.state_only_records.store(0);
        g_rec.render_stamp_mismatches.store(0);
        for (size_t i = 0; i < kSliceIds.size(); ++i) {
            g_rec.slice_attempts[i].store(0); g_rec.slice_ok[i].store(0);
            g_rec.slice_busy[i].store(0); g_rec.slice_invalid_identity[i].store(0);
            g_rec.slice_fault[i].store(0); g_rec.slice_cap_exceeded[i].store(0);
            g_rec.slice_render_mismatch[i].store(0);
            g_rec.slice_max_bytes[i].store(0);
        }
        g_rec.running.store(true);
        g_rec.worker = std::thread(capture_loop, g_rec.path, g_rec.rich, g_rec.with_vp,
                                   g_rec.hz, g_rec.state_hz, g_rec.max_bytes);
        res.set_content("{\"ok\":true,\"status\":" + status_json() + "}", "application/json");
    });

    server.Get("/recorder/stop", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        stop_flight_recorder();   // counters persist until the next start, so report after join
        std::lock_guard<std::mutex> lock(g_rec.control);
        res.set_content("{\"ok\":true,\"status\":" + status_json() + "}", "application/json");
    });

    server.Get("/recorder/status", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        std::lock_guard<std::mutex> lock(g_rec.control);
        res.set_content(status_json(), "application/json");
    });
}

} // namespace dwf
