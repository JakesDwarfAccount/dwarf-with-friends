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

#include "unit_sprites.h"
#include "diagnostics.h"
#include "frame.h"
#include "image_encoder.h"

#include "Core.h"
#include "modules/DFSDL.h"
#include "modules/Maps.h"

#include "df/enabler.h"
#include "df/global_objects.h"
#include "df/map_block.h"
#include "df/tile_designation.h"
#include "df/unit_flags1.h"
#include "df/unit_flags4.h"

#include <SDL_surface.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <future>
#include <list>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

using namespace DFHack;

namespace dwf {
namespace {

// FNV-1a fold, local copy of the tiny helper in tile_map_dump.cpp (not worth
// exporting a whole utility header for 5 lines).
inline uint64_t fnv1a(uint64_t h, const void* data, size_t n) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ull; }
    return h;
}

// Cadence for the spec's "slow safety rescan" diagnostic heartbeat (~150
// passes at a 30Hz-ish call rate ~= 5s). The per-pass hash compare below
// already re-verifies EVERY unit's identity every single pass -- a strict
// superset of a 150-tick cadence -- so this heartbeat cannot find a mismatch
// the per-pass check missed; it exists as an explicit, spec-literal log line
// for QA visibility (distinct from the immediate dirty-edge log lines).
constexpr uint64_t kSafetyRescanPasses = 150;

// ah-defect retry cadence (2026-07-09). Generated creatures (demons/bogeymen/nightmares)
// that DF has never RENDERED carry no texpos_currently_in_use, so the census never marks them
// dirty and no composite ("ah") record is ever produced (641/1873 frozen on the pause-locked
// range world). The per-pass hash check DOES catch a unit the moment its texpos appears -- but
// only if a pass happens to run after the render, and the change is consumed exactly once. This
// wall-clock-gated retry (independent of sim ticks -- the world is paused) periodically
// re-enqueues record-less units whose texpos is NOW populated, so a composite is produced as
// soon as a player's camera has rendered them. Bounded to record-less + already-rendered units,
// so it never spends the export worker on units with nothing to copy.
constexpr auto kRecordRetryInterval = std::chrono::seconds(7);

// Defensive cap on the dirty queue (coalesced by id, so it can only reach
// the tracker's size in practice -- this guards against a future bug, not
// normal operation).
constexpr size_t kMaxDirtyQueue = 4096;

struct UnitTexState {
    int32_t texpos[3][2] = {{0, 0}, {0, 0}, {0, 0}};
    bool in_use[3][2]    = {{false, false}, {false, false}, {false, false}};
    bool refresh_flag_prev = false;
    uint64_t content_hash  = 0;
    uint64_t last_seen_pass = 0;
};

std::mutex g_mu;
std::unordered_map<int32_t, UnitTexState> g_tracker;
std::deque<int32_t> g_dirty_queue;
std::unordered_set<int32_t> g_dirty_set;   // membership mirror of g_dirty_queue
uint64_t g_pass_gen = 0;
uint64_t g_last_heartbeat_pass = 0;
UnitCensusStats g_last_stats;
// ah-defect retry (see kRecordRetryInterval): wall-clock timestamp of the last retry sweep.
std::chrono::steady_clock::time_point g_last_record_retry{};

std::atomic<bool> g_enabled{false};

// ah-defect retry helper: fill `out` with the ids that currently HAVE a composite record.
// Defined after the WE-2 g_records map (below in this TU -- an anonymous-namespace global is
// visible throughout the translation unit); forward-declared here so unit_census_pass can call
// it. Takes one g_records_mu lock per retry sweep (every ~7s), so it is not a hot path.
void census_collect_record_ids(std::unordered_set<int32_t>& out);

uint64_t hash_identity(const int32_t texpos[3][2], const bool in_use[3][2]) {
    uint64_t h = 1469598103934665603ull;
    h = fnv1a(h, texpos, sizeof(int32_t) * 6);
    h = fnv1a(h, in_use, sizeof(bool) * 6);
    return h;
}

