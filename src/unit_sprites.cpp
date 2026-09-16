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
#include "fnv.h"
#include "frame.h"
#include "image_encoder.h"

#include "Core.h"
#include "modules/DFSDL.h"
#include "modules/Maps.h"

#include "df/enabler.h"
#include "df/global_objects.h"
#include "df/map_block.h"
#include "df/world.h"
#include "df/creature_raw.h"
#include "df/caste_raw.h"
#include "df/tile_designation.h"
#include "df/unit_flags1.h"
#include "df/unit_flags4.h"
#include "df/creature_raw.h"
#include "df/caste_raw.h"
#include "df/creature_raw_graphics.h"
#include "df/graphic.h"
#include "df/profession.h"

#include <SDL_surface.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
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

// passes between safety-rescan heartbeat log lines
constexpr uint64_t kSafetyRescanPasses = 150;

// Record-retry cadence, keyed on the WALL CLOCK rather than sim ticks so it still fires while the
// world is paused. A unit DF has never rendered has no texpos, so nothing ever marks it dirty.
constexpr auto kRecordRetryInterval = std::chrono::seconds(7);

// defensive cap on the dirty queue (coalesced by id, so normal operation stays far below it)
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
// wall-clock timestamp of the last record-retry sweep
std::chrono::steady_clock::time_point g_last_record_retry{};

std::atomic<bool> g_enabled{false};

// Fills `out` with the ids that already have a composite record. One g_records_mu lock per sweep.
void census_collect_record_ids(std::unordered_set<int32_t>& out);

uint64_t hash_identity(const int32_t texpos[3][2], const bool in_use[3][2]) {
    uint64_t h = kFnvOffsetBasis;
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

    // Snapshot the ids that already have a record ONCE per sweep, so the per-unit test below is a
    // set lookup instead of a lock.
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

        // DF composites nothing for a hidden ambusher or a unit on an unrevealed tile. Leave any
        // tracker entry alone rather than purge it: it matters again the moment the unit shows.
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

        // Re-enqueue a unit that has no composite record but whose texpos is now populated. Gated
        // to texpos-present and record-less units, so it never queues a unit with nothing to copy.
        if (retry_due && !dirty && new_texpos[0][0] != 0 && !have_record.count(id)) {
            enqueue_dirty_locked(id);
            ++retry_requeued;
        }
    }

    // Purge tracker entries for ids no longer active: DF recycles unit slots, so a stale id must
    // never be trusted.
    for (auto it = g_tracker.begin(); it != g_tracker.end(); ) {
        if (seen.count(it->first)) { ++it; continue; }
        g_dirty_set.erase(it->first);
        it = g_tracker.erase(it);
        ++stats.units_purged;
    }

    stats.tracker_size = (int)g_tracker.size();
    stats.queue_size = (int)g_dirty_queue.size();

    if (retry_due && retry_requeued > 0) {
        diagnostics_log_v("unit-census: ah-defect retry re-enqueued " +
                          std::to_string(retry_requeued) +
                          " record-less rendered unit(s) for export");
    }

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

// ---- composite export service: its own mutexes, its own background thread -----------------------
namespace {

#ifdef _WIN32
int we2_seh_filter(struct _EXCEPTION_POINTERS*) { return EXCEPTION_EXECUTE_HANDLER; }
#endif

// One copied texpos cell's pixels, in the R,G,B,A memory order DFSDL_ConvertSurface produces for
// SDL_PIXELFORMAT_ABGR8888 on a little-endian machine.
struct CellPixels {
    int i = 0, j = 0;   // original unit.texpos[i][j] indices (col, row-from-top)
    int w = 0, h = 0;   // this cell's pixel dimensions (32x32 for the standard tileset)
    std::vector<uint8_t> rgba;
};

// Allocated once and never freed -- DFSDL exposes no DFSDL_FreeFormat. This runs once per dirty
// unit, so allocating a fresh format per call would be a real per-export leak.
SDL_PixelFormat* abgr8888_format() {
    static SDL_PixelFormat* fmt = DFHack::DFSDL::DFSDL_AllocFormat(SDL_PIXELFORMAT_ABGR8888);
    return fmt;
}

bool copy_texpos_cell(int32_t tp, int i, int j, CellPixels& cp) {
    auto en = df::global::enabler;
    if (!en || tp <= 0 || static_cast<size_t>(tp) >= en->textures.raws.size()) return false;
    SDL_Surface* s = reinterpret_cast<SDL_Surface*>(en->textures.raws[tp]);
    if (!s || !s->pixels || s->w <= 0 || s->h <= 0) return false;
    SDL_PixelFormat* fmt = abgr8888_format();
    SDL_Surface* conv = fmt ? DFHack::DFSDL::DFSDL_ConvertSurface(s, fmt, 0) : nullptr;
    SDL_Surface* use = conv ? conv : s;
    cp.i = i; cp.j = j; cp.w = use->w; cp.h = use->h;
    cp.rgba.resize(static_cast<size_t>(use->w) * use->h * 4);
    for (int y = 0; y < use->h; ++y)
        std::memcpy(cp.rgba.data() + static_cast<size_t>(y) * use->w * 4,
                    reinterpret_cast<const uint8_t*>(use->pixels) + static_cast<size_t>(y) * use->pitch,
                    static_cast<size_t>(use->w) * 4);
    if (conv) DFHack::DFSDL::DFSDL_FreeSurface(conv);
    return true;
}

bool copy_texpos_cell_safe(int32_t tp, int i, int j, CellPixels& cp) {
    bool ok = false;
#ifdef _WIN32
    __try {
#endif
        ok = copy_texpos_cell(tp, i, j, cp);
#ifdef _WIN32
    } __except (we2_seh_filter(GetExceptionInformation())) {
        ok = false;
    }
#endif
    return ok;
}


// Object-owning half, called only from the SEH wrapper below: MSVC C2712 forbids __try in a
// function that also has unwindable locals.
bool copy_unit_texture_cells_impl(df::unit* u, std::vector<CellPixels>& cells, std::string* err) {
    if (!df::global::enabler) { if (err) *err = "no enabler"; return false; }
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 2; ++j) {
            if (!u->texpos_currently_in_use[i][j]) continue;
            CellPixels cp;
            if (copy_texpos_cell(u->texpos[i][j], i, j, cp)) cells.push_back(std::move(cp));
        }
    }
    return true; // an empty `cells` (all slots blank/out-of-range) is a valid outcome
}

