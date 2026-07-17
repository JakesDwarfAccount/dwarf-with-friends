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

#include "world_stream.h"

#include "bake_sweep.h"
#include "portrait_sweep.h"

#include "wire_v1.h"
#include "diagnostics.h"
#include "client_state.h"   // camera_for_player
#include "unit_sprites.h"   // WE-3: appearance-hash + span/anchor snapshot
#include "unit_status.h"    // B222: shared overhead-status st bits (kUStat*/unit_status_bits)

#include "Core.h"
#include "DataDefs.h"
#include "TileTypes.h"
#include "modules/Maps.h"
#include "modules/MapCache.h"
#include "modules/Materials.h"
#include "modules/Translation.h"
#include "modules/World.h"    // WC-20: World::ReadCurrentWeather()
#include "modules/Units.h"    // isAlive/isGhost/isFortControlled (status bits now via unit_status.h)
#include "modules/Job.h"      // B135: Job::getWorker (djob worker-claimed flag)
#include "modules/Items.h"    // TX1: Items::getContainedItems (barrel/bin contents fold)

#include "df/global_objects.h"
#include "df/d_init.h"
#include "df/graphic.h"
#include "df/graphic_viewportst.h"
#include "df/world.h"
#include "df/plotinfost.h"                          // P3 audio: env.siege active-invasion scan
#include "df/plot_invasion_infost.h"
#include "df/invasion_info.h"
#include "df/world_data.h"                          // V2 audio: env.evil/savage region-map read
#include "df/world_site.h"
#include "df/region_map_entry.h"
#include "music_sync.h"                             // V2 audio: env.music canonical sync state
#include "df/map_block.h"
#include "df/tile_designation.h"
#include "df/tile_dig_designation.h"   // B204: block_has_active_designation dig/traffic enums
#include "df/tile_traffic.h"
#include "df/unit.h"
#include "df/building.h"
#include "df/building_actual.h"
#include "df/buildingitemst.h"
#include "df/building_item_role_type.h"
#include "df/creature_raw.h"
#include "df/caste_raw.h"
#include "df/material.h"
#include "df/descriptor_color.h"
#include "df/matter_state.h"
// WC-22: projectiles (world->projectiles.all, a proj_list_link linked-list head) + item
// art fields; vehicles (world->vehicles.active).
#include "df/proj_handlerst.h"
#include "df/proj_list_link.h"
#include "df/projectile.h"
#include "df/proj_itemst.h"
#include "df/job.h"
#include "df/job_list_link.h"
#include "df/job_type.h"
#include "df/tiletype_shape.h"
#include "df/vehicle.h"
#include "df/block_square_event.h"
#include "df/block_square_event_material_spatterst.h"
#include "df/block_square_event_item_spatterst.h"   // WC-11: item-spatter amount grid fold
#include "df/block_square_event_grassst.h"           // WC-17: grass coverage amount grid fold
#include "df/block_square_event_designation_priorityst.h"  // WC-19: priority grid fold
#include "df/flow_info.h"                            // WC-15: block->flows fold
#include "df/item.h"   // WC-1: item id/flags fold into block_signature()
// B253: a built statue's sprite identity lives ENTIRELY on the ITEM it was built from
// (df::item_statuest), never on df::building_statuest (which holds one unused `statue_flag`,
// df.building.xml:1520) -- the same root cause as B246. DF has already resolved the subject onto
// the item as art_graphics_type/art_graphics_id (df.item.xml:1532-1542), so we do not walk the
// art_image at all; we forward DF's own two numbers, plus quality + material class.
#include "df/item_statuest.h"
#include "df/item_quality.h"
#include "df/building_statuest.h"
#include "df/art_image.h"
#include "df/art_image_element.h"
#include "df/art_image_element_creaturest.h"
#include "art_desc.h"                                // B253: find_art_image() (shared chunk walk)
// WC-6: building direction/state/category on the AUX wire (machines et al.). All reads run
// inside the existing suspended buildings scan; every cast is virtual_cast (null on mismatch)
// and machine::find is null-checked -- no map-block access, so this adds no crash surface.
#include "df/machine.h"
#include "df/building_screw_pumpst.h"
#include "df/building_water_wheelst.h"
#include "df/building_windmillst.h"
#include "df/building_axle_horizontalst.h"
#include "df/building_axle_verticalst.h"
#include "df/building_gear_assemblyst.h"
#include "df/building_rollersst.h"
#include "df/building_bridgest.h"
#include "df/building_doorst.h"
#include "df/building_hatchst.h"
#include "df/building_floodgatest.h"
#include "df/building_grate_wallst.h"
#include "df/building_grate_floorst.h"
#include "df/building_bars_verticalst.h"
#include "df/building_bars_floorst.h"
#include "df/building_trapst.h"
#include "df/building_wellst.h"
#include "df/building_farmplotst.h"
#include "df/building_stockpilest.h"
#include "df/building_civzonest.h"
#include "df/machine_info.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

// ---- GlobalMapState (§WA-9.1), owned by the push-loop thread (single-threaded access) --
struct GlobalMapState {
    uint32_t world_seq = 0;
    std::unordered_map<uint64_t, uint64_t> sig;   // key -> last block signature
    std::unordered_map<uint64_t, uint32_t> ver;   // key -> world_seq at last observed change
    // Keys which have been considered by the interest sig scanner at least once. This is
    // deliberately separate from `sig`: fully-hidden blocks have no signature, but must not
    // be treated as first-seen (and force-scanned) forever.
    std::unordered_set<uint64_t> sig_seen;
    std::deque<std::pair<uint32_t, std::vector<uint64_t>>> changelog;   // last ~900 dirty ticks
};
constexpr size_t kChangelogMax = 900;
constexpr uint32_t kSigScanBuckets = 4;       // <= 4 push ticks of ordinary detection latency
constexpr uint32_t kPausedIdleScanEvery = 4;  // native paused UI changes are re-read within 4 ticks
// WA-11.1: per-tick per-connection budget for the background discovery walk (blocks
// TESTED for "discovered", not blocks sent -- a cheap 256-tile hidden-bit scan each).
// Chosen so even a large map's full walk finishes well inside the 5 min target without
// coming close to a perceptible suspender hold (measured well under 1 ms/tick at this size).
constexpr int kTrickleVisitBudget = 128;

// Per-connection v1 stream state (side table keyed by connection pointer).
struct ConnState {
    std::unordered_map<uint64_t, uint32_t> sent_ver;   // block -> ver last handed to writer
    std::unordered_set<uint64_t> pending;              // blocks owed to this client

    // ---- WA-11: snapshot + background trickle + resume + REQ_BLOCKS -----------------
    bool startup_decided = false;      // resume-vs-snapshot decision made for this connection
    bool trickle_active = false;       // background discovery walk in progress (fresh connect)
    std::vector<int> trickle_z_order;  // z levels ordered by |z - cam.z at walk start| ascending
    size_t trickle_z_idx = 0;
    int trickle_bx = 0, trickle_by = 0;      // walk cursor within the current z tier
    int trickle_mbx = 0, trickle_mby = 0;    // block-space map extents captured at walk start
    std::deque<uint64_t> trickle_backlog;    // walk-discovered keys not yet sent (priority 4)
    std::deque<uint64_t> req_front;          // REQ_BLOCKS front-of-line keys (priority 0)

    bool itemdef_sent = false;   // WC-1: has this connection received ITEMDEF_DICT yet?

    // S4: byte-reuse cache is push-loop owned. It never retains DF pointers; only the
    // post-release JSON and optional deflate body are cached.
    bool aux_cache_valid = false;
    std::string aux_cache_json;
    std::vector<uint8_t> aux_cache_body;
    bool aux_cache_deflated = false;

    // S4 per-section JSON-value caches. Windowed sections share the camera bounds below;
    // env/players are global but keep independent folds/content comparisons.
    bool aux_sections_valid = false;
    uint64_t aux_units_fold = 0, aux_bldgs_fold = 0, aux_djobs_fold = 0;
    uint64_t aux_proj_fold = 0, aux_env_fold = 0;
    int aux_cache_ox = 0, aux_cache_oy = 0, aux_cache_oz = 0;
    int aux_cache_w = 0, aux_cache_h = 0;
    std::string aux_units_json, aux_bldgs_json, aux_djobs_json;
    std::string aux_proj_json, aux_env_json, aux_players_json;

    // S5 negotiated AUX-delta state. Full fallbacks remain available for every change.
    uint32_t aux_seq = 0;
    uint32_t last_aux_full_tick = 0;
    bool aux_needs_full = false;
    std::unordered_map<int, uint64_t> sent_units;
    std::unordered_map<int, uint64_t> sent_bldgs;
    bool aux_sent_sections_valid = false;
    uint64_t sent_env_fold = 0;
    uint32_t last_env_refresh = 0, last_players_refresh = 0;
    std::string sent_players_json;
    bool aux_pending_delta = false;
};

GlobalMapState g_gms;
std::unordered_map<WsConnection*, ConnState> g_conn;
uint64_t g_sig_scan_tick = 0;
uint32_t g_paused_idle_ticks = 0;

// WC-1: ITEMDEF_DICT is built ONCE (raws are static after world/fort load, §1.5 "dict
// build is one-time") and cached as ready-to-send framed bytes; every v1 connection gets
// it once, right after its first tick with a live interest (see the AFTER-release send
// loop below). Like g_gms, this is touched only from world_stream_tick() -- one thread,
// no lock needed.
bool g_itemdef_ready = false;
std::vector<uint8_t> g_itemdef_frame;   // full framed bytes: header(kTypeItemDefDict) + payload

// Cached map size (tiles) for hello_ack; refreshed under the suspender.
std::mutex g_mapinfo_mu;
V1MapInfo g_mapinfo;

// /diag rows.
struct DiagRow {
    uint32_t scan = 0, dirty = 0, encoded = 0, pending = 0; int inflight = 0; long long rtt = -1;
    bool trickleActive = false;               // WA-11: background snapshot walk in progress
    uint32_t trickleBacklog = 0, reqFront = 0;
    bool isHost = false;   // isHostClient() hook (WD-27 follow-up): WsConnection::is_host()
};
std::mutex g_diag_mu;
std::unordered_map<std::string, DiagRow> g_diag;
// Windowed suspender accounting (guarded by g_diag_mu): each tick's CoreSuspender hold
// duration, kept for ~1.5 s so /diag can report a real ms/s (not a single-tick snapshot).
std::deque<std::pair<long long, double>> g_susp_ring;

// F6 Phase-0 (a1): per-phase timing breakdown of the SAME tick the g_susp_ring above
// measures whole. The live ~247-440 ms/s suspender cost had an UNKNOWN split across the
// sig-scan / encode / units / buildings / misc(djobs+proj+env+plan) phases inside the
// hold, plus post-release AUX assemble+deflate CPU. This instruments it -- ADDITIVE ONLY,
// zero behaviour change, zero wire/CRC surface (never leaves /diag JSON). Same windowed
// MsPerSec convention as g_susp_ring: one entry pushed per tick, summed over the last
// 1000 ms in world_stream_diag_json(). The five in-suspend accumulators reconcile to
// v1SuspenderMsPerSec (minus the pre-mark capture_mu+CoreSuspender acquisition, which
// hold_ms includes but the phases do not -- that residual = suspenderMsPerSec - sum of
// phases, and is the offline test-the-test: a mis-attributed lap breaks the reconciliation
// or zeroes a bucket that must be non-zero on a populated fort).
struct PhaseTimes {
    double sig = 0, enc = 0, unit = 0, bld = 0, misc = 0;   // in-suspend (ms this tick)
    double auxAsm = 0, auxDef = 0;                           // post-release (ms this tick)
    uint32_t auxSkip = 0;                                    // post-release AUX reuse count
    // F6 Phase-0b (spec 2026-07-09 §4): the residual split. Unlike the five phase accumulators
    // these are per-tick SET-ONCE bracket durations, not summed within a tick.
    //   capWait  = tA - t0  (capture_mu acquisition wait)
    //   suspWait = tB - tA  (CoreSuspender acquisition wait -- push thread blocked, DF running)
    //   dfStall  = t1 - tB  (the true DF-parked time we cause == the hold minus acquisition)
    double capWait = 0, suspWait = 0, dfStall = 0;
};
std::deque<std::pair<long long, PhaseTimes>> g_phase_ring;   // guarded by g_diag_mu

// F6 Phase-0b: ground-truth sim-throughput oracle. world->frame_counter (df.world.xml:719,
// "increases by 1 every time . is pressed" == one per sim frame) sampled under the hold each
// tick; diag derives simTicksPerSec as the windowed delta. `paused` (df::global::pause_state)
// is carried so a frozen fort reports -1 instead of a meaningless ~0.
struct SimTickSample { long long ts = 0; int32_t frame_counter = 0; bool paused = false; };
std::deque<SimTickSample> g_simtick_ring;                    // guarded by g_diag_mu

long long steady_now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// ---- key pack / geometry ----------------------------------------------------------
inline uint64_t bkey(int bx, int by, int bz) {
    return ((uint64_t)(uint32_t)bz << 40) | ((uint64_t)(uint32_t)by << 20) | (uint64_t)(uint32_t)bx;
}
inline void bunpack(uint64_t k, int& bx, int& by, int& bz) {
    bx = (int)(k & 0xFFFFF); by = (int)((k >> 20) & 0xFFFFF); bz = (int)((k >> 40) & 0xFFFFFF);
}
inline int fdiv16(int a) { return a >= 0 ? a / 16 : -(((-a) + 15) / 16); }
inline int clampdim(int v) { return v < 1 ? 1 : (v > 200 ? 200 : v); }
inline uint32_t sig_scan_bucket(uint64_t key) {
    // Stable, cheap key mixing prevents coordinate packing's low bits from making a bucket
    // spatially striped. This only schedules detection; it never enters the wire or sig value.
    key ^= key >> 33;
    key *= 0xff51afd7ed558ccdull;
    key ^= key >> 33;
    return static_cast<uint32_t>(key % kSigScanBuckets);
}

