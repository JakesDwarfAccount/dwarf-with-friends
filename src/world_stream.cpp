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
#include "fnv.h"
#include "json_util.h"
#include "unit_sprites.h"   // appearance-hash + span/anchor snapshot
#include "unit_status.h"    // Shared overhead-status st bits (kUStat*/unit_status_bits)

#include "Core.h"
#include "DataDefs.h"
#include "TileTypes.h"
#include "modules/Maps.h"
#include "modules/MapCache.h"
#include "modules/Materials.h"
#include "modules/Translation.h"
#include "modules/World.h"    // World::ReadCurrentWeather()
#include "modules/Units.h"    // isDead/isGhost/isFortControlled (status bits now via unit_status.h)
#include "modules/Job.h"      // Job::getWorker (djob worker-claimed flag)
#include "modules/Items.h"    // Items::getContainedItems (barrel/bin contents fold)

#include "df/global_objects.h"
#include "df/d_init.h"
#include "df/graphic.h"
#include "df/graphic_viewportst.h"
#include "df/world.h"
#include "df/plotinfost.h"                          // env.siege active-invasion scan
#include "df/plot_invasion_infost.h"
#include "df/invasion_info.h"
#include "df/world_data.h"                          // env.evil/savage region-map read
#include "df/world_site.h"
#include "df/region_map_entry.h"
#include "music_sync.h"                             // env.music canonical sync state
#include "df/map_block.h"
#include "df/tile_designation.h"
#include "df/tile_dig_designation.h"   // block_has_active_designation dig/traffic enums
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
// Projectiles (world->projectiles.all, a proj_list_link head) and vehicles.
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
#include "df/block_square_event_item_spatterst.h"   // item-spatter amount grid fold
#include "df/block_square_event_grassst.h"           // Grass coverage amount grid fold
#include "df/block_square_event_designation_priorityst.h"  // Priority grid fold
#include "df/flow_info.h"                            // block->flows fold
#include "df/item.h"   // Item id/flags fold into block_signature()
// A built statue's sprite identity lives ENTIRELY on the ITEM it was built from; DF has already
// resolved the subject onto that item, so this forwards DF's own numbers instead of re-deriving.
#include "df/item_statuest.h"
#include "df/item_quality.h"
#include "df/building_statuest.h"
#include "df/art_image.h"
#include "df/art_image_element.h"
#include "df/art_image_element_creaturest.h"
#include "art_desc.h"                                // find_art_image() (shared chunk walk)
// Every building read runs inside the existing suspended scan, every cast is a virtual_cast, and
// machine::find is null-checked -- no map-block access, so this adds no crash surface.
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
#include "df/building_siegeenginest.h"
#include "df/item_type.h"
#include "df/building_wellst.h"
#include "df/building_wagonst.h"
#include "df/building_farmplotst.h"
#include "df/building_stockpilest.h"
#include "df/building_civzonest.h"
#include "df/machine_info.h"

#include <algorithm>
#include <cmath>
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

// ---- GlobalMapState: mutated only by world_stream_tick() ----------------------------
// world_seq is also read unlocked off that thread by world_stream_map_info / _diag_json.
struct GlobalMapState {
    uint32_t world_seq = 0;
    std::unordered_map<uint64_t, uint64_t> sig;   // key -> last block signature
    std::unordered_map<uint64_t, uint32_t> ver;   // key -> world_seq at last observed change
    // Deliberately separate from `sig`: a fully-hidden block has no signature, but must not be
    // treated as first-seen and force-scanned forever.
    std::unordered_set<uint64_t> sig_seen;
    std::deque<std::pair<uint32_t, std::vector<uint64_t>>> changelog;   // last ~900 dirty ticks
};
constexpr size_t kChangelogMax = 900;
constexpr uint32_t kSigScanBuckets = 4;       // <= 4 push ticks of ordinary detection latency
constexpr uint32_t kPausedIdleScanEvery = 4;  // native paused UI changes are re-read within 4 ticks
// Blocks TESTED for "discovered" per tick and per connection, not blocks sent -- a 256-tile
// hidden-bit scan each.
constexpr int kTrickleVisitBudget = 128;

// Per-connection v1 stream state (side table keyed by connection pointer).
struct ConnState {
    std::unordered_map<uint64_t, uint32_t> sent_ver;   // block -> ver last handed to writer
    std::unordered_set<uint64_t> pending;              // blocks owed to this client

    // ---- snapshot + background trickle + resume + REQ_BLOCKS ------------------------
    bool startup_decided = false;      // resume-vs-snapshot decision made for this connection
    bool trickle_active = false;       // background discovery walk in progress (fresh connect)
    std::vector<int> trickle_z_order;  // z levels ordered by |z - cam.z at walk start| ascending
    size_t trickle_z_idx = 0;
    int trickle_bx = 0, trickle_by = 0;      // walk cursor within the current z tier
    int trickle_mbx = 0, trickle_mby = 0;    // block-space map extents captured at walk start
    std::deque<uint64_t> trickle_backlog;    // walk-discovered keys not yet sent
    std::deque<uint64_t> req_front;          // REQ_BLOCKS front-of-line keys
    std::unordered_set<uint64_t> req_front_set; // O(1) dedupe; queue owns first-demand order

    bool itemdef_sent = false;   // Has this connection received ITEMDEF_DICT yet?

    // The byte-reuse cache is push-loop owned and never retains DF pointers: only the
    // post-release JSON and the optional deflate body are cached.
    bool aux_cache_valid = false;
    std::string aux_cache_json;
    std::vector<uint8_t> aux_cache_body;
    bool aux_cache_deflated = false;

    // Windowed sections share the camera bounds below; env and players are global but keep
    // independent folds.
    bool aux_sections_valid = false;
    uint64_t aux_units_fold = 0, aux_bldgs_fold = 0, aux_djobs_fold = 0;
    uint64_t aux_proj_fold = 0, aux_env_fold = 0;
    int aux_cache_ox = 0, aux_cache_oy = 0, aux_cache_oz = 0;
    int aux_cache_w = 0, aux_cache_h = 0;
    std::string aux_units_json, aux_bldgs_json, aux_djobs_json;
    std::string aux_proj_json, aux_env_json, aux_players_json;

    // Negotiated AUX-delta state. Full fallbacks remain available for every change.
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

// ITEMDEF_DICT is built ONCE -- raws are static after world load -- and cached as ready-to-send
// framed bytes. Touched only from world_stream_tick(), so it needs no lock.
bool g_itemdef_ready = false;
std::vector<uint8_t> g_itemdef_frame;   // full framed bytes: header(kTypeItemDefDict) + payload

// Cached map size (tiles) for hello_ack; refreshed under the suspender.
std::mutex g_mapinfo_mu;
V1MapInfo g_mapinfo;

// /diag rows.
struct DiagRow {
    uint32_t scan = 0, dirty = 0, encoded = 0, pending = 0; int inflight = 0; long long rtt = -1;
    bool trickleActive = false;               // Background snapshot walk in progress
    uint32_t trickleBacklog = 0, reqFront = 0;
    uint32_t reqQueued = 0;
    uint64_t reqCoalesced = 0, reqOverflowDrops = 0;
    bool isHost = false;   // isHostClient() hook: WsConnection::is_host()
};
std::mutex g_diag_mu;
std::unordered_map<std::string, DiagRow> g_diag;
// Windowed suspender accounting (guarded by g_diag_mu): each tick's CoreSuspender hold
// duration, kept for ~1.5 s so /diag can report a real ms/s (not a single-tick snapshot).
std::deque<std::pair<long long, double>> g_susp_ring;

// Per-phase timing of the SAME tick g_susp_ring measures whole, summed over the last 1000 ms.
// The five in-suspend phases reconcile to v1SuspenderMsPerSec minus the acquisition residual.
struct PhaseTimes {
    double sig = 0, enc = 0, unit = 0, bld = 0, misc = 0;   // in-suspend (ms this tick)
    double auxAsm = 0, auxDef = 0;                           // post-release (ms this tick)
    uint32_t auxSkip = 0;                                    // post-release AUX reuse count
    // Per-tick SET-ONCE bracket durations, unlike the five phase accumulators above: capWait is
    // the capture_mu wait, suspWait the CoreSuspender wait, dfStall the true DF-parked time.
    double capWait = 0, suspWait = 0, dfStall = 0;
};
std::deque<std::pair<long long, PhaseTimes>> g_phase_ring;   // guarded by g_diag_mu

// Ground-truth sim-throughput oracle: world->frame_counter advances once per sim frame, so diag
// derives simTicksPerSec from the windowed delta. `paused` keeps a frozen fort reporting -1.
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
    // Mixing stops coordinate packing's low bits from striping a bucket spatially. This only
    // schedules detection; it never enters the wire or the signature value.
    key ^= key >> 33;
    key *= 0xff51afd7ed558ccdull;
    key ^= key >> 33;
    return static_cast<uint32_t>(key % kSigScanBuckets);
}

