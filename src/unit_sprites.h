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
// ===========================================================================
// WE-1 -- unit texture census + dirty tracking (spec:
// docs/superpowers/specs/2026-07-07-WE-dwarf-compositing-spec.md, scout:
// docs/superpowers/scout/we-unit-appearance.md).
//
// DF composites every layered unit (dwarf/civ-humanoid/animal-person/layered
// domestic) into its own runtime texture slots (`unit.texpos[3][2]`). This
// module does NOT touch pixels -- it only watches the per-unit texture
// IDENTITY (slot ids + DF's own composite-dirty flag) so a future exporter
// (WE-2, not yet built) knows WHICH units need a fresh composite copy,
// without re-copying/re-hashing pixels for units that haven't changed.
//
// Call sites: unit_census_pass() runs in BOTH unit-read paths: emit_units()
// (tile_map_dump.cpp, legacy /mapdata) and world_stream.cpp's one neutral v1
// unit scan. Both already hold CoreSuspender, so this adds no separate
// suspension. Keeping both is required: once a v1 WebSocket is live the
// browser stops polling /mapdata, and otherwise a unit that arrives later is
// never discovered or queued for composite export (B278).
// ===========================================================================

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

// Runs the census over `active` (world->units.active, unfiltered by any
// viewport -- WE-2's future export target is "every unit any player might
// see", not one player's current window). No-op (returns a zeroed stats
// struct) when the feature flag is off -- see unit_census_enabled().
//
// Per active unit: skip (no read, tracker entry left untouched) if
// `flags1.hidden_in_ambush` or the unit's own tile is unrevealed (DF never
// composites either case -- scout §3, same rule WE-5 applies to the wire).
// Otherwise read `texpos[3][2]`, `texpos_currently_in_use[3][2]`, and
// `flags4.any_texture_must_be_refreshed`, and mark the unit DIRTY when:
//   - first seen with a nonzero texpos[0][0] (a fresh composite exists), or
//   - any slot id / in-use bit changed since last seen, or
//   - the refresh flag fell (true -> false: DF just finished recompositing).
// Dirty unit ids are pushed to a bounded, coalesced-by-id queue (drained by
// drain_dirty_queue(), the future WE-2 consumer). Tracker entries for unit
// ids no longer present in `active` at all are purged (DF recycles unit
// slots -- a stale id must never be trusted downstream).
//
// Must be called from inside the caller's CoreSuspender (same context as
// emit_units) -- it performs no I/O and no allocation beyond the tracker /
// queue's own amortized growth.
UnitCensusStats unit_census_pass(const std::vector<df::unit*>& active);

// Feature flag -- default OFF (mirrors capture-diag-verbose's pattern).
// When off, unit_census_pass() is a pure no-op: no reads, no tracker/queue
// mutation, so emit_units()'s legacy JSON output is provably unaffected
// (WE-1 acceptance: "legacy JSON path byte-identical when feature flag
// off"). Toggle with the `capture-unit-census on|off` DFHack command.
bool unit_census_enabled();
void set_unit_census_enabled(bool on);

// Drains up to `max` unit ids from the dirty queue into `out` (FIFO,
// deduplicated -- an id already queued is never pushed twice). Ids for
// units purged from the tracker before being drained are silently skipped
// (not counted against `max`). Returns the number of ids appended to `out`.
// This is the hook WE-2's export step will call; unused by WE-1 itself
// beyond diagnostics (unit_census_last_stats().queue_size).
size_t drain_dirty_queue(std::vector<int32_t>& out, size_t max);

// Snapshot of the most recent unit_census_pass() outcome (for /diag).
UnitCensusStats unit_census_last_stats();

// Total distinct unit ids currently tracked (for /diag).
size_t unit_census_tracker_size();

// ===========================================================================
// WE-2 -- composite export service (same spec doc, item WE-2). Turns WE-1's
// dirty-unit ids into content-addressed PNG sprites: DF's own per-unit
// texpos cells, copied verbatim off the render thread (the validated
// runOnRenderThread + SEH-wrapper + DFSDL_ConvertSurface-to-ABGR8888 pattern
// tile_dump.cpp's dump_atlas_impl uses -- reused exactly, not reinvented),
// hashed + PNG-encoded on a worker thread, and served at
// GET /unit-sprite/<16-hex>.png (see http_server.cpp).
//
// Parity is exact by construction: the exporter never re-renders or
// recomposites anything -- it copies the SAME SDL surfaces DF's own creature
// layers already reference (enabler->textures.raws[texpos]). A byte-compare
// against a /tiledump?atlas=1 atlas cell for the same texpos is expected to
// be 100% identical; any diff is an exporter bug (this item's acceptance
// gate).
// ===========================================================================

// One unit's most recent composite record -- the future WE-3 AUX wire shape
// ("ah"/"sw"/"sh"/"ax"/"ay") lives here first.
struct UnitSpriteRecord {
    std::string hash;   // 16 lowercase hex chars: FNV-1a-64(RGBA bytes + span dims)
    int sw = 0;          // span width, cells (1..3)
    int sh = 0;          // span height, cells (1..2)
    int ax = 0;          // anchor cell col within the span (0 if sw==1, else 1)
    int ay = 0;          // anchor cell row within the span (sh - 1 -- bottom)
};

// Feature flag -- default OFF, independent of unit_census_enabled() (a unit
// can be census-tracked with the exporter still off, e.g. for a WE-1-only
// test). When on, the background worker (see unit_sprite_export_ensure_started)
// drains WE-1's dirty queue and exports; when off, the worker still wakes on
// its poll interval but skips the render-thread hop entirely -- no reads, no
// allocation. Toggle with `capture-unit-sprites on|off` (mirrors
// capture-unit-census).
bool unit_sprite_export_enabled();
void set_unit_sprite_export_enabled(bool on);

// Idempotent: starts the background export worker on first call, no-op on
// later calls. Safe from any thread. The worker itself is inert (see above)
// unless the feature flag is also on -- starting it early (e.g. at
// /unit-sprite route registration) costs nothing but a parked thread.
void unit_sprite_export_ensure_started();

// Stops and joins the worker thread. Safe even if never started or already
// stopped. Call from plugin_shutdown so no thread outlives the DLL.
void unit_sprite_export_shutdown();

// HTTP route support --------------------------------------------------------

// Cache lookup by content hash (the `/unit-sprite/<hash>.png` path segment).
// Returns false (caller should 404) if the hash was never produced or has
// since been evicted from the LRU cache -- callers must never touch DF state
// to satisfy this, per the spec (content-addressed cache-only route).
bool unit_sprite_cache_get(const std::string& hash, std::vector<uint8_t>& png_out);

// Snapshot of unit_id -> current composite record. Backs the `/unit-sprite`
// listing response, this item's manual oracle-parity QA surface (WE-3 will
// additionally place the same fields on the live wire).
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

// Oracle/gate helper: synchronously (re)exports ONE unit's CURRENT texpos
// state on the render thread, bypassing the dirty queue/background worker,
// and refreshes its cache entry + record. Used by this item's manual parity
// check and reusable by WE-8's gate_unitsprites.py. Returns false if the
// unit is not found or has no in-use texpos slot right now.
bool unit_sprite_export_now(int32_t unit_id, UnitSpriteRecord& out, std::string* err = nullptr);

} // namespace dwf