// ---- block signature (§WA-9.1): single-block hash_block, no column fold ------------
inline uint64_t fnv1a(uint64_t h, const void* data, size_t n) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ull; }
    return h;
}
// WC-17/WC-18: `world`+`bx,by,bz` are needed on top of the block pointer -- grass is
// still a per-block block_events fold (same as spatter/item_spatter below), but
// engravings are a world-vector with no per-block storage of their own, so this
// signature now takes the block's own coordinate + world to fold both via the shared
// wire_v1.cpp index (dwf::wire::engraving_block_fold). A null block still short-
// circuits to 0 (unrevealed/off-map), same as before.
uint64_t block_signature(df::world* world, df::map_block* b, int bx, int by, int bz) {
    if (!b) return 0;
    uint64_t h = 1469598103934665603ull;
    h = fnv1a(h, &b->tiletype[0][0],    sizeof(b->tiletype));
    h = fnv1a(h, &b->designation[0][0], sizeof(b->designation));
    // build-place self-invalidation fix: the block wire (wire_v1.cpp emit) reads ONLY two
    // things out of tile occupancy -- the `dig_marked` (marker-mode) bit and the four
    // carve_track_* bits. Folding the WHOLE 32-bit occupancy grid re-signed a block on every
    // transient occupancy change the wire never encodes: the `unit`/`unit_grounded` presence
    // bits flip on EVERY creature STEP (units ship on the AUX channel, not this per-tile
    // wire), and `temp_value` ("currently used by location calcs") is toggled constantly by
    // DF's own pathing/location math. Placing a building draws dwarves to swarm and construct
    // it, so its neighbourhood churned occupancy for the whole 1-20s build -- turning the
    // placer's own tiles (which the client already has) into a self-inflicted storm of
    // redundant BLOCK_SET re-sends. Fold ONLY the bits the wire actually serializes, so a
    // block re-signs on a real wire-visible change, not on a dwarf walking past. This narrows
    // dirty DETECTION only; the wire FORMAT is unchanged (golden CRC unaffected).
    {
        constexpr uint32_t kOccWireMask =
            (uint32_t)df::tile_occupancy::mask_dig_marked |
            (uint32_t)df::tile_occupancy::mask_carve_track_north |
            (uint32_t)df::tile_occupancy::mask_carve_track_south |
            (uint32_t)df::tile_occupancy::mask_carve_track_east |
            (uint32_t)df::tile_occupancy::mask_carve_track_west;
        for (int ox = 0; ox < 16; ++ox)
            for (int oy = 0; oy < 16; ++oy) {
                uint32_t masked = b->occupancy[ox][oy].whole & kOccWireMask;
                h = fnv1a(h, &masked, sizeof(masked));
            }
    }
    size_t ni = b->items.size(); h = fnv1a(h, &ni, sizeof(ni));
    // WC-1: items.size() alone misses flag-only churn (forbid/dump/melt/on_fire toggle
    // without an item count change) -- fold each ground item's (id, flag mask) too, the
    // same fields the ITEM tail now carries (§1.5 "Hash addition").
    for (size_t ii = 0; ii < b->items.size(); ++ii) {
        df::item* it = df::item::find(b->items[ii]);
        if (!it) continue;
        int32_t iid = it->id;
        uint8_t mv = 0;
        if (it->flags.bits.spider_web) mv |= 0x01;
        if (it->flags.bits.forbid)     mv |= 0x02;
        if (it->flags.bits.dump)       mv |= 0x04;
        if (it->flags.bits.melt)       mv |= 0x08;
        if (it->flags.bits.on_fire)    mv |= 0x10;
        if (it->flags.bits.hidden)     mv |= 0x20;
        h = fnv1a(h, &iid, sizeof(iid));
        h = fnv1a(h, &mv, sizeof(mv));
        // TX1 CONTAINER_PEEK: storing/removing an item INSIDE a barrel/bin never touches
        // block->items (stored items leave the ground vector), so the (id, flags) fold above
        // cannot see a contents change -- the peek tail would serve stale forever (the same
        // "invisible to the signature" class B139 hit for flows). Fold each container's
        // contents fingerprint: count + first contained item id -- exactly the fields the
        // CONTAINER_PEEK tail is derived from (wire_v1.cpp's representative-first pick).
        df::item_type ity = it->getType();
        if (ity == df::item_type::BARREL || ity == df::item_type::BIN) {
            std::vector<df::item*> contained;
            Items::getContainedItems(it, &contained);
            uint32_t cn = (uint32_t)contained.size();
            int32_t cid = -1;
            for (size_t ci = 0; ci < contained.size(); ++ci)
                if (contained[ci]) { cid = contained[ci]->id; break; }
            h = fnv1a(h, &cn, sizeof(cn));
            h = fnv1a(h, &cid, sizeof(cid));
        }
    }
    for (size_t ei = 0; ei < b->block_events.size(); ++ei) {
        STRICT_VIRTUAL_CAST_VAR(sp, df::block_square_event_material_spatterst, b->block_events[ei]);
        if (sp) {
            h = fnv1a(h, &sp->amount[0][0], sizeof(sp->amount));
            // WC-11: amount-grid churn alone misses a same-amount mat/state swap (e.g. a
            // fresh spatter event replacing an old one at the same tile) -- fold the
            // event's (mat_type, mat_index, mat_state) header too (§1.5 "Hash addition").
            int16_t mt = sp->mat_type; int32_t mi = sp->mat_index;
            int16_t st = (int16_t)sp->mat_state;
            h = fnv1a(h, &mt, sizeof(mt)); h = fnv1a(h, &mi, sizeof(mi)); h = fnv1a(h, &st, sizeof(st));
            continue;
        }
        STRICT_VIRTUAL_CAST_VAR(isp, df::block_square_event_item_spatterst, b->block_events[ei]);
        if (isp) {
            // WC-11: item-spatter (fallen leaves/fruit litter) amount grid + header.
            h = fnv1a(h, &isp->amount[0][0], sizeof(isp->amount));
            int16_t it = (int16_t)isp->item_type; int16_t ist = isp->item_subtype;
            h = fnv1a(h, &it, sizeof(it)); h = fnv1a(h, &ist, sizeof(ist));
            continue;
        }
        // WC-17: grass coverage churns as dwarves trample/regrow it -- fold the amount
        // grid + which plant is currently winning (same "amount grid + event header"
        // rule WC-11 set above; §1.5 "Hash addition").
        STRICT_VIRTUAL_CAST_VAR(gr, df::block_square_event_grassst, b->block_events[ei]);
        if (gr) {
            h = fnv1a(h, &gr->amount[0][0], sizeof(gr->amount));
            int32_t pid = gr->plant_index;
            h = fnv1a(h, &pid, sizeof(pid));
            continue;
        }
        // WC-19: designation priority can change without any other block state changing
        // (a player re-prioritizing an existing dig designation) -- fold the whole grid
        // (§1.5 "Hash addition"; the grid is only 256 int32s, same cost class as the
        // tiletype/designation grids already folded above).
        STRICT_VIRTUAL_CAST_VAR(dp, df::block_square_event_designation_priorityst, b->block_events[ei]);
        if (dp) {
            h = fnv1a(h, &dp->priority[0][0], sizeof(dp->priority));
        }
    }
    // WC-15: block->flows are volatile (mist/smoke/miasma drift every tick) -- fold count
    // + each flow's (type, alive, density bucket, pos); quantization keeps idle flutter
    // from forcing a delta every single tick while still catching real density swings (§1.5).
    // B139 fix: the old fold used density>>4 and ignored flags.DEAD, which made the ENTIRE
    // miasma band invisible to the signature (miasma density is 1..~25 -> dq 0/1) AND missed
    // dead<->alive flips (DF re-uses flow_info slots IN PLACE: same pos/type/count, so
    // nothing else re-signed either). Live consequence: a refuse-pile block encoded once
    // while its slots were dead kept serving cached density-0 flow tails forever. Now:
    // `alive` (not DEAD && density>0 -- the exact emission gate in wire_v1.cpp's pre-scan)
    // is folded explicitly, and live density folds in 8-wide buckets (>>3), so every
    // client-visible opacity step re-signs while in-bucket flutter still doesn't.
    {
        size_t nf = b->flows.size();
        h = fnv1a(h, &nf, sizeof(nf));
        for (size_t fi = 0; fi < nf; ++fi) {
            df::flow_info* fl = b->flows[fi];
            if (!fl) continue;
            int16_t ft = (int16_t)fl->type;
            uint8_t alive = (!fl->flags.bits.DEAD && fl->density > 0) ? 1 : 0;
            uint8_t dq = alive ? (uint8_t)((fl->density > 255 ? 255 : fl->density) >> 3)
                               : (uint8_t)0;
            h = fnv1a(h, &ft, sizeof(ft));
            h = fnv1a(h, &alive, sizeof(alive));
            h = fnv1a(h, &dq, sizeof(dq));
            h = fnv1a(h, &fl->pos, sizeof(fl->pos));
        }
    }
    // WC-18: engravings are a world-vector, not part of `b` -- fold via the shared
    // position-keyed index (wire_v1.cpp's engraving_block_fold), keyed by this block's
    // OWN coordinate (bx,by,bz), so a new/changed engraving at this block re-signs it.
    h ^= dwf::wire::engraving_block_fold(world, bx, by, bz);
    // WC-21: vermin/vermin-colonies are ALSO world-vectors (same shape as engravings) --
    // fold the same way so a vermin entering/leaving/being-reclassified at this block
    // re-signs it (§1.5 "Hash addition").
    h ^= dwf::wire::vermin_block_fold(world, bx, by, bz);
    // TX4: farm crops are building-owned contained items, so neither map_block::items nor
    // building AUX changes when their per-tile stage changes. Fold the shared crop index.
    h ^= dwf::wire::farm_crop_block_fold(bx, by, bz);
    if (h == 0) h = 1;   // reserve 0 for "null/undiscovered"
    return h;
}
// Discovered (§0.8): a block with >=1 tile hidden==0. Fully-hidden blocks never ship.
bool block_discovered(df::map_block* b) {
    if (!b) return false;
    for (int x = 0; x < 16; ++x)
        for (int y = 0; y < 16; ++y)
            if (!b->designation[x][y].bits.hidden) return true;
    return false;
}

// BLACK-GLYPHS/B204 (RENDER half of B133): a block that is FULLY hidden but carries a live
// designation must ALSO ship -- otherwise a mining designation dropped into unexplored rock is
// written to the map (B133 accepts it) yet its block never reaches the client, so the glyph can
// never draw over the black. Mirrors the emitter's own `active` designation test (dig != No, or
// smooth/traffic set, or a carve-track / marker occupancy bit). encode_block emits such a block
// with VOID tiletypes so only the designation (never real terrain/material) crosses the wire --
// fog-of-war is preserved; the client draws the glyph over black with no terrain invented.
bool block_has_active_designation(df::map_block* b) {
    if (!b) return false;
    for (int x = 0; x < 16; ++x)
        for (int y = 0; y < 16; ++y) {
            const df::tile_designation& d = b->designation[x][y];
            if (d.bits.dig != df::tile_dig_designation::No) return true;
            if (d.bits.smooth != 0) return true;
            if (d.bits.traffic != df::tile_traffic::Normal) return true;
            const df::tile_occupancy& o = b->occupancy[x][y];
            if (o.bits.dig_marked) return true;
            if (o.bits.carve_track_north || o.bits.carve_track_south ||
                o.bits.carve_track_east  || o.bits.carve_track_west) return true;
        }
    return false;
}

// Shippable (§0.8 + B204): the union gate every block-selection site uses. A block ships if it is
// discovered OR if it is fully hidden but carries a designation the player needs to see.
bool block_shippable(df::map_block* b) {
    return block_discovered(b) || block_has_active_designation(b);
}

// ---- WA-11.2 changelog resume test (§0.6) ------------------------------------------
// `have` is "within" the ring iff every dirty tick since it is still recorded (so the
// union of changelog entries with world_seq>have is a COMPLETE catch-up set, never a gap).
// have==0 always misses (full snapshot, §WA-11.1); a `have` claiming a world_seq we
// haven't reached is never trusted either (misses -> full snapshot).
bool changelog_within(const GlobalMapState& gms, uint32_t have) {
    if (have == 0 || have > gms.world_seq) return false;
    if (gms.changelog.empty()) return have == gms.world_seq;   // nothing dirtied yet
    uint32_t oldest = gms.changelog.front().first;
    return have + 1 >= oldest;
}

// ---- WA-11.1 background trickle walk (§0.8 priority 4) -----------------------------
// Advances `cs`'s discovery walk by exactly one block-space cell (column-major bx,by
// within each z tier; z tiers ordered by |z - cam.z| ascending, fixed at walk start).
// A discovered block not yet at this connection's current ver is queued into
// trickle_backlog and, if never seen before, registers a first-encode sig/ver stamp in
// GlobalMapState (§WA-11.4) so it enters normal global change tracking from here on.
// Returns false once every (z,bx,by) cell has been visited -- the caller then closes out
// the snapshot (emits trickle:"end").
bool trickle_visit_one(df::world* world, GlobalMapState& gms, ConnState& cs) {
    if (cs.trickle_z_idx >= cs.trickle_z_order.size()) return false;
    int bz = cs.trickle_z_order[cs.trickle_z_idx];
    int bx = cs.trickle_bx, by = cs.trickle_by;
    if (++cs.trickle_by >= cs.trickle_mby) {
        cs.trickle_by = 0;
        if (++cs.trickle_bx >= cs.trickle_mbx) {
            cs.trickle_bx = 0;
            ++cs.trickle_z_idx;
        }
    }
    uint64_t key = bkey(bx, by, bz);
    df::map_block* b = Maps::getBlock(bx, by, bz);
    if (!block_shippable(b)) return true;              // visited, undiscovered (& no desig): skip
    if (gms.sig.find(key) == gms.sig.end()) {
        gms.sig[key] = block_signature(world, b, bx, by, bz);
        gms.ver[key] = gms.world_seq;                    // first-encode stamp (§WA-11.4)
    }
    uint32_t v = gms.ver[key];
    auto sit = cs.sent_ver.find(key);
    if (sit == cs.sent_ver.end() || sit->second < v) {
        cs.trickle_backlog.push_back(key);
        cs.pending.insert(key);
    }
    return true;
}

std::string json_escape(const std::string& s) {
    std::string o; o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20 || c >= 0x80) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
                else o.push_back((char)c);
        }
    }
    return o;
}

// ---- neutral in-memory scans (built under suspend, no JSON inside the hold) --------
// WE-3: ah/sw/sh/ax/ay mirror the WE-2 exporter's UnitSpriteRecord (unit_sprites.h) --
// ah empty means "no composite yet", the AUX/legacy-JSON emit contract for omitting
// the fields entirely (client falls back, WE-4).
// B23: sd_top = the highest camera z from which this unit is see-down-visible through an
// unobstructed open column (computed during the suspended phase; defaults to own z = not
// visible from above). A camera at oz sees the unit iff u.z < oz <= u.sd_top.
// WINDOW #13 / WT29 / B222 -- overhead unit-status flags (native flashes sleeping/mood/etc over
// units). ONE optional "st" int per unit on the aux JSON, emitted ONLY when non-zero (a content
// unit adds zero bytes -> satisfies the AUX delta policy; units already ride the aux stream every
// frame). ZERO binary-wire / golden-CRC surface. The bit constants (kUStat*/kUMood*) and the ONE
// shared computation now live in unit_status.h (included above) so this serializer and
// tile_map_dump.cpp's emit_units can never disagree again -- B222's root cause was exactly that
// split (emit_units never shipped st, so snapshot/fresh-join paths lost every bubble).
struct UnitRec { int x, y, z, id, race, caste; std::string rt, ct, name; std::string ah; int sw = 0, sh = 0, ax = 0, ay = 0; int sd_top = 0; int st = 0; int st2 = 0; bool ghostly = false; uint64_t rec_fold = 0; };
struct BldRec  { int id = -1; int x1, y1, x2, y2, z, subtype, stage, mat_type, mat_index; int sd_top = 0; std::string type; bool has_rgb; int r, g, b; bool built; std::string ext;
                 // B273 building component color. `crgb` is the descriptor's display RGB for
                 // compatibility with older clients; `cpal` preserves the canonical STATE_COLOR
                 // token so new clients can perform DF's exact default-palette substitution.
                 bool has_crgb = false; int cr = 0, cg = 0, cb = 0; std::string cpal;
                 // WC-6: direction/state/category. `ds_valid` gates emission (only building
                 // types in the WC-6 table carry these); default bclass=0 (building art),
                 // 1=stockpile overlay, 2=civzone overlay. `direction`/`state` packed per the
                 // WC-6 table; `extra` per-type (farmplot plant id / stockpile flags / civzone type).
                 bool ds_valid = false; int bclass = 0; int direction = 0; int state = 0; uint32_t extra = 0;
                 // B253: the STATUE sprite key. A built statue is a 3-cell composite (plinth on its
                 // own tile + the subject's bottom cell over it + the subject's TOP cell one tile
                 // ABOVE), and every part of the key lives on the contained df::item_statuest:
                 //   s_quality   df::item_quality 0..5, 6 = artifact  (plinth COLUMN = the frieze)
                 //   s_mt/s_mi   the ITEM's material (NOT the building header's) -- the client runs
                 //               its own already-tested WOOD/STONE/METAL/GLASS classifier on it,
                 //               so no second material classifier is introduced here.
                 //   s_gtype     item_statue_graphics_type_overall    (df.itemdef.xml:2-9)
                 //   s_gid       art_graphics_id (statue_generic_event_type when gtype=GENERIC_EVENT)
                 //   s_race      "RACE" / "RACE:CASTE" when gtype=CREATURE (932 creature statues)
                 // s_valid gates emission: a client with none of these still draws the plinth + the
                 // DEFAULT subject, so an old DLL degrades to "the cube", never to a bare block.
                 bool s_valid = false; int s_quality = 0; int s_mt = -1; int s_mi = -1;
                 int s_gtype = -1; int s_gid = -1; std::string s_race;
                 uint64_t rec_fold = 0; };

// WC-6: is `bld->machine`'s machine currently active (rotating/powered)? Null-safe:
// machine_id can be -1 (unconnected) and machine::find returns null then. Reads only
// world->machines.all[·]->flags -- no map access.
static bool machine_is_active(const df::machine_info& mi) {
    if (mi.machine_id < 0) return false;
    df::machine* m = df::machine::find(mi.machine_id);
    return m && m->flags.bits.active;
}

// WC-6: quantize a windmill's orient_x/orient_y (facing sign vector) into an 8-way index
// 0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW (screen coords: +x East, +y South, so N=(0,-1)).
static int windmill_dir8(int ox, int oy) {
    int sx = (ox > 0) - (ox < 0);
    int sy = (oy > 0) - (oy < 0);
    // (sx,sy) -> index via an explicit table (matches the client's WINDMILL_<dir> tokens).
    if (sx == 0 && sy < 0) return 0;  // N
    if (sx > 0 && sy < 0) return 1;   // NE
    if (sx > 0 && sy == 0) return 2;  // E
    if (sx > 0 && sy > 0) return 3;   // SE
    if (sx == 0 && sy > 0) return 4;  // S
    if (sx < 0 && sy > 0) return 5;   // SW
    if (sx < 0 && sy == 0) return 6;  // W
    if (sx < 0 && sy < 0) return 7;   // NW
    return 0;                          // (0,0) undefined facing -> N default
}

// B253: the CASTE of a creature statue's subject. art_graphics_id gives DF's race index but not the
// caste, and 26 of the 932 vanilla creature statues are caste-split (a peahen statue is not a
// peacock statue). DF reads the caste off the art_image's creature element -- so do we
// (df.art_image.xml:117-121, `art_image_element_creaturest {race; caste; histfig}`). Returns -1
// when the art_image chunk is not paged in or carries no creature element: the client then falls
// back from "RACE:CASTE" to the bare "RACE" entry, which every creature has. Never a guess.
static int statue_creature_caste(df::item_statuest* st) {
    if (!st)
        return -1;
    df::art_image* img = dwf::find_art_image(st->image.id, st->image.subid);
    if (!img)
        return -1;
    for (auto el : img->elements) {
        auto cr = virtual_cast<df::art_image_element_creaturest>(el);
        if (cr)
            return cr->caste;
    }
    return -1;
}