void enqueue_dirty_locked(int32_t id) {
    if (!g_dirty_set.insert(id).second) return; // already queued
    g_dirty_queue.push_back(id);
    if (g_dirty_queue.size() > kMaxDirtyQueue) {
        int32_t evicted = g_dirty_queue.front();
        g_dirty_queue.pop_front();
        g_dirty_set.erase(evicted);
        diagnostics_log_v("unit-census: dirty queue overflow, dropped unit " +
                          std::to_string(evicted));
    }
}

} // namespace

bool unit_census_enabled() { return g_enabled.load(std::memory_order_relaxed); }
void set_unit_census_enabled(bool on) { g_enabled.store(on, std::memory_order_relaxed); }

UnitCensusStats unit_census_pass(const std::vector<df::unit*>& active) {
    if (!g_enabled.load(std::memory_order_relaxed)) return UnitCensusStats{};

    std::lock_guard<std::mutex> lock(g_mu);
    ++g_pass_gen;
    const uint64_t pass = g_pass_gen;

    // ah-defect retry: is a wall-clock retry sweep due this pass? If so, snapshot the ids that
    // already have a composite record ONCE (one g_records_mu lock), so the per-unit test below
    // is a cheap set lookup. Only record-less units that DF has already rendered get re-enqueued.
    const auto now = std::chrono::steady_clock::now();
    const bool retry_due = (now - g_last_record_retry) >= kRecordRetryInterval;
    std::unordered_set<int32_t> have_record;
    if (retry_due) {
        g_last_record_retry = now;
        census_collect_record_ids(have_record);
    }
    int retry_requeued = 0;

    UnitCensusStats stats;
    std::unordered_set<int32_t> seen;
    seen.reserve(active.size());

    for (df::unit* u : active) {
        if (!u) continue;
        const int32_t id = u->id;
        seen.insert(id);

        // WE-5's own rule, applied here too: DF never composites an
        // undetected ambusher or a unit standing on an unrevealed tile, so
        // there is nothing to track yet. Leave any existing tracker entry
        // untouched (it may become relevant again the moment the unit is
        // revealed / the ambush ends) rather than purge it.
        if (u->flags1.bits.hidden_in_ambush) { ++stats.units_skipped_hidden; continue; }
        {
            df::map_block* ublk = Maps::getTileBlock(u->pos);
            if (ublk && ublk->designation[u->pos.x & 15][u->pos.y & 15].bits.hidden) {
                ++stats.units_skipped_hidden;
                continue;
            }
        }

        ++stats.units_scanned;

        int32_t new_texpos[3][2];
        bool new_in_use[3][2];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 2; ++j) {
                new_texpos[i][j] = u->texpos[i][j];
                new_in_use[i][j] = u->texpos_currently_in_use[i][j];
            }
        const bool refresh_now = u->flags4.bits.any_texture_must_be_refreshed;
        const uint64_t new_hash = hash_identity(new_texpos, new_in_use);

        auto it = g_tracker.find(id);
        const bool is_new = (it == g_tracker.end());
        UnitTexState& st = g_tracker[id]; // default-constructs on first sight

        bool dirty = false;
        const char* reason = nullptr;
        if (is_new) {
            if (new_texpos[0][0] != 0) { dirty = true; reason = "first-seen"; }
        } else {
            if (new_hash != st.content_hash) { dirty = true; reason = "slot-changed"; }
            else if (st.refresh_flag_prev && !refresh_now) { dirty = true; reason = "refresh-falling-edge"; }
        }

        std::memcpy(st.texpos, new_texpos, sizeof(new_texpos));
        std::memcpy(st.in_use, new_in_use, sizeof(new_in_use));
        st.refresh_flag_prev = refresh_now;
        st.content_hash = new_hash;
        st.last_seen_pass = pass;

        if (dirty) {
            ++stats.units_dirty;
            enqueue_dirty_locked(id);
            diagnostics_log_v("unit-census: unit " + std::to_string(id) + " DIRTY (" +
                              reason + ")");
        }

        // ah-defect retry: on a wall-clock cadence, re-enqueue a unit that has NO composite
        // record yet but whose texpos is NOW populated (DF has rendered it since -- e.g. a
        // player's camera passed over a never-before-drawn generated creature). The normal
        // dirty path only fires on a CHANGE and only if a pass runs at the right moment; this
        // is the belt-and-braces sweep that un-freezes the 641/1873 stuck records. Gated to
        // texpos-present (new_texpos[0][0] != 0) so we never re-queue a unit with nothing to
        // copy, and to record-less units so it is bounded and cheap. enqueue_dirty_locked
        // dedups against anything already queued this pass.
        if (retry_due && !dirty && new_texpos[0][0] != 0 && !have_record.count(id)) {
            enqueue_dirty_locked(id);
            ++retry_requeued;
        }
    }

    // Purge tracker entries for ids no longer present in `active` at all --
    // DF recycles unit slots, so a stale id must never be trusted (scout §3).
    for (auto it = g_tracker.begin(); it != g_tracker.end(); ) {
        if (seen.count(it->first)) { ++it; continue; }
        g_dirty_set.erase(it->first);
        it = g_tracker.erase(it);
        ++stats.units_purged;
    }

    stats.tracker_size = (int)g_tracker.size();
    stats.queue_size = (int)g_dirty_queue.size();
    g_last_stats = stats;

    if (retry_due && retry_requeued > 0) {
        diagnostics_log_v("unit-census: ah-defect retry re-enqueued " +
                          std::to_string(retry_requeued) +
                          " record-less rendered unit(s) for export");
    }

    // Safety-rescan heartbeat (spec: slow ~150-tick cadence). The per-pass hash
    // compare above already re-verifies every unit's identity on EVERY pass -- a
    // strict superset of the 150-tick rescan -- so this is a single QA-visible
    // log line per cadence window, not extra reads. Logged ONCE per crossing
    // (not per unit; that spammed 1 line/unit in the first cut).
    if (pass - g_last_heartbeat_pass >= kSafetyRescanPasses) {
        g_last_heartbeat_pass = pass;
        diagnostics_log_v("unit-census: safety rescan pass " + std::to_string(pass) +
                          " scanned=" + std::to_string(stats.units_scanned) +
                          " tracker=" + std::to_string(g_tracker.size()) +
                          " dirty_queue=" + std::to_string(g_dirty_queue.size()));
    }
    return stats;
}

