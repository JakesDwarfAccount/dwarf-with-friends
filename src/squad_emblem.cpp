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

#include "squad_emblem.h"
#include "render_thread_wait.h"

#include "capture_guard.h"
#include "diagnostics.h"
#include "save_barrier.h"
#include "modules/DFSDL.h"

#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/historical_entity.h"
#include "df/plotinfost.h"
#include "df/squad.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <future>
#include <memory>
#include <mutex>
#include <sstream>

namespace dwf {
namespace {

// ---- native random-emblem generator (exe-pinned direct call) ----------------------------------
constexpr uintptr_t NATIVE_EMBLEM_ROLL_RVA = 0x40aa30;   // roll-random-squad-emblem(squad)
constexpr uint8_t NATIVE_EMBLEM_ROLL_SIG[32] = {
    0x48, 0x89, 0x5c, 0x24, 0x10, 0x57, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0x3d, 0xf7, 0x02,
    0x24, 0x02, 0x48, 0x8b, 0xd9, 0x48, 0x2b, 0x3d, 0xe5, 0x02, 0x24, 0x02, 0x48, 0xc1, 0xff,
    0x02, 0x85,
};
constexpr uintptr_t NATIVE_EMBLEM_BAKER_RVA = 0x40ac50;  // bake-emblem(squad), the tail-jump target
constexpr uint8_t NATIVE_EMBLEM_BAKER_SIG[32] = {
    0x40, 0x53, 0x48, 0x83, 0xec, 0x70, 0x48, 0x8b, 0xd9, 0x48, 0x63, 0x89, 0xdc, 0x01, 0x00,
    0x00, 0x85, 0xc9, 0x0f, 0x88, 0x99, 0x02, 0x00, 0x00, 0x48, 0x8b, 0x05, 0xc9, 0x00, 0x24,
    0x02, 0x48,
};

static_assert(offsetof(df::squad, solid_texpos) == 0x1d4, "squad.solid_texpos moved");
static_assert(offsetof(df::squad, blended_texpos) == 0x1d8, "squad.blended_texpos moved");
static_assert(offsetof(df::squad, symbol) == 0x1dc, "squad.symbol moved");
static_assert(offsetof(df::squad, foreground_r) == 0x1e0, "squad.foreground_r moved");

using pfn_native_emblem_roll = void (*)(df::squad*);

std::atomic<bool> g_roll_faulted(false);
std::mutex g_resolve_mu;
bool g_resolved = false;
void* g_roll_fn = nullptr;
std::string g_unavailable_reason;

// Serializes the marshal so two concurrent callers cannot queue two passes over the same squad.
std::mutex g_roll_mu;

bool resolve_roll_locked() {
#ifdef _WIN32
    HMODULE exe = GetModuleHandleA(nullptr);
    if (!exe) {
        g_unavailable_reason = "could not resolve the game module";
        return false;
    }
    auto base = reinterpret_cast<const uint8_t*>(exe);
    if (std::memcmp(base + NATIVE_EMBLEM_ROLL_RVA, NATIVE_EMBLEM_ROLL_SIG,
                    sizeof(NATIVE_EMBLEM_ROLL_SIG)) != 0 ||
        std::memcmp(base + NATIVE_EMBLEM_BAKER_RVA, NATIVE_EMBLEM_BAKER_SIG,
                    sizeof(NATIVE_EMBLEM_BAKER_SIG)) != 0) {
        g_unavailable_reason =
            "unsupported Dwarf Fortress binary (squad emblem generator signature mismatch)";
        diagnostics_log("DIAG squad emblem native roll UNAVAILABLE: signature mismatch; "
                        "unassigned emblems keep serving symbol -1");
        return false;
    }
    g_roll_fn = const_cast<uint8_t*>(base) + NATIVE_EMBLEM_ROLL_RVA;
    diagnostics_log("DIAG squad emblem native roll pinned (SQUAD-EMBLEM-NATIVE-ROLL rva=40aa30)");
    return true;
#else
    g_unavailable_reason = "native squad emblem generation is Windows-only";
    return false;
#endif
}

bool roll_ready(std::string* why) {
    std::lock_guard<std::mutex> lock(g_resolve_mu);
    if (!g_resolved) {
        g_resolved = true;
        resolve_roll_locked();
    }
    if (!g_roll_fn && why)
        *why = g_unavailable_reason;
    return g_roll_fn != nullptr;
}

#ifdef _WIN32
int call_native_emblem_roll_seh(void* fn, df::squad* squad) {
    __try {
        reinterpret_cast<pfn_native_emblem_roll>(fn)(squad);
        return 0;
    } __except (seh_filter(GetExceptionInformation())) {
        return 1;
    }
}
#endif

bool emblem_colours_all_zero(const df::squad* squad) {
    return squad->foreground_r == 0 && squad->foreground_g == 0 && squad->foreground_b == 0 &&
           squad->background_r == 0 && squad->background_g == 0 && squad->background_b == 0;
}

// Unbaked is solid_texpos == 0 (the sentinel is 0, not -1). Symbol 0 is a legal atlas index, so
// the emblem_colours_all_zero disjunct is load-bearing: a zero-filled record never rolls without it.
bool needs_roll(const df::squad* squad, int atlas_count) {
    return squad && squad->solid_texpos == 0 &&
           (squad->symbol < 0 || squad->symbol >= atlas_count || emblem_colours_all_zero(squad));
}

struct RollRequest {
    int rolled = 0;
    std::string err;
    std::promise<bool> done;
};

void roll_fort_squads_on_render(RollRequest& request) {
#ifdef _WIN32
    auto plotinfo = df::global::plotinfo;
    auto gps = df::global::gps;
    if (!plotinfo || !gps) {
        request.err = "world unavailable";
        return;
    }
    const int atlas_count = static_cast<int>(gps->texpos_custom_symbol.size());
    if (atlas_count < 1) {
        request.err = "the custom-symbol atlas is not loaded";
        return;
    }
    auto fort = df::historical_entity::find(plotinfo->group_id);
    if (!fort) {
        request.err = "fort entity unavailable";
        return;
    }
    for (int32_t squad_id : fort->squads) {
        auto squad = df::squad::find(squad_id);
        if (!needs_roll(squad, atlas_count))
            continue;
        if (call_native_emblem_roll_seh(g_roll_fn, squad) != 0) {
            g_roll_faulted.store(true);
            std::ostringstream ss;
            ss << "DIAG squad emblem native roll FAULT code=0x" << std::hex << g_seh_code
               << " at=" << g_seh_at << "; rolling latched OFF for this session";
            diagnostics_log(ss.str());
            request.err = "native squad emblem generator faulted; rolling disabled";
            return;
        }
        ++request.rolled;
    }
    if (request.rolled > 0) {
        std::ostringstream ss;
        ss << "DIAG squad emblem rolled " << request.rolled
           << " unassigned squad(s) (SQUAD-EMBLEM-BLANK-ROLL)";
        diagnostics_log(ss.str());
    }
#else
    request.err = "native squad emblem generation is Windows-only";
#endif
}

} // namespace

int squad_emblem_ensure_native_roll(std::string* err) {
    if (g_roll_faulted.load()) {
        if (err) *err = "native squad emblem rolling is disabled after an earlier native fault";
        return 0;
    }
    std::string why;
    if (!roll_ready(&why)) {
        if (err) *err = why;
        return 0;
    }
    if (save_barrier_active()) {
        if (err) *err = "save in progress; emblem rolling deferred";
        return 0;
    }

    std::lock_guard<std::mutex> lock(g_roll_mu);
    auto request = std::make_shared<RollRequest>();
    auto future = request->done.get_future();
    DFHack::runOnRenderThread([request]() {
        roll_fort_squads_on_render(*request);
        request->done.set_value(true);
    });
    if (!render_future_ready(future)) {
        if (err) *err = "render thread did not run the emblem roll in time";
        return 0;
    }
    if (err) *err = request->err;
    return request->rolled;
}

} // namespace dwf