// B253 (07-14: "missing the top half and some decorative patterning on the built statues").
// Fill BldRec's statue sprite key from the ITEM the statue was built out of.
//
// DF draws a built statue as THREE cells, one of which lands on the tile ABOVE it:
//     the statue's tile : plinth[material class][quality] + the subject's BOTTOM cell
//     one tile ABOVE    : the subject's TOP cell
// `item_statue_graphics_infost` (df.itemdef.xml:44-48) is the ONLY *_graphics_infost in
// df-structures carrying a texpos_top/texpos_bottom PAIR -- a statue is DF's only 2-cell-tall
// built object -- and its flags bitfield (df.itemdef.xml:24-42) keys the sprite on the overall
// subject type, the material class AND THE QUALITY. The quality column is the decorative frieze.
//
// None of that is on the BUILDING: df::building_statuest has exactly one field, an unused
// `statue_flag` (df.building.xml:1520). It all lives on the contained df::item_statuest -- and DF
// has ALREADY resolved the subject onto that item as `art_graphics_type` + `art_graphics_id`
// (df.item.xml:1532-1542), so we forward DF's own answer rather than re-deriving it by walking
// the art_image (exactly the B246 lesson: read DF's own resolution, don't rebuild it).
//
// Crash surface: none new. contained_items is the same vector building_art() (art_desc.cpp:188)
// already walks inside the same suspended scan; every step is null-checked and the cast is a
// virtual_cast. No map access.
static void fill_statue_art(df::building* b, BldRec& r) {
    auto actual = virtual_cast<df::building_actual>(b);
    if (!actual)
        return;
    for (auto contained : actual->contained_items) {
        if (!contained || !contained->item)
            continue;
        auto st = virtual_cast<df::item_statuest>(contained->item);
        if (!st)
            continue;                        // a statue building holds exactly one statue item
        r.s_valid = true;
        // QUALITY: df::item_quality 0(Ordinary)..5(Masterful); an artifact overrides it with the
        // dedicated ITEM_STATUE_ARTIFACT plinth row (graphics_statues.txt:36-41).
        // getQuality() is the vmethod every other quality read in this codebase uses
        // (wire_v1.cpp:1189, unit_sheet.cpp:903) -- not the raw item_crafted field.
        r.s_quality = st->flags.bits.artifact ? 6 : (int)st->getQuality();
        if (r.s_quality < 0) r.s_quality = 0;
        if (r.s_quality > 6) r.s_quality = 6;
        // MATERIAL: the ITEM's, not the building header's. The client classifies it with the same
        // WOOD/STONE/METAL/GLASS classifier it already uses for every other item.
        r.s_mt = st->getMaterial();
        r.s_mi = st->getMaterialIndex();
        // SUBJECT: DF's own precomputed answer.
        r.s_gtype = st->art_graphics_type;
        r.s_gid = st->art_graphics_id;
        // A CREATURE statue (item_statue_graphics_type_overall::CREATURE == 2) picks its art from
        // the creature's own STATUE_CREATURE[_CASTE]_GRAPHICS raws, which the client's statue map
        // keys by race token (and "RACE:CASTE" for the 26 caste-split ones). art_graphics_id is
        // the race index; the caste comes off the art_image's creature element, which is where DF
        // itself reads it (df.art_image.xml:117-121 art_image_element_creaturest{race,caste}).
        if (r.s_gtype == 2 && df::global::world) {
            auto& craws = df::global::world->raws.creatures.all;
            int race = r.s_gid;
            if (race >= 0 && race < (int)craws.size() && craws[race]) {
                r.s_race = craws[race]->creature_id;
                int caste = statue_creature_caste(st);
                if (caste >= 0 && caste < (int)craws[race]->caste.size() && craws[race]->caste[caste])
                    r.s_race += ":" + craws[race]->caste[caste]->caste_id;
            }
        }
        return;
    }
}

// WC-6: fill BldRec.direction/state/extra/bclass/ds_valid from a df::building's concrete
// subtype. Every branch is a guarded virtual_cast; unmatched types leave ds_valid=false
// (the AUX emit then omits the fields, old clients unaffected). Crash-safe: no map/tile
// reads, machine::find null-checked, off-map (-30000) building coords never dereferenced.
static void fill_building_ds(df::building* b, BldRec& r) {
    using namespace df::enums;
    df::building_type bt = b->getType();
    switch (bt) {
        case building_type::ScrewPump:
            if (auto sp = virtual_cast<df::building_screw_pumpst>(b)) {
                r.ds_valid = true; r.direction = (int)sp->direction;   // FromNorth..FromWest 0-3
                r.state = machine_is_active(sp->machine) ? 1 : 0;
            }
            break;
        case building_type::WaterWheel:
            if (auto ww = virtual_cast<df::building_water_wheelst>(b)) {
                r.ds_valid = true; r.direction = ww->is_vertical ? 1 : 0;  // 1=NS(vertical) 0=WE
                r.state = machine_is_active(ww->machine) ? 1 : 0;
            }
            break;
        case building_type::Windmill:
            if (auto wm = virtual_cast<df::building_windmillst>(b)) {
                r.ds_valid = true; r.direction = windmill_dir8(wm->orient_x, wm->orient_y);
                r.state = (wm->is_working != 0 ? 1 : 0) | ((wm->rotation & 3) << 1);
            }
            break;
        case building_type::AxleHorizontal:
            if (auto ax = virtual_cast<df::building_axle_horizontalst>(b)) {
                r.ds_valid = true; r.direction = ax->is_vertical ? 1 : 0;  // 1=NS 0=WE
                r.state = machine_is_active(ax->machine) ? 1 : 0;
            }
            break;
        case building_type::AxleVertical:
            r.ds_valid = true; r.direction = 0;
            // vertical axle: machine info lives on building_axle_verticalst.machine.
            {
                df::building* bb = b;
                if (auto av = virtual_cast<df::building_axle_verticalst>(bb))
                    r.state = machine_is_active(av->machine) ? 1 : 0;
            }
            break;
        case building_type::GearAssembly:
            if (auto ga = virtual_cast<df::building_gear_assemblyst>(b)) {
                r.ds_valid = true;
                r.state = (machine_is_active(ga->machine) ? 1 : 0)
                        | (ga->gear_flags.bits.disengaged ? 2 : 0);
            }
            break;
        case building_type::Rollers:
            if (auto ro = virtual_cast<df::building_rollersst>(b)) {
                r.ds_valid = true; r.direction = (int)ro->direction;
                r.state = machine_is_active(ro->machine) ? 1 : 0;
            }
            break;
        case building_type::Bridge:
            if (auto br = virtual_cast<df::building_bridgest>(b)) {
                r.ds_valid = true; r.direction = (int)br->direction;      // Retracting=-1..Down=3
                r.state = br->gate_flags.bits.raised ? 1 : 0;
            }
            break;
        case building_type::Door:
            if (auto dr = virtual_cast<df::building_doorst>(b)) {
                r.ds_valid = true;
                r.state = (dr->door_flags.bits.closed ? 1 : 0)
                        | (dr->door_flags.bits.forbidden ? 2 : 0)
                        | (dr->door_flags.bits.operated_by_mechanisms ? 4 : 0);
            }
            break;
        case building_type::Hatch:
            if (auto ha = virtual_cast<df::building_hatchst>(b)) {
                r.ds_valid = true;
                r.state = (ha->door_flags.bits.closed ? 1 : 0)
                        | (ha->door_flags.bits.forbidden ? 2 : 0)
                        | (ha->door_flags.bits.operated_by_mechanisms ? 4 : 0);
            }
            break;
        case building_type::Floodgate:
            if (auto fg = virtual_cast<df::building_floodgatest>(b)) {
                r.ds_valid = true; r.state = fg->gate_flags.bits.closed ? 1 : 0;
            }
            break;
        case building_type::GrateWall:
            if (auto gw = virtual_cast<df::building_grate_wallst>(b)) {
                r.ds_valid = true; r.state = gw->gate_flags.bits.closed ? 1 : 0;
            }
            break;
        case building_type::GrateFloor:
            if (auto gf = virtual_cast<df::building_grate_floorst>(b)) {
                r.ds_valid = true; r.state = gf->gate_flags.bits.closed ? 1 : 0;
            }
            break;
        case building_type::BarsVertical:
            if (auto bv = virtual_cast<df::building_bars_verticalst>(b)) {
                r.ds_valid = true; r.state = bv->gate_flags.bits.closed ? 1 : 0;
            }
            break;
        case building_type::BarsFloor:
            if (auto bf = virtual_cast<df::building_bars_floorst>(b)) {
                r.ds_valid = true; r.state = bf->gate_flags.bits.closed ? 1 : 0;
            }
            break;
        case building_type::Trap:
            if (auto tp = virtual_cast<df::building_trapst>(b)) {
                r.ds_valid = true; r.state = (tp->state != 0) ? 1 : 0;
            }
            break;
        case building_type::Well:
            if (auto we = virtual_cast<df::building_wellst>(b)) {
                r.ds_valid = true; r.state = (we->bucket_z < b->z) ? 1 : 0;  // bucket down
            }
            break;
        case building_type::FarmPlot:
            if (auto fp = virtual_cast<df::building_farmplotst>(b)) {
                r.ds_valid = true;
                int season = df::global::cur_season ? (int)*df::global::cur_season : 0;
                if (season < 0 || season > 3) season = 0;   // plant_id[season], season enum 0..3
                int pid = fp->plant_id[season];
                r.extra = (uint32_t)(pid < 0 ? 0xFFFF : (pid & 0xFFFF));
            }
            break;
        case building_type::Statue:
            // B253: no direction/state -- a statue's whole sprite key is on its contained item.
            fill_statue_art(b, r);
            break;
        case building_type::Stockpile:
            if (auto st = virtual_cast<df::building_stockpilest>(b)) {
                r.ds_valid = true; r.bclass = 1;
                r.extra = (uint32_t)st->settings.flags.whole;
            }
            break;
        case building_type::Civzone:
            if (auto cz = virtual_cast<df::building_civzonest>(b)) {
                r.ds_valid = true; r.bclass = 2;
                r.state = cz->spec_sub_flag.bits.active ? 1 : 0;
                r.extra = (uint32_t)(int)cz->type;
            }
            break;
        default:
            break;
    }
}
// S3 derived-record caches are push-loop-owned and retain only value records.
struct UnitDerived { uint64_t fold = 0; std::string name; };
struct BldDerived { uint64_t fold = 0; BldRec rec; };
struct MatRgb { bool valid = false; int r = 0, g = 0, b = 0; std::string palette_token; };
std::unordered_map<int, UnitDerived> g_unit_derived;
std::unordered_map<int, BldDerived> g_bld_derived;
std::map<std::pair<int, int>, std::pair<std::string, std::string>> g_race_caste_derived;
std::map<std::pair<int, int>, MatRgb> g_mat_rgb_derived;
inline uint64_t s3_fold(uint64_t h, const void* p, size_t n) { return n ? fnv1a(h, p, n) : h; }
static uint64_t s3_name_fold(const df::language_name& n) { uint64_t h = s3_fold(1469598103934665603ull, &n, sizeof(n)); return s3_fold(h, n.nickname.data(), n.nickname.size()); }
static uint64_t s3_bld_fold(df::building* b) { uint64_t h = 1469598103934665603ull; auto add = [&](const auto& v) { h = s3_fold(h, &v, sizeof(v)); }; add(b->id); add(b->x1); add(b->y1); add(b->x2); add(b->y2); add(b->z); int t=(int)b->getType(),st=(int)b->getSubtype(),bs=(int)b->getBuildStage(),ms=(int)b->getMaxBuildStage(); add(t); add(st); add(bs); add(ms); add(b->mat_type); add(b->mat_index); BldRec ds; fill_building_ds(b, ds); add(ds.ds_valid); add(ds.bclass); add(ds.direction); add(ds.state); add(ds.extra); add(ds.s_valid); add(ds.s_quality); add(ds.s_mt); add(ds.s_mi); add(ds.s_gtype); add(ds.s_gid); if (!ds.s_race.empty()) h = s3_fold(h, ds.s_race.data(), ds.s_race.size()); if (b->room.extents && b->room.width > 0 && b->room.height > 0) h=s3_fold(h,b->room.extents,(size_t)b->room.width*(size_t)b->room.height*sizeof(*b->room.extents)); return h; }
template <typename T> static inline void s4_fold_add(uint64_t& h, const T& v) { h = s3_fold(h, &v, sizeof(v)); }
static inline void s4_fold_add(uint64_t& h, const std::string& v) { h = s3_fold(h, v.data(), v.size()); }
static uint64_t s4_unit_fold(const UnitRec& u, uint64_t name_fold) {
    uint64_t h = 1469598103934665603ull;
    s4_fold_add(h, u.id); s4_fold_add(h, u.x); s4_fold_add(h, u.y); s4_fold_add(h, u.z);
    s4_fold_add(h, u.sd_top); s4_fold_add(h, name_fold); s4_fold_add(h, u.name);
    s4_fold_add(h, u.race); s4_fold_add(h, u.caste); s4_fold_add(h, u.rt); s4_fold_add(h, u.ct);
    s4_fold_add(h, u.ah); s4_fold_add(h, u.sw); s4_fold_add(h, u.sh);
    // WT31: st2 MUST be folded alongside st. Without it a unit whose ONLY change is a second-word
    // bit (a dwarf who starts telling a story, a migrant whose trait ticks out) keeps its old fold,
    // the aux delta never re-ships the record, and the new bubbles silently never appear -- the
    // exact B222 failure mode, one word over. Pinned by wt30_status_full_test §8.
    s4_fold_add(h, u.ax); s4_fold_add(h, u.ay); s4_fold_add(h, u.st); s4_fold_add(h, u.st2);
    s4_fold_add(h, u.ghostly);
    return h;
}

// WC-22: projectiles + vehicles in flight. `fx/fy` are sub-tile fractions (0..255, from
// the DF fine_*_adj fields' -50000..50000 native range, per §WC-22 wire); `is_vehicle`
// distinguishes the two record shapes on one flat AUX array (both resolve through the
// same item_type/subtype/mat art). z is int (not clamped) -- camera-window z-match is a
// plain equality test same as units/buildings above.
struct ProjRec { int x, y, z, fx, fy, item_type, subtype; int32_t mat_type, mat_index; bool is_vehicle; };
// B35/B54: a map designation that v50 has already converted into a JOB
// (the map's designation bits clear on pickup, but native keeps drawing the glyph from the
// live job). Kinds 1-6 retain smooth/engrave/fortify/track/chop/gather; kinds 7-13
// add dig/up/down/up-down/ramp/channel/remove-construction.
// B135: `w` = a UNIT_WORKER general ref is attached (a dwarf claimed the job). DF posts
// smooth/chop/etc jobs that sit WORKERLESS in the list -- native keeps those steady and
// only flashes once a worker is assigned (live report 07-10), so the client needs the
// discriminator on the wire. Additive JSON field, emitted only when true.
struct DJobRec { int x, y, z, k; bool w = false; };