size_t drain_dirty_queue(std::vector<int32_t>& out, size_t max) {
    std::lock_guard<std::mutex> lock(g_mu);
    size_t n = 0;
    while (n < max && !g_dirty_queue.empty()) {
        int32_t id = g_dirty_queue.front();
        g_dirty_queue.pop_front();
        g_dirty_set.erase(id);
        if (!g_tracker.count(id)) continue; // purged before being drained
        out.push_back(id);
        ++n;
    }
    return n;
}

UnitCensusStats unit_census_last_stats() {
    std::lock_guard<std::mutex> lock(g_mu);
    return g_last_stats;
}

size_t unit_census_tracker_size() {
    std::lock_guard<std::mutex> lock(g_mu);
    return g_tracker.size();
}

// ===========================================================================
// WE-2 -- composite export service. See unit_sprites.h for the design note;
// this block is self-contained (its own mutexes, its own background thread)
// so it never needs to touch the WE-1 tracker's internals beyond the public
// drain_dirty_queue() hook WE-1 already exposes for this purpose.
// ===========================================================================
namespace {

#ifdef _WIN32
int we2_seh_filter(struct _EXCEPTION_POINTERS*) { return EXCEPTION_EXECUTE_HANDLER; }
#endif

// One copied texpos cell's pixels, in the R,G,B,A memory order that
// DFSDL_ConvertSurface(..., SDL_PIXELFORMAT_ABGR8888, ...) produces on a
// little-endian machine (same normalisation tile_dump.cpp's dump_atlas_impl
// uses -- see its comment for why ABGR8888 is the "RGBA on little-endian"
// target format).
struct CellPixels {
    int i = 0, j = 0;   // original unit.texpos[i][j] indices (col, row-from-top)
    int w = 0, h = 0;   // this cell's pixel dimensions (32x32 for the standard tileset)
    std::vector<uint8_t> rgba;
};

// Allocated once and never freed (DFSDL exposes no DFSDL_FreeFormat -- same
// one-shot-leak tradeoff tile_dump.cpp's dump_atlas_impl documents). Unlike
// dump_atlas_impl (called once per manual /tiledump?atlas=1), this function
// is called once per dirty unit for the life of the plugin, so allocating a
// fresh SDL_PixelFormat every call would be a real per-export leak -- cache it.
SDL_PixelFormat* abgr8888_format() {
    static SDL_PixelFormat* fmt = DFHack::DFSDL::DFSDL_AllocFormat(SDL_PIXELFORMAT_ABGR8888);
    return fmt;
}

// Object-owning worker (locals with destructors), called only from the SEH
// wrapper below -- never contains __try itself (MSVC C2712: __try cannot
// coexist with unwindable locals in the same function; tile_dump.cpp's
// dump_atlas/dump_atlas_impl split exists for the same reason).
bool copy_unit_texture_cells_impl(df::unit* u, std::vector<CellPixels>& cells, std::string* err) {
    auto en = df::global::enabler;
    if (!en) { if (err) *err = "no enabler"; return false; }
    auto& raws = en->textures.raws;
    SDL_PixelFormat* fmt = abgr8888_format();
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 2; ++j) {
            if (!u->texpos_currently_in_use[i][j]) continue;
            int32_t tp = u->texpos[i][j];
            if (tp <= 0 || static_cast<size_t>(tp) >= raws.size()) continue;
            SDL_Surface* s = reinterpret_cast<SDL_Surface*>(raws[tp]);
            if (!s || !s->pixels || s->w <= 0 || s->h <= 0) continue;
            SDL_Surface* conv = fmt ? DFHack::DFSDL::DFSDL_ConvertSurface(s, fmt, 0) : nullptr;
            SDL_Surface* use = conv ? conv : s;
            CellPixels cp;
            cp.i = i; cp.j = j; cp.w = use->w; cp.h = use->h;
            cp.rgba.resize(static_cast<size_t>(use->w) * use->h * 4);
            for (int y = 0; y < use->h; ++y)
                std::memcpy(cp.rgba.data() + static_cast<size_t>(y) * use->w * 4,
                            reinterpret_cast<const uint8_t*>(use->pixels) + static_cast<size_t>(y) * use->pitch,
                            static_cast<size_t>(use->w) * 4);
            cells.push_back(std::move(cp));
            if (conv) DFHack::DFSDL::DFSDL_FreeSurface(conv);
        }
    }
    return true; // an empty `cells` (all slots blank/out-of-range) is a valid outcome
}