// ---- block_signature: single-block fold, no column fold ----------------------------
// Engravings are a world-vector with no per-block storage, so the coordinate is needed too.
uint64_t block_signature(df::world* world, df::map_block* b, int bx, int by, int bz) {
    if (!b) return 0;
    uint64_t h = kFnvOffsetBasis;
    h = fnv1a(h, &b->tiletype[0][0],    sizeof(b->tiletype));
    h = fnv1a(h, &b->designation[0][0], sizeof(b->designation));
    // Fold ONLY the occupancy bits the wire actually serializes. The unit-presence bits flip on
    // EVERY creature step, which re-signed a block on churn the wire never encodes.
    {
        constexpr uint32_t kOccWireMask =
            (uint32_t)df::tile_occupancy::mask_dig_marked |
            (uint32_t)df::tile_occupancy::mask_dig_auto |
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
    // items.size() alone misses flag-only churn, so fold each ground item's (id, flag mask) --
    // the same fields the ITEM tail carries.
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
        // Storing or removing an item INSIDE a barrel or bin never touches block->items, so fold
        // each container's contents fingerprint or the peek tail serves stale forever.
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
            // The amount grid alone misses a same-amount mat/state swap, so fold the event's
            // (mat_type, mat_index, mat_state) header too.
            int16_t mt = sp->mat_type; int32_t mi = sp->mat_index;
            int16_t st = (int16_t)sp->mat_state;
            h = fnv1a(h, &mt, sizeof(mt)); h = fnv1a(h, &mi, sizeof(mi)); h = fnv1a(h, &st, sizeof(st));
            continue;
        }
        STRICT_VIRTUAL_CAST_VAR(isp, df::block_square_event_item_spatterst, b->block_events[ei]);
        if (isp) {
            // item-spatter (fallen leaves/fruit litter) amount grid + header.
            h = fnv1a(h, &isp->amount[0][0], sizeof(isp->amount));
            int16_t it = (int16_t)isp->item_type; int16_t ist = isp->item_subtype;
            h = fnv1a(h, &it, sizeof(it)); h = fnv1a(h, &ist, sizeof(ist));
            continue;
        }
        // Grass churns as dwarves trample and regrow it: fold the amount grid and which plant is
        // currently winning.
        STRICT_VIRTUAL_CAST_VAR(gr, df::block_square_event_grassst, b->block_events[ei]);
        if (gr) {
            h = fnv1a(h, &gr->amount[0][0], sizeof(gr->amount));
            int32_t pid = gr->plant_index;
            h = fnv1a(h, &pid, sizeof(pid));
            continue;
        }
        // Designation priority can change with nothing else about the block changing, so fold the
        // whole grid -- 256 int32s, the same cost class as the grids already folded.
        STRICT_VIRTUAL_CAST_VAR(dp, df::block_square_event_designation_priorityst, b->block_events[ei]);
        if (dp) {
            h = fnv1a(h, &dp->priority[0][0], sizeof(dp->priority));
        }
    }
    // Flows are volatile, so fold count plus each flow's (type, alive, density bucket, pos).
    // `alive` is the exact emission gate, and 8-wide density buckets keep idle flutter quiet.
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
    // Engravings are a world-vector, not part of `b`, so fold via the shared position-keyed index
    // keyed on this block's OWN coordinate.
    h ^= dwf::wire::engraving_block_fold(world, bx, by, bz);
    // Vermin and vermin colonies are world-vectors too, folded the same way.
    h ^= dwf::wire::vermin_block_fold(world, bx, by, bz);
    // Farm crops are building-owned contained items, so neither map_block::items nor
    // building AUX changes when their per-tile stage changes. Fold the shared crop index.
    h ^= dwf::wire::farm_crop_block_fold(bx, by, bz);
    if (h == 0) h = 1;   // reserve 0 for "null/undiscovered"
    return h;
}
// Discovered: a block with >=1 tile hidden==0.
bool block_discovered(df::map_block* b) {
    if (!b) return false;
    for (int x = 0; x < 16; ++x)
        for (int y = 0; y < 16; ++y)
            if (!b->designation[x][y].bits.hidden) return true;
    return false;
}

// A FULLY hidden block that carries a live designation must ALSO ship, or a designation dropped
// into unexplored rock never reaches the client and its glyph can never draw over the black.
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
            if (o.bits.dig_auto) return true;
            if (o.bits.carve_track_north || o.bits.carve_track_south ||
                o.bits.carve_track_east  || o.bits.carve_track_west) return true;
        }
    return false;
}

// Shippable: the union gate every block-selection site uses. A block ships if it is
// discovered OR if it is fully hidden but carries a designation the player needs to see.
bool block_shippable(df::map_block* b) {
    return block_discovered(b) || block_has_active_designation(b);
}

// ---- changelog resume test ----------------------------------------------------------
// `have` is within the ring iff every dirty tick since it is still recorded, so the union is complete.
bool changelog_within(const GlobalMapState& gms, uint32_t have) {
    if (have == 0 || have > gms.world_seq) return false;
    if (gms.changelog.empty()) return have == gms.world_seq;   // nothing dirtied yet
    uint32_t oldest = gms.changelog.front().first;
    return have + 1 >= oldest;
}

// Advances the discovery walk by exactly one block-space cell. A discovered block not yet at this
// connection's ver is queued, and a never-seen one registers its first sig/ver stamp.
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
        gms.ver[key] = gms.world_seq;                    // first-encode stamp
    }
    uint32_t v = gms.ver[key];
    auto sit = cs.sent_ver.find(key);
    if (sit == cs.sent_ver.end() || sit->second < v) {
        cs.trickle_backlog.push_back(key);
        cs.pending.insert(key);
    }
    return true;
}

// ah/sw/sh/ax/ay mirror the composite exporter's record; an empty ah means "no composite yet".
// sd_top is the highest camera z with an unobstructed open column down to the record.
struct UnitRec { int x, y, z, id, race, caste; std::string rt, ct, name; std::string ah; int sw = 0, sh = 0, ax = 0, ay = 0; int sd_top = 0; int st = 0; int st2 = 0; bool ghostly = false; uint64_t rec_fold = 0; };
struct BldRec  { int id = -1; int x1, y1, x2, y2, z, subtype, stage, mat_type, mat_index; int sd_top = 0; std::string type; bool has_rgb; int r, g, b; bool built; std::string ext;
                 // `crgb` is the descriptor's display RGB for older clients; `cpal` preserves the
                 // canonical STATE_COLOR token so a new client can do DF's palette substitution.
                 bool has_crgb = false; int cr = 0, cg = 0, cb = 0; std::string cpal;
                 // ds_valid gates emission: only building types in the direction/state table carry
                 // these. bclass 0 = building art, 1 = stockpile overlay, 2 = civzone overlay.
                 bool ds_valid = false; int bclass = 0; int direction = 0; int state = 0; uint32_t extra = 0;
                 // Doors and hatches use close_timer for momentary OPEN art. Additive: an old
                 // client keeps bst bit0, a new one prefers dopen when present.
                 bool door_open_valid = false; bool door_open = false;
                 // A built statue is a 3-cell composite and every part of its key lives on the
                 // contained item. s_valid gates emission; without it the client draws the default.
                 bool s_valid = false; int s_quality = 0; int s_mt = -1; int s_mi = -1;
                 int s_gtype = -1; int s_gid = -1; std::string s_race;
                 uint64_t rec_fold = 0; };

// Is this machine currently active? Null-safe: machine_id can be -1 and machine::find returns null.
static bool machine_is_active(const df::machine_info& mi) {
    if (mi.machine_id < 0) return false;
    df::machine* m = df::machine::find(mi.machine_id);
    return m && m->flags.bits.active;
}

// Quantizes orient_x/orient_y into an 8-way index 0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW, in screen
// coords where +x is East and +y is South.
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