// WC-20: weather/season/year_tick -- one global read, no per-connection cost, piggybacked
// onto the existing per-tick AUX JSON (protocol v1's own "UNITS cadence" channel,
// RECONCILE-R2's suggested piggyback point) rather than a whole new message type.
// V2 audio ambience matrix: `evil` = fort-site surroundings alignment (0 Good / 1 Neutral /
// 2 Evil, from region_map_entry.evilness thresholds), `savage` = savagery>=66. Together they key
// the Good/Evil/Terrifying(evil+savage)/Neutral_Winds ambient loops (7 of the 27). Additive JSON
// in `env` only -- golden binary-wire CRC untouched, same pattern as `siege`.
struct EnvRec {
    uint8_t weather = 0; uint8_t season = 0; uint32_t year_tick = 0; bool siege = false;
    uint8_t evil = 1; bool savage = false;
    const char* autosave = nullptr; // d_init.feature.autosave; null leaves the additive field absent
};
static uint64_t s4_djobs_fold(const std::vector<DJobRec>& records) {
    uint64_t h = 1469598103934665603ull;
    // B135: r.w folds in so a worker being assigned/unassigned (position+kind unchanged)
    // still changes the fold and the delta path re-sends the djobs array.
    for (const auto& r : records) { s4_fold_add(h, r.x); s4_fold_add(h, r.y); s4_fold_add(h, r.z); s4_fold_add(h, r.k); s4_fold_add(h, r.w); }
    return h;
}
static uint64_t s4_proj_fold(const std::vector<ProjRec>& records) {
    uint64_t h = 1469598103934665603ull;
    for (const auto& r : records) {
        s4_fold_add(h, r.x); s4_fold_add(h, r.y); s4_fold_add(h, r.z);
        s4_fold_add(h, r.fx); s4_fold_add(h, r.fy); s4_fold_add(h, r.item_type);
        s4_fold_add(h, r.subtype); s4_fold_add(h, r.mat_type); s4_fold_add(h, r.mat_index);
        s4_fold_add(h, r.is_vehicle);
    }
    return h;
}
static uint64_t s4_env_fold(const EnvRec& env, const std::string& music_frag) {
    uint64_t h = 1469598103934665603ull;
    s4_fold_add(h, env.weather); s4_fold_add(h, env.season); s4_fold_add(h, env.year_tick);
    s4_fold_add(h, env.siege); s4_fold_add(h, env.evil); s4_fold_add(h, env.savage);
    if (env.autosave) h = s3_fold(h, env.autosave, std::strlen(env.autosave));
    s4_fold_add(h, music_frag);
    return h;
}
static uint64_t s5_env_fold(const EnvRec& env, const std::string& music_frag) {
    uint64_t h = 1469598103934665603ull;
    s4_fold_add(h, env.weather); s4_fold_add(h, env.season);
    s4_fold_add(h, env.siege); s4_fold_add(h, env.evil); s4_fold_add(h, env.savage);
    if (env.autosave) h = s3_fold(h, env.autosave, std::strlen(env.autosave));
    s4_fold_add(h, music_frag);
    return h;
}
static void append_unit_json(std::ostringstream& a, const UnitRec& u, bool seedown) {
    a << "{\"x\":" << u.x << ",\"y\":" << u.y << ",\"z\":" << u.z << ",\"id\":" << u.id
      << ",\"race\":" << u.race << ",\"caste\":" << u.caste
      << ",\"rt\":\"" << json_escape(u.rt) << "\",\"ct\":\"" << json_escape(u.ct)
      << "\",\"name\":\"" << json_escape(u.name) << "\"";
    if (seedown) a << ",\"sd\":1";
    if (u.ghostly) a << ",\"gh\":1";
    if (u.st) a << ",\"st\":" << u.st;
    if (u.st2) a << ",\"st2\":" << u.st2;   // WT31 second status word; same only-when-non-zero rule
    if (!u.ah.empty()) {
        a << ",\"ah\":\"" << u.ah << "\""
          << ",\"sw\":" << u.sw << ",\"sh\":" << u.sh
          << ",\"ax\":" << u.ax << ",\"ay\":" << u.ay;
    }
    a << "}";
}
static void append_bld_json(std::ostringstream& a, const BldRec& b, bool seedown = false) {
    a << "{\"id\":" << b.id << ",\"x1\":" << b.x1 << ",\"y1\":" << b.y1 << ",\"x2\":" << b.x2 << ",\"y2\":" << b.y2
      << ",\"z\":" << b.z << ",\"type\":\"" << json_escape(b.type) << "\",\"subtype\":" << b.subtype
      << ",\"stage\":" << b.stage << ",\"mat_type\":" << b.mat_type << ",\"mat_index\":" << b.mat_index
      << ",\"built\":" << (b.built ? "true" : "false");
    // ZBELOW-BUILDINGS: optional see-down tag, only when the server proved an open column
    // from the camera z down to this building (sd_top recomputed fresh every scan).
    if (seedown) a << ",\"sd\":1";
    if (!b.ext.empty()) a << ",\"ext\":\"" << b.ext << "\"";
    if (b.has_rgb) a << ",\"rgb\":[" << b.r << "," << b.g << "," << b.b << "]";
    if (b.has_crgb) a << ",\"crgb\":[" << b.cr << "," << b.cg << "," << b.cb << "]";
    if (b.has_crgb && !b.cpal.empty()) a << ",\"cpal\":\"" << json_escape(b.cpal) << "\"";
    if (b.ds_valid) {
        a << ",\"dir\":" << b.direction << ",\"bst\":" << b.state
          << ",\"bextra\":" << b.extra << ",\"bcls\":" << b.bclass;
    }
    // B253: the statue sprite key (statues only -- s_valid gates it). Absent => the client draws
    // the plinth + DF's DEFAULT subject, which is the cube-on-plinth; it never degrades to the
    // bare block we used to ship. `srt` is emitted only for creature statues.
    if (b.s_valid) {
        a << ",\"sq\":" << b.s_quality << ",\"smt\":" << b.s_mt << ",\"smi\":" << b.s_mi
          << ",\"sgt\":" << b.s_gtype << ",\"sgi\":" << b.s_gid;
        if (!b.s_race.empty())
            a << ",\"srt\":\"" << json_escape(b.s_race) << "\"";
    }
    a << "}";
}

// S1: a skipped paused-idle tick never reads DF. The regular tick immediately before it
// leaves this neutral snapshot for the post-release AUX fanout. It is push-loop owned, like
// GlobalMapState, so no mutex is needed.
struct LastReadState {
    bool valid = false;
    bool paused = false;
    std::vector<UnitRec> units;
    std::vector<BldRec> bldgs;
    std::vector<ProjRec> projs;
    std::vector<DJobRec> djobs;
    EnvRec env;
    std::string env_music_frag;
    uint64_t units_fold = 0, bldgs_fold = 0, djobs_fold = 0, proj_fold = 0, env_fold = 0;
    uint64_t env_delta_fold = 0;
};
LastReadState g_last_read;

// A v1 connection's interest for this tick.
struct Interest { WsConnection* conn; std::string player; int ox, oy, oz, w, h; };

} // namespace

// ---- hello_ack map info -----------------------------------------------------------
V1MapInfo world_stream_map_info(std::recursive_mutex& capture_mu) {
    try {
        std::lock_guard<std::recursive_mutex> lock(capture_mu);
        CoreSuspender suspend;
        V1MapInfo mi;
        { std::lock_guard<std::mutex> lk(g_mapinfo_mu); mi = g_mapinfo; }
        if (Maps::IsValid()) {
            int mx = 0, my = 0, mz = 0;
            Maps::getSize(mx, my, mz);
            mi.w = mx * 16; mi.h = my * 16; mi.z = mz;
        }
        mi.world_seq = g_gms.world_seq;
        { std::lock_guard<std::mutex> lk(g_mapinfo_mu); g_mapinfo = mi; }
        return mi;
    } catch (...) {
        std::lock_guard<std::mutex> lk(g_mapinfo_mu);
        g_mapinfo.world_seq = g_gms.world_seq;
        return g_mapinfo;
    }
}