// SEH wrapper only -- no unwindable locals. Never dereferences a texpos slot
// outside this one render-thread hop (scout §3: DF recycles slots).
bool copy_unit_texture_cells(df::unit* u, std::vector<CellPixels>& cells, std::string* err) {
    bool ok = false;
#ifdef _WIN32
    __try {
#endif
        ok = copy_unit_texture_cells_impl(u, cells, err);
#ifdef _WIN32
    } __except (we2_seh_filter(GetExceptionInformation())) {
        if (err) *err = "SEH fault copying unit texture cells";
        ok = false;
    }
#endif
    return ok;
}

// One unit's assembled composite, ready for FNV hashing and PNG encoding.
struct AssembledSprite {
    int sw = 0, sh = 0;         // span, cells
    int ax = 0, ay = 0;         // anchor cell within the span
    int cell_w = 0, cell_h = 0; // pixel size of one cell (uniform across the span)
    std::vector<uint8_t> rgba;  // R,G,B,A memory order, (sw*cell_w) x (sh*cell_h)
};

// Span/anchor rule (scout §3, spec WE-2 step 3): the bounding box is driven
// by which texpos SLOTS are in use (structural signal), not by which pixels
// happen to be non-transparent -- a legitimately blank allocated cell must
// still occupy its place in the span ("keep geometry"). anchor col = 0 if
// sw==1 else 1; anchor row = sh-1 (bottom row -- DF's texpos[i][j] is
// row-from-top, so the unit's own tile is always the LAST row in the span).
bool assemble_sprite(const std::vector<CellPixels>& cells, const bool in_use[3][2],
                     AssembledSprite& out) {
    int min_i = 3, max_i = -1, min_j = 2, max_j = -1;
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 2; ++j)
            if (in_use[i][j]) {
                min_i = std::min(min_i, i); max_i = std::max(max_i, i);
                min_j = std::min(min_j, j); max_j = std::max(max_j, j);
            }
    if (max_i < 0) return false; // nothing in use right now -- no composite to export

    out.sw = std::max(1, std::min(3, max_i - min_i + 1));
    out.sh = std::max(1, std::min(2, max_j - min_j + 1));
    out.ax = (out.sw == 1) ? 0 : 1;
    out.ay = out.sh - 1;

    if (cells.empty()) return false; // in-use slots exist but every surface was null/out of range
    out.cell_w = cells.front().w;
    out.cell_h = cells.front().h;
    for (const auto& c : cells)
        if (c.w != out.cell_w || c.h != out.cell_h) return false; // non-uniform: bail, don't guess

    out.rgba.assign(static_cast<size_t>(out.sw) * out.cell_w *
                     static_cast<size_t>(out.sh) * out.cell_h * 4, 0);
    const int canvas_w_px = out.sw * out.cell_w;
    for (const auto& c : cells) {
        int ci = c.i - min_i;
        int cj = c.j - min_j;
        if (ci < 0 || ci >= out.sw || cj < 0 || cj >= out.sh) continue; // bbox math guarantees this
        for (int y = 0; y < c.h; ++y) {
            uint8_t* dst = out.rgba.data() +
                (static_cast<size_t>(cj * out.cell_h + y) * canvas_w_px +
                 static_cast<size_t>(ci) * out.cell_w) * 4;
            const uint8_t* src = c.rgba.data() + static_cast<size_t>(y) * c.w * 4;
            std::memcpy(dst, src, static_cast<size_t>(c.w) * 4);
        }
    }
    return true;
}

