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
//
// Unit texture census + dirty tracking, and the composite PNG export service it feeds.

#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "df/unit.h"

namespace dwf {

// One census pass' outcome, for /diag + capture-diag-verbose logging.
struct UnitCensusStats {
    int units_scanned = 0;   // active units actually read this pass (visible ones)
    int units_skipped_hidden = 0; // active units skipped: ambushed / on an unrevealed tile
    int units_dirty = 0;     // units newly marked dirty this pass
    int units_purged = 0;    // tracker entries dropped (unit id no longer in active list)
    int tracker_size = 0;    // tracker map size AFTER this pass
    int queue_size = 0;      // dirty queue size AFTER this pass (coalesced by unit id)
};

// Runs the census over world->units.active, unfiltered by any viewport. Must be called from
// inside the caller's CoreSuspender; a zeroed no-op while unit_census_enabled() is false.
UnitCensusStats unit_census_pass(const std::vector<df::unit*>& active);

// Feature flag -- default OFF; toggled by the `capture-unit-census on|off` DFHack command.
bool unit_census_enabled();
void set_unit_census_enabled(bool on);

// Drains up to `max` unit ids from the dirty queue into `out`: FIFO, deduplicated, purged ids
// skipped without counting against `max`. Returns the number appended.
size_t drain_dirty_queue(std::vector<int32_t>& out, size_t max);

// ---------------- composite export: dirty census ids -> content-addressed PNGs, served at
// GET /unit-sprite/<hash>.png. Copies DF's own texpos surfaces; never re-renders or recomposites.

struct UnitSpriteRecord {
    std::string hash;   // 16 lowercase hex chars: FNV-1a-64(RGBA bytes + span dims)
    int sw = 0;          // span width, cells (1..3)
    int sh = 0;          // span height, cells (1..2)
    int ax = 0;          // anchor cell col within the span (0 if sw==1, else 1)
    int ay = 0;          // anchor cell row within the span (sh - 1 -- bottom)
};

// Feature flag -- default OFF, independent of unit_census_enabled(); toggled by
// `capture-unit-sprites on|off`.
bool unit_sprite_export_enabled();
void set_unit_sprite_export_enabled(bool on);

// Idempotent and safe from any thread; the started worker stays inert until the flag is on too.
void unit_sprite_export_ensure_started();

// Stops and joins the worker; safe if never started. Must run from plugin_shutdown -- a worker
// thread that outlives the DLL crashes DF on unload.
void unit_sprite_export_shutdown();

// HTTP route support --------------------------------------------------------

// Cache lookup by content hash; false when never produced or LRU-evicted. This route is
// cache-only: satisfying it must never touch DF state.
bool unit_sprite_cache_get(const std::string& hash, std::vector<uint8_t>& png_out);

// Snapshot of unit_id -> current composite record; backs the `/unit-sprite` listing response.
std::unordered_map<int32_t, UnitSpriteRecord> unit_sprite_snapshot();

// /diag and QA support.
struct UnitSpriteExportStats {
    uint64_t exports_attempted = 0;     // dirty ids drained + handed to the render thread
    uint64_t exports_succeeded = 0;     // produced a non-empty composite record
    uint64_t exports_skipped_blank = 0; // unit had no in-use texpos slot (nothing to export)
    uint64_t hashes_new = 0;            // distinct hashes newly inserted into the PNG cache
    uint64_t hashes_reused = 0;         // export matched an already-cached hash (dedup working)
    uint64_t cache_evictions = 0;
    size_t cache_size = 0;
    size_t records_tracked = 0;
    uint64_t last_batch_units = 0;
    double last_render_hop_ms = 0.0;
};
UnitSpriteExportStats unit_sprite_export_stats();

// Lazily exports ONE native creature key rather than walking the whole key space per frame.
// `path` is an oracle scalar/global key, or "layer_unitless" with a profession index.
bool unit_sprite_export_key(int32_t unit_id, int32_t race, int32_t caste,
                            const std::string& path, int profession,
                            UnitSpriteRecord& out, std::string* err = nullptr);


} // namespace dwf