// ---- the per-tick global read pass (§WA-9.3) --------------------------------------
void world_stream_tick(std::recursive_mutex& capture_mu,
                       const std::function<std::string(const std::string&)>& presence_fn) {
    auto conns = ws_v1_connections();

    // Prune per-conn state for connections that are gone; drop diag rows for players with
    // no remaining v1 connection.
    {
        std::unordered_set<WsConnection*> live;
        std::unordered_set<std::string> livePlayers;
        for (auto& c : conns) { live.insert(c.get()); livePlayers.insert(c->player()); }
        for (auto it = g_conn.begin(); it != g_conn.end(); )
            it = live.count(it->first) ? std::next(it) : g_conn.erase(it);
        std::lock_guard<std::mutex> lk(g_diag_mu);
        for (auto it = g_diag.begin(); it != g_diag.end(); )
            it = livePlayers.count(it->first) ? std::next(it) : g_diag.erase(it);
    }
    if (conns.empty()) return;   // zero v1 clients -> zero overhead

    // ---- WA-11.3 REQ_BLOCKS intake -----------------------------------------------------
    // Thread-safe queues (recv-thread producer, this thread consumer) drained here, range-
    // validated against the cached map dims, and promoted to this connection's front-of-line
    // (priority 0, §0.8). No DF access -- safe before the suspended section.
    std::unordered_set<uint64_t> req_this_tick;
    {
        V1MapInfo mi; { std::lock_guard<std::mutex> lk(g_mapinfo_mu); mi = g_mapinfo; }
        int mbx = mi.w > 0 ? (mi.w + 15) / 16 : 0;
        int mby = mi.h > 0 ? (mi.h + 15) / 16 : 0;
        int mbz = mi.z;
        for (auto& c : conns) {
            auto triples = c->take_reqblocks();
            if (triples.empty()) continue;
            ConnState& cs = g_conn[c.get()];
            for (auto& t : triples) {
                int bx = t[0], by = t[1], bz = t[2];
                if (bx < 0 || by < 0 || bz < 0) continue;
                if (mbx > 0 && bx >= mbx) continue;
                if (mby > 0 && by >= mby) continue;
                if (mbz > 0 && bz >= mbz) continue;
                uint64_t key = bkey(bx, by, bz);
                cs.pending.insert(key);
                req_this_tick.insert(key);   // S2 force-scan exception: client is waiting now.
                if (std::find(cs.req_front.begin(), cs.req_front.end(), key) == cs.req_front.end())
                    cs.req_front.push_back(key);
            }
        }
    }

    // Build interests (only conns that have sent hello + carry CAM dims participate; the
    // interest POSITION is the POST /camera authority, dims come from CAM -- §0.8).
    std::vector<Interest> interests;
    interests.reserve(conns.size());
    for (auto& c : conns) {
        if (!c->hello_received()) continue;
        int cx, cy, cz, cw, ch;
        if (!c->get_cam(cx, cy, cz, cw, ch)) continue;
        Camera cam; std::string err;
        if (!camera_for_player(c->player(), cam, &err)) continue;
        Interest in;
        in.conn = c.get(); in.player = c->player();
        in.ox = cam.x; in.oy = cam.y; in.oz = cam.z;
        in.w = clampdim(cw); in.h = clampdim(ch);
        interests.push_back(in);

        // ---- WA-11.1/.2: one-time resume-vs-snapshot decision, made as soon as this
        // connection's hello+cam are first available. --------------------------------
        ConnState& cs0 = g_conn[c.get()];
        if (!cs0.startup_decided) {
            cs0.startup_decided = true;
            uint32_t have = c->hello_have();
            if (changelog_within(g_gms, have)) {
                // RESUME (§WA-11.2): pending = union of changelog entries dirtied since
                // `have`, restricted to blocks whose CURRENT ver is actually > have (skip
                // re-dirtied convergence). No snapshot_meta trickle -- AUX is fresh anyway.
                for (auto& entry : g_gms.changelog) {
                    if (entry.first <= have) continue;
                    for (uint64_t k : entry.second) {
                        auto vit = g_gms.ver.find(k);
                        if (vit != g_gms.ver.end() && vit->second > have) cs0.pending.insert(k);
                    }
                }
            } else {
                // FULL SNAPSHOT (§WA-11.1): seed the background discovery walk, ordered by
                // |z - cam.z| then column-major (bx,by). Interest-window blocks need no
                // separate seeding -- the existing in-view scan re-offers them every tick
                // unconditionally (priorities 1-3 below).
                V1MapInfo mi; { std::lock_guard<std::mutex> lk(g_mapinfo_mu); mi = g_mapinfo; }
                int mbx = mi.w > 0 ? (mi.w + 15) / 16 : 0;
                int mby = mi.h > 0 ? (mi.h + 15) / 16 : 0;
                int mz  = mi.z > 0 ? mi.z : 0;
                cs0.trickle_active = true;
                cs0.trickle_mbx = mbx; cs0.trickle_mby = mby;
                cs0.trickle_z_order.assign(mz, 0);
                for (int z = 0; z < mz; ++z) cs0.trickle_z_order[(size_t)z] = z;
                int camz = in.oz;
                auto zdist = [](int a, int b) { return a > b ? a - b : b - a; };
                std::sort(cs0.trickle_z_order.begin(), cs0.trickle_z_order.end(),
                          [camz, zdist](int a, int b) { return zdist(a, camz) < zdist(b, camz); });
                cs0.trickle_z_idx = 0; cs0.trickle_bx = 0; cs0.trickle_by = 0;
                std::string meta = "{\"type\":\"snapshot_meta\",\"world_seq\":" +
                    std::to_string(g_gms.world_seq) + ",\"discovered_blocks\":" +
                    std::to_string(g_gms.sig.size()) + ",\"trickle\":\"begin\"}";
                c->enqueue_frame(WsConnection::CH_CTRL,
                                 std::vector<uint8_t>(meta.begin(), meta.end()), /*binary=*/false);
            }
        }
    }
    if (interests.empty()) return;

    // Scan set = union of interest rects x z-range [z-10, z] (§WA-9.3b).
    std::unordered_set<uint64_t> scan;
    for (const auto& in : interests) {
        int bx0 = fdiv16(in.ox), bx1 = fdiv16(in.ox + in.w - 1);
        int by0 = fdiv16(in.oy), by1 = fdiv16(in.oy + in.h - 1);
        int z1 = in.oz, z0 = in.oz - 10; if (z0 < 0) z0 = 0;
        for (int bz = z0; bz <= z1; ++bz)
            for (int bx = bx0; bx <= bx1; ++bx)
                for (int by = by0; by <= by1; ++by)
                    if (bx >= 0 && by >= 0) scan.insert(bkey(bx, by, bz));
    }
    // A REQ_BLOCKS key may be outside the current camera union. It is nevertheless a same-tick
    // force-scan exception before we encode and return it to the waiting client.
    scan.insert(req_this_tick.begin(), req_this_tick.end());

    std::unordered_map<uint64_t, std::shared_ptr<wire::EncodedBlock>> encoded;
    std::vector<UnitRec> units;
    std::vector<BldRec> bldgs;
    std::vector<ProjRec> projs;   // WC-22
    std::vector<DJobRec> djobs;   // B35
    EnvRec env;                   // WC-20
    // V2 audio: canonical env.music fragment (computed once/frame). Seeded with a VALID default so
    // the env JSON is well-formed even on the (guarded) path where the env block doesn't run --
    // "," << env_music_frag << "}" must never become ",}".
    std::string env_music_frag = "\"music\":{\"track\":\"hill_dwarf\",\"elapsedMs\":0,\"manual\":false}";
    // per-conn plan: which block keys to send this tick + whether to emit AUX.
    struct Plan { WsConnection* conn; std::vector<uint64_t> keys; bool aux; bool trickle_end = false; };
    std::vector<Plan> plans;
    plans.reserve(interests.size());

    int scanCount = 0, dirtyCount = 0;
    // S1 eligibility is deliberately narrower than "the fort looked quiet last tick". We
    // never skip while stream work is queued (dirty/pending, REQ_BLOCKS, or snapshot trickle),
    // while a new interest block needs its first signature, or before we have a full neutral
    // snapshot to serve AUX from. `paused` itself is only read under the previous acquisition.
    bool no_stream_work = req_this_tick.empty();
    for (const auto& c : conns) {
        const ConnState& cs = g_conn[c.get()];
        if (!cs.pending.empty() || !cs.req_front.empty() || cs.trickle_active ||
            !cs.trickle_backlog.empty()) {
            no_stream_work = false;
            break;
        }
    }
    bool has_first_seen = false;
    for (uint64_t key : scan) {
        if (g_gms.sig_seen.find(key) == g_gms.sig_seen.end()) {
            has_first_seen = true;
            break;
        }
    }
    const bool paused_idle = g_last_read.valid && g_last_read.paused && no_stream_work &&
                             !has_first_seen;
    const bool paused_idle_skip = paused_idle && ++g_paused_idle_ticks < kPausedIdleScanEvery;
    if (!paused_idle || !paused_idle_skip) g_paused_idle_ticks = 0;
    // A paused cadence acquisition reads every bucket, rather than its ordinary S2 bucket.
    // That keeps a native paused UI mutation bounded by four ticks instead of composing S1
    // (every fourth tick) with S2 (one bucket per fourth tick).
    const bool paused_idle_full_scan = paused_idle && !paused_idle_skip;
    const uint32_t scan_slot = static_cast<uint32_t>(g_sig_scan_tick++ % kSigScanBuckets);
    // F6 Phase-0 (a1): per-phase accumulators for THIS tick (ms). Filled by ph_lap() at the
    // phase boundaries inside the suspended block + the post-release AUX loop, then pushed as
    // one g_phase_ring entry at function end. Declared out here so the post-release loop and
    // the end-of-tick ring push can see them.
    PhaseTimes pt;
    // F6 Phase-0b: bracket marks. t0 = pre-lock; tA = after capture_mu; tB = after CoreSuspender.
    // Only meaningful once a full tick completes (early/exception returns skip the ring push, so
    // an unset tA/tB is never read). frame_counter/paused snapshot the sim-throughput oracle.
    auto t0 = std::chrono::steady_clock::now();
    auto tA = t0, tB = t0;
    int32_t frame_counter_snap = 0;
    bool paused_snap = false;
    std::vector<BakeSweepPoint> bake_candidates;
    bool collect_bake_candidates = false;
    int bake_viewport_w = 80, bake_viewport_h = 50, bake_map_w = 0, bake_map_h = 0;
    if (paused_idle_skip) {
        // The cached neutral records below are enough for the post-release AUX fanout. There
        // cannot be a BLOCK_SET here: no pending/request/trickle/first-seen work is eligible
        // for this path, by the S1 predicate above.
        for (const auto& in : interests) {
            Plan plan;
            plan.conn = in.conn;
            plan.aux = in.conn->window_open(false);
            plans.push_back(std::move(plan));
        }
    } else {
    try {
        std::lock_guard<std::recursive_mutex> lock(capture_mu);
        tA = std::chrono::steady_clock::now();
        CoreSuspender suspend;
        tB = std::chrono::steady_clock::now();
#ifdef DWF_DIAG_SEED_MISLAP
        // T1 test-the-test (spec §6): fold tB back onto t0 so the CoreSuspender wait is
        // mis-attributed out of suspWait -> the C1 reconciliation (capWait+suspWait vs residualMs)
        // MUST break by ~suspWait. Proves the split is load-bearing, not decorative.
        tB = t0;
#endif
        if (!Maps::IsValid()) return;
        auto world = df::global::world;
        if (!world) return;
        bake_sweep_observe_world(reinterpret_cast<uintptr_t>(world));
        portrait_sweep_observe_world(reinterpret_cast<uintptr_t>(world));
        collect_bake_candidates = bake_sweep_needs_candidates();
        bake_map_w = world->map.x_count; bake_map_h = world->map.y_count;
        if (auto gps = df::global::gps) {
            if (gps->main_viewport && gps->main_viewport->dim_x > 0 && gps->main_viewport->dim_y > 0) {
                bake_viewport_w = gps->main_viewport->dim_x;
                bake_viewport_h = gps->main_viewport->dim_y;
            }
        }
        frame_counter_snap = world->frame_counter;
        paused_snap = df::global::pause_state ? *df::global::pause_state : false;
#ifdef DWF_DIAG_SEED_STALL
        // T2 test-the-test (spec §6): a real 5 ms stall inside the hold -> dfStallMsPerSec must
        // rise ~150 ms/s (30 Hz x 5 ms) AND simTicksPerSec must visibly drop. Proves the gate
        // metrics detect a genuine stall rather than passing vacuously.
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
#endif

        // Warm the host-camera cache while we legally hold the core, so next tick's
        // interest-building (camera_for_player, above/pre-suspend) never marshals a read
        // onto the render thread (see g_host_cam in client_state.cpp -- crash fix).
        if (df::global::window_x && df::global::window_y && df::global::window_z) {
            Camera hostcam;
            hostcam.x = *df::global::window_x;
            hostcam.y = *df::global::window_y;
            hostcam.z = *df::global::window_z;
            note_host_camera(hostcam);
        }

        // F6 Phase-0: moving-cursor phase timer. ph_lap(acc) adds the elapsed since the last
        // mark to `acc` and re-marks -- ~20 ns/call, 7 calls/tick (negligible; and the whole
        // tick early-returns before here when there are zero v1 clients, so idle overhead is 0).
        auto ph_mark = std::chrono::steady_clock::now();
        auto ph_lap = [&ph_mark](double& acc) {
            auto n = std::chrono::steady_clock::now();
            acc += std::chrono::duration<double, std::milli>(n - ph_mark).count();
            ph_mark = n;
        };

        // WC-1: build ITEMDEF_DICT once (raws are static per fort load -- §1.5 "dict
        // build is one-time"); cheap (14 vectors, a few hundred entries typical).
        if (!g_itemdef_ready) {
            wire::ItemDefSubcat subcats[wire::kItemDefSubcatCount];
            wire::read_itemdef_dict(world, subcats);
            std::vector<uint8_t> payload = wire::assemble_itemdef_dict(subcats);
            std::vector<uint8_t> frame = wire::build_frame_header(wire::kTypeItemDefDict, 0, 0);
            frame.insert(frame.end(), payload.begin(), payload.end());
            g_itemdef_frame = std::move(frame);
            g_itemdef_ready = true;
        }
        // TX4: one cheap farm-contained-item scan per suspended stream tick. block_signature
        // and encode_block consume this same immutable-by-convention snapshot below.
        wire::refresh_farm_crop_index(world);
        ph_lap(pt.misc);   // F6 P0: one-time itemdef dict build + IsValid/world fetch

        // (i) S2 sig-scan: one stable quarter of the interest union per normal tick. REQ
        // keys and never-before-seen keys bypass the bucket; a paused S1 cadence acquisition
        // scans the whole union so a native paused edit still lands within four push ticks.
        std::vector<uint64_t> dirty;
        for (uint64_t key : scan) {
            const bool first_seen = g_gms.sig_seen.find(key) == g_gms.sig_seen.end();
            if (!paused_idle_full_scan && !first_seen && !req_this_tick.count(key) &&
                sig_scan_bucket(key) != scan_slot)
                continue;
            ++scanCount;
            g_gms.sig_seen.insert(key);
            int bx, by, bz; bunpack(key, bx, by, bz);
            df::map_block* b = Maps::getBlock(bx, by, bz);
            // B209 UN-SHIP: a block we ALREADY tracked (g_gms.sig has it) stays in the sig-scan even
            // after it stops being shippable -- so erasing the LAST designation in a fully-hidden
            // block registers here as a signature change (block_signature folds the whole
            // designation grid), dirties the block, and re-encodes it as a pure-void frame that
            // clears the now-stale glyph on every client that still holds it. Without this the
            // block_shippable gate that first let the B204 designation-over-black through is the
            // very thing that hides its erasure: once dark it was skipped forever and the client
            // kept drawing the erased pick. A block that was NEVER shipped (no sig entry) and is
            // not shippable is still skipped -- no fog leak, no per-tick cost for undiscovered rock.
            if (!block_shippable(b) && g_gms.sig.find(key) == g_gms.sig.end()) continue;
            uint64_t sig = block_signature(world, b, bx, by, bz);
            auto it = g_gms.sig.find(key);
            bool changed = (it == g_gms.sig.end()) || (it->second != sig);
            if (changed) {
                g_gms.sig[key] = sig;
                g_gms.ver[key] = g_gms.world_seq + 1;
                dirty.push_back(key);
            }
        }
        ph_lap(pt.sig);   // F6 P0: (i) S2-selected block_signature() calls

        // (ii) if anything dirtied: bump world_seq, changelog, broadcast to every pending set.
        if (!dirty.empty()) {
            ++g_gms.world_seq;
            g_gms.changelog.push_back({g_gms.world_seq, dirty});
            while (g_gms.changelog.size() > kChangelogMax) g_gms.changelog.pop_front();
            for (auto& c : conns) for (uint64_t k : dirty) g_conn[c.get()].pending.insert(k);
        }
        dirtyCount = (int)dirty.size();

        // (iii) per-connection: refresh in-view pending, pick sendable keys (in-view first,
        //       capped 24/frame, gated by the pacing window + FIFO space).
        std::unordered_set<uint64_t> needed;
        for (const auto& in : interests) {
            ConnState& cs = g_conn[in.conn];
            int bx0 = fdiv16(in.ox), bx1 = fdiv16(in.ox + in.w - 1);
            int by0 = fdiv16(in.oy), by1 = fdiv16(in.oy + in.h - 1);
            int z1 = in.oz, z0 = in.oz - 10; if (z0 < 0) z0 = 0;
            std::vector<uint64_t> inview;   // ordered: camera z first, then downward
            for (int bz = z1; bz >= z0; --bz)
                for (int bx = bx0; bx <= bx1; ++bx)
                    for (int by = by0; by <= by1; ++by) {
                        if (bx < 0 || by < 0) continue;
                        uint64_t key = bkey(bx, by, bz);
                        df::map_block* b = Maps::getBlock(bx, by, bz);
                        // B209 UN-SHIP: also OFFER a no-longer-shippable block to a conn that still
                        // HOLDS it (sent_ver has the key), so the pure-void re-encode reaches the
                        // client and clears the stale glyph. A conn that never received the block is
                        // still not offered a fully-hidden block -- fog-of-war preserved, as B204.
                        if (!block_shippable(b) && cs.sent_ver.find(key) == cs.sent_ver.end()) continue;
                        if (g_gms.ver.find(key) == g_gms.ver.end()) {   // WA-11.4 first-encode stamp
                            g_gms.ver[key] = g_gms.world_seq;
                            if (g_gms.sig.find(key) == g_gms.sig.end()) g_gms.sig[key] = block_signature(world, b, bx, by, bz);
                        }
                        uint32_t v = g_gms.ver[key];
                        auto sit = cs.sent_ver.find(key);
                        if (sit == cs.sent_ver.end() || sit->second < v) {
                            cs.pending.insert(key);
                            inview.push_back(key);
                        }
                    }
            Plan plan; plan.conn = in.conn; plan.aux = in.conn->window_open(false);
            // BLOCK_SET: assemble at most one frame this tick, if window + FIFO allow.
            // Priority order (§0.8): 0 REQ_BLOCKS, 1-3 in-view, 4 background trickle walk,
            // 5 leftover pending (off-screen dirty broadcast). Trickle never preempts
            // in-view: it only fills capacity in-view left unused (WA-11 acceptance).
            if (in.conn->window_open(true) && in.conn->v1_map_fifo_space() > 0) {
                // Priority 0 (§WA-11.3): REQ_BLOCKS front-of-line. Each queued key is
                // resolved (discovered test + first-encode ver stamp) and consumed from the
                // queue whether sent or dropped-as-stale/hidden; anything left when the frame
                // fills stays at the front for next tick.
                while (!cs.req_front.empty() && plan.keys.size() < wire::kMaxBlocksPerFrame) {
                    uint64_t key = cs.req_front.front(); cs.req_front.pop_front();
                    int bx, by, bz; bunpack(key, bx, by, bz);
                    df::map_block* b = Maps::getBlock(bx, by, bz);
                    // B209 UN-SHIP: honor a REQ for a block that went dark only if the conn already
                    // holds it (deliver the void un-ship); otherwise drop as before -- never seed a
                    // fully-hidden block to a conn that lacks it.
                    if (!block_shippable(b) && cs.sent_ver.find(key) == cs.sent_ver.end()) {
                        cs.pending.erase(key); continue;   // hidden & no desig, conn never had it: never sent
                    }
                    if (g_gms.ver.find(key) == g_gms.ver.end()) {
                        g_gms.ver[key] = g_gms.world_seq;
                        if (g_gms.sig.find(key) == g_gms.sig.end()) g_gms.sig[key] = block_signature(world, b, bx, by, bz);
                    }
                    // P1 (2026-07-10): NO sent_ver skip here, unlike every other priority band.
                    // A REQ_BLOCKS key is the client explicitly saying "I do not have this block"
                    // (evicted from its cache, or a trickle hole) -- the server's sent_ver
                    // bookkeeping is exactly what's stale in that situation. Terra's P1 run found
                    // the skip made the whole gap-fill feature a no-op for evicted blocks.
                    if (std::find(plan.keys.begin(), plan.keys.end(), key) != plan.keys.end()) continue;
                    plan.keys.push_back(key);
                    needed.insert(key);
                }
                // Priorities 1-3: in-view (camera z first, downward, §0.8).
                for (uint64_t k : inview) {
                    if (plan.keys.size() >= wire::kMaxBlocksPerFrame) break;
                    if (std::find(plan.keys.begin(), plan.keys.end(), k) != plan.keys.end()) continue;
                    plan.keys.push_back(k);
                    needed.insert(k);
                }
                // Priority 4 (§WA-11.1): advance the background discovery walk by a bounded
                // per-tick budget (cheap hidden-bit reads; never a multi-second suspend), then
                // drain whatever it has queued so far -- still capped by the frame limit.
                if (cs.trickle_active) {
                    for (int i = 0; i < kTrickleVisitBudget; ++i) {
                        if (!trickle_visit_one(world, g_gms, cs)) {
                            cs.trickle_active = false;
                            plan.trickle_end = true;
                            break;
                        }
                    }
                }
                while (!cs.trickle_backlog.empty() && plan.keys.size() < wire::kMaxBlocksPerFrame) {
                    uint64_t key = cs.trickle_backlog.front(); cs.trickle_backlog.pop_front();
                    auto sit = cs.sent_ver.find(key);
                    uint32_t v = g_gms.ver.count(key) ? g_gms.ver[key] : g_gms.world_seq;
                    if (sit != cs.sent_ver.end() && sit->second >= v) { cs.pending.erase(key); continue; }
                    if (std::find(plan.keys.begin(), plan.keys.end(), key) != plan.keys.end()) continue;
                    plan.keys.push_back(key);
                    needed.insert(key);
                }
                // Priority 5: leftover pending (off-screen dirty -- global broadcast, §0.8.5).
                if (plan.keys.size() < wire::kMaxBlocksPerFrame) {
                    for (uint64_t k : cs.pending) {
                        if (plan.keys.size() >= wire::kMaxBlocksPerFrame) break;
                        if (std::find(plan.keys.begin(), plan.keys.end(), k) != plan.keys.end()) continue;
                        plan.keys.push_back(k);
                        needed.insert(k);
                    }
                }
            }
            plans.push_back(std::move(plan));
        }
        ph_lap(pt.misc);   // F6 P0: (ii) changelog + (iii) per-conn pending/plan scheduling (incl. block_discovered/first-encode reads)

        // (iv) encode-once each needed block (shared across connections).
        MapExtras::MapCache MC;
        for (uint64_t key : needed) {
            int bx, by, bz; bunpack(key, bx, by, bz);
            df::map_block* b = Maps::getBlock(bx, by, bz);
            uint32_t v = g_gms.ver.count(key) ? g_gms.ver[key] : g_gms.world_seq;
            encoded[key] = std::make_shared<wire::EncodedBlock>(
                wire::encode_block(world, MC, b, bx, by, bz, v));
        }
        ph_lap(pt.enc);   // F6 P0: (iv) wire::encode_block for dirty/owed blocks only

        // (v) ONE units scan + ONE buildings scan into neutral vectors (WE-5 filtering).
        // B278: v1 streaming replaces the legacy /mapdata poll once the WebSocket is live, so
        // emit_units() is no longer available to drive the texture census. Run the same census
        // here, inside this scan's existing CoreSuspender hold, or units that arrive after the
        // client connects are never queued for composite export. A page refresh appeared to fix
        // them only because its boot-time /mapdata request called emit_units() once.
        unit_census_pass(world->units.active);
        // WE-3: one snapshot of the WE-2 exporter's unit_id->record map up front (NOT
        // per-unit -- unit_sprite_snapshot() copies the whole map, so per-unit calls
        // would be O(units^2)); each unit does a plain O(1) lookup into it below. No DF
        // reads involved -- WE-2's own mutex, held only for this copy.
        std::unordered_map<int32_t, UnitSpriteRecord> sprite_snapshot =
            unit_sprite_export_enabled() ? unit_sprite_snapshot()
                                          : std::unordered_map<int32_t, UnitSpriteRecord>{};
        // B23: highest connected camera z -- units below it are candidates for see-down.
        // interests is non-empty here (checked above). Bounds the per-unit open-column walk.
        int maxCamZ = interests[0].oz;
        for (const auto& q : interests) if (q.oz > maxCamZ) maxCamZ = q.oz;
        const int MAX_SEEDOWN = 60;   // mirrors tile_map_dump.cpp's terrain MAX_DEPTH
        for (size_t i = 0; i < world->units.active.size(); ++i) {
            df::unit* u = world->units.active[i];
            if (!u) continue;
            // units.active retains killed/inactive records after death. Native DF still
            // draws real ghosts translucently, so preserve the explicit ghostly exception.
            if (!Units::isGhost(u) &&
                (!Units::isActive(u) || !Units::isAlive(u))) continue;
            if (u->flags1.bits.hidden_in_ambush) continue;
            df::map_block* ublk = Maps::getTileBlock(u->pos);
            if (ublk && ublk->designation[u->pos.x & 15][u->pos.y & 15].bits.hidden) continue;
            UnitRec r; r.x = u->pos.x; r.y = u->pos.y; r.z = u->pos.z;
            // B23 see-down visibility: walk UP from the unit through open (EMPTY/RAMP_TOP/AIR)
            // tiles -- the highest contiguously-open z is the topmost camera that can see the
            // unit through the floor(s) above (same is_open predicate + null-block-is-transparent
            // rule the terrain see-down descent uses in tile_map_dump.cpp). Only computed for
            // units below some camera; the walk stops at the first solid ceiling, so a unit under
            // a roof is correctly hidden from cameras above that roof.
            r.sd_top = r.z;
            if (r.z < maxCamZ) {
                int lx = r.x & 15, ly = r.y & 15;
                int limit = std::min(maxCamZ, r.z + MAX_SEEDOWN);
                int top = r.z;
                for (int z = r.z + 1; z <= limit; ++z) {
                    df::map_block* ab = Maps::getTileBlock(df::coord(r.x, r.y, z));
                    if (ab) {
                        df::tiletype att = ab->tiletype[lx][ly];
                        df::tiletype_shape s = tileShape(att);
                        df::tiletype_material m = tileMaterial(att);
                        bool open = (s == df::tiletype_shape::EMPTY
                                  || s == df::tiletype_shape::RAMP_TOP
                                  || m == df::tiletype_material::AIR);
                        if (!open) break;
                    }
                    top = z;   // open (or a null/unallocated block -> transparent, per the descent)
                }
                r.sd_top = top;
            }
            r.id = u->id; r.race = u->race; r.caste = u->caste;
            r.ghostly = Units::isGhost(u);
            const uint64_t name_fold = s3_name_fold(u->name);
            UnitDerived& named = g_unit_derived[r.id];
            if (named.fold != name_fold) { named.fold = name_fold; named.name = u->name.has_name ? Translation::translateName(&u->name, true) : std::string(); }
            r.name = named.name;
            const auto race_key = std::make_pair(r.race, r.caste);
            auto raw = g_race_caste_derived.find(race_key);
            if (raw == g_race_caste_derived.end()) {
                std::pair<std::string, std::string> names;
                if (u->race >= 0 && (size_t)u->race < world->raws.creatures.all.size()) {
                    df::creature_raw* cr = world->raws.creatures.all[u->race];
                    if (cr) { names.first = cr->creature_id; if (u->caste >= 0 && (size_t)u->caste < cr->caste.size() && cr->caste[u->caste]) names.second = cr->caste[u->caste]->caste_id; }
                }
                raw = g_race_caste_derived.emplace(race_key, std::move(names)).first;
            }
            r.rt = raw->second.first; r.ct = raw->second.second;
            auto sit = sprite_snapshot.find(u->id);
            if (sit != sprite_snapshot.end() && !sit->second.hash.empty()) {
                r.ah = sit->second.hash; r.sw = sit->second.sw; r.sh = sit->second.sh;
                r.ax = sit->second.ax; r.ay = sit->second.ay;
            }
            // Portrait bake sweep: only visible/revealed units reach here. A unit is a
            // candidate when DF has no live texpos slot, its appearance is flagged dirty,
            // or the exporter has not yet served the current composite. This piggybacks on
            // the existing unit read and adds no per-tick AUX fields.
            if (collect_bake_candidates && ublk) {
                bool has_texpos = false;
                for (int tx = 0; tx < 3; ++tx)
                    for (int ty = 0; ty < 2; ++ty)
                        has_texpos = has_texpos || (u->texpos[tx][ty] != 0 &&
                                                     u->texpos_currently_in_use[tx][ty]);
                const bool served = sit != sprite_snapshot.end() && !sit->second.hash.empty();
                if (!has_texpos || u->flags4.bits.any_texture_must_be_refreshed || !served)
                    bake_candidates.push_back({u->pos.x, u->pos.y, u->pos.z});
            }
            // PORTRAITS-ROOT (B128): DF only fills unit->portrait_texpos when a unit view
            // sheet is rendered for that unit, so most portraits stay 0 for the whole
            // session unless the host opens each dwarf in the Steam UI. Offer every
            // streamed unit that still has no portrait to the paced generation sweep
            // (dedup'd there); migrants/newborns enter on their first scan automatically.
            if (u->portrait_texpos == 0)
                portrait_sweep_note_unit(u->id, Units::isFortControlled(u));
            // WINDOW #13 / WT29 / B222: overhead status flags -- the ONE shared computation in
            // unit_status.h (crisp DF fields only, incl. the WT29 mood-subtype nibble; returns 0
            // for non-living units, so the ghost belt-and-braces is inside the helper). Runs
            // under the EXISTING CoreSuspender hold, per the helper's contract.
            r.st = unit_status_bits(u);
            r.st2 = unit_status_bits2(u);   // WT31
            r.rec_fold = s4_unit_fold(r, name_fold);
            units.push_back(std::move(r));
        }
        ph_lap(pt.unit);   // F6 P0: (v) units scan -- sprite snapshot + translateName + B23 sd_top walks

        std::unordered_set<int> seen_bld_ids;
        for (size_t i = 0; i < world->buildings.all.size(); ++i) {
            df::building* b = world->buildings.all[i];
            if (!b) continue;
            const int bld_id = b->id;
            seen_bld_ids.insert(bld_id);
            const uint64_t probe_fold = s3_bld_fold(b);
            auto cached_bld = g_bld_derived.find(bld_id);
            if (cached_bld != g_bld_derived.end() && cached_bld->second.fold == probe_fold) { bldgs.push_back(cached_bld->second.rec); continue; }
            BldRec r; r.id = bld_id; r.x1 = b->x1; r.y1 = b->y1; r.x2 = b->x2; r.y2 = b->y2; r.z = b->z;
            r.type = ENUM_KEY_STR(building_type, b->getType());
            r.subtype = (int)b->getSubtype(); r.stage = (int)b->getBuildStage();
            // B18: a building is "built" once its build stage reaches its max -- a queued/unbuilt
            // construction (or any planned building) reports false so the client can draw a
            // pending designation box. Additive JSON field, no binary-wire (CRC) surface.
            r.built = b->getBuildStage() >= b->getMaxBuildStage();
            // B08: per-tile stockpile footprint bitmap (row-major over the bbox, '1'=in the
            // pile, '0'=notch). DF stockpiles are frequently painted into irregular (L-shaped)
            // shapes, so the bbox alone over-draws; this lets the client render the TRUE outline
            // (like /zones does for civzones). Emitted only for stockpiles (bounded cost). If the
            // pile is a full rectangle (no shaped extents) the string is left empty and the client
            // falls back to the bbox box. Additive JSON, no binary-wire (CRC) surface.
            if (b->getType() == df::building_type::Stockpile && b->isExtentShaped() &&
                b->room.extents && b->room.width > 0 && b->room.height > 0) {
                int bw = b->x2 - b->x1 + 1, bh = b->y2 - b->y1 + 1;
                if (bw > 0 && bh > 0 && bw * bh <= 4096) {
                    r.ext.reserve((size_t)bw * bh);
                    for (int yy = 0; yy < bh; ++yy) {
                        for (int xx = 0; xx < bw; ++xx) {
                            int dx = (b->x1 + xx) - b->room.x;
                            int dy = (b->y1 + yy) - b->room.y;
                            bool in = dx >= 0 && dy >= 0 && dx < b->room.width && dy < b->room.height &&
                                b->room.extents[dx + dy * b->room.width] != df::building_extents_type::None;
                            r.ext.push_back(in ? '1' : '0');
                        }
                    }
                }
            }
            // BUILDING COLOR (2026-07-09; B273): native derives a building's
            // appearance from its COMPONENT items, not the header material -- a microcline-header
            // workshop actually built from gray stone reads GRAY natively, but the header alone
            // over-tints the browser CYAN. The client therefore never uses `rgb` for coloring:
            //   `rgb`  = the HEADER material's descriptor color (present whenever resolvable),
            //   `crgb` = the COMPONENT-derived color, OPTIONAL -- emitted only when a structural
            //            component resolves,
            //   `cpal` = that component's canonical STATE_COLOR descriptor token. B273 needs this
            //            because RGB alone cannot select one of DF's 137 full 18-color ramps.
            // An old client ignores cpal and retains the crgb multiply approximation; a new client
            // palette-substitutes exact source pixels and uses crgb only if cpal is unknown. Only
            // building_actual subclasses carry contained_items (plain building*/
            // civzones do not) -> virtual_cast guards that. Additive JSON only; NO binary-wire /
            // golden-CRC surface. LIVE ACCEPTANCE (still deferred -- pause-only): needs the native
            // multi-material oracle per building class; the SIGNAL derivation is what's verified.
            // Resolve material -> its solid-state descriptor RGB and optional canonical token.
            auto resolve_desc_rgb = [&](int mt, int mi, int& rr, int& gg, int& bb,
                                        std::string* palette_token) -> bool {
                const auto key = std::make_pair(mt, mi);
                auto cached = g_mat_rgb_derived.find(key);
                if (cached == g_mat_rgb_derived.end()) {
                    MatRgb rgb;
                    if (mt >= 0) {
                        MaterialInfo minfo(mt, mi);
                        if (minfo.isValid() && minfo.material) {
                            int cidx = minfo.material->state_color[df::matter_state::Solid];
                            if (cidx >= 0 && (size_t)cidx < world->raws.descriptors.colors.size()) {
                                df::descriptor_color* col = world->raws.descriptors.colors[cidx];
                                if (col) {
                                    rgb.r = std::min(255, std::max(0, (int)(col->red   * 255.0f + 0.5f)));
                                    rgb.g = std::min(255, std::max(0, (int)(col->green * 255.0f + 0.5f)));
                                    rgb.b = std::min(255, std::max(0, (int)(col->blue  * 255.0f + 0.5f)));
                                    rgb.palette_token = col->id;
                                    rgb.valid = true;
                                }
                            }
                        }
                    }
                    cached = g_mat_rgb_derived.emplace(key, rgb).first;
                }
                if (!cached->second.valid) return false;
                rr = cached->second.r; gg = cached->second.g; bb = cached->second.b;
                if (palette_token) *palette_token = cached->second.palette_token;
                return true;
            };
            r.mat_type = b->mat_type; r.mat_index = b->mat_index;   // header material (unchanged wire)
            r.has_rgb  = resolve_desc_rgb(r.mat_type, r.mat_index, r.r, r.g, r.b, nullptr);
            r.has_crgb = false; r.cpal.clear();
            if (df::building_actual* ba = virtual_cast<df::building_actual>(b)) {
                for (df::buildingitemst* bi : ba->contained_items) {
                    if (!bi || !bi->item) continue;
                    if (bi->use_mode != df::building_item_role_type::PERM) continue;
                    int cmt = (int)bi->item->getMaterial();
                    if (cmt < 0) continue;
                    // First structural (PERM) component is the tintprobe-established signal for
                    // the single-material furniture/workshop cases. Building graphics flags carry
                    // one 8-bit descriptor color index, but mixed-component selection still needs
                    // a controlled native differential (documented B273 residual). If this item
                    // cannot resolve, emit neither component field; the header remains metadata,
                    // never a color fallback.
                    r.has_crgb = resolve_desc_rgb(cmt, (int)bi->item->getMaterialIndex(),
                                                  r.cr, r.cg, r.cb, &r.cpal);
                    break;
                }
            }
            // WC-6: direction/state/category (machines, doors, bridges, wells, farmplot,
            // stockpile/civzone). Guarded virtual_casts only; no map access. Left ds_valid=false
            // for plain workshops/furniture (fields omitted from AUX, old clients unaffected).
            fill_building_ds(b, r);
            r.rec_fold = probe_fold;
            g_bld_derived[bld_id] = BldDerived{probe_fold, r};
            bldgs.push_back(std::move(r));
        }
        // ZBELOW-BUILDINGS: refresh see-down reach every scan, outside the derived-record cache:
        // ceilings and connected-camera z can change while a building's own content fold does not.
        // Use the footprint anchor (x1,y1) as the representative column; checking every footprint
        // tile would multiply map reads for large workshops while this matches other renderer-side
        // single-value approximations for multi-tile building records.
        for (auto& r : bldgs) {
            r.sd_top = r.z;
            if (r.z < maxCamZ) {
                int lx = r.x1 & 15, ly = r.y1 & 15;
                int limit = std::min(maxCamZ, r.z + MAX_SEEDOWN);
                int top = r.z;
                for (int z = r.z + 1; z <= limit; ++z) {
                    df::map_block* ab = Maps::getTileBlock(df::coord(r.x1, r.y1, z));
                    if (ab) {
                        df::tiletype att = ab->tiletype[lx][ly];
                        df::tiletype_shape shape = tileShape(att);
                        df::tiletype_material mat = tileMaterial(att);
                        bool open = (shape == df::tiletype_shape::EMPTY
                                  || shape == df::tiletype_shape::RAMP_TOP
                                  || mat == df::tiletype_material::AIR);
                        if (!open) break;
                    }
                    top = z; // null/unallocated blocks are transparent, matching terrain and B23 units
                }
                r.sd_top = top;
            }
        }
        for (auto it = g_bld_derived.begin(); it != g_bld_derived.end(); ) it = seen_bld_ids.count(it->first) ? std::next(it) : g_bld_derived.erase(it);
        std::unordered_set<int> seen_unit_ids; for (const auto& unit : units) seen_unit_ids.insert(unit.id);
        for (auto it = g_unit_derived.begin(); it != g_unit_derived.end(); ) it = seen_unit_ids.count(it->first) ? std::next(it) : g_unit_derived.erase(it);
        ph_lap(pt.bld);   // F6 P0: (v) buildings scan with S3 derived-record caches

        // B35/B54: smooth and mining-family designation JOBS. When DF materializes a job,
        // it clears the corresponding map bits. GatherPlants jobs are accepted only when their
        // position is still a SHRUB tile: unlike the other designation jobs, accepting the enum
        // alone produced phantom gather glyphs on arbitrary ground and made erase appear to lose
        // (B122/B124). This is an O(1) map lookup only for GatherPlants jobs, not a broad plant scan.
        // The old scan recovered smooth/chop/gather but
        // explicitly omitted Dig/stairs/ramp/channel, so a claimed WALL lost its mining glyph
        // even though native kept drawing it from the live job. Scan the complete map-designation
        // job family here (plain linked-list reads under
        // the EXISTING CoreSuspender -- no new suspension) and emit the affected tiles as an
        // additive AUX array so the client keeps drawing the glyph. EXCLUDED on purpose:
        // EngraveSlab (211) = ITEM engraving, not a tile designation. Existing AUX field,
        // window filtering, and binary-wire / CRC surface stay unchanged.
        for (df::job_list_link* node = world->jobs.list.next; node; node = node->next) {
            df::job* job = node->item;
            if (!job) continue;
            int kind = 0;
            switch (job->job_type) {
                case df::job_type::SmoothWall:
                case df::job_type::SmoothFloor:        kind = 1; break;  // smooth
                case df::job_type::DetailWall:
                case df::job_type::DetailFloor:        kind = 2; break;  // engrave
                case df::job_type::CarveFortification: kind = 3; break;  // fortify
                case df::job_type::CarveTrack:         kind = 4; break;  // track
                // Plant designations also clear the shared Default dig bit when DF queues
                // their work. Keep the native chop/gather glyph visible via this additive AUX
                // record; tile material alone cannot distinguish a claimed plant job.
                case df::job_type::FellTree:           kind = 5; break;  // chop
                case df::job_type::GatherPlants: {
                    df::map_block* block = Maps::getTileBlock(job->pos);
                    if (!block || DFHack::tileShape(block->tiletype[job->pos.x & 15][job->pos.y & 15]) !=
                            df::tiletype_shape::SHRUB)
                        continue;
                    kind = 6; break;  // gather (validated shrub tile only)
                }
                case df::job_type::Dig:                 kind = 7; break;  // regular mining
                case df::job_type::CarveUpwardStaircase:   kind = 8; break;
                case df::job_type::CarveDownwardStaircase: kind = 9; break;
                case df::job_type::CarveUpDownStaircase:   kind = 10; break;
                case df::job_type::CarveRamp:           kind = 11; break;
                case df::job_type::DigChannel:          kind = 12; break;
                case df::job_type::RemoveConstruction:  kind = 13; break;
                default: continue;
            }
            DJobRec dr; dr.x = job->pos.x; dr.y = job->pos.y; dr.z = job->pos.z; dr.k = kind;
            // B135: worker-claimed discriminator. Job::getWorker is exactly
            // getGeneralRef(job, general_ref_type::UNIT_WORKER) -- a plain vector walk on the
            // already-held job under the EXISTING CoreSuspender; no map access, no new suspension.
            dr.w = (DFHack::Job::getWorker(job) != nullptr);
            djobs.push_back(dr);
        }

        // WC-20: weather/season/year_tick -- one cheap global read (§WC-20 "Suspender: one
        // global read; ~0"). `World::ReadCurrentWeather()` already does the 5x5-grid ->
        // modal-value reduction DFHack itself uses for its own weather queries, so this
        // reuses it instead of re-deriving the same grid scan (matches hud.cpp's own
        // `weather_name(DFHack::World::ReadCurrentWeather())` call site). Season is derived
        // the SAME way hud.cpp already does (month = year_tick/1200/28, season = month/3) --
        // no new DF read, just the existing math duplicated at this call site (hud.cpp's
        // own struct is private to that file, not worth a cross-file refactor for 2 lines).
        env.weather = World::ReadCurrentWeather();
        {
            int year_tick = df::global::cur_year_tick ? *df::global::cur_year_tick : 0;
            env.year_tick = (uint32_t)(year_tick < 0 ? 0 : year_tick);
            int day_of_year = std::max(0, year_tick / 1200);
            int month = std::min(11, day_of_year / 28);
            env.season = (uint8_t)(month / 3);
        }
        // Settings Info: report DF's configured autosave interval, not the transient
        // plotinfo->main.autosave_request saving flag. This is a read-only global under the
        // existing suspender; the string literal snapshot is safe to serialize after release.
        if (df::global::d_init) {
            switch (df::global::d_init->feature.autosave) {
                case df::enums::d_init_autosave::NONE:       env.autosave = "none"; break;
                case df::enums::d_init_autosave::SEASONAL:   env.autosave = "seasonal"; break;
                case df::enums::d_init_autosave::YEARLY:     env.autosave = "yearly"; break;
                case df::enums::d_init_autosave::SEMIANNUAL: env.autosave = "semiannual"; break;
                default: break;
            }
        }

        // P3 audio (spec §2 "Needs small NEW instrumentation"): env.siege -- is a siege active
        // right now? plotinfo->invasions.list holds every invasion this fort has seen; an entry
        // is ACTIVE iff active_size1 != 0 (df.plotinfo.xml documents the field "0 unless
        // active"), and a SIEGE (vs a thief/snatcher incursion, mission SUPPORT_THIEVES) iff
        // mission == KILL_ALL_AT_SITE -- without the mission check one active kobold snatcher
        // would flip the client into Vile Force of Darkness + the Siege ambience (adversarial-
        // review finding #3). A late-joining client can't hear the one-shot SIEGE *announcement*
        // (fired before it connected), so this persistent bit lets it start the siege track.
        // Additive JSON in the aux `env` object only -- NOT the binary block wire, so the golden
        // CRC is untouched. Cheap: a short vector walk once per aux frame (~0 suspender cost,
        // same lap as the djobs/projectile walks).
        env.siege = false;
        if (auto* plotinfo = df::global::plotinfo) {
            for (df::invasion_info* inv : plotinfo->invasions.list) {
                if (inv && inv->active_size1 != 0 &&
                    inv->mission == df::mission_type::KILL_ALL_AT_SITE) {
                    env.siege = true;
                    break;
                }
            }
        }

        // V2 audio: fort-site surroundings alignment (env.evil/env.savage) for the
        // Good/Evil/Terrifying/Neutral ambient loops. region_map is indexed by world-tile coords
        // (same space as world_site::pos); region_map_entry.evilness (0-32 Good / 33-65 Neutral /
        // 66+ Evil) and .savagery (66+ Savage) -- the SAME read worldmap_panel.cpp uses for the
        // region-name plate (verified vs embark-assistant survey.cpp). Fail-soft to Neutral on a
        // pocket/degenerate world or before region_map populates. One O(sites) walk per aux frame,
        // cheap (fort count is tiny), under the existing suspender.
        env.evil = 1; env.savage = false;
        if (auto* plotinfo = df::global::plotinfo) {
            if (auto* wd = df::global::world ? df::global::world->world_data : nullptr) {
                int32_t own_site = plotinfo->site_id;
                for (auto site : wd->sites) {
                    if (!site || site->id != own_site) continue;
                    if (wd->region_map && wd->world_width > 0 && wd->world_height > 0 &&
                        site->pos.x >= 0 && site->pos.x < wd->world_width &&
                        site->pos.y >= 0 && site->pos.y < wd->world_height) {
                        auto& e = wd->region_map[site->pos.x][site->pos.y];
                        env.evil = (e.evilness >= 66) ? 2 : (e.evilness >= 33 ? 1 : 0);
                        env.savage = e.savagery >= 66;
                    }
                    break;
                }
            }
        }

        // V2 audio correction #1: advance + serialize the ONE canonical music state (env.music),
        // computed ONCE per aux frame (not per connection) so every client shares the identical
        // {track,elapsedMs,manual}. Auto selection uses the env triggers just computed. Manual
        // (host POST /music) is honored inside.
        //
        // WINDOW #13: first_year is now DERIVED (previously hardcoded -1/unknown). Source =
        // plotinfo->fortress_age -- the fort's lifetime measured in game-ticks/10 (DFHack's own
        // sort.lua keys founder detection on `fortress_age == unit...time_on_site // 10`, and
        // autobutcher gates on `fortress_age > 0`; it is a persistent, save-resident field, not a
        // volatile counter). One DF fortress-year = 336 days * 1200 ticks = 403200 ticks, so the
        // FIRST_YEAR window (CONTEXT:FIRST_YEAR) is fortress_age in [0, 40320). >= 40320 =>
        // established (CONTEXT:SECOND_YEAR_PLUS); plotinfo unavailable or a negative reading =>
        // -1 (unknown -> CONTEXT:MAIN, the prior no-regression fallback). Cosmetic music selection
        // only; NOT-VERIFIED against DF's native music engine (DFHack cannot read it -- inherent,
        // see music_sync.h banner), so the founding SIGNAL is what's verified, not the DF track.
        int first_year = -1;
        if (auto* pi = df::global::plotinfo) {
            constexpr int32_t kFortYearOver10 = 40320;   // 403200 ticks/year / 10
            int32_t age = pi->fortress_age;
            if (age >= 0) first_year = (age < kFortYearOver10) ? 1 : 0;
        }
        env_music_frag = music::frame_json(env.siege, (int)env.season, first_year);

        // WC-22: projectiles (world->projectiles.all is a proj_list_link DUMMY HEAD --
        // real entries start at .next, RFR rfr:1157-1219 pattern) + vehicles
        // (world->vehicles.active; a vehicle has NO pos of its own -- position comes from
        // its linked item, same RFR pattern the spec names). proj_itemst only (unit/magic
        // projectiles skipped per §WC-22 "proj_itemst only (skip unit/magic)" -- no art
        // source for those two on this wire yet). Both position sources ride the SAME
        // ProjRec shape (`is_vehicle` distinguishes them for the client).
        for (df::proj_list_link* node = world->projectiles.all.next; node; node = node->next) {
            df::projectile* p = node->item;
            if (!p) continue;
            VIRTUAL_CAST_VAR(pit, df::proj_itemst, p);
            if (!pit || !pit->item) continue;
            df::item* it = pit->item;
            ProjRec r{};
            r.x = p->cur_pos.x; r.y = p->cur_pos.y; r.z = p->cur_pos.z;
            // fine_*_adj is documented -50000..50000 (df.proj.xml); rescale to the wire's
            // 0..255 sub-tile fraction (§WC-22 "fx/fy = sub-tile 0-255"). DOCUMENTED
            // SIMPLIFICATION vs the spec's "copy RFR's two-branch position math": this
            // always reads pos_x/pos_y as the sub-tile offset regardless of the
            // `parabolic` (USE_PHYSICS) flag; RFR branches here because the two DF
            // projectile motion models (arcing vs sliding) use these fields with a
            // slightly different reference frame. A non-parabolic projectile (the common
            // case -- thrown/fired weapons) reads correctly; a parabolic one may show a
            // small sub-tile jitter -- a known, documented residual in the client's
            // sub-tile projectile placement (both renderers consume fx/fy).
            r.fx = std::min(255, std::max(0, (p->pos_x + 50000) * 255 / 100000));
            r.fy = std::min(255, std::max(0, (p->pos_y + 50000) * 255 / 100000));
            r.item_type = (int)it->getType();
            r.subtype = (int)it->getSubtype();
            r.mat_type = it->getMaterial(); r.mat_index = it->getMaterialIndex();
            r.is_vehicle = false;
            projs.push_back(r);
        }
        for (size_t i = 0; i < world->vehicles.active.size(); ++i) {
            df::vehicle* v = world->vehicles.active[i];
            if (!v) continue;
            df::item* it = df::item::find(v->item_id);
            if (!it) continue;   // no position source without the linked item (RFR pattern)
            ProjRec r{};
            r.x = it->pos.x; r.y = it->pos.y; r.z = it->pos.z;
            r.fx = std::min(255, std::max(0, (v->offset_x + 50000) * 255 / 100000));
            r.fy = std::min(255, std::max(0, (v->offset_y + 50000) * 255 / 100000));
            r.item_type = (int)it->getType();
            r.subtype = (int)it->getSubtype();
            r.mat_type = it->getMaterial(); r.mat_index = it->getMaterialIndex();
            r.is_vehicle = true;
            projs.push_back(r);
        }
        ph_lap(pt.misc);   // F6 P0: djobs + env(weather/season) + projectiles/vehicles walks

        // Publish the fully-read neutral snapshot before releasing CoreSuspender. S1's skipped
        // ticks only consume these values after release; no cached record aliases DF memory.
        uint64_t units_fold = 1469598103934665603ull;
        for (const auto& r : units) s4_fold_add(units_fold, r.rec_fold);
        uint64_t bldgs_fold = 1469598103934665603ull;
        for (const auto& r : bldgs) s4_fold_add(bldgs_fold, r.rec_fold);
        g_last_read.valid = true;
        g_last_read.paused = paused_snap;
        g_last_read.units_fold = units_fold;
        g_last_read.bldgs_fold = bldgs_fold;
        g_last_read.djobs_fold = s4_djobs_fold(djobs);
        g_last_read.proj_fold = s4_proj_fold(projs);
        g_last_read.env_fold = s4_env_fold(env, env_music_frag);
        g_last_read.env_delta_fold = s5_env_fold(env, env_music_frag);
        g_last_read.units = std::move(units);
        g_last_read.bldgs = std::move(bldgs);
        g_last_read.projs = std::move(projs);
        g_last_read.djobs = std::move(djobs);
        g_last_read.env = env;
        g_last_read.env_music_frag = std::move(env_music_frag);
    }
    catch (const std::exception& e) {
        diagnostics_log(std::string("world_stream tick exception: ") + e.what());
        return;
    }
    catch (...) { diagnostics_log("world_stream tick: unknown exception"); return; }
    auto t1 = std::chrono::steady_clock::now();
    double hold_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    // F6 Phase-0b: the residual split (capture_mu wait / CoreSuspender wait / true DF stall). Set
    // here (post full-tick) onto pt; pushed with the rest of pt into g_phase_ring at function end.
    pt.capWait = std::chrono::duration<double, std::milli>(tA - t0).count();
    pt.suspWait = std::chrono::duration<double, std::milli>(tB - tA).count();
    pt.dfStall = std::chrono::duration<double, std::milli>(t1 - tB).count();
    {
        long long now = steady_now_ms();
        std::lock_guard<std::mutex> lk(g_diag_mu);
        g_susp_ring.push_back({now, hold_ms});
        while (!g_susp_ring.empty() && now - g_susp_ring.front().first > 1500) g_susp_ring.pop_front();
        // Sim-throughput oracle sample (same 1.5 s window convention).
        g_simtick_ring.push_back({now, frame_counter_snap, paused_snap});
        while (!g_simtick_ring.empty() && now - g_simtick_ring.front().ts > 1500)
            g_simtick_ring.pop_front();
    }
    }

    // The unit scan above is complete and CoreSuspender is released. Plan once, then execute
    // at most one guarded real-camera render step for this push tick; no sweep state rides AUX.
    if (!paused_idle_skip && collect_bake_candidates)
        bake_sweep_submit_candidates(bake_candidates, bake_viewport_w, bake_viewport_h,
                                     bake_map_w, bake_map_h);
    bake_sweep_tick(capture_mu);
    // PORTRAITS-ROOT (B128): at most one paced native portrait generation per push tick,
    // and only once the map bake sweep above has drained (both are offscreen renders).
    portrait_sweep_tick();

    // ---- AFTER release: assemble + enqueue per connection (no DF access below) --------
    const auto& send_units = g_last_read.units;
    const auto& send_bldgs = g_last_read.bldgs;
    const auto& send_projs = g_last_read.projs;
    const auto& send_djobs = g_last_read.djobs;
    const EnvRec& send_env = g_last_read.env;
    const std::string& send_env_music_frag = g_last_read.env_music_frag;
    for (Plan& plan : plans) {
        WsConnection* conn = plan.conn;
        const Interest* in = nullptr;
        for (const auto& q : interests) if (q.conn == conn) { in = &q; break; }
        if (!in) continue;
        ConnState& cs = g_conn[conn];

        // WC-1: send ITEMDEF_DICT once per connection (generic enqueue_frame -- this is
        // NOT one of the two v1-sequenced FIFOs (BLOCK_SET/AUX), so it carries its own
        // pre-built frame header with seq=0; it's a one-shot dictionary, not part of the
        // ack-tracked BLOCK_SET/AUX ordering). CH_CTRL is a single-slot "latest wins"
        // channel shared with ping/snapshot_meta (§WA-3/WA-11) -- same fire-and-forget
        // risk profile those already accept (a same-tick collision could overwrite one
        // pending message with another before the writer drains it); acceptable here for
        // the same reason it's acceptable there: writer drain (sub-tick) is far faster
        // than ping cadence, so a real collision is rare in practice. If WC-1's dict
        // reliably needs an ack, move it onto its own slot (RECONCILE-R2 territory).
        if (!cs.itemdef_sent && g_itemdef_ready) {
            conn->enqueue_frame(WsConnection::CH_CTRL, g_itemdef_frame, /*binary=*/true);
            cs.itemdef_sent = true;
        }

        // BLOCK_SET frame.
        if (!plan.keys.empty()) {
            std::vector<wire::EncodedBlock> blocks;
            blocks.reserve(plan.keys.size());
            for (uint64_t k : plan.keys) { auto it = encoded.find(k); if (it != encoded.end()) blocks.push_back(*it->second); }
            if (!blocks.empty()) {
                std::vector<uint8_t> payload = wire::assemble_block_set(g_gms.world_seq, blocks.data(), blocks.size());
                bool deflate = payload.size() > wire::kDeflateThreshold;
                std::vector<uint8_t> body = deflate ? deflate_wire_payload(payload.data(), payload.size()) : payload;
                if (deflate && body.empty()) { body = payload; deflate = false; }   // deflate failed: send raw
                if (conn->enqueue_v1_block_set(std::move(body), deflate)) {
                    for (uint64_t k : plan.keys) { cs.sent_ver[k] = g_gms.ver.count(k) ? g_gms.ver[k] : g_gms.world_seq; cs.pending.erase(k); }
                }
            }
        }

        // WA-11.1: snapshot trickle completion (background walk exhausted this tick).
        if (plan.trickle_end) {
            std::string meta = "{\"type\":\"snapshot_meta\",\"world_seq\":" +
                std::to_string(g_gms.world_seq) + ",\"discovered_blocks\":" +
                std::to_string(g_gms.sig.size()) + ",\"trickle\":\"end\"}";
            conn->enqueue_frame(WsConnection::CH_CTRL,
                                std::vector<uint8_t>(meta.begin(), meta.end()), /*binary=*/false);
        }

        // AUX frame (units/buildings filtered to interest at camera z + presence + cam).
        if (conn->take_aux_full_request()) cs.aux_needs_full = true;
        if (plan.aux) {
            auto ax0 = std::chrono::steady_clock::now();   // F6 P0: post-release AUX assemble timer
            const bool auxd = conn->wants_auxd();
            const bool send_full = auxd && (cs.aux_seq == 0 || cs.aux_needs_full ||
                cs.aux_seq - cs.last_aux_full_tick >= 150);
            const bool same_window = cs.aux_sections_valid &&
                cs.aux_cache_ox == in->ox && cs.aux_cache_oy == in->oy && cs.aux_cache_oz == in->oz &&
                cs.aux_cache_w == in->w && cs.aux_cache_h == in->h;
            const bool units_changed = !same_window || cs.aux_units_fold != g_last_read.units_fold;
            const bool bldgs_changed = !same_window || cs.aux_bldgs_fold != g_last_read.bldgs_fold;
            const bool djobs_changed = !same_window || cs.aux_djobs_fold != g_last_read.djobs_fold;
            const bool proj_changed = !same_window || cs.aux_proj_fold != g_last_read.proj_fold;
            const std::string players_json = presence_fn(in->player);
            const bool players_changed = !cs.aux_sections_valid || cs.aux_players_json != players_json;
            const bool env_delta_due = !cs.aux_sent_sections_valid ||
                cs.sent_env_fold != g_last_read.env_delta_fold ||
                cs.aux_seq - cs.last_env_refresh >= 25;
            const bool players_due = !cs.aux_sent_sections_valid ||
                cs.sent_players_json != players_json ||
                cs.aux_seq - cs.last_players_refresh >= 25;
            const bool env_changed = !cs.aux_sections_valid ||
                (!auxd && cs.aux_env_fold != g_last_read.env_fold) ||
                (auxd && (send_full || env_delta_due));
            std::vector<std::pair<const UnitRec*, bool>> visible_units;
            std::vector<std::pair<const BldRec*, bool>> visible_bldgs;  // ZBELOW: bool = seedown
            bool first = true;
            if (units_changed || send_full) {
                std::ostringstream s;
                if (units_changed) s << "[";
                for (const auto& u : send_units) {
                    bool seedown = false;
                    if (u.z != in->oz) {
                        if (u.z < in->oz && in->oz <= u.sd_top) seedown = true;
                        else continue;
                    }
                    if (u.x < in->ox || u.x >= in->ox + in->w) continue;
                    if (u.y < in->oy || u.y >= in->oy + in->h) continue;
                    visible_units.push_back({&u, seedown});
                    if (units_changed) {
                        if (!first) s << ","; first = false;
                        append_unit_json(s, u, seedown);
                    }
                }
                if (units_changed) { s << "]"; cs.aux_units_json = s.str(); }
            }
            if (bldgs_changed || send_full) {
                std::ostringstream s;
                if (bldgs_changed) s << "[";
                first = true;
                for (const auto& b : send_bldgs) {
                    // ZBELOW-BUILDINGS: below-camera buildings ride only when the server proved
                    // an open column (sd_top); above-camera stays dropped. Mirrors units' B23.
                    bool seedown = false;
                    if (b.z != in->oz) {
                        if (b.z < in->oz && in->oz <= b.sd_top) seedown = true;
                        else continue;
                    }
                    if (b.x2 < in->ox || b.x1 >= in->ox + in->w) continue;
                    if (b.y2 < in->oy || b.y1 >= in->oy + in->h) continue;
                    visible_bldgs.push_back({&b, seedown});
                    if (bldgs_changed) {
                        if (!first) s << ","; first = false;
                        append_bld_json(s, b, seedown);
                    }
                }
                if (bldgs_changed) { s << "]"; cs.aux_bldgs_json = s.str(); }
            }
            if (djobs_changed) {
                std::ostringstream s; s << "["; first = true;
                for (const auto& dj : send_djobs) {
                    if (dj.z != in->oz) continue;
                    if (dj.x < in->ox || dj.x >= in->ox + in->w) continue;
                    if (dj.y < in->oy || dj.y >= in->oy + in->h) continue;
                    if (!first) s << ","; first = false;
                    s << "{\"x\":" << dj.x << ",\"y\":" << dj.y << ",\"z\":" << dj.z << ",\"k\":" << dj.k;
                    if (dj.w) s << ",\"w\":1";   // B135: additive worker-claimed flag
                    s << "}";
                }
                s << "]"; cs.aux_djobs_json = s.str();
            }
            if (proj_changed) {
                std::ostringstream s; s << "["; first = true;
                for (const auto& p : send_projs) {
                    if (p.z != in->oz) continue;
                    if (p.x < in->ox || p.x >= in->ox + in->w) continue;
                    if (p.y < in->oy || p.y >= in->oy + in->h) continue;
                    if (!first) s << ","; first = false;
                    s << "{\"x\":" << p.x << ",\"y\":" << p.y << ",\"z\":" << p.z
                      << ",\"fx\":" << p.fx << ",\"fy\":" << p.fy
                      << ",\"item_type\":" << p.item_type << ",\"subtype\":" << p.subtype
                      << ",\"mat_type\":" << p.mat_type << ",\"mat_index\":" << p.mat_index
                      << ",\"vehicle\":" << (p.is_vehicle ? "true" : "false") << "}";
                }
                s << "]"; cs.aux_proj_json = s.str();
            }
            if (env_changed) {
                std::ostringstream s;
                s << "{\"weather\":" << (int)send_env.weather
                  << ",\"season\":" << (int)send_env.season
                  << ",\"year_tick\":" << send_env.year_tick
                  << ",\"siege\":" << (send_env.siege ? "true" : "false")
                  << ",\"evil\":" << (int)send_env.evil
                  << ",\"savage\":" << (send_env.savage ? "true" : "false")
                  << "," << send_env_music_frag;
                if (send_env.autosave) s << ",\"autosave\":\"" << send_env.autosave << "\"";
                s << "}"; cs.aux_env_json = s.str();
            }
            if (players_changed) cs.aux_players_json = players_json;
            cs.aux_sections_valid = true;
            cs.aux_units_fold = g_last_read.units_fold; cs.aux_bldgs_fold = g_last_read.bldgs_fold;
            cs.aux_djobs_fold = g_last_read.djobs_fold; cs.aux_proj_fold = g_last_read.proj_fold;
            if (env_changed) cs.aux_env_fold = g_last_read.env_fold;
            cs.aux_cache_ox = in->ox; cs.aux_cache_oy = in->oy; cs.aux_cache_oz = in->oz;
            cs.aux_cache_w = in->w; cs.aux_cache_h = in->h;
            if (auxd && !send_full) {
                const uint32_t base = cs.aux_seq;
                ++cs.aux_seq;
                std::ostringstream d;
                d << "{\"type\":\"auxd\",\"aseq\":" << cs.aux_seq << ",\"base\":" << base
                  << ",\"cam\":{\"x\":" << in->ox << ",\"y\":" << in->oy << ",\"z\":" << in->oz
                  << ",\"w\":" << in->w << ",\"h\":" << in->h << "}";
                bool emitted = false;
                if (units_changed) {
                    std::unordered_set<int> current;
                    std::vector<std::pair<const UnitRec*, bool>> up;
                    for (const auto& v : visible_units) {
                        current.insert(v.first->id);
                        uint64_t fold = v.first->rec_fold; s4_fold_add(fold, v.second);
                        auto old = cs.sent_units.find(v.first->id);
                        if (old == cs.sent_units.end() || old->second != fold) up.push_back(v);
                    }
                    std::vector<int> rm;
                    for (const auto& old : cs.sent_units) if (!current.count(old.first)) rm.push_back(old.first);
                    if (!up.empty() || !rm.empty()) {
                        emitted = true; d << ",\"units\":{\"up\":["; first = true;
                        for (const auto& v : up) {
                            if (!first) d << ","; first = false;
                            append_unit_json(d, *v.first, v.second);
                        }
                        d << "],\"rm\":["; first = true;
                        for (int id : rm) { if (!first) d << ","; first = false; d << id; }
                        d << "]}";
                    }
                    for (const auto& v : up) {
                        uint64_t fold = v.first->rec_fold; s4_fold_add(fold, v.second);
                        cs.sent_units[v.first->id] = fold;
                    }
                    for (int id : rm) cs.sent_units.erase(id);
                }
                if (bldgs_changed) {
                    std::unordered_set<int> current;
                    std::vector<std::pair<const BldRec*, bool>> up;
                    for (const auto& v : visible_bldgs) {
                        current.insert(v.first->id);
                        uint64_t fold = v.first->rec_fold; s4_fold_add(fold, v.second);
                        auto old = cs.sent_bldgs.find(v.first->id);
                        if (old == cs.sent_bldgs.end() || old->second != fold) up.push_back(v);
                    }
                    std::vector<int> rm;
                    for (const auto& old : cs.sent_bldgs) if (!current.count(old.first)) rm.push_back(old.first);
                    if (!up.empty() || !rm.empty()) {
                        emitted = true; d << ",\"buildings\":{\"up\":["; first = true;
                        for (const auto& v : up) {
                            if (!first) d << ","; first = false;
                            append_bld_json(d, *v.first, v.second);
                        }
                        d << "],\"rm\":["; first = true;
                        for (int id : rm) { if (!first) d << ","; first = false; d << id; }
                        d << "]}";
                    }
                    for (const auto& v : up) {
                        uint64_t fold = v.first->rec_fold; s4_fold_add(fold, v.second);
                        cs.sent_bldgs[v.first->id] = fold;
                    }
                    for (int id : rm) cs.sent_bldgs.erase(id);
                }
                if (djobs_changed) { emitted = true; d << ",\"djobs\":" << cs.aux_djobs_json; }
                if (proj_changed) { emitted = true; d << ",\"proj\":" << cs.aux_proj_json; }
                if (env_delta_due) {
                    emitted = true; d << ",\"env\":" << cs.aux_env_json;
                    cs.sent_env_fold = g_last_read.env_delta_fold; cs.last_env_refresh = cs.aux_seq;
                }
                if (players_due) {
                    emitted = true; d << ",\"players\":" << cs.aux_players_json;
                    cs.sent_players_json = cs.aux_players_json; cs.last_players_refresh = cs.aux_seq;
                }
                d << "}";
                std::string delta = d.str();
                if (!emitted) pt.auxSkip += 1;
                const bool replaced_unsent = conn->enqueue_v1_aux(
                    std::vector<uint8_t>(delta.begin(), delta.end()), false);
                if (replaced_unsent && cs.aux_pending_delta) cs.aux_needs_full = true;
                cs.aux_pending_delta = true;
            } else if (!auxd && cs.aux_cache_valid && same_window && !units_changed &&
                       !bldgs_changed && !djobs_changed && !proj_changed && !env_changed &&
                       !players_changed) {
                pt.auxSkip += 1;
                conn->enqueue_v1_aux(cs.aux_cache_body, cs.aux_cache_deflated);
                cs.aux_pending_delta = false;
            } else {
                std::ostringstream a;
                a << "{\"type\":\"aux\",\"cam\":{\"x\":" << in->ox << ",\"y\":" << in->oy
                  << ",\"z\":" << in->oz << ",\"w\":" << in->w << ",\"h\":" << in->h
                  << "},\"units\":" << cs.aux_units_json << ",\"buildings\":" << cs.aux_bldgs_json
                  << ",\"djobs\":" << cs.aux_djobs_json << ",\"proj\":" << cs.aux_proj_json
                  << ",\"env\":" << cs.aux_env_json << ",\"players\":" << cs.aux_players_json << "}";
                std::string aux = a.str();
                if (auxd) {
                    ++cs.aux_seq;
                    cs.last_aux_full_tick = cs.aux_seq;
                    cs.aux_needs_full = false;
                    aux.insert(aux.find(",\"cam\""), ",\"aseq\":" + std::to_string(cs.aux_seq));
                    cs.sent_units.clear();
                    for (const auto& v : visible_units) {
                        uint64_t fold = v.first->rec_fold; s4_fold_add(fold, v.second);
                        cs.sent_units[v.first->id] = fold;
                    }
                    cs.sent_bldgs.clear();
                    for (const auto& v : visible_bldgs) {
                        uint64_t fold = v.first->rec_fold; s4_fold_add(fold, v.second);
                        cs.sent_bldgs[v.first->id] = fold;
                    }
                    cs.aux_sent_sections_valid = true;
                    cs.sent_env_fold = g_last_read.env_delta_fold;
                    cs.sent_players_json = cs.aux_players_json;
                    cs.last_env_refresh = cs.aux_seq; cs.last_players_refresh = cs.aux_seq;
                }
                auto ax1 = std::chrono::steady_clock::now();
                pt.auxAsm += std::chrono::duration<double, std::milli>(ax1 - ax0).count();
                bool deflate = aux.size() > wire::kDeflateThreshold;
                std::vector<uint8_t> body = deflate
                    ? deflate_wire_payload(reinterpret_cast<const uint8_t*>(aux.data()), aux.size())
                    : std::vector<uint8_t>(aux.begin(), aux.end());
                if (deflate && body.empty()) { body.assign(aux.begin(), aux.end()); deflate = false; }
                pt.auxDef += std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - ax1).count();
                cs.aux_cache_valid = true;
                cs.aux_cache_json = a.str();
                if (!auxd) { cs.aux_cache_body = body; cs.aux_cache_deflated = deflate; }
                conn->enqueue_v1_aux(std::move(body), deflate);
                cs.aux_pending_delta = false;
            }
        }

        // /diag row.
        DiagRow row;
        row.scan = (uint32_t)scanCount; row.dirty = (uint32_t)dirtyCount;
        row.encoded = (uint32_t)plan.keys.size(); row.pending = (uint32_t)cs.pending.size();
        row.inflight = conn->inflight_frames(); row.rtt = conn->rtt_ms_app();
        row.trickleActive = cs.trickle_active;
        row.trickleBacklog = (uint32_t)cs.trickle_backlog.size();
        row.reqFront = (uint32_t)cs.req_front.size();
        row.isHost = conn->is_host();
        { std::lock_guard<std::mutex> lk(g_diag_mu); g_diag[in->player] = row; }
    }

    // F6 Phase-0 (a1): record this tick's per-phase split (same windowed convention as
    // g_susp_ring above -- one entry/tick, decayed to ~1.5 s, summed to ms/s in diag). Only
    // reached on a fully-completed tick (the early/exception returns skip it, exactly like
    // g_susp_ring), so the phase ring and the suspender ring cover the same set of ticks.
    if (!paused_idle_skip) {
        long long pnow = steady_now_ms();
        std::lock_guard<std::mutex> lk(g_diag_mu);
        g_phase_ring.push_back({pnow, pt});
        while (!g_phase_ring.empty() && pnow - g_phase_ring.front().first > 1500)
            g_phase_ring.pop_front();
    }
}