// CapturedFrame.bgra is B,G,R,A memory order (GDI+'s PixelFormat32bppARGB
// native layout -- see image_encoder.cpp); the assembled sprite is R,G,B,A
// (ABGR8888-converted). Swap channels 0/2 so encode_png's output PNG has the
// correct standard R,G,B,A pixel values.
CapturedFrame to_captured_frame_bgra(const AssembledSprite& sp) {
    CapturedFrame f;
    f.width = sp.sw * sp.cell_w;
    f.height = sp.sh * sp.cell_h;
    f.bgra.resize(sp.rgba.size());
    for (size_t p = 0; p + 3 < sp.rgba.size(); p += 4) {
        f.bgra[p + 0] = sp.rgba[p + 2];
        f.bgra[p + 1] = sp.rgba[p + 1];
        f.bgra[p + 2] = sp.rgba[p + 0];
        f.bgra[p + 3] = sp.rgba[p + 3];
    }
    return f;
}

std::string to_hex16(uint64_t v) {
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(v));
    return std::string(buf, 16);
}

// Content-addressed LRU PNG cache (spec: cap 1024 entries). Guarded by its
// own mutex, independent of the WE-1 tracker's g_mu.
struct CacheEntry {
    std::vector<uint8_t> png;
    std::list<std::string>::iterator lru_it;
};
constexpr size_t kMaxCacheEntries = 1024;
std::mutex g_cache_mu;
std::list<std::string> g_lru; // front = most recently used
std::unordered_map<std::string, CacheEntry> g_cache;