// art_graphics_id gives DF's race index but not the caste, and some creature statues are
// caste-split. Returns -1 when the chunk is not paged in: the client then falls back to bare RACE.
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

// Fills the statue sprite key from the ITEM the statue was built out of: DF has ALREADY resolved
// the subject there as art_graphics_type + art_graphics_id, so read its answer, do not rebuild it.
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
        // An artifact overrides quality with the dedicated artifact plinth row. getQuality() is the
        // vmethod every other quality read here uses.
        r.s_quality = st->flags.bits.artifact ? 6 : (int)st->getQuality();
        if (r.s_quality < 0) r.s_quality = 0;
        if (r.s_quality > 6) r.s_quality = 6;
        // The ITEM's material, not the building header's: the client runs the same
        // WOOD/STONE/METAL/GLASS classifier it uses for every other item.
        r.s_mt = st->getMaterial();
        r.s_mi = st->getMaterialIndex();
        // SUBJECT: DF's own precomputed answer.
        r.s_gtype = st->art_graphics_type;
        r.s_gid = st->art_graphics_id;
        // A CREATURE statue keys its art by race token, and "RACE:CASTE" for the caste-split ones.
        // art_graphics_id is the race index; the caste comes off the art_image's creature element.
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

// building_wagonst stores no direction member: native derives the cardinal body from motion and
// uses BLD while stationary, so only the previous anchor is retained between scans.
struct WagonAnchor { int x = 0; int y = 0; };
std::unordered_map<int32_t, WagonAnchor> g_wagon_anchor;

static int wagon_motion_direction(df::building* b) {
    auto prev = g_wagon_anchor.find(b->id);
    if (prev == g_wagon_anchor.end()) return 0; // BLD: first observation / stationary
    int dx = b->x1 - prev->second.x;
    int dy = b->y1 - prev->second.y;
    if (dy < 0 && std::abs(dy) >= std::abs(dx)) return 1; // N
    if (dy > 0 && std::abs(dy) >= std::abs(dx)) return 2; // S
    if (dx < 0) return 3;                                  // W
    if (dx > 0) return 4;                                  // E
    return 0;
}

