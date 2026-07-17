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

#include "Core.h"
#include "client_state.h"
#include "curses_palette.h"
#include "http_server.h"
#include "json_util.h"
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
    std::lock_guard<std::recursive_mutex> burrows_lock(g_burrows_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    return fn();
}

// ---------------------------------------------------------------------------------------------
// B238 BURROW REVISION + CHANGE BROADCAST.
//
// Before this, burrow state had NO push at all: /burrows was fetched when the panel opened and
// after YOUR OWN mutations, and nothing else. So another player painting a burrow was invisible to
// you until you closed and reopened the panel -- in a multiplayer fort, the one state you most need
// to see change live (an emergency civ-alert burrow) was the one state that never propagated.
//
// Shape is the sticky change-only broadcast the pause/vote/popup mirrors already use
// (native_popup.cpp popup_push_tick): a monotonic seq bumped by every write path, a <=1 Hz tick
// that broadcasts ONLY when the seq moved, and a late-join sync so a reconnecting tab is told the
// current seq once. The frame is deliberately a POKE ({"type":"burrows","seq":N}), not the state:
// each player's rects are built for THEIR camera's z, so there is no one payload to push, and the
// client already knows how to fetch its own.
//
// Unlike vote/popup this tick samples NOTHING from DF -- it compares two integers in plugin memory,
// so it takes no CoreSuspender (AGENTS.md rule 5) and costs nothing on an idle fort. The tradeoff
// that buys: burrow edits made in the NATIVE client (the host's Steam window) do not bump the seq,
// because detecting them would mean walking every burrow's tile masks under a suspender every
// second. Those still land on the next panel open / z-change refetch; every browser-side edit --
// which is every edit a remote player can make -- broadcasts immediately.
std::atomic<uint64_t> g_burrow_seq{0};
std::mutex g_burrow_sync_mutex;
std::set<std::string> g_burrow_synced;   // players told the current seq (late-join bookkeeping)
uint64_t g_burrow_broadcast_seq = 0;     // last seq we actually pushed

uint64_t current_burrow_seq() { return g_burrow_seq.load(); }
void bump_burrow_seq() { g_burrow_seq.fetch_add(1); }

long long burrow_steady_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

void set_no_store_json(httplib::Response& res, const std::string& json) {
    res.set_header("Cache-Control", "no-store");
    res.set_content(json, "application/json; charset=utf-8");
}

void json_error(httplib::Response& res, int status, const std::string& message) {
    res.status = status;
    res.set_header("Cache-Control", "no-store");
    res.set_content("{\"ok\":false,\"error\":" + json_string(message) + "}\n",
                    "application/json; charset=utf-8");
}

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

// BUGFIX (cursor/selection misalignment): was clamping/rescaling against
// effective_capture_viewport_dims (DF's own tiny native viewport) instead of the client's real
// frame_w/frame_h -- see interaction.cpp's pixel_to_tile_coord banner for the root cause. px is
// already a plain tile-grid index into the client's rendered window; clamp against that window.
int burrow_pixel_to_tile(int pixel, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, pixel));
}

// "Civilian alert" (the burrow-row toggle that marks a burrow as a place citizens flee to when
// the alarm is sounded) is not a per-burrow bitflag in df::burrow -- df::burrow_flag only has
// limit_workshops/suspended. The real mechanism (verified against DFHack's own
// scripts/gui/civ-alert.lua, which ships this exact feature): df::global::plotinfo->alerts.list
// always has a "civ-alert" alert_statest lazily created at index 0 (get_civ_alert() there pads
// the list to size>=2 the first time it's touched); a burrow is a civilian-alert destination iff
// its id is in that alert_statest's `burrows` vector (kept sorted, mirroring
// utils.insert_sorted/erase_sorted in the lua). civ_alert_idx is a separate on/off latch for
// whether the alarm is currently sounding, not per-burrow -- untouched here.
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