bool cache_get_locked(const std::string& hash, std::vector<uint8_t>& out) {
    auto it = g_cache.find(hash);
    if (it == g_cache.end()) return false;
    g_lru.splice(g_lru.begin(), g_lru, it->second.lru_it); // move-to-front, no realloc
    out = it->second.png;
    return true;
}

// Returns true iff `hash` was newly inserted (a genuinely new appearance);
// false if it already existed (content-addressed dedup hit -- `png` unused).
bool cache_put_locked(const std::string& hash, std::vector<uint8_t> png, uint64_t& evictions) {
    auto it = g_cache.find(hash);
    if (it != g_cache.end()) {
        g_lru.splice(g_lru.begin(), g_lru, it->second.lru_it);
        return false;
    }
    g_lru.push_front(hash);
    CacheEntry entry;
    entry.png = std::move(png);
    entry.lru_it = g_lru.begin();
    g_cache.emplace(hash, std::move(entry));
    if (g_cache.size() > kMaxCacheEntries) {
        const std::string victim = g_lru.back();
        g_lru.pop_back();
        g_cache.erase(victim);
        ++evictions;
    }
    return true;
}

// unit_id -> current composite record. WE-3 will read this to populate the
// AUX wire's "ah"/"sw"/"sh"/"ax"/"ay" fields; the /unit-sprite listing route
// reads it as this item's interim/QA surface.
std::mutex g_records_mu;
std::unordered_map<int32_t, UnitSpriteRecord> g_records;

// ah-defect retry helper (forward-declared near the WE-1 tracker). One lock per ~7s retry sweep.
void census_collect_record_ids(std::unordered_set<int32_t>& out) {
    std::lock_guard<std::mutex> lock(g_records_mu);
    out.reserve(g_records.size());
    for (const auto& kv : g_records) out.insert(kv.first);
}

// Accumulated counters for /diag; cache_size/records_tracked are read live
// from their own containers at snapshot time rather than double-booked here.
std::mutex g_stats_mu;
uint64_t g_exports_attempted = 0;
uint64_t g_exports_succeeded = 0;
uint64_t g_exports_skipped_blank = 0;
uint64_t g_hashes_new = 0;
uint64_t g_hashes_reused = 0;
uint64_t g_cache_evictions = 0;
uint64_t g_last_batch_units = 0;
double g_last_render_hop_ms = 0.0;

// Background worker lifecycle.
std::atomic<bool> g_export_enabled{false};
std::atomic<bool> g_worker_running{false}; // idempotent-start guard
std::atomic<bool> g_worker_stop{false};
std::thread g_worker_thread;
std::mutex g_worker_wake_mu;
std::condition_variable g_worker_wake_cv;

struct BatchUnitCopy {
    int32_t unit_id = -1;
    bool found = false;
    bool in_use[3][2] = {{false, false}, {false, false}, {false, false}};
    std::vector<CellPixels> cells;
};