// SEH wrapper only -- no unwindable locals. Never dereferences a texpos slot outside this one
// render-thread hop: DF recycles slots.
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

// The span is driven by which texpos SLOTS are in use, not by which pixels are non-transparent: a
// blank allocated cell still holds its place. texpos j is row-from-top, so the unit is the last row.
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

// CapturedFrame.bgra is B,G,R,A (GDI+ 32bppARGB) while the assembled sprite is R,G,B,A, so swap
// channels 0 and 2 to make encode_png write standard RGBA.
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

// Content-addressed LRU PNG cache, guarded by its own mutex, independent of the census tracker's.
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

// True iff `hash` was newly inserted; false on a content-addressed dedup hit, where `png` is unused.
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

// unit_id -> current composite record; the source of the AUX wire's "ah"/"sw"/"sh"/"ax"/"ay" fields.
std::mutex g_records_mu;
std::unordered_map<int32_t, UnitSpriteRecord> g_records;

// One g_records_mu lock per retry sweep.
void census_collect_record_ids(std::unordered_set<int32_t>& out) {
    std::lock_guard<std::mutex> lock(g_records_mu);
    out.reserve(g_records.size());
    for (const auto& kv : g_records) out.insert(kv.first);
}

// Accumulated /diag counters. cache_size and records_tracked are read live from their containers.
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

// runOnRenderThread hops onto DF's render thread, not a core-suspended context, so the
// CoreSuspender budget here is ZERO; hashing and PNG encoding stay on the calling thread.
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
                std::memcpy(bc.in_use, u->texpos_currently_in_use.data(), sizeof(bc.in_use));
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

        uint64_t h = kFnvOffsetBasis;
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

// Polls the census's dirty queue. While the feature flag is off it parks doing no reads or
// allocation at all; the <=32-units-per-hop cap is the budget guarantee, not the wake interval.
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