// ---------------------------------------------------------------------------------------------
// B230 SYMBOL/COLOUR (the native burrow symbol picker).
//
// GROUND TRUTH (df.burrow.xml + DF's own raws + DFHack's own burrow writer):
//   df::burrow has TWO parallel appearance representations, and DF v50 renders from the SECOND:
//     (a) LEGACY ASCII:   `tile` (original-name 'symbol', init 43 = '+'),
//                         `fg_color` ('f', init 11 = LCYAN), `bg_color` ('b', init 3 = CYAN).
//     (b) GRAPHICS MODE:  `symbol_index` + `texture_r/g/b` (fg RGB) + `texture_br/bg/bb` (bg RGB),
//                         plus `solid_texpos`/`blended_texpos` -- DF-OWNED render caches.
//
//   `symbol_index` indexes DF's CUSTOM_SYMBOLS tile page:
//     data/vanilla/vanilla_interface/graphics/tile_page_interface.txt
//       [TILE_PAGE:CUSTOM_SYMBOLS][FILE:images/custom_symbols.png][TILE_DIM:32:32][PAGE_DIM_PIXELS:384:64]
//     graphics_interface.txt binds EXACTLY 23 CUSTOM_SYMBOL cells (12 across row 0, 11 across
//     row 1) -- so the valid range is 0..22, which is precisely the range DFHack's own burrow
//     writer rolls: scripts/internal/quickfort/burrow.lua create_burrow():
//       b.symbol_index = math.random(0, 22)
//       b.texture_r/g/b = random 0..255 ; b.texture_br/bg/bb = 255 - the fg component
//
// WHAT WE WRITE, AND WHAT WE DELIBERATELY DO NOT:
//   WRITE: symbol_index, fg_color, bg_color, texture_r/g/b, texture_br/bg/bb.
//   DO NOT WRITE: `tile`, `solid_texpos`, `blended_texpos`.
//     quickfort -- the only burrow writer in DFHack -- sets NONE of these three either, and the
//     burrows it creates render correctly, which is the empirical proof that DF derives the two
//     texpos caches itself and that `tile` is dead weight outside ASCII mode. Writing a guessed
//     texpos would be poking a render cache with a made-up value; writing `tile` would require an
//     index->CP437-char table we have no oracle for (see the probe list in the closeout). Neither
//     is simulation state, so leaving them alone cannot desync a save -- inventing them might.
//
// The fg/bg RGB is NOT hardcoded: DF's live curses palette is df::global::gps->uccolor[16][3]
// (df.g_src.graphics.xml: "The curses-RGB mapping used for non-curses display modes"), which
// already reflects the player's data/init/colors.txt. So a colour index picked in the browser
// lands on exactly the RGB DF itself would use.
constexpr int kBurrowSymbolCount = 23;  // CUSTOM_SYMBOL cells in graphics_interface.txt
constexpr int kCursesColors = dwf::curses::kColors;

// B230 burrow swatches now share the ONE curses-palette reader (curses_palette.h) with the
// text-color palette handshake, so a single place touches gps->uccolor (text-color spec §3.2).
// Thin aliases keep every call site below unchanged. Contract is identical: false when gps is
// unavailable (headless/early boot), in which case callers leave the texture_* bytes ALONE rather
// than substituting invented colours.
using BurrowRgb = dwf::curses::Rgb;
inline bool curses_rgb(int index, BurrowRgb& out) { return dwf::curses::rgb(index, out); }

int clamp_int(int value, int lo, int hi) { return std::max(lo, std::min(hi, value)); }

// Apply a symbol/colour selection to a burrow. Any of symbol/fg/bg may be < 0 meaning "leave as
// is", so the picker can change just a colour without resending the symbol.
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

bool do_burrow_symbol(int32_t id, int symbol, int fg, int bg, std::string* err) {
    return run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) { if (err) *err = "burrow not found"; return false; }
        apply_burrow_symbol(burrow, symbol, fg, bg);
        bump_burrow_seq();
        return true;
    });
}

struct BurrowRect { int x; int y; int w; int h; };

// B238 CAP. Runs are merged per row (merge_row_runs below), so a burrow covering an entire
// 768-wide map on one z is ~768 rects, not one-per-block. This cap only exists so a pathological
// burrow cannot turn /burrows into a multi-megabyte response; it is far above anything a real
// burrow reaches, and the alternative -- clipping to a window -- is exactly the bug B238 fixes.
constexpr size_t kMaxBurrowRects = 8192;

// B238: merge adjacent same-row runs. listBlocks walks 16x16 blocks, so a run can only ever be as
// wide as the block that produced it -- a 60-tile-wide burrow row arrives as 4 separate runs that
// happen to touch. Sorting by (y, x) and coalescing touching runs collapses those back into the
// one rect they actually are, which is what keeps the now-UNCLIPPED payload small.
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