// Fills direction/state/extra/bclass from a building's concrete subtype. Every branch is a guarded
// virtual_cast, and an unmatched type leaves ds_valid=false so the AUX emit omits the fields.
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
                r.door_open_valid = true;
                r.door_open = dr->close_timer > 0;
            }
            break;
        case building_type::Hatch:
            if (auto ha = virtual_cast<df::building_hatchst>(b)) {
                r.ds_valid = true;
                r.state = (ha->door_flags.bits.closed ? 1 : 0)
                        | (ha->door_flags.bits.forbidden ? 2 : 0)
                        | (ha->door_flags.bits.operated_by_mechanisms ? 4 : 0);
                r.door_open_valid = true;
                r.door_open = ha->close_timer > 0;
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
        // Existing dir/bst/bextra fields are reused, so the binary wire and older clients are
        // untouched: SiegeEngine packs facing/firing/kind/ammo, Trap packs type/ready/plate flags.
        case building_type::SiegeEngine:
            if (auto se = virtual_cast<df::building_siegeenginest>(b)) {
                r.ds_valid = true;
                r.direction = std::clamp((int)se->facing, 0, 7);
                int firing_limit = se->type == df::siegeengine_type::BoltThrower ? 2 : 5;
                r.state = (se->fire_timer >= 1 && se->fire_timer <= firing_limit) ? 1 : 0;
                uint32_t ammo = 0;
                if (se->type == df::siegeengine_type::BoltThrower) {
                    for (auto* held : se->contained_items) {
                        if (!held || !held->item || held->use_mode == df::building_item_role_type::PERM ||
                            held->item->getType() != df::item_type::AMMO)
                            continue;
                        int stack = held->item->getStackSize();
                        ammo += (uint32_t)(stack > 0 ? stack : 1);
                    }
                }
                uint32_t ammo_level = ammo ? std::min<uint32_t>((ammo - 1) / 20, 5) : 0;
                r.extra = ((uint32_t)(int)se->type & 0xffu) | (ammo_level << 8);
            }
            break;
        case building_type::Trap:
            if (auto tp = virtual_cast<df::building_trapst>(b)) {
                r.ds_valid = true;
                r.direction = (int)tp->trap_type;
                bool loading = false;
                for (auto* job : tp->jobs) {
                    if (!job) continue;
                    loading = job->job_type == df::job_type::LoadCageTrap ||
                              job->job_type == df::job_type::LoadStoneTrap ||
                              job->job_type == df::job_type::LoadWeaponTrap;
                    if (loading) break;
                }
                bool needs_item = tp->trap_type != df::trap_type::PressurePlate &&
                                  tp->trap_type != df::trap_type::Lever &&
                                  tp->trap_type != df::trap_type::TrackStop;
                r.state = (tp->state > 0 || tp->fill_timer > 0 || loading || tp->ready_timeout > 0 ||
                           (needs_item && tp->contained_items.size() < 2)) ? 1 : 0;
                r.extra = tp->plate_info.flags.whole;
            }
            break;
        case building_type::Well:
            if (auto we = virtual_cast<df::building_wellst>(b)) {
                r.ds_valid = true; r.state = (we->bucket_z < b->z) ? 1 : 0;  // bucket down
            }
            break;
        case building_type::Wagon:
            if (auto wa = virtual_cast<df::building_wagonst>(b)) {
                r.ds_valid = true;
                r.direction = wagon_motion_direction(wa); // 0 BLD, 1 N, 2 S, 3 W, 4 E
                auto actual = virtual_cast<df::building_actual>(wa);
                size_t goods = actual ? actual->contained_items.size() : 0;
                r.state = (int)std::min<size_t>(7, goods); // native 3-bit goods level
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
            // No direction/state -- a statue's whole sprite key is on its contained item.
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
static uint64_t s3_name_fold(const df::language_name& n) { uint64_t h = s3_fold(kFnvOffsetBasis, &n, sizeof(n)); return s3_fold(h, n.nickname.data(), n.nickname.size()); }
static uint64_t s3_bld_fold(df::building* b) { uint64_t h = kFnvOffsetBasis; auto add = [&](const auto& v) { h = s3_fold(h, &v, sizeof(v)); }; add(b->id); add(b->x1); add(b->y1); add(b->x2); add(b->y2); add(b->z); int t=(int)b->getType(),st=(int)b->getSubtype(),bs=(int)b->getBuildStage(),ms=(int)b->getMaxBuildStage(); add(t); add(st); add(bs); add(ms); add(b->mat_type); add(b->mat_index); BldRec ds; fill_building_ds(b, ds); add(ds.ds_valid); add(ds.bclass); add(ds.direction); add(ds.state); add(ds.extra); add(ds.door_open_valid); add(ds.door_open); add(ds.s_valid); add(ds.s_quality); add(ds.s_mt); add(ds.s_mi); add(ds.s_gtype); add(ds.s_gid); if (!ds.s_race.empty()) h = s3_fold(h, ds.s_race.data(), ds.s_race.size()); if (b->room.extents && b->room.width > 0 && b->room.height > 0) h=s3_fold(h,b->room.extents,(size_t)b->room.width*(size_t)b->room.height*sizeof(*b->room.extents)); return h; }
template <typename T> static inline void s4_fold_add(uint64_t& h, const T& v) { h = s3_fold(h, &v, sizeof(v)); }
static inline void s4_fold_add(uint64_t& h, const std::string& v) { h = s3_fold(h, v.data(), v.size()); }
static uint64_t s4_unit_fold(const UnitRec& u, uint64_t name_fold) {
    uint64_t h = kFnvOffsetBasis;
    s4_fold_add(h, u.id); s4_fold_add(h, u.x); s4_fold_add(h, u.y); s4_fold_add(h, u.z);
    s4_fold_add(h, u.sd_top); s4_fold_add(h, name_fold); s4_fold_add(h, u.name);
    s4_fold_add(h, u.race); s4_fold_add(h, u.caste); s4_fold_add(h, u.rt); s4_fold_add(h, u.ct);
    s4_fold_add(h, u.ah); s4_fold_add(h, u.sw); s4_fold_add(h, u.sh);
    // st2 MUST be folded alongside st: without it a unit whose ONLY change is a second-word bit
    // keeps its old fold, the delta never re-ships the record, and the new bubbles never appear.
    s4_fold_add(h, u.ax); s4_fold_add(h, u.ay); s4_fold_add(h, u.st); s4_fold_add(h, u.st2);
    s4_fold_add(h, u.ghostly);
    return h;
}

// Projectiles and vehicles in flight on one flat AUX array; `is_vehicle` distinguishes the two.
// fx/fy are sub-tile fractions -- an addition DWF makes, since native draws one whole cell.
struct ProjRec { int x, y, z, fx, fy, item_type, subtype; int32_t mat_type, mat_index; bool is_vehicle; int sd_top = 0; };
// A map designation v50 has already converted into a JOB: the map bits clear on pickup, but native
// keeps drawing the glyph from the live job. `w` means a worker claimed it, which is when it flashes.
struct DJobRec { int x, y, z, k; bool w = false; };

// Weather, season and year_tick ride the existing per-tick AUX JSON rather than a new message.
// `evil` and `savage` key the ambient loops. Additive JSON only -- the binary wire is untouched.
struct EnvRec {
    uint8_t weather = 0; uint8_t season = 0; uint32_t year_tick = 0; bool siege = false;
    uint8_t evil = 1; bool savage = false;
    const char* autosave = nullptr; // d_init.feature.autosave; null leaves the additive field absent
};
static uint64_t s4_djobs_fold(const std::vector<DJobRec>& records) {
    uint64_t h = kFnvOffsetBasis;
    // r.w folds in so a worker being assigned or unassigned still changes the fold, even when
    // position and kind are unchanged.
    for (const auto& r : records) { s4_fold_add(h, r.x); s4_fold_add(h, r.y); s4_fold_add(h, r.z); s4_fold_add(h, r.k); s4_fold_add(h, r.w); }
    return h;
}
static uint64_t s4_proj_fold(const std::vector<ProjRec>& records) {
    uint64_t h = kFnvOffsetBasis;
    for (const auto& r : records) {
        s4_fold_add(h, r.x); s4_fold_add(h, r.y); s4_fold_add(h, r.z);
        s4_fold_add(h, r.fx); s4_fold_add(h, r.fy); s4_fold_add(h, r.item_type);
        s4_fold_add(h, r.subtype); s4_fold_add(h, r.mat_type); s4_fold_add(h, r.mat_index);
        // sd_top folds in for the same reason units' does: a ceiling opening above a stationary
        // projectile changes who can see it while nothing else about the record moves.
        s4_fold_add(h, r.is_vehicle); s4_fold_add(h, r.sd_top);
    }
    return h;
}
static uint64_t s4_env_fold(const EnvRec& env, const std::string& music_frag) {
    uint64_t h = kFnvOffsetBasis;
    s4_fold_add(h, env.weather); s4_fold_add(h, env.season); s4_fold_add(h, env.year_tick);
    s4_fold_add(h, env.siege); s4_fold_add(h, env.evil); s4_fold_add(h, env.savage);
    if (env.autosave) h = s3_fold(h, env.autosave, std::strlen(env.autosave));
    s4_fold_add(h, music_frag);
    return h;
}
static uint64_t s5_env_fold(const EnvRec& env, const std::string& music_frag) {
    uint64_t h = kFnvOffsetBasis;
    s4_fold_add(h, env.weather); s4_fold_add(h, env.season);
    s4_fold_add(h, env.siege); s4_fold_add(h, env.evil); s4_fold_add(h, env.savage);
    if (env.autosave) h = s3_fold(h, env.autosave, std::strlen(env.autosave));
    s4_fold_add(h, music_frag);
    return h;
}
// ONE see-down reach walk, shared by units, buildings and projectiles: the highest contiguously
// open z above (x,y,z). A null block counts as transparent. Callers must hold CoreSuspender.
static const int MAX_SEEDOWN = 60;        // mirrors tile_map_dump.cpp's terrain MAX_DEPTH
// Native's item-projectile printer selects one of EIGHT lower viewports by z distance, so a
// projectile's see-down reach is capped at eight levels rather than the terrain depth.
static const int MAX_SEEDOWN_PROJ = 8;
static int seedown_top(int x, int y, int z, int maxCamZ, int max_depth) {
    if (z >= maxCamZ) return z;
    const int lx = x & 15, ly = y & 15;
    const int limit = std::min(maxCamZ, z + max_depth);
    int top = z;
    for (int az = z + 1; az <= limit; ++az) {
        df::map_block* ab = Maps::getTileBlock(df::coord(x, y, az));
        if (ab) {
            df::tiletype att = ab->tiletype[lx][ly];
            df::tiletype_shape shape = tileShape(att);
            df::tiletype_material mat = tileMaterial(att);
            bool open = (shape == df::tiletype_shape::EMPTY
                      || shape == df::tiletype_shape::RAMP_TOP
                      || mat == df::tiletype_material::AIR);
            if (!open) break;
        }
        top = az;   // open (or a null/unallocated block -> transparent, per the descent)
    }
    return top;
}
static void append_unit_json(std::ostringstream& a, const UnitRec& u, bool seedown) {
    a << "{\"x\":" << u.x << ",\"y\":" << u.y << ",\"z\":" << u.z << ",\"id\":" << u.id
      << ",\"race\":" << u.race << ",\"caste\":" << u.caste
      << ",\"rt\":\"" << json_escape_bytes(u.rt) << "\",\"ct\":\"" << json_escape_bytes(u.ct)
      << "\",\"name\":\"" << json_escape_bytes(u.name) << "\"";
    if (seedown) a << ",\"sd\":1";
    if (u.ghostly) a << ",\"gh\":1";
    if (u.st) a << ",\"st\":" << u.st;
    if (u.st2) a << ",\"st2\":" << u.st2;   // second status word; same only-when-non-zero rule
    if (!u.ah.empty()) {
        a << ",\"ah\":\"" << u.ah << "\""
          << ",\"sw\":" << u.sw << ",\"sh\":" << u.sh
          << ",\"ax\":" << u.ax << ",\"ay\":" << u.ay;
    }
    a << "}";
}
static void append_bld_json(std::ostringstream& a, const BldRec& b, bool seedown = false) {
    a << "{\"id\":" << b.id << ",\"x1\":" << b.x1 << ",\"y1\":" << b.y1 << ",\"x2\":" << b.x2 << ",\"y2\":" << b.y2
      << ",\"z\":" << b.z << ",\"type\":\"" << json_escape_bytes(b.type) << "\",\"subtype\":" << b.subtype
      << ",\"stage\":" << b.stage << ",\"mat_type\":" << b.mat_type << ",\"mat_index\":" << b.mat_index
      << ",\"built\":" << (b.built ? "true" : "false");
    // Optional see-down tag, emitted only when the server proved an open column down to this
    // building; sd_top is recomputed fresh every scan.
    if (seedown) a << ",\"sd\":1";
    if (!b.ext.empty()) a << ",\"ext\":\"" << b.ext << "\"";
    if (b.has_rgb) a << ",\"rgb\":[" << b.r << "," << b.g << "," << b.b << "]";
    if (b.has_crgb) a << ",\"crgb\":[" << b.cr << "," << b.cg << "," << b.cb << "]";
    if (b.has_crgb && !b.cpal.empty()) a << ",\"cpal\":\"" << json_escape_bytes(b.cpal) << "\"";
    if (b.ds_valid) {
        a << ",\"dir\":" << b.direction << ",\"bst\":" << b.state
          << ",\"bextra\":" << b.extra << ",\"bcls\":" << b.bclass;
    }
    if (b.door_open_valid) a << ",\"dopen\":" << (b.door_open ? "true" : "false");
    // Statues only, gated by s_valid. Absent, the client draws the plinth plus DF's DEFAULT
    // subject; `srt` is emitted only for creature statues.
    if (b.s_valid) {
        a << ",\"sq\":" << b.s_quality << ",\"smt\":" << b.s_mt << ",\"smi\":" << b.s_mi
          << ",\"sgt\":" << b.s_gtype << ",\"sgi\":" << b.s_gid;
        if (!b.s_race.empty())
            a << ",\"srt\":\"" << json_escape_bytes(b.s_race) << "\"";
    }
    a << "}";
}

// A skipped paused-idle tick never reads DF: the regular tick before it leaves this neutral
// snapshot for the post-release AUX fanout. Push-loop owned, so no mutex.
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
std::atomic<bool> g_world_reset_requested{false};
// The lifecycle gate: false whenever DF has no world we may legally read -- before the first load,
// and from SC_WORLD_UNLOADED until the next SC_WORLD_LOADED completes.
std::atomic<bool> g_world_loaded{false};

void reset_world_stream_state() {
    g_gms = GlobalMapState{};
    g_conn.clear();
    g_sig_scan_tick = 0;
    g_paused_idle_ticks = 0;
    g_itemdef_ready = false;
    g_itemdef_frame.clear();
    g_unit_derived.clear();
    g_bld_derived.clear();
    g_race_caste_derived.clear();
    g_mat_rgb_derived.clear();
    g_last_read = LastReadState{};
    {
        std::lock_guard<std::mutex> lk(g_mapinfo_mu);
        g_mapinfo = V1MapInfo{};
    }
    {
        std::lock_guard<std::mutex> lk(g_diag_mu);
        g_diag.clear();
        g_susp_ring.clear();
        g_phase_ring.clear();
        g_simtick_ring.clear();
    }
    diagnostics_log("world-stream: reset all world-derived state after world unload");
}

// A v1 connection's interest for this tick.
struct Interest { WsConnection* conn; std::string player; int ox, oy, oz, w, h; };

} // namespace

void world_stream_set_world_loaded(bool loaded) {
    // On unload, close the gate BEFORE publishing the reset request: a tick that observes either
    // value must not enter CoreSuspender during DF's world teardown.
    g_world_loaded.store(loaded, std::memory_order_release);
    if (!loaded) set_reqblocks_map_capacity(0);
    g_world_reset_requested.store(true, std::memory_order_release);
    diagnostics_log(loaded ? "world-stream: lifecycle gate OPEN (world loaded)"
                           : "world-stream: lifecycle gate CLOSED (world unavailable)");
}

// ---- hello_ack map info -----------------------------------------------------------
V1MapInfo world_stream_map_info(std::recursive_mutex& capture_mu) {
    try {
        if (!g_world_loaded.load(std::memory_order_acquire))
            return {};
        std::lock_guard<std::recursive_mutex> lock(capture_mu);
        // Recheck after the capture lock: the unload edge can land while we were blocked on it.
        if (!g_world_loaded.load(std::memory_order_acquire))
            return {};
        CoreSuspender suspend;
        V1MapInfo mi;
        { std::lock_guard<std::mutex> lk(g_mapinfo_mu); mi = g_mapinfo; }
        if (Maps::IsValid()) {
            int mx = 0, my = 0, mz = 0;
            Maps::getSize(mx, my, mz);
            mi.w = mx * 16; mi.h = my * 16; mi.z = mz;
            set_reqblocks_map_capacity((size_t)mx * (size_t)my * (size_t)mz);
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

// ---- the per-tick global read pass -------------------------------------------------
void world_stream_tick(std::recursive_mutex& capture_mu,
                       const std::function<std::string(const std::string&)>& presence_fn) {
    if (g_world_reset_requested.exchange(false, std::memory_order_acq_rel))
        reset_world_stream_state();
    // The reset above is the LAST work this tick may do with no world. Bail before inspecting
    // clients or taking any DF lock.
    if (!g_world_loaded.load(std::memory_order_acquire))
        return;
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

    // ---- REQ_BLOCKS intake -------------------------------------------------------------
    // Range-validated against the cached map dims. No DF access, so it is safe pre-suspend.
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
                req_this_tick.insert(key);   // force-scan exception: the client is waiting now
                if (cs.req_front_set.insert(key).second)
                    cs.req_front.push_back(key);
            }
        }
    }

    // Only conns that sent hello and carry CAM dims participate: the interest POSITION is the
    // camera authority, the DIMS come from CAM.
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

        // ---- one-time resume-vs-snapshot decision, as soon as hello+cam are available ----
        ConnState& cs0 = g_conn[c.get()];
        if (!cs0.startup_decided) {
            cs0.startup_decided = true;
            uint32_t have = c->hello_have();
            if (changelog_within(g_gms, have)) {
                // RESUME: the union of changelog entries dirtied since `have`, restricted to
                // blocks whose CURRENT ver is actually greater -- skipping re-dirtied convergence.
                for (auto& entry : g_gms.changelog) {
                    if (entry.first <= have) continue;
                    for (uint64_t k : entry.second) {
                        auto vit = g_gms.ver.find(k);
                        if (vit != g_gms.ver.end() && vit->second > have) cs0.pending.insert(k);
                    }
                }
            } else {
                // FULL SNAPSHOT: seed the background walk. Interest-window blocks need no seeding,
                // since the in-view scan re-offers them every tick unconditionally.
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

    // Scan set = union of interest rects x z-range [z-10, z].
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
    // A REQ_BLOCKS key may sit outside the camera union, and is a same-tick force-scan exception
    // so it can be encoded and returned to the waiting client.
    scan.insert(req_this_tick.begin(), req_this_tick.end());

    std::unordered_map<uint64_t, std::shared_ptr<wire::EncodedBlock>> encoded;
    std::vector<UnitRec> units;
    std::vector<BldRec> bldgs;
    std::vector<ProjRec> projs;   // projectiles + vehicles in flight
    std::vector<DJobRec> djobs;   // designation jobs
    EnvRec env;                   // weather/season/year_tick
    // Seeded with a VALID default so the env JSON stays well-formed on the guarded path where the
    // env block does not run.
    std::string env_music_frag = "\"music\":{\"track\":\"hill_dwarf\",\"elapsedMs\":0,\"manual\":false}";
    // per-conn plan: which block keys to send this tick + whether to emit AUX.
    struct Plan { WsConnection* conn; std::vector<uint64_t> keys; bool aux; bool trickle_end = false; };
    std::vector<Plan> plans;
    plans.reserve(interests.size());

    int scanCount = 0, dirtyCount = 0;
    // Never skip while stream work is queued, while a new interest block needs its first
    // signature, or before there is a full neutral snapshot to serve AUX from.
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
    // A paused cadence acquisition reads EVERY bucket, so a native paused edit is bounded by four
    // ticks rather than by the skip and bucket cadences composed.
    const bool paused_idle_full_scan = paused_idle && !paused_idle_skip;
    const uint32_t scan_slot = static_cast<uint32_t>(g_sig_scan_tick++ % kSigScanBuckets);
    // Per-phase accumulators for THIS tick, filled at the phase boundaries and pushed as one
    // g_phase_ring entry at function end. Declared here so the post-release loop can see them.
    PhaseTimes pt;
    // Bracket marks: t0 pre-lock, tA after capture_mu, tB after CoreSuspender. Only meaningful
    // once a full tick completes, since early returns skip the ring push.
    auto t0 = std::chrono::steady_clock::now();
    auto tA = t0, tB = t0;
    int32_t frame_counter_snap = 0;
    bool paused_snap = false;
    std::vector<BakeSweepPoint> bake_candidates;
    bool collect_bake_candidates = false;
    int bake_viewport_w = 80, bake_viewport_h = 50, bake_map_w = 0, bake_map_h = 0;
    if (paused_idle_skip) {
        // The cached neutral records are enough for the post-release AUX fanout, and there can be
        // no BLOCK_SET here: the skip predicate above excludes every kind of pending work.
        for (const auto& in : interests) {
            Plan plan;
            plan.conn = in.conn;
            plan.aux = in.conn->window_open(false);
            plans.push_back(std::move(plan));
        }
    } else {
    // Invalidate before attempting a fresh read, so every early return and exception disables the
    // paused-idle reuse path; only the complete publication at the end re-arms it.
    g_last_read.valid = false;
    try {
        if (!g_world_loaded.load(std::memory_order_acquire))
            return;
        std::lock_guard<std::recursive_mutex> lock(capture_mu);
        // Recheck after the capture lock: the unload edge can land while we were blocked on it.
        if (!g_world_loaded.load(std::memory_order_acquire))
            return;
        tA = std::chrono::steady_clock::now();
        CoreSuspender suspend;
        tB = std::chrono::steady_clock::now();
#ifdef DWF_DIAG_SEED_MISLAP
        // Test-the-test: folding tB back onto t0 mis-attributes the CoreSuspender wait out of
        // suspWait, so the reconciliation MUST break -- proving the split is load-bearing.
        tB = t0;
#endif
        if (!Maps::IsValid()) {
            // A confirmed map-loss path, not the deferred reset that follows a successful load:
            // hello_ack's published capacity must survive the latter.
            set_reqblocks_map_capacity(0);
            reset_world_stream_state();
            return;
        }
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
        // Test-the-test: a real 5 ms stall inside the hold must raise dfStallMsPerSec by ~150 ms/s
        // and visibly drop simTicksPerSec, proving the gate metrics are not vacuous.
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
#endif

        // Warm the host-camera cache while we legally hold the core, so next tick's interest
        // building never marshals a read onto the render thread.
        if (df::global::window_x && df::global::window_y && df::global::window_z) {
            Camera hostcam;
            hostcam.x = *df::global::window_x;
            hostcam.y = *df::global::window_y;
            hostcam.z = *df::global::window_z;
            note_host_camera(hostcam);
        }

        // ph_lap(acc) adds the elapsed since the last mark and re-marks. The tick early-returns
        // before here with zero v1 clients, so idle overhead is zero.
        auto ph_mark = std::chrono::steady_clock::now();
        auto ph_lap = [&ph_mark](double& acc) {
            auto n = std::chrono::steady_clock::now();
            acc += std::chrono::duration<double, std::milli>(n - ph_mark).count();
            ph_mark = n;
        };

        // Build ITEMDEF_DICT once: raws are static per fort load, and it is cheap.
        if (!g_itemdef_ready) {
            wire::ItemDefSubcat subcats[wire::kItemDefSubcatCount];
            wire::read_itemdef_dict(world, subcats);
            std::vector<uint8_t> payload = wire::assemble_itemdef_dict(subcats);
            std::vector<uint8_t> frame = wire::build_frame_header(wire::kTypeItemDefDict, 0, 0);
            frame.insert(frame.end(), payload.begin(), payload.end());
            g_itemdef_frame = std::move(frame);
            g_itemdef_ready = true;
        }
        // One farm-contained-item scan per suspended tick; block_signature and encode_block both
        // consume this same snapshot below.
        wire::refresh_farm_crop_index(world);
        ph_lap(pt.misc);   // one-time itemdef dict build + IsValid/world fetch

        // One stable quarter of the interest union per normal tick. REQ keys and never-seen keys
        // bypass the bucket, and a paused cadence scans the whole union.
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
            // A block we ALREADY tracked stays in the sig-scan after it stops being shippable, so
            // erasing its last designation re-encodes it as a void frame clearing the stale glyph.
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
        ph_lap(pt.sig);   // (i) the bucket-selected block_signature() calls

        // (ii) if anything dirtied: bump world_seq, changelog, broadcast to every pending set.
        if (!dirty.empty()) {
            ++g_gms.world_seq;
            g_gms.changelog.push_back({g_gms.world_seq, dirty});
            while (g_gms.changelog.size() > kChangelogMax) g_gms.changelog.pop_front();
            for (auto& c : conns) for (uint64_t k : dirty) g_conn[c.get()].pending.insert(k);
        }
        dirtyCount = (int)dirty.size();

        // (iii) per-connection: refresh in-view pending, then pick sendable keys -- in-view first,
        //       capped per frame, gated by the pacing window and FIFO space.
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
                        // Offer a no-longer-shippable block to a conn that still HOLDS it, so the
                        // void re-encode clears the stale glyph; a conn that never had it is not.
                        if (!block_shippable(b) && cs.sent_ver.find(key) == cs.sent_ver.end()) continue;
                        if (g_gms.ver.find(key) == g_gms.ver.end()) {   // first-encode stamp
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
            // At most one BLOCK_SET frame per tick, if the window and FIFO allow. Priority order:
            // REQ_BLOCKS, in-view, background trickle, then leftover pending. Trickle never preempts.
            if (in.conn->window_open(true) && in.conn->v1_map_fifo_space() > 0) {
                // Each queued key is consumed whether sent or dropped as stale; anything left when
                // the frame fills stays at the front for next tick.
                while (!cs.req_front.empty() && plan.keys.size() < wire::kMaxBlocksPerFrame) {
                    uint64_t key = cs.req_front.front(); cs.req_front.pop_front();
                    cs.req_front_set.erase(key);
                    int bx, by, bz; bunpack(key, bx, by, bz);
                    df::map_block* b = Maps::getBlock(bx, by, bz);
                    // Honor a REQ for a block that went dark only if the conn already holds it:
                    // never seed a fully-hidden block to a conn that lacks it.
                    if (!block_shippable(b) && cs.sent_ver.find(key) == cs.sent_ver.end()) {
                        cs.pending.erase(key); continue;   // hidden & no desig, conn never had it: never sent
                    }
                    if (g_gms.ver.find(key) == g_gms.ver.end()) {
                        g_gms.ver[key] = g_gms.world_seq;
                        if (g_gms.sig.find(key) == g_gms.sig.end()) g_gms.sig[key] = block_signature(world, b, bx, by, bz);
                    }
                    // NO sent_ver skip here, unlike the in-view and trickle bands: a REQ_BLOCKS
                    // key is the client saying it does NOT have the block, so sent_ver is stale.
                    if (std::find(plan.keys.begin(), plan.keys.end(), key) != plan.keys.end()) continue;
                    plan.keys.push_back(key);
                    needed.insert(key);
                }
                // In-view next: camera z first, then downward.
                for (uint64_t k : inview) {
                    if (plan.keys.size() >= wire::kMaxBlocksPerFrame) break;
                    if (std::find(plan.keys.begin(), plan.keys.end(), k) != plan.keys.end()) continue;
                    plan.keys.push_back(k);
                    needed.insert(k);
                }
                // Advance the discovery walk by a bounded per-tick budget of cheap hidden-bit
                // reads, then drain what it queued, still capped by the frame limit.
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
                // Last: leftover pending, the off-screen dirty broadcast.
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
        ph_lap(pt.misc);   // (ii) changelog + (iii) per-conn pending/plan scheduling

        // (iv) encode-once each needed block (shared across connections).
        MapExtras::MapCache MC;
        for (uint64_t key : needed) {
            int bx, by, bz; bunpack(key, bx, by, bz);
            df::map_block* b = Maps::getBlock(bx, by, bz);
            uint32_t v = g_gms.ver.count(key) ? g_gms.ver[key] : g_gms.world_seq;
            encoded[key] = std::make_shared<wire::EncodedBlock>(
                wire::encode_block(world, MC, b, bx, by, bz, v));
        }
        ph_lap(pt.enc);   // (iv) wire::encode_block for dirty/owed blocks only

        // ONE units scan and ONE buildings scan into neutral vectors. The texture census runs here
        // too: the /mapdata path that also runs it is not polled while the WebSocket is up.
        unit_census_pass(world->units.active);
        // ONE snapshot of the exporter's unit_id->record map up front: it copies the whole map, so
        // per-unit calls would be O(units^2). Each unit then does an O(1) lookup.
        std::unordered_map<int32_t, UnitSpriteRecord> sprite_snapshot =
            unit_sprite_export_enabled() ? unit_sprite_snapshot()
                                          : std::unordered_map<int32_t, UnitSpriteRecord>{};
        // Highest connected camera z -- units below it are see-down candidates. This also bounds
        // the per-unit open-column walk.
        int maxCamZ = interests[0].oz;
        for (const auto& q : interests) if (q.oz > maxCamZ) maxCamZ = q.oz;
        for (size_t i = 0; i < world->units.active.size(); ++i) {
            df::unit* u = world->units.active[i];
            if (!u) continue;
            // units.active keeps killed records, and DF still draws real ghosts. NOT
            // Units::isAlive(): it folds in the NOT_LIVING curse flag, which erased the vampire.
            if (!Units::isGhost(u) &&
                (!Units::isActive(u) || !unit_is_animate(u))) continue;
            // Skip BEFORE the getTileBlock read: a caged unit's pos is frozen at the trap tile, so
            // the lookup is wasted at best and a null path on an unloaded block at worst.
            if (!unit_is_map_present(u)) continue;
            df::map_block* ublk = Maps::getTileBlock(u->pos);
            if (ublk && ublk->designation[u->pos.x & 15][u->pos.y & 15].bits.hidden) continue;
            UnitRec r; r.x = u->pos.x; r.y = u->pos.y; r.z = u->pos.z;
            // The walk stops at the first solid ceiling, so a unit under a roof is correctly
            // hidden from every camera above that roof.
            r.sd_top = seedown_top(r.x, r.y, r.z, maxCamZ, MAX_SEEDOWN);
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
            // Only visible, revealed units reach here. A unit is a bake candidate when DF has no
            // live texpos slot, its appearance is dirty, or the exporter has not served it yet.
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
            // DF only fills portrait_texpos when a unit view sheet is rendered, so most portraits
            // stay 0 unless the host opens each dwarf. Offer every unstamped streamed unit.
            if (u->portrait_texpos == 0)
                portrait_sweep_note_unit(u->id, Units::isFortControlled(u));
            // The ONE shared computation in unit_status.h, which returns 0 for non-living units.
            // Runs under the EXISTING CoreSuspender hold, per that helper's contract.
            r.st = unit_status_bits(u);
            r.st2 = unit_status_bits2(u);   // second status word
            r.rec_fold = s4_unit_fold(r, name_fold);
            units.push_back(std::move(r));
        }
        ph_lap(pt.unit);   // (v) units scan -- sprite snapshot + translateName + sd_top walks

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
            // "built" means the build stage reached its max: a queued construction reports false
            // so the client can draw a pending designation box.
            r.built = b->getBuildStage() >= b->getMaxBuildStage();
            // Per-tile stockpile footprint bitmap over the bbox, since DF piles are often
            // L-shaped and the bbox alone over-draws. Empty for a full rectangle.
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
            // Native derives a building's appearance from its COMPONENT items, not the header
            // material, so `rgb` (header) is metadata only and never used for colouring.
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
                    // The first structural (PERM) component is the established signal for the
                    // single-material cases. If it cannot resolve, emit neither component field.
                    r.has_crgb = resolve_desc_rgb(cmt, (int)bi->item->getMaterialIndex(),
                                                  r.cr, r.cg, r.cb, &r.cpal);
                    break;
                }
            }
            // Guarded virtual_casts only, no map access. ds_valid stays false for plain
            // workshops and furniture, and the AUX emit then omits the fields.
            fill_building_ds(b, r);
            r.rec_fold = probe_fold;
            g_bld_derived[bld_id] = BldDerived{probe_fold, r};
            bldgs.push_back(std::move(r));
        }
        // Refresh see-down reach every scan, outside the derived-record cache: ceilings and
        // camera z change while a building's own content fold does not.
        for (auto& r : bldgs)
            r.sd_top = seedown_top(r.x1, r.y1, r.z, maxCamZ, MAX_SEEDOWN);
        for (auto it = g_bld_derived.begin(); it != g_bld_derived.end(); ) it = seen_bld_ids.count(it->first) ? std::next(it) : g_bld_derived.erase(it);
        // Motion history advances only after every wagon resolved against the prior snapshot.
        // Purge departed caravans so a recycled building id never inherits a facing.
        for (df::building* b : world->buildings.all)
            if (b && b->getType() == df::building_type::Wagon)
                g_wagon_anchor[b->id] = WagonAnchor{b->x1, b->y1};
        for (auto it = g_wagon_anchor.begin(); it != g_wagon_anchor.end(); )
            it = seen_bld_ids.count(it->first) ? std::next(it) : g_wagon_anchor.erase(it);
        std::unordered_set<int> seen_unit_ids; for (const auto& unit : units) seen_unit_ids.insert(unit.id);
        for (auto it = g_unit_derived.begin(); it != g_unit_derived.end(); ) it = seen_unit_ids.count(it->first) ? std::next(it) : g_unit_derived.erase(it);
        ph_lap(pt.bld);   // (v) buildings scan, with the derived-record caches

        // When DF materializes a designation job it clears the corresponding map bits, so the
        // glyph has to come from the live job. GatherPlants is accepted only on a SHRUB tile.
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
                // Plant designations also clear the shared Default dig bit, and tile material
                // alone cannot distinguish a claimed plant job.
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
            // Job::getWorker is a plain vector walk on the already-held job, under the EXISTING
            // CoreSuspender: no map access and no new suspension.
            dr.w = (DFHack::Job::getWorker(job) != nullptr);
            djobs.push_back(dr);
        }

        // World::ReadCurrentWeather() already does the 5x5-grid modal reduction, so reuse it
        // rather than re-deriving the same scan. Season is month/3 with month = tick/1200/28.
        env.weather = World::ReadCurrentWeather();
        {
            int year_tick = df::global::cur_year_tick ? *df::global::cur_year_tick : 0;
            env.year_tick = (uint32_t)(year_tick < 0 ? 0 : year_tick);
            int day_of_year = std::max(0, year_tick / 1200);
            int month = std::min(11, day_of_year / 28);
            env.season = (uint8_t)(month / 3);
        }
        // Report DF's CONFIGURED autosave interval, not the transient autosave_request flag. The
        // string literal is safe to serialize after release.
        if (df::global::d_init) {
            switch (df::global::d_init->feature.autosave) {
                case df::enums::d_init_autosave::NONE:       env.autosave = "none"; break;
                case df::enums::d_init_autosave::SEASONAL:   env.autosave = "seasonal"; break;
                case df::enums::d_init_autosave::YEARLY:     env.autosave = "yearly"; break;
                case df::enums::d_init_autosave::SEMIANNUAL: env.autosave = "semiannual"; break;
                default: break;
            }
        }

        // An invasion is ACTIVE iff active_size1 != 0, and a SIEGE iff its mission is
        // KILL_ALL_AT_SITE -- without that check a kobold snatcher would flip on siege ambience.
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

        // Fort-site alignment: region_map is indexed by world-tile coords, evilness 0-32 Good /
        // 33-65 Neutral / 66+ Evil, savagery 66+ Savage. Fails soft to Neutral.
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

        // ONE canonical music state, computed once per aux frame so every client shares the same
        // {track,elapsedMs,manual}. first_year derives from plotinfo->fortress_age.
        int first_year = -1;
        if (auto* pi = df::global::plotinfo) {
            constexpr int32_t kFortYearOver10 = 40320;   // 403200 ticks/year / 10
            int32_t age = pi->fortress_age;
            if (age >= 0) first_year = (age < kFortYearOver10) ? 1 : 0;
        }
        env_music_frag = music::frame_json(env.siege, (int)env.season, first_year);

        // world->projectiles.all is a DUMMY HEAD -- real entries start at .next. A vehicle has no
        // pos of its own; its position comes from its linked item. proj_itemst only.
        for (df::proj_list_link* node = world->projectiles.all.next; node; node = node->next) {
            df::projectile* p = node->item;
            if (!p) continue;
            VIRTUAL_CAST_VAR(pit, df::proj_itemst, p);
            if (!pit || !pit->item) continue;
            df::item* it = pit->item;
            ProjRec r{};
            r.x = p->cur_pos.x; r.y = p->cur_pos.y; r.z = p->cur_pos.z;
            // fine_*_adj is -50000..50000, rescaled to the wire's 0..255 sub-tile fraction. It
            // reads pos_x/pos_y regardless of the parabolic flag, so an arcing shot may jitter.
            r.fx = std::min(255, std::max(0, (p->pos_x + 50000) * 255 / 100000));
            r.fy = std::min(255, std::max(0, (p->pos_y + 50000) * 255 / 100000));
            r.item_type = (int)it->getType();
            r.subtype = (int)it->getSubtype();
            r.mat_type = it->getMaterial(); r.mat_index = it->getMaterialIndex();
            r.is_vehicle = false;
            // The same proven-open-column reach units and buildings get, capped at the eight lower
            // viewports native's item-projectile printer selects between.
            r.sd_top = seedown_top(r.x, r.y, r.z, maxCamZ, MAX_SEEDOWN_PROJ);
            projs.push_back(r);
        }
        for (size_t i = 0; i < world->vehicles.active.size(); ++i) {
            df::vehicle* v = world->vehicles.active[i];
            if (!v) continue;
            df::item* it = df::item::find(v->item_id);
            if (!it) continue;   // no position source without the linked item
            ProjRec r{};
            r.x = it->pos.x; r.y = it->pos.y; r.z = it->pos.z;
            r.fx = std::min(255, std::max(0, (v->offset_x + 50000) * 255 / 100000));
            r.fy = std::min(255, std::max(0, (v->offset_y + 50000) * 255 / 100000));
            r.item_type = (int)it->getType();
            r.subtype = (int)it->getSubtype();
            r.mat_type = it->getMaterial(); r.mat_index = it->getMaterialIndex();
            r.is_vehicle = true;
            // A vehicle is not a native projectile and its own ITEM sprite already has see-down
            // from the tile layer, so keep the vehicle MARKER camera-plane-only.
            r.sd_top = r.z;
            projs.push_back(r);
        }
        ph_lap(pt.misc);   // djobs + env + projectiles/vehicles walks

        // Publish the fully-read neutral snapshot BEFORE releasing CoreSuspender. No cached record
        // aliases DF memory.
        uint64_t units_fold = kFnvOffsetBasis;
        for (const auto& r : units) s4_fold_add(units_fold, r.rec_fold);
        uint64_t bldgs_fold = kFnvOffsetBasis;
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
    // The residual split (capture_mu wait / CoreSuspender wait / true DF stall), set post-tick and
    // pushed with the rest of pt at function end.
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

    // The unit scan is complete and CoreSuspender is released. Plan once, then execute at most one
    // guarded real-camera render step per push tick; no sweep state rides AUX.
    if (!paused_idle_skip && collect_bake_candidates)
        bake_sweep_submit_candidates(bake_candidates, bake_viewport_w, bake_viewport_h,
                                     bake_map_w, bake_map_h);
    bake_sweep_tick(capture_mu);
    // Native portraits advance from plugin_onupdate: they must use DF's ordinary viewscreen
    // lifecycle, never a recursive render-thread logic call from this worker.

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

        // ITEMDEF_DICT is a one-shot dictionary, not part of the ack-tracked BLOCK_SET/AUX
        // ordering, and CH_DICT is its own slot so hello or ping traffic cannot overwrite it.
        if (!cs.itemdef_sent && g_itemdef_ready) {
            conn->enqueue_frame(WsConnection::CH_DICT, g_itemdef_frame, /*binary=*/true);
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

        // Snapshot trickle completion (background walk exhausted this tick).
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
            auto ax0 = std::chrono::steady_clock::now();   // post-release AUX assemble timer
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
            std::vector<std::pair<const BldRec*, bool>> visible_bldgs;  // bool = seedown
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
                        if (!first) s << ",";
                        first = false;
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
                    // Below-camera buildings ride only when the server proved an open column;
                    // above-camera stays dropped. Mirrors units' see-down.
                    bool seedown = false;
                    if (b.z != in->oz) {
                        if (b.z < in->oz && in->oz <= b.sd_top) seedown = true;
                        else continue;
                    }
                    if (b.x2 < in->ox || b.x1 >= in->ox + in->w) continue;
                    if (b.y2 < in->oy || b.y1 >= in->oy + in->h) continue;
                    visible_bldgs.push_back({&b, seedown});
                    if (bldgs_changed) {
                        if (!first) s << ",";
                        first = false;
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
                    if (!first) s << ",";
                    first = false;
                    s << "{\"x\":" << dj.x << ",\"y\":" << dj.y << ",\"z\":" << dj.z << ",\"k\":" << dj.k;
                    if (dj.w) s << ",\"w\":1";   // Additive worker-claimed flag
                    s << "}";
                }
                s << "]"; cs.aux_djobs_json = s.str();
            }
            if (proj_changed) {
                std::ostringstream s; s << "["; first = true;
                for (const auto& p : send_projs) {
                    // Below-camera projectiles ride on the same proven open column. `sd` is an
                    // additive tag: an old client that ignores it keeps its camera-plane guard.
                    bool seedown = false;
                    if (p.z != in->oz) {
                        if (p.z < in->oz && in->oz <= p.sd_top) seedown = true;
                        else continue;
                    }
                    if (p.x < in->ox || p.x >= in->ox + in->w) continue;
                    if (p.y < in->oy || p.y >= in->oy + in->h) continue;
                    if (!first) s << ",";
                    first = false;
                    s << "{\"x\":" << p.x << ",\"y\":" << p.y << ",\"z\":" << p.z
                      << ",\"fx\":" << p.fx << ",\"fy\":" << p.fy
                      << ",\"item_type\":" << p.item_type << ",\"subtype\":" << p.subtype
                      << ",\"mat_type\":" << p.mat_type << ",\"mat_index\":" << p.mat_index
                      << ",\"vehicle\":" << (p.is_vehicle ? "true" : "false");
                    if (seedown) s << ",\"sd\":1";
                    s << "}";
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
                            if (!first) d << ",";
                            first = false;
                            append_unit_json(d, *v.first, v.second);
                        }
                        d << "],\"rm\":["; first = true;
                        for (int id : rm) {
                            if (!first) d << ",";
                            first = false;
                            d << id;
                        }
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
                            if (!first) d << ",";
                            first = false;
                            append_bld_json(d, *v.first, v.second);
                        }
                        d << "],\"rm\":["; first = true;
                        for (int id : rm) {
                            if (!first) d << ",";
                            first = false;
                            d << id;
                        }
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
        row.reqQueued = (uint32_t)conn->reqblocks_queued();
        row.reqCoalesced = conn->reqblocks_coalesced();
        row.reqOverflowDrops = conn->reqblocks_overflow_drops();
        row.isHost = conn->is_host();
        { std::lock_guard<std::mutex> lk(g_diag_mu); g_diag[in->player] = row; }
    }

    // Recorded only on a fully-completed tick, exactly like g_susp_ring, so the phase ring and the
    // suspender ring always cover the same set of ticks.
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
    // Sum the CoreSuspender holds over the last 1000 ms. ONE global pass, so this must NOT scale
    // with the v1 client count.
    long long now = steady_now_ms();
    double susp_ms_per_sec = 0.0;
    for (auto& e : g_susp_ring) if (now - e.first <= 1000) susp_ms_per_sec += e.second;
    // The five in-suspend phases sum to about v1SuspenderMsPerSec minus acquisition, and
    // residualMsPerSec reports that difference so a mis-attributed phase stops reconciling.
    PhaseTimes ps{};   // summed ms/s
    for (auto& e : g_phase_ring) {
        if (now - e.first > 1000) continue;
        const PhaseTimes& p = e.second;
        ps.sig += p.sig; ps.enc += p.enc; ps.unit += p.unit; ps.bld += p.bld; ps.misc += p.misc;
        ps.auxAsm += p.auxAsm; ps.auxDef += p.auxDef; ps.auxSkip += p.auxSkip;
    }
    double phase_sum = ps.sig + ps.enc + ps.unit + ps.bld + ps.misc;
    double residual = susp_ms_per_sec - phase_sum;   // = acquisition + timing slop; ~0 when idle
    // Summed over the SAME trailing 1000 ms as the phases (suspWaitMax is a windowed MAX).
    // Identity: capWaitMsPerSec + suspWaitMsPerSec ~= residualMs.
    double cap_wait = 0.0, susp_wait = 0.0, df_stall = 0.0, susp_wait_max = 0.0;
    for (auto& e : g_phase_ring) {
        if (now - e.first > 1000) continue;
        const PhaseTimes& p = e.second;
        cap_wait += p.capWait; susp_wait += p.suspWait; df_stall += p.dfStall;
        if (p.suspWait > susp_wait_max) susp_wait_max = p.suspWait;
    }
    // Windowed frame_counter delta -> ticks/sec, and -1 when the newest sample is paused, since a
    // frozen counter would misrepresent throughput.
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
      // Additive residual fields.
      << ",\"capWaitMsPerSec\":" << cap_wait
      << ",\"suspWaitMsPerSec\":" << susp_wait
      << ",\"suspWaitMaxMs\":" << susp_wait_max
      << ",\"dfStallMsPerSec\":" << df_stall
      << ",\"simTicksPerSec\":" << sim_ticks_per_sec
      << ",\"players\":[";
    bool first = true;
    for (auto& kv : g_diag) {
        if (!first) o << ",";
        first = false;
        const DiagRow& r = kv.second;
        o << "{\"player\":\"" << json_escape_bytes(kv.first) << "\",\"scanBlocks\":" << r.scan
          << ",\"dirtyBlocks\":" << r.dirty << ",\"encodedBlocks\":" << r.encoded
          << ",\"pendingBlocks\":" << r.pending << ",\"inflightFrames\":" << r.inflight
          << ",\"rttMs\":" << r.rtt
          << ",\"trickleActive\":" << (r.trickleActive ? "true" : "false")
          << ",\"trickleBacklog\":" << r.trickleBacklog << ",\"reqFront\":" << r.reqFront
          << ",\"reqQueued\":" << r.reqQueued
          << ",\"reqCoalesced\":" << r.reqCoalesced
          << ",\"reqOverflowDrops\":" << r.reqOverflowDrops
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