bool unit_sprite_export_key(int32_t unit_id, int32_t race, int32_t caste,
                            const std::string& path, int profession,
                            UnitSpriteRecord& out, std::string* err) {
    struct NativeCopy {
        bool found = false;
        bool in_use[3][2] = {{false, false}, {false, false}, {false, false}};
        std::vector<CellPixels> cells;
        std::string error;
    };
    auto prom = std::make_shared<std::promise<NativeCopy>>();
    auto fut = prom->get_future();
    DFHack::runOnRenderThread([unit_id, race, caste, path, profession, prom]() {
        NativeCopy nc;
        df::unit* u = df::unit::find(unit_id);
        auto world = df::global::world;
        if (!world) {
            nc.error = "world not loaded"; prom->set_value(std::move(nc)); return;
        }
        int32_t race_index = u ? u->race : race;
        int32_t caste_index = u ? u->caste : caste;
        df::creature_raw* cr = race_index >= 0 && static_cast<size_t>(race_index) < world->raws.creatures.all.size()
                             ? world->raws.creatures.all[race_index] : nullptr;
        df::caste_raw* ca = cr && caste_index >= 0 && static_cast<size_t>(caste_index) < cr->caste.size()
                          ? cr->caste[caste_index] : nullptr;
        df::creature_raw_graphics* graphics = ca && ca->caste_graphics ? ca->caste_graphics
                                            : (cr ? cr->graphics : nullptr);
        int32_t scalar = 0;
        if (path == "sheet_icon_texpos" && u) scalar = u->sheet_icon_texpos;
        else if (graphics) {
            if (path == "egg_texpos") scalar = graphics->egg_texpos;
            else if (path == "list_icon_texpos") scalar = graphics->list_icon_texpos;
            else if (path == "skeleton_with_skull_texpos") scalar = graphics->skeleton_with_skull_texpos;
            else if (path == "skeleton_texpos") scalar = graphics->skeleton_texpos;
            else if (path == "texpos_glow") scalar = graphics->texpos_glow;
            else if (path == "texpos_glow_left_gone") scalar = graphics->texpos_glow_left_gone;
            else if (path == "texpos_glow_right_gone") scalar = graphics->texpos_glow_right_gone;
            else if (path == "texpos_glow_child") scalar = graphics->texpos_glow_child;
            else if (path.rfind("creature_small_texpos[", 0) == 0 && path.back() == ']') {
                static const char* names[] = {"VERMIN", "VERMIN_ALT", "SWARM_LARGE", "SWARM_MEDIUM",
                    "SWARM_SMALL", "LIGHT_VERMIN", "LIGHT_VERMIN_ALT", "LIGHT_SWARM_LARGE",
                    "LIGHT_SWARM_MEDIUM", "LIGHT_SWARM_SMALL", "REMAINS", "HIVE"};
                std::string name = path.substr(22, path.size() - 23);
                for (int idx = 0; idx <= (int)df::creature_small_texture_type::HIVE; ++idx)
                    if (name == names[idx]) { scalar = graphics->creature_small_texpos[idx]; break; }
            } else if (path == "layer_unitless") {
                int max_prof = (int)df::profession::STANDARD;
                int p = std::max(0, std::min(max_prof, profession));
                for (int i = 0; i < 3; ++i) for (int j = 0; j < 2; ++j) {
                    auto& cells = graphics->layer_unitless_texpos[p][i][j];
                    if (cells.empty()) continue;
                    CellPixels cp;
                    if (copy_texpos_cell_safe(cells.front(), i, j, cp)) {
                        nc.in_use[i][j] = true;
                        nc.cells.push_back(std::move(cp));
                    }
                }
            }
        }
        if (!scalar && df::global::gps) {
            // Frozen oracle global list/fallback cells. Slots are table-relative, never texpos.
            if (path == "generated_feature_beast_list_icon") scalar = df::global::gps->texture_indices4[1115];
            else if (path == "generated_titan_list_icon") scalar = df::global::gps->texture_indices4[1116];
            else if (path == "generated_demon_list_icon") scalar = df::global::gps->texture_indices4[1117];
            else if (path == "generated_night_creature_list_icon") scalar = df::global::gps->texture_indices4[1118];
            else if (path == "generated_other_list_icon") scalar = df::global::gps->texture_indices4[1119];
            else if (path == "corpse_resolution_failed") scalar = df::global::gps->texture_indices7[236];
            else if (path == "vermin_list_icon_fallback") scalar = df::global::gps->texture_indices7[241];
            else if (path == "creature_resolution_failed") scalar = df::global::gps->texture_indices7[416];
            else if (path == "portrait_frame_default") scalar = df::global::gps->texture_indices3[657];
            else if (path == "portrait_frame_variant_a") scalar = df::global::gps->texture_indices3[658];
            else if (path == "portrait_frame_variant_b") scalar = df::global::gps->texture_indices3[659];
            else if (path == "portrait_frame_fallback") scalar = df::global::gps->texture_indices3[660];
        }
        if (scalar) {
            CellPixels cp;
            if (copy_texpos_cell_safe(scalar, 0, 0, cp)) {
                nc.in_use[0][0] = true;
                nc.cells.push_back(std::move(cp));
            }
        }
        nc.found = !nc.cells.empty();
        if (!nc.found && nc.error.empty()) nc.error = "native creature key has no texture";
        prom->set_value(std::move(nc));
    });
    if (fut.wait_for(std::chrono::seconds(5)) != std::future_status::ready) {
        if (err) *err = "native creature key render-thread hop timed out";
        return false;
    }
    NativeCopy nc = fut.get();
    if (!nc.found) { if (err) *err = nc.error; return false; }
    AssembledSprite sp;
    if (!assemble_sprite(nc.cells, nc.in_use, sp)) {
        if (err) *err = "native creature key did not assemble";
        return false;
    }
    uint64_t h = kFnvOffsetBasis;
    h = fnv1a(h, sp.rgba.data(), sp.rgba.size());
    struct { int32_t sw, sh, cw, ch; } dims{sp.sw, sp.sh, sp.cell_w, sp.cell_h};
    h = fnv1a(h, &dims, sizeof(dims));
    const std::string hash = to_hex16(h);
    {
        std::lock_guard<std::mutex> lock(g_cache_mu);
        std::vector<uint8_t> existing;
        if (!cache_get_locked(hash, existing)) {
            CapturedFrame frame = to_captured_frame_bgra(sp);
            std::vector<uint8_t> png;
            std::string perr;
            if (!encode_png(frame, png, &perr)) { if (err) *err = perr; return false; }
            uint64_t evictions = 0;
            cache_put_locked(hash, std::move(png), evictions);
        }
    }
    out.hash = hash; out.sw = sp.sw; out.sh = sp.sh; out.ax = sp.ax; out.ay = sp.ay;
    return true;
}

} // namespace dwf