// Per-burrow tile rects on ONE z, in WORLD coordinates (WD-13 ENDPOINT-EXTEND: the client draws its
// in-mode overlay from this). Uses Burrows::listBlocks to only touch blocks the burrow actually
// occupies (cheap regardless of map size). Emits one rect per contiguous same-row run of assigned
// tiles -- not a minimal rectangle cover, but exact and simple, and the overlay only fills pixels.
//
// B238 BUGFIX ("half of it showed up... the second one didn't show at all, but both showed in
// full on the steam client"). This used to CLIP every rect to a window of
// effective_capture_viewport_dims tiles anchored at the camera -- DF's OWN native viewport
// (gps->main_viewport x the player's zoom), which is NOT the browser's rendered window. The
// browser's window comes from its canvas size / cell size (the &w=&h= it sends to /mapdata and
// /zones), and when it is zoomed out it is WIDER and TALLER than DF's native viewport. Every burrow
// tile past the native viewport's width/height was therefore silently dropped from the payload:
// paint near the camera origin and the burrow appears; paint across the view and HALF appears;
// paint further out and NONE does. The tiles were written correctly the whole time -- the native
// client rendered them -- so this was never a write bug and never a stale-cache bug.
//
// This is the identical bug class that /designate, /placement-cursor, /stockpile-repaint, /hauling
// and /burrow-PAINT itself were each already fixed for ("was clamping/rescaling against
// effective_capture_viewport_dims instead of the client's real frame_w/frame_h"). /burrows is the
// one that never got the fix, because nothing DREW its rects until B230.
//
// The fix is not "pass the client's window too" (the /zones treatment) -- it is to stop clipping in
// x/y at all. The overlay planner already culls world rects to whatever window it is really
// rendering (dwf-burrow-overlay.js burrowOverlayPlans, pinned by b230's tests), so a rect the
// client cannot see costs a few bytes, while a rect the server never sent is an invisible burrow.
// It also makes a PAN free: no refetch is needed to reveal tiles the camera moves onto.
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

std::string build_burrows_json(const std::string& player, const Camera& camera, bool have_camera,
                               int32_t detail_id, std::string* err) {
    std::ostringstream body;
    bool ok = run_burrows_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }

        // B230: DF's live 16-colour curses palette (gps->uccolor), shipped once per payload so the
        // browser's symbol/colour picker can paint real DF swatches instead of carrying a hardcoded
        // copy of a palette the player is free to edit (data/init/colors.txt). Empty when gps is
        // unavailable -- the picker then simply renders no colour chips rather than inventing them.
        // B238: the payload states WHICH z its rects were built for, and that they are world-space
        // (unclipped) rects. Both are load-bearing for the client:
        //   `z`          -- rects exist for one z only (a burrow's tiles on other levels are not in
        //                   this payload). The overlay draws nothing when the camera has moved to a
        //                   different z, instead of washing the old z's tiles over the new one, and
        //                   the panel refetches. Absent (an old DLL) => the client keeps its old
        //                   ungated behaviour rather than going blank.
        //   `worldRects` -- tells a new client it does NOT need to refetch on every pan (an old DLL
        //                   clipped to a window, so with one, the client must).
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
            // B230: symbolIndex/fgColor/bgColor drive the native symbol picker; rgb/bgRgb are the
            // resolved DF palette colours (gps->uccolor) so the client's tile overlay can tint a
            // burrow exactly as DF paints it, without shipping a duplicate palette to the browser.
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
        // If a detail id is provided, emit that burrow's members with names.
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
    if (!ok)
        return "";
    return body.str();
}

