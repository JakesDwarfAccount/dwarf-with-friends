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

#include "status_harvest.h"

#include <cstdint>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "client_state.h"
// capture_state_mutex() lives in sdl_capture.h -- taken BEFORE the CoreSuspender, in the same order
// every other read route uses (see status_truth.cpp's note on why omitting it only breaks at the
// orchestrator build, since this file compiles nowhere in the agent worktree).
#include "sdl_capture.h"
#include "json_util.h"
#include "unit_status.h"

#include "Core.h"
#include "DataDefs.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/graphic_viewportst.h"
#include "df/job.h"
#include "df/texture_handlerst.h"
#include "df/tile_pagest.h"
#include "df/unit.h"
#include "df/unit_personality.h"
#include "df/unit_soul.h"
#include "df/world.h"

namespace dwf {

namespace {

// The 41 UNIT_STATUS rows, in the game's own sheet order (spec §2.1 -- verbatim from
// data/vanilla/vanilla_interface/graphics/graphics_interface.txt:2439-2479). Row index == sheet
// row == index into the UNIT_STATUS page's texpos vector, so this names a texpos hit for free.
// This is the ONLY place the harvest hard-codes the row order; the runtime texpos VALUES are always
// re-read from df.global.texture per session (spec: "contiguity is an observation, not a contract").
const char* const kUnitStatusRowNames[] = {
    "MIGRANT", "NO_JOB", "NO_DESTINATION", "HUNGRY", "THIRSTY", "DROWSY", "STRESSED", "DISTRACTED",
    "SLEEPING", "FEY_MOOD", "POSSESSED", "SECRETIVE_MOOD", "FELL_MOOD", "MACABRE_MOOD", "TANTRUM",
    "OBLIVIOUS", "DEPRESSION", "MADNESS", "MELANCHOLY", "BERSERK", "ENRAGED", "MARTIAL_TRANCE",
    "TERRIFIED", "WRESTLING", "MINOR_INJURY", "MAJOR_INJURY", "PARALYZED", "STUNNED", "NAUSEA",
    "WINDED", "UNCONSCIOUS", "FEVERED", "YIELDING", "PLAYING_MAKE_BELIEVE", "TELLING_A_STORY",
    "RECITING_POETRY", "PERFORMING", "PROJECTILE", "GROUNDED", "WEBBED", "CLIMBING",
};
constexpr int kUnitStatusRowCount = static_cast<int>(sizeof(kUnitStatusRowNames) / sizeof(char*));

std::string row_name(int row) {
    if (row < 0 || row >= kUnitStatusRowCount) return std::string("ROW_") + std::to_string(row);
    return kUnitStatusRowNames[row];
}

// Pack a map tile into one key so units can be found by position in O(1).
inline int64_t tile_key(int x, int y, int z) {
    return (static_cast<int64_t>(z) << 42) ^ (static_cast<int64_t>(y) << 21) ^ static_cast<int64_t>(x);
}

// One painted UNIT_STATUS cell found in a screen array.
struct Hit {
    const char* layer;   // which screentexpos_* array it came from
    int vx, vy;          // VIEW coords (column-major idx = x*dim_y + y)
    long texpos;         // the global texture id painted there
    int row;             // its row in the UNIT_STATUS page (== sheet row == raws name index)
    df::unit* unit;      // attributed unit, or nullptr (unmatched)
    int dy_off;          // vertical offset unit-minus-bubble that matched: +1 (0,-1) or 0 (0,0)
};

// Scan one screentexpos_* array for values in the UNIT_STATUS texpos set. Column-major, bounds-safe.
void scan_layer(const char* name, const int32_t* arr, int dim_x, int dim_y,
                const std::unordered_map<long, int>& texpos_row, std::vector<Hit>& out) {
    if (!arr || dim_x <= 0 || dim_y <= 0) return;
    for (int x = 0; x < dim_x; ++x) {
        for (int y = 0; y < dim_y; ++y) {
            long v = arr[x * dim_y + y];   // idx = x*dim_y + y  (spec §3.A, live-probe pinned)
            if (v <= 0) continue;
            auto it = texpos_row.find(v);
            if (it == texpos_row.end()) continue;
            out.push_back(Hit{name, x, y, v, it->second, nullptr, 0});
        }
    }
}

std::string build_status_harvest_json() {
    std::ostringstream body;

    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;

    df::world* world = df::global::world;
    df::graphic* gps = df::global::gps;
    df::texture_handlerst* tex = df::global::texture;
    df::graphic_viewportst* vp = gps ? gps->main_viewport : nullptr;

    if (!world || !gps || !tex || !vp || !df::global::window_x || !df::global::window_y ||
        !df::global::window_z) {
        return std::string("{\"v\":1,\"ok\":false,\"err\":\"globals unavailable\"}");
    }

    const int win_x = *df::global::window_x;
    const int win_y = *df::global::window_y;
    const int win_z = *df::global::window_z;
    const int dim_x = vp->dim_x;
    const int dim_y = vp->dim_y;

    // ---- 1) the live UNIT_STATUS texpos map (spec §2.2). Re-read EVERY call -- never baked. --------
    std::unordered_map<long, int> texpos_row;   // global texture id -> sheet row
    std::vector<long> page_texpos;
    bool page_loaded = false;
    bool page_found = false;
    for (df::tile_pagest* pg : tex->page) {
        if (!pg || pg->token != "UNIT_STATUS") continue;
        page_found = true;
        page_loaded = pg->loaded;
        for (size_t i = 0; i < pg->texpos.size(); ++i) {
            page_texpos.push_back(pg->texpos[i]);
            if (pg->texpos[i] > 0) texpos_row[pg->texpos[i]] = static_cast<int>(i);
        }
        break;
    }

    // ---- 2) scan the pinned layers for painted UNIT_STATUS cells (passive read; no re-render) ------
    // Spec §3.A step 1 pins the DESIGNATION layer as where the bubbles land; the creature layer is
    // scanned too because on-tile markers (GROUNDED at offset (0,0)) can share the sheet and DF may
    // route them differently. Both are the arrays DF already filled this frame.
    std::vector<Hit> hits;
    scan_layer("designation", vp->screentexpos_designation, dim_x, dim_y, texpos_row, hits);
    scan_layer("screentexpos", vp->screentexpos, dim_x, dim_y, texpos_row, hits);

    // ---- 3) index units at the current z, then attribute each hit ----------------------------------
    // Bubbles render one tile ABOVE the unit (offset (0,-1)) OR on the unit's own tile (offset (0,0)
    // for on-tile markers). So for a cell at map (mx,my) the unit is at (mx,my+1) first, else (mx,my).
    std::unordered_map<int64_t, df::unit*> units_at;
    for (df::unit* u : world->units.active) {
        if (!u || !DFHack::Units::isAlive(u)) continue;
        if (u->pos.z != win_z) continue;
        units_at[tile_key(u->pos.x, u->pos.y, u->pos.z)] = u;
    }
    for (Hit& h : hits) {
        const int mx = win_x + h.vx;
        const int my = win_y + h.vy;
        auto above = units_at.find(tile_key(mx, my + 1, win_z));   // bubble ABOVE unit -> unit below
        if (above != units_at.end()) { h.unit = above->second; h.dy_off = 1; continue; }
        auto ontile = units_at.find(tile_key(mx, my, win_z));      // on-tile marker
        if (ontile != units_at.end()) { h.unit = ontile->second; h.dy_off = 0; }
    }

    // ---- 4) emit -----------------------------------------------------------------------------------
    body << "{\"v\":1,\"ok\":true"
         << ",\"frame\":" << world->frame_counter
         << ",\"window\":{\"x\":" << win_x << ",\"y\":" << win_y << ",\"z\":" << win_z << "}"
         << ",\"viewport\":{\"dim_x\":" << dim_x << ",\"dim_y\":" << dim_y << "}"
         << ",\"page\":{\"token\":\"UNIT_STATUS\",\"found\":" << (page_found ? "true" : "false")
         << ",\"loaded\":" << (page_loaded ? "true" : "false")
         << ",\"count\":" << page_texpos.size() << ",\"texpos\":[";
    for (size_t i = 0; i < page_texpos.size(); ++i) {
        if (i) body << ',';
        body << page_texpos[i];
    }
    body << "]}";

    auto emit_hit = [&](const Hit& h) {
        body << "{\"layer\":\"" << h.layer << "\""
             << ",\"vx\":" << h.vx << ",\"vy\":" << h.vy
             << ",\"map_x\":" << (win_x + h.vx) << ",\"map_y\":" << (win_y + h.vy)
             << ",\"texpos\":" << h.texpos << ",\"row\":" << h.row
             << ",\"name\":" << json_string(row_name(h.row));
        if (h.unit) {
            df::unit* u = h.unit;
            const int job = (u->job.current_job) ? static_cast<int>(u->job.current_job->job_type) : -1;
            int32_t longterm_stress = 0;
            if (df::unit_soul* soul = u->status.current_soul) longterm_stress = soul->personality.longterm_stress;
            body << ",\"offset\":[0," << (-h.dy_off) << "]"
                 << ",\"unit_id\":" << u->id
                 << ",\"unit_name\":" << json_string(DFHack::Translation::translateName(&u->name, false))
                 << ",\"st\":" << unit_status_bits(u)
                 << ",\"st2\":" << unit_status_bits2(u)
                 // the chooser inputs: every field unit_status.h reads, raw and unfiltered.
                 << ",\"hunger_timer\":" << u->counters2.hunger_timer
                 << ",\"thirst_timer\":" << u->counters2.thirst_timer
                 << ",\"sleepiness_timer\":" << u->counters2.sleepiness_timer
                 << ",\"paralysis\":" << u->counters2.paralysis
                 << ",\"fever\":" << u->counters2.fever
                 << ",\"unconscious\":" << u->counters.unconscious
                 << ",\"stunned\":" << u->counters.stunned
                 << ",\"winded\":" << u->counters.winded
                 << ",\"webbed\":" << u->counters.webbed
                 << ",\"nausea\":" << u->counters.nausea
                 << ",\"longterm_stress\":" << longterm_stress
                 << ",\"mood\":" << static_cast<int>(u->mood)
                 << ",\"soldier_mood\":" << static_cast<int>(u->counters.soldier_mood)
                 << ",\"on_ground\":" << (u->flags1.bits.on_ground ? 1 : 0)
                 << ",\"projectile\":" << (u->flags1.bits.projectile ? 1 : 0)
                 << ",\"has_mood\":" << (u->flags1.bits.has_mood ? 1 : 0)
                 << ",\"job\":" << job;
        }
        body << "}";
    };

    body << ",\"hits\":[";
    bool first = true;
    for (const Hit& h : hits) {
        if (!h.unit) continue;
        if (!first) body << ',';
        first = false;
        emit_hit(h);
    }
    body << "],\"unmatched\":[";
    first = true;
    for (const Hit& h : hits) {
        if (h.unit) continue;
        if (!first) body << ',';
        first = false;
        emit_hit(h);
    }
    body << "]}";
    return body.str();
}

} // namespace

void register_status_harvest_routes(httplib::Server& server) {
    server.Get("/statusharvest", [](const httplib::Request&, httplib::Response& res) {
        std::string json = build_status_harvest_json();
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });
}

} // namespace dwf