// One render-thread hop for a whole batch of dirty unit ids (spec: "drain
// the WE-1 dirty queue at most once per render frame"). CoreSuspender budget
// is ZERO -- runOnRenderThread hops onto DF's render thread, not a
// core-suspended context (same LAW tile_dump.cpp's header comment states).
// Hashing + PNG encoding happen back on the CALLING thread (the export
// worker, or the HTTP handler thread for unit_sprite_export_now), never on
// the render thread itself, per spec step 2.
void export_batch_on_render_thread(const std::vector<int32_t>& ids) {
    auto prom = std::make_shared<std::promise<std::vector<BatchUnitCopy>>>();
    auto fut = prom->get_future();
    const auto t0 = std::chrono::steady_clock::now();

    DFHack::runOnRenderThread([ids, prom]() {
        std::vector<BatchUnitCopy> out;
        out.reserve(ids.size());
        for (int32_t id : ids) {
            BatchUnitCopy bc;
            bc.unit_id = id;
            df::unit* u = df::unit::find(id);
            if (u) {
                std::memcpy(bc.in_use, u->texpos_currently_in_use, sizeof(bc.in_use));
                std::string cerr;
                if (copy_unit_texture_cells(u, bc.cells, &cerr)) {
                    bc.found = true;
                } else {
                    diagnostics_log_v("unit-sprite: copy failed unit=" + std::to_string(id) +
                                      ": " + cerr);
                }
            }
            out.push_back(std::move(bc));
        }
        prom->set_value(std::move(out));
    });

    if (fut.wait_for(std::chrono::seconds(5)) != std::future_status::ready) {
        diagnostics_log("unit-sprite: export batch render-thread hop timed out (" +
                        std::to_string(ids.size()) + " units)");
        return;
    }
    std::vector<BatchUnitCopy> batch = fut.get();
    const double hop_ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();

    uint64_t local_new = 0, local_reused = 0, local_evictions = 0;
    uint64_t local_attempted = 0, local_succeeded = 0, local_skipped = 0;

    for (auto& bc : batch) {
        ++local_attempted;
        if (!bc.found) {
            // Unit vanished between being marked dirty and this hop (died / left the
            // fort / a bad id) -- drop any stale record rather than serve it forever.
            std::lock_guard<std::mutex> lock(g_records_mu);
            g_records.erase(bc.unit_id);
            continue;
        }

        AssembledSprite sp;
        if (!assemble_sprite(bc.cells, bc.in_use, sp)) {
            ++local_skipped;
            continue;
        }

        uint64_t h = 1469598103934665603ull;
        h = fnv1a(h, sp.rgba.data(), sp.rgba.size());
        struct { int32_t sw, sh, cw, ch; } dims{sp.sw, sp.sh, sp.cell_w, sp.cell_h};
        h = fnv1a(h, &dims, sizeof(dims));
        const std::string hash = to_hex16(h);

        {
            std::lock_guard<std::mutex> lock(g_cache_mu);
            std::vector<uint8_t> existing;
            if (cache_get_locked(hash, existing)) {
                ++local_reused;
            } else {
                CapturedFrame frame = to_captured_frame_bgra(sp);
                std::vector<uint8_t> png;
                std::string perr;
                if (!encode_png(frame, png, &perr)) {
                    diagnostics_log("unit-sprite: encode_png failed unit=" +
                                    std::to_string(bc.unit_id) + ": " + perr);
                    continue;
                }
                uint64_t ev = 0;
                bool inserted = cache_put_locked(hash, std::move(png), ev);
                local_evictions += ev;
                if (inserted) ++local_new; else ++local_reused;
            }
        }

        UnitSpriteRecord rec;
        rec.hash = hash; rec.sw = sp.sw; rec.sh = sp.sh; rec.ax = sp.ax; rec.ay = sp.ay;
        {
            std::lock_guard<std::mutex> lock(g_records_mu);
            g_records[bc.unit_id] = rec;
        }
        ++local_succeeded;
    }

    std::lock_guard<std::mutex> lock(g_stats_mu);
    g_exports_attempted += local_attempted;
    g_exports_succeeded += local_succeeded;
    g_exports_skipped_blank += local_skipped;
    g_hashes_new += local_new;
    g_hashes_reused += local_reused;
    g_cache_evictions += local_evictions;
    g_last_batch_units = batch.size();
    g_last_render_hop_ms = hop_ms;
}