int32_t do_burrow_create(const std::string& name, std::string* err) {
    int32_t new_id = -1;
    run_burrows_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        auto burrow = df::allocate<df::burrow>();
        if (!burrow) { if (err) *err = "allocation failed"; return false; }
        burrow->id = plotinfo->burrows.next_id++;
        burrow->name = name;
        // B230 BUGFIX (invisible burrows). This used to set fg_color=7/bg_color=0 and touch
        // NOTHING else, which left symbol_index=0 and -- the actual bug -- texture_r/g/b and
        // texture_br/bg/bb all at 0. Those six bytes are what DF v50's graphics mode actually
        // renders a burrow with (see the apply_burrow_symbol banner), so every burrow this route
        // has ever created was black-on-black: correct tiles, invisible marker. Route the defaults
        // through the same helper the picker uses, so a created burrow is always a valid,
        // *visible* one.
        //
        // The colours are df.burrow.xml's own declared init-values (fg_color init 11 = LCYAN,
        // bg_color init 3 = CYAN) rather than invented ones -- passed explicitly instead of relying
        // on the allocator having applied them. The symbol cycles over the 23 CUSTOM_SYMBOL cells by
        // id so successive burrows are visually distinct; unlike quickfort's math.random this is
        // deterministic, which matters here: every client must derive the same burrow art.
        apply_burrow_symbol(burrow, burrow->id % kBurrowSymbolCount, 11, 3);
        plotinfo->burrows.list.push_back(burrow);
        new_id = burrow->id;
        bump_burrow_seq();
        return true;
    });
    return new_id;
}

bool do_burrow_rename(int32_t id, const std::string& name, std::string* err) {
    return run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) { if (err) *err = "burrow not found"; return false; }
        burrow->name = name;
        bump_burrow_seq();
        return true;
    });
}

bool do_burrow_member(int32_t id, int32_t unit_id, bool enable, std::string* err) {
    return run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) { if (err) *err = "burrow not found"; return false; }
        auto unit = df::unit::find(unit_id);
        if (!unit) { if (err) *err = "unit not found"; return false; }
        DFHack::Burrows::setAssignedUnit(burrow, unit, enable);
        bump_burrow_seq();
        return true;
    });
}

// POST /burrow-action?id=&action=suspend|resume|civalert-on|civalert-off (ENDPOINT-ADD, WD-13
// client's per-row suspend + civilian-alert toggle buttons).
bool do_burrow_action(int32_t id, const std::string& action, std::string* err) {
    return run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) { if (err) *err = "burrow not found"; return false; }
        if (action == "suspend") { burrow->flags.bits.suspended = 1; bump_burrow_seq(); return true; }
        if (action == "resume") { burrow->flags.bits.suspended = 0; bump_burrow_seq(); return true; }
        if (action == "civalert-on") { bump_burrow_seq(); return set_burrow_civalert(id, true, err); }
        if (action == "civalert-off") { bump_burrow_seq(); return set_burrow_civalert(id, false, err); }
        // B230: the OTHER half of df::burrow_flag. burrow_flag has exactly two bits
        // (df.burrow.xml): limit_workshops (original-name WORKSHOPS_RESTRICTED) and suspended.
        // DF ships real art for both states of this one -- BURROW_WORKSHOPS_BURROW_ONLY /
        // BURROW_WORKSHOPS_EVERYWHERE in interface_map.json -- and nothing was driving it.
        if (action == "workshops-limit") { burrow->flags.bits.limit_workshops = 1; bump_burrow_seq(); return true; }
        if (action == "workshops-all") { burrow->flags.bits.limit_workshops = 0; bump_burrow_seq(); return true; }
        if (err) *err = "unknown burrow action: " + action;
        return false;
    });
}

// POST /burrow-delete?id= (ENDPOINT-ADD). DFHack exposes no single "delete burrow" helper (the
// in-game screen handles it internally); mirrors what deletion actually needs to leave clean:
// drop its tile masks + unit assignments (Burrows::clearTiles/clearUnits -- same calls the
// `burrow` plugin's own tile/unit-remove commands use), drop it from any civilian-alert burrow
// list (mirrors gui/civ-alert.lua's remove_civalert_burrow, including clearing the alarm if that
// was the last burrow in it), then erase it from plotinfo->burrows.list and free it.
bool do_burrow_delete(int32_t id, std::string* err) {
    return run_burrows_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        auto burrow = find_burrow(id);
        if (!burrow) { if (err) *err = "burrow not found"; return false; }

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
        if (it == list.end()) { if (err) *err = "burrow not tracked in plotinfo"; return false; }
        list.erase(it);
        delete burrow;
        bump_burrow_seq();
        return true;
    });
}