std::string world_stream_diag_json() {
    std::ostringstream o;
    o.setf(std::ios::fixed); o.precision(2);
    std::lock_guard<std::mutex> lk(g_diag_mu);
    // Sum the CoreSuspender holds over the last 1000 ms -> true ms/s (the A7 headline metric:
    // ONE global pass, so this must NOT scale with the v1 client count).
    long long now = steady_now_ms();
    double susp_ms_per_sec = 0.0;
    for (auto& e : g_susp_ring) if (now - e.first <= 1000) susp_ms_per_sec += e.second;
    // F6 Phase-0 (a1): sum each phase over the same trailing 1000 ms -> ms/s, matching the
    // v1SuspenderMsPerSec convention exactly. ADDITIVE nested object; nothing above renamed
    // or removed; never touches the binary wire (this is /diag JSON only). The five in-suspend
    // phases sum to ~v1SuspenderMsPerSec minus the pre-mark capture_mu+CoreSuspender
    // acquisition; `residualMsPerSec` reports that difference explicitly so the split is
    // self-checking (a mis-attributed phase would make the parts stop reconciling).
    PhaseTimes ps{};   // summed ms/s
    for (auto& e : g_phase_ring) {
        if (now - e.first > 1000) continue;
        const PhaseTimes& p = e.second;
        ps.sig += p.sig; ps.enc += p.enc; ps.unit += p.unit; ps.bld += p.bld; ps.misc += p.misc;
        ps.auxAsm += p.auxAsm; ps.auxDef += p.auxDef; ps.auxSkip += p.auxSkip;
    }
    double phase_sum = ps.sig + ps.enc + ps.unit + ps.bld + ps.misc;
    double residual = susp_ms_per_sec - phase_sum;   // = acquisition + timing slop; ~0 when idle
    // F6 Phase-0b: split the residual + expose the DF-stall gate metric + throughput oracle. All
    // summed over the SAME trailing 1000 ms as the phases above (suspWaitMax is a windowed MAX,
    // not a sum). Identity: capWaitMsPerSec + suspWaitMsPerSec ~= residualMs (spec C1);
    // dfStallMsPerSec ~= phase_sum + slop (spec C4).
    double cap_wait = 0.0, susp_wait = 0.0, df_stall = 0.0, susp_wait_max = 0.0;
    for (auto& e : g_phase_ring) {
        if (now - e.first > 1000) continue;
        const PhaseTimes& p = e.second;
        cap_wait += p.capWait; susp_wait += p.suspWait; df_stall += p.dfStall;
        if (p.suspWait > susp_wait_max) susp_wait_max = p.suspWait;
    }
    // simTicksPerSec: windowed frame_counter delta -> ticks/sec. -1 when the newest sample is
    // paused (frozen counter would read ~0 and misrepresent throughput).
    double sim_ticks_per_sec = -1.0;
    if (!g_simtick_ring.empty() && !g_simtick_ring.back().paused) {
        const SimTickSample* oldest = nullptr;
        for (auto& s : g_simtick_ring) { if (now - s.ts <= 1000) { oldest = &s; break; } }
        const SimTickSample& newest = g_simtick_ring.back();
        if (oldest && newest.ts > oldest->ts) {
            double dframes = static_cast<double>(newest.frame_counter - oldest->frame_counter);
            sim_ticks_per_sec = dframes * 1000.0 / static_cast<double>(newest.ts - oldest->ts);
        } else {
            sim_ticks_per_sec = 0.0;   // <1 sample-span in the window yet
        }
    }
    o << "{\"worldSeq\":" << g_gms.world_seq
      << ",\"v1SuspenderMsPerSec\":" << susp_ms_per_sec
      << ",\"phaseMsPerSec\":{\"sigScanMs\":" << ps.sig
      << ",\"encodeMs\":" << ps.enc
      << ",\"unitScanMs\":" << ps.unit
      << ",\"bldScanMs\":" << ps.bld
      << ",\"miscScanMs\":" << ps.misc
      << ",\"residualMs\":" << residual
      << ",\"auxAssembleMs\":" << ps.auxAsm
      << ",\"auxDeflateMs\":" << ps.auxDef
      << ",\"auxSkipped\":" << ps.auxSkip << "}"
      // F6 Phase-0b additive fields (spec 2026-07-09 §4). residualMs (above) stays for continuity.
      << ",\"capWaitMsPerSec\":" << cap_wait
      << ",\"suspWaitMsPerSec\":" << susp_wait
      << ",\"suspWaitMaxMs\":" << susp_wait_max
      << ",\"dfStallMsPerSec\":" << df_stall
      << ",\"simTicksPerSec\":" << sim_ticks_per_sec
      << ",\"players\":[";
    bool first = true;
    for (auto& kv : g_diag) {
        if (!first) o << ","; first = false;
        const DiagRow& r = kv.second;
        o << "{\"player\":\"" << json_escape(kv.first) << "\",\"scanBlocks\":" << r.scan
          << ",\"dirtyBlocks\":" << r.dirty << ",\"encodedBlocks\":" << r.encoded
          << ",\"pendingBlocks\":" << r.pending << ",\"inflightFrames\":" << r.inflight
          << ",\"rttMs\":" << r.rtt
          << ",\"trickleActive\":" << (r.trickleActive ? "true" : "false")
          << ",\"trickleBacklog\":" << r.trickleBacklog << ",\"reqFront\":" << r.reqFront
          << ",\"isHost\":" << (r.isHost ? "true" : "false") << "}";
    }
    o << "]}";
    return o.str();
}

void world_stream_forget(const std::string& player) {
    std::lock_guard<std::mutex> lk(g_diag_mu);
    g_diag.erase(player);
}

} // namespace dwf