// Background worker: polls WE-1's dirty queue and exports. Parks on a short
// wait (woken early by set_unit_sprite_export_enabled) when the feature flag
// is off, doing no reads/allocation at all -- mirrors unit_census_pass()'s
// no-op-when-disabled contract. There is no ambient "once per render frame"
// hook available to this module (that lives in the WA-9 read pass / WA-11's
// push loop, out of this item's territory), so a ~30Hz timer is the closest
// available proxy for the spec's per-frame cadence; the ≤32-units-per-hop
// cap is the actual budget guarantee, not the wake interval.
void export_worker_loop() {
    std::vector<int32_t> batch_ids;
    while (!g_worker_stop.load(std::memory_order_relaxed)) {
        if (!g_export_enabled.load(std::memory_order_relaxed)) {
            std::unique_lock<std::mutex> lk(g_worker_wake_mu);
            g_worker_wake_cv.wait_for(lk, std::chrono::milliseconds(250),
                                      [] { return g_worker_stop.load(std::memory_order_relaxed); });
            continue;
        }
        batch_ids.clear();
        size_t n = drain_dirty_queue(batch_ids, 32); // spec's per-hop cap
        if (n == 0) {
            std::unique_lock<std::mutex> lk(g_worker_wake_mu);
            g_worker_wake_cv.wait_for(lk, std::chrono::milliseconds(33),
                                      [] { return g_worker_stop.load(std::memory_order_relaxed); });
            continue;
        }
        export_batch_on_render_thread(batch_ids);
    }
}

} // namespace

bool unit_sprite_export_enabled() { return g_export_enabled.load(std::memory_order_relaxed); }

void set_unit_sprite_export_enabled(bool on) {
    g_export_enabled.store(on, std::memory_order_relaxed);
    g_worker_wake_cv.notify_all(); // wake promptly instead of waiting out the poll interval
}

void unit_sprite_export_ensure_started() {
    if (g_worker_running.exchange(true)) return; // already started -- idempotent
    g_worker_stop.store(false, std::memory_order_relaxed);
    g_worker_thread = std::thread(export_worker_loop);
}

void unit_sprite_export_shutdown() {
    if (!g_worker_running.load()) return;
    g_worker_stop.store(true, std::memory_order_relaxed);
    g_worker_wake_cv.notify_all();
    if (g_worker_thread.joinable()) g_worker_thread.join();
    g_worker_running.store(false);
}

bool unit_sprite_cache_get(const std::string& hash, std::vector<uint8_t>& png_out) {
    std::lock_guard<std::mutex> lock(g_cache_mu);
    return cache_get_locked(hash, png_out);
}

std::unordered_map<int32_t, UnitSpriteRecord> unit_sprite_snapshot() {
    std::lock_guard<std::mutex> lock(g_records_mu);
    return g_records;
}

UnitSpriteExportStats unit_sprite_export_stats() {
    UnitSpriteExportStats s;
    {
        std::lock_guard<std::mutex> lock(g_stats_mu);
        s.exports_attempted = g_exports_attempted;
        s.exports_succeeded = g_exports_succeeded;
        s.exports_skipped_blank = g_exports_skipped_blank;
        s.hashes_new = g_hashes_new;
        s.hashes_reused = g_hashes_reused;
        s.cache_evictions = g_cache_evictions;
        s.last_batch_units = g_last_batch_units;
        s.last_render_hop_ms = g_last_render_hop_ms;
    }
    { std::lock_guard<std::mutex> lock(g_cache_mu); s.cache_size = g_cache.size(); }
    { std::lock_guard<std::mutex> lock(g_records_mu); s.records_tracked = g_records.size(); }
    return s;
}

bool unit_sprite_export_now(int32_t unit_id, UnitSpriteRecord& out, std::string* err) {
    export_batch_on_render_thread(std::vector<int32_t>{unit_id});
    std::lock_guard<std::mutex> lock(g_records_mu);
    auto it = g_records.find(unit_id);
    if (it == g_records.end()) {
        if (err) *err = "unit has no in-use texpos slot (no composite to export right now)";
        return false;
    }
    out = it->second;
    return true;
}

} // namespace dwf