// POST /burrow-paint?id=&px=&py=&px2=&py2=&w=&h=&mode=add|erase (ENDPOINT-ADD, spec contract:
// docs/superpowers/specs/2026-07-07-WD-ui-parity-spec.md WD-13). Same px/py/px2/py2/w/h pixel
// contract as /designate and /stockpile-repaint (grid tile index + window tile dims,
// camera-relative); converts to a world tile rect and calls
// DFHack::Burrows::setAssignedTile(burrow, pos, mode==add) per tile on the camera's current z,
// exactly the API the spec item names.
bool do_burrow_paint(const Camera& camera, int frame_w, int frame_h, int32_t id,
                     int px, int py, int px2, int py2, bool add, int& out_count,
                     std::string* err) {
    return run_burrows_locked([&]() -> bool {
        auto burrow = find_burrow(id);
        if (!burrow) { if (err) *err = "burrow not found"; return false; }

        // BUGFIX (cursor/selection misalignment): frame_w/frame_h are the client's real
        // rendered-window tile dims (px/py are ALREADY a plain tile-grid index into that
        // window -- renderedImageRect(): "one map unit is one tile"), and are the ONLY correct
        // scale for them. This used to void frame_w/frame_h and clamp against DF's own tiny
        // native viewport (effective_capture_viewport_dims) instead, on the theory that
        // http_server.cpp's normalize_frame_to_viewport had already made that "the same
        // identity" -- it hadn't; that helper is now a no-op precisely because of this bug
        // (see its banner). Use frame_w/frame_h directly; the viewport probe stays as a
        // best-effort "is DF's capture path alive" signal only.
        int probe_w = 0, probe_h = 0;
        if (!effective_capture_viewport_dims(camera, probe_w, probe_h, err)) {
            if (err && err->empty()) *err = "viewport unavailable";
            return false;
        }

        int tx1 = burrow_pixel_to_tile(std::min(px, px2), frame_w);
        int ty1 = burrow_pixel_to_tile(std::min(py, py2), frame_h);
        int tx2 = burrow_pixel_to_tile(std::max(px, px2), frame_w);
        int ty2 = burrow_pixel_to_tile(std::max(py, py2), frame_h);
        int wx1 = camera.x + tx1, wy1 = camera.y + ty1;
        int wx2 = camera.x + tx2, wy2 = camera.y + ty2;

        int changed = 0;
        for (int y = wy1; y <= wy2; ++y) {
            for (int x = wx1; x <= wx2; ++x) {
                df::coord pos(x, y, camera.z);
                if (DFHack::Burrows::setAssignedTile(burrow, pos, add))
                    ++changed;
            }
        }
        out_count = changed;
        if (changed)
            bump_burrow_seq();
        return true;
    });
}

} // namespace

// B238: burrow change push. Runs once per ws_push_loop iteration (alongside vote/popup), rate-
// limited to <=1 Hz. Broadcasts ONLY on a real change ({"type":"burrows","seq":N} -- a poke, not
// state: see the g_burrow_seq banner), then stickily syncs any player who has not been told the
// current seq (reconnects, late joins). Touches no DF memory and takes no suspender.
void burrow_push_tick() {
    static long long last_pass = 0;
    const long long now = burrow_steady_ms();
    if (now - last_pass < 1000)
        return;
    last_pass = now;

    const uint64_t seq = current_burrow_seq();
    if (seq == 0)
        return;   // nothing has ever changed -- nothing to say, and nothing to sync

    const std::string frame = "{\"type\":\"burrows\",\"seq\":" + std::to_string(seq) + "}";

    // Change edge: tell everyone, and mark everyone synced (they just heard the current seq).
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

    // Late-join sync: a player who joined after the last change never heard the current seq, so
    // their client has no way to know its (possibly pre-join) burrow snapshot is behind.
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
    // GET /burrows?detail=<id> -> list of burrows (+ members of `detail`). ENDPOINT-EXTEND
    // (WD-13): each burrow now also carries suspended/civAlert state and a `rects` array of its
    // tiles visible in the requesting player's current window, for the client's in-mode overlay.
    // The camera lookup is best-effort -- an unknown/unavailable camera still returns the burrow
    // list, just with empty rects, rather than failing the whole request.
    server.Get("/burrows", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int detail = -1;
        query_int(req, "detail", detail);
        Camera camera;
        std::string cam_err;
        bool have_camera = camera_for_player(player, camera, &cam_err);
        std::string err;
        std::string json = build_burrows_json(player, camera, have_camera, detail, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "burrows unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // POST /burrow-create?name= -> allocate a new (tile-less) burrow.
    auto create_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string name = req.has_param("name") ? req.get_param_value("name") : "New Burrow";
        if (name.size() > 64) name.resize(64);
        std::string err;
        int32_t id = do_burrow_create(name, &err);
        if (id < 0) { json_error(res, 400, err.empty() ? "create failed" : err); return; }
        set_no_store_json(res, "{\"ok\":true,\"id\":" + std::to_string(id) + "}\n");
    };
    server.Get("/burrow-create", create_handler);
    server.Post("/burrow-create", create_handler);

    // POST /burrow-rename?id=&name=
    auto rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("name")) {
            json_error(res, 400, "missing id/name");
            return;
        }
        std::string name = req.get_param_value("name");
        if (name.size() > 64) name.resize(64);
        std::string err;
        if (!do_burrow_rename(id, name, &err)) { json_error(res, 400, err); return; }
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/burrow-rename", rename_handler);
    server.Post("/burrow-rename", rename_handler);

    // POST /burrow-unit?id=&unit=&on=1 -> add/remove a unit from the burrow.
    auto member_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int unit_id = -1;
        if (!query_int(req, "id", id) || !query_int(req, "unit", unit_id)) {
            json_error(res, 400, "missing id/unit");
            return;
        }
        int on = 1;
        query_int(req, "on", on);
        std::string err;
        if (!do_burrow_member(id, unit_id, on != 0, &err)) { json_error(res, 400, err); return; }
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/burrow-unit", member_handler);
    server.Post("/burrow-unit", member_handler);

    // POST /burrow-action?id=&action=suspend|resume|civalert-on|civalert-off (ENDPOINT-ADD).
    auto action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("action")) {
            json_error(res, 400, "missing id/action");
            return;
        }
        std::string err;
        if (!do_burrow_action(id, req.get_param_value("action"), &err)) {
            json_error(res, 400, err.empty() ? "burrow action failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/burrow-action", action_handler);
    server.Post("/burrow-action", action_handler);

    // POST /burrow-symbol?id=&symbol=&fg=&bg= (ENDPOINT-ADD, B230) -- the native symbol/colour
    // picker. symbol is a CUSTOM_SYMBOLS cell index (0..22); fg/bg are DF curses colour indices
    // (0..15). Each is optional: omitting one leaves that facet of the burrow untouched, so the
    // client can send a colour change without restating the symbol. Values are clamped, not
    // rejected -- an out-of-range index is a client bug, not a reason to leave the burrow in a
    // half-written state.
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
        std::string err;
        if (!do_burrow_symbol(id, symbol, fg, bg, &err)) {
            json_error(res, 400, err.empty() ? "burrow symbol failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/burrow-symbol", symbol_handler);
    server.Post("/burrow-symbol", symbol_handler);

    // POST /burrow-delete?id= (ENDPOINT-ADD).
    auto delete_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            json_error(res, 400, "missing id");
            return;
        }
        std::string err;
        if (!do_burrow_delete(id, &err)) {
            json_error(res, 400, err.empty() ? "burrow delete failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/burrow-delete", delete_handler);
    server.Post("/burrow-delete", delete_handler);

    // POST /burrow-paint?id=&px=&py=&px2=&py2=&w=&h=&mode=add|erase (ENDPOINT-ADD, spec
    // contract). player selects whose camera (and thus which world window) px/py are relative
    // to, same as /designate and /stockpile-repaint.
    auto paint_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int id = -1;
        int px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "id", id) || !query_int(req, "px", px) || !query_int(req, "py", py) ||
                !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
            json_error(res, 400, "missing id/px/py/w/h");
            return;
        }
        int px2 = px, py2 = py;
        query_int(req, "px2", px2);
        query_int(req, "py2", py2);
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "add";
        bool add = mode != "erase";

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            json_error(res, 503, err.empty() ? "camera unavailable" : err);
            return;
        }

        int count = 0;
        if (!do_burrow_paint(camera, frame_w, frame_h, id, px, py, px2, py2, add, count, &err)) {
            json_error(res, 400, err.empty() ? "burrow paint failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true,\"id\":" + std::to_string(id) +
                                ",\"count\":" + std::to_string(count) + "}\n");
    };
    server.Get("/burrow-paint", paint_handler);
    server.Post("/burrow-paint", paint_handler);
}

} // namespace dwf
