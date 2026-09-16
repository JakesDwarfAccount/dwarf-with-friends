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
// Crash-safe tile / unit / building reads over DF's stable sim structures, under CoreSuspender.

#include "tile_map_dump.h"
#include "tile_material.h"
#include "common_util.h"
#include "diagnostics.h"
#include "json_util.h"
#include "unit_sprites.h"
#include "unit_status.h"    // Shared overhead-status st bits (kUStat*/unit_status_bits)

#include "Core.h"
#include "DataDefs.h"
#include "TileTypes.h"

#include "modules/Maps.h"
#include "modules/MapCache.h"
#include "modules/Materials.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/global_objects.h"
#include "df/world.h"
#include "df/graphic.h"
#include "df/map_block.h"
#include "df/map_block_column.h"
#include "df/tile_designation.h"
#include "df/tile_occupancy.h"
#include "df/tile_dig_designation.h"
#include "df/tile_traffic.h"
#include "df/tiletype.h"
#include "df/tiletype_shape.h"
#include "df/tiletype_material.h"
#include "df/building.h"
#include "df/unit.h"
#include "df/item.h"
#include "df/item_type.h"
#include "df/item_actual.h"
#include "df/plant.h"
#include "df/plant_raw.h"
#include "df/creature_raw.h"
#include "df/caste_raw.h"
#include "df/block_square_event.h"
#include "df/block_square_event_material_spatterst.h"
#include "df/block_square_event_item_spatterst.h"   // item-spatter (leaves/fruit)
#include "df/flow_info.h"                            // block->flows (mist/smoke/...)
#include "df/plant_growth.h"                         // Growth token -> growth_class
#include "df/material.h"
#include "df/descriptor_color.h"
#include "df/matter_state.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <direct.h>
#endif

using namespace DFHack;

namespace dwf {
namespace {

// Does building [x1,x2] x [y1,y2] at z overlap the viewport rect?
bool building_in_view(df::building* b, int ox, int oy, int oz, int w, int h) {
    if (!b) return false;
    if (b->z != oz) return false;
    if (b->x2 < ox || b->x1 >= ox + w) return false;
    if (b->y2 < oy || b->y1 >= oy + h) return false;
    return true;
}

} // namespace

// ---- shared per-tile / per-object emitters ------------------------------------------------------

// Emits ONE tile object at (tx,ty) on z=oz; false means a null/edge {"tt":-1} marker was written.
// include_xy=false keeps the full-frame output byte-identical to the legacy inline reader.
static bool emit_tile_fields(std::ostringstream& js, MapExtras::MapCache& MC,
                             df::world* world, int tiles_x, int tiles_y,
                             int tx, int ty, int oz, bool include_xy) {
    auto put_xy = [&]() { if (include_xy) js << "\"x\":" << tx << ",\"y\":" << ty << ","; };

    // Is the tile at (x,y,z) a WALL? Crash-safe.
    auto tile_is_wall = [&](int x, int y, int z) -> bool {
        if (x < 0 || y < 0 || x >= tiles_x || y >= tiles_y) return false;
        df::map_block* nb = Maps::getTileBlock(df::coord(x, y, z));
        if (!nb) return false;
        return tileShape(nb->tiletype[x & 15][y & 15]) == df::tiletype_shape::WALL;
    };

    if (tx < 0 || ty < 0 || tx >= tiles_x || ty >= tiles_y) {
        js << "{"; put_xy(); js << "\"tt\":-1}";
        return false;
    }
    df::coord tpos(tx, ty, oz);
    df::map_block* block = Maps::getTileBlock(tpos);
    if (!block) { js << "{"; put_xy(); js << "\"tt\":-1}"; return false; }

    const int lx = tx & 15, ly = ty & 15;
    df::tiletype tt = block->tiletype[lx][ly];

    df::map_block* fblk = block;
    df::coord      fpos = tpos;

    df::tiletype_shape    shp  = tileShape(tt);
    df::tiletype_material tmat = tileMaterial(tt);
    df::tiletype_special  spc  = tileSpecial(tt);

    df::tile_designation des = block->designation[lx][ly];
    int flow = des.bits.flow_size;

    df::tile_designation top_des = block->designation[lx][ly];
    df::tile_occupancy   top_occ = block->occupancy[lx][ly];

    int base_mt = -1, base_mi = -1;

    auto is_open = [](df::tiletype_shape s, df::tiletype_material m) {
        return s == df::tiletype_shape::EMPTY
            || s == df::tiletype_shape::RAMP_TOP
            || m == df::tiletype_material::AIR;
    };
    int depth = 0;
    if (!des.bits.hidden && is_open(shp, tmat)) {
        // z-levels of see-down search; 10 fell short of ordinary outdoor sky-to-ground spans
        const int MAX_DEPTH = 60;
        for (int dz = 1; dz <= MAX_DEPTH; ++dz) {
            int lz = oz - dz;
            if (lz < 0) break;
            df::coord lpos(tx, ty, lz);
            df::map_block* lblk = Maps::getTileBlock(lpos);
            if (!lblk) continue;
            df::tiletype ltt = lblk->tiletype[lx][ly];
            df::tiletype_shape    lshp = tileShape(ltt);
            df::tiletype_material lmat = tileMaterial(ltt);
            df::tiletype_special  lspc = tileSpecial(ltt);
            df::tile_designation  ldes = lblk->designation[lx][ly];
            int lflow = ldes.bits.flow_size;
            if (is_open(lshp, lmat) && lflow == 0)
                continue;
            tt = ltt; shp = lshp; tmat = lmat; spc = lspc; des = ldes; flow = lflow;
            depth = dz;
            fblk = lblk; fpos = lpos;

            break;
        }
    }

    resolve_tile_material(MC, fpos, tmat, base_mt, base_mi);
    std::string extra;

    if (shp == df::tiletype_shape::WALL) {
        int m = 0;
        if (tile_is_wall(fpos.x, fpos.y - 1, fpos.z)) m |= 1;
        if (tile_is_wall(fpos.x, fpos.y + 1, fpos.z)) m |= 2;
        if (tile_is_wall(fpos.x + 1, fpos.y, fpos.z)) m |= 4;
        if (tile_is_wall(fpos.x - 1, fpos.y, fpos.z)) m |= 8;
        extra += ",\"wallnbr\":" + std::to_string(m);
    }

    if (fblk) {
        df::item* top = nullptr;
        const size_t ITEM_SCAN_CAP = 512;
        size_t scanned = 0;
        for (size_t ii = 0; ii < fblk->items.size() && scanned < ITEM_SCAN_CAP; ++ii, ++scanned) {
            df::item* it = df::item::find(fblk->items[ii]);
            if (!it) continue;
            // Hidden items are never drawn by DF, so one can never be the topmost item.
            if (it->flags.bits.hidden) continue;
            if (it->pos.x == fpos.x && it->pos.y == fpos.y && it->pos.z == fpos.z)
                top = it;
        }
        if (top) {
            int iflags = 0;
            if (top->flags.bits.spider_web) iflags |= 0x01;
            if (top->flags.bits.forbid)     iflags |= 0x02;
            if (top->flags.bits.dump)       iflags |= 0x04;
            if (top->flags.bits.melt)       iflags |= 0x08;
            if (top->flags.bits.on_fire)    iflags |= 0x10;
            VIRTUAL_CAST_VAR(actual, df::item_actual, top);
            int stack = actual ? actual->stack_size : 1;
            std::ostringstream io;
            io << ",\"item\":{\"type\":\"" << ENUM_KEY_STR(item_type, top->getType())
               << "\",\"mat_type\":" << (int)top->getMaterial()
               << ",\"mat_index\":" << (int)top->getMaterialIndex()
               << ",\"subtype\":" << (int)top->getSubtype()
               << ",\"iflags\":" << iflags
               << ",\"stack\":" << stack << "}";
            extra += io.str();
        }
    }

    {
        const char* part = nullptr;
        if      (shp == df::tiletype_shape::SAPLING)      part = "SAPLING";
        else if (shp == df::tiletype_shape::SHRUB)        part = "SHRUB";
        else if (shp == df::tiletype_shape::TWIG)         part = "LEAVES";
        else if (shp == df::tiletype_shape::BRANCH)       part = "BRANCH";
        else if (shp == df::tiletype_shape::TRUNK_BRANCH) part = "TRUNK";
        else if (tmat == df::tiletype_material::TREE)
            part = (shp == df::tiletype_shape::WALL) ? "TRUNK" : "CANOPY";
        else if (tmat == df::tiletype_material::MUSHROOM) part = "TRUNK";
        if (part) {
            std::string pid;
            int colx = (fpos.x / 48) * 3, coly = (fpos.y / 48) * 3;
            if (world->map.column_index && colx >= 0 && coly >= 0
                && colx < world->map.x_count_block && coly < world->map.y_count_block) {
                df::map_block_column* col = world->map.column_index[colx][coly];
                if (col) {
                    const size_t PLANT_CAP = 4096;
                    for (size_t pi = 0; pi < col->plants.size() && pi < PLANT_CAP; ++pi) {
                        df::plant* pl = col->plants[pi];
                        if (!pl) continue;
                        // column->plants spans every z at this x/y, so the species tail must use
                        // the exact-position predicate or it borrows an unrelated plant's raw id.
                        if (pl->pos.x == fpos.x && pl->pos.y == fpos.y && pl->pos.z == fpos.z) {
                            df::plant_raw* pr = df::plant_raw::find(pl->material);
                            if (pr) pid = pr->id;
                            break;
                        }
                    }
                }
            }
            extra += ",\"plant\":{";
            if (!pid.empty()) extra += "\"id\":\"" + json_escape_bytes(pid) + "\",";
            extra += "\"part\":\"";
            extra += part;
            extra += "\"}";
        }
    }

    // This legacy JSON stays first-event-only; the wire path emits ALL events ordered by amount.
    if (fblk) {
        for (size_t ei = 0; ei < fblk->block_events.size(); ++ei) {
            STRICT_VIRTUAL_CAST_VAR(sp, df::block_square_event_material_spatterst, fblk->block_events[ei]);
            if (!sp) continue;
            int amt = sp->amount[lx][ly];
            if (amt <= 0) continue;
            std::ostringstream so;
            so << ",\"spatter\":{\"mat_type\":" << (int)sp->mat_type
               << ",\"mat_index\":" << (int)sp->mat_index
               << ",\"state\":" << (int)sp->mat_state
               << ",\"amount\":" << amt << "}";
            extra += so.str();
            break;
        }
    }

    // item-spatter litter (fallen leaves/fruit), first event with amount>0. growth_class:
    // 0 OTHER / 1 LEAVES / 2 FRUIT / 3 FRUIT_SMALL / 4 FRUIT_LARGE, from the plant's growths[] token.
    if (fblk) {
        static std::unordered_map<int64_t, int> growth_cache;
        for (size_t ei = 0; ei < fblk->block_events.size(); ++ei) {
            STRICT_VIRTUAL_CAST_VAR(isp, df::block_square_event_item_spatterst, fblk->block_events[ei]);
            if (!isp) continue;
            int amt = isp->amount[lx][ly];
            if (amt <= 0) continue;
            int gclass = 0;
            if (isp->item_type == df::item_type::PLANT_GROWTH) {
                int64_t key = ((int64_t)isp->matindex << 20) ^ (int64_t)(uint16_t)isp->item_subtype;
                auto cit = growth_cache.find(key);
                if (cit != growth_cache.end()) {
                    gclass = cit->second;
                } else {
                    if (isp->matindex >= 0 && isp->matindex < (int32_t)world->raws.plants.all.size()) {
                        df::plant_raw* pr = world->raws.plants.all[isp->matindex];
                        if (pr && isp->item_subtype >= 0 && isp->item_subtype < (int16_t)pr->growths.size()) {
                            df::plant_growth* pg = pr->growths[isp->item_subtype];
                            if (pg) {
                                const std::string& tok = pg->id;
                                if (tok.find("LEA") != std::string::npos) gclass = 1;
                                else if (tok.find("FRUIT") != std::string::npos) {
                                    if (tok.find("SMALL") != std::string::npos) gclass = 3;
                                    else if (tok.find("LARGE") != std::string::npos) gclass = 4;
                                    else gclass = 2;
                                }
                            }
                        }
                    }
                    growth_cache[key] = gclass;
                }
            }
            std::ostringstream io;
            io << ",\"item_spatter\":{\"growth_class\":" << gclass
               << ",\"item_type\":" << (int)isp->item_type
               << ",\"amount\":" << (amt > 255 ? 255 : amt) << "}";
            extra += io.str();
            break;
        }
    }

    // Block flows, densest at this tile. Keyed "cloud", not "flow": "flow" is already the
    // liquid-flow-depth field emitted below.
    if (fblk) {
        int best_type = -1, best_density = -1;
        for (size_t fi = 0; fi < fblk->flows.size(); ++fi) {
            df::flow_info* fl = fblk->flows[fi];
            if (!fl || (int)fl->type < 0) continue;
            // DF keeps expired flows in the block vector and re-uses the slots.
            if (fl->flags.bits.DEAD || fl->density <= 0) continue;
            if (fl->pos.x != fpos.x || fl->pos.y != fpos.y || fl->pos.z != fpos.z) continue;
            int dens = fl->density; if (dens > 255) dens = 255;
            if (dens > best_density) { best_type = (int)fl->type; best_density = dens; }
        }
        if (best_type >= 0) {
            std::ostringstream co;
            co << ",\"cloud\":{\"type\":" << best_type << ",\"density\":" << best_density << "}";
            extra += co.str();
        }
    }

    {
        df::tile_dig_designation dig = top_des.bits.dig;
        int smooth  = (int)top_des.bits.smooth;
        int traffic = (int)top_des.bits.traffic;
        int track   = 0;
        if (top_occ.bits.carve_track_north) track |= 1;
        if (top_occ.bits.carve_track_south) track |= 2;
        if (top_occ.bits.carve_track_east)  track |= 4;
        if (top_occ.bits.carve_track_west)  track |= 8;
        bool marker = top_occ.bits.dig_marked != 0;
        bool active = (dig != df::tile_dig_designation::No)
                    || smooth > 0
                    || traffic != df::tile_traffic::Normal
                    || track != 0;
        if (active) {
            std::ostringstream de;
            de << ",\"desig\":{\"dig\":\"" << ENUM_KEY_STR(tile_dig_designation, dig) << "\""
               << ",\"smooth\":" << smooth
               << ",\"traffic\":" << traffic
               << ",\"track\":" << track
               << ",\"marker\":" << (marker ? 1 : 0) << "}";
            extra += de.str();
        }
    }

    const char* liq = (flow > 0)
        ? (des.bits.liquid_type == df::enums::tile_liquid::Magma ? "magma" : "water")
        : "none";

    js << "{";
    put_xy();
    js << "\"tt\":" << (int)tt
       << ",\"ttname\":\"" << ENUM_KEY_STR(tiletype, tt) << "\""
       << ",\"shape\":\"" << ENUM_KEY_STR(tiletype_shape, shp) << "\""
       << ",\"mat\":\""   << ENUM_KEY_STR(tiletype_material, tmat) << "\""
       << ",\"special\":\"" << ENUM_KEY_STR(tiletype_special, spc) << "\""
       << ",\"flow\":" << flow
       << ",\"liquid\":\"" << liq << "\""
       << ",\"hidden\":" << (des.bits.hidden ? 1 : 0)
       << ",\"outside\":" << (des.bits.outside ? 1 : 0)
       << ",\"base_mt\":" << base_mt
       << ",\"base_mi\":" << base_mi
       << ",\"depth\":" << depth
       << extra
       << "}";
    return true;
}

// Is a unit at (ux,uy,uz) see-down-visible from camera oz? True iff every tile in the column from
// uz+1 to oz is open -- the same predicate the terrain descent uses, capped at 60 like MAX_DEPTH.
static bool seedown_visible(int ux, int uy, int uz, int oz) {
    if (uz >= oz) return false;
    if (oz - uz > 60) return false;
    int lx = ux & 15, ly = uy & 15;
    for (int z = uz + 1; z <= oz; ++z) {
        df::map_block* ab = Maps::getTileBlock(df::coord(ux, uy, z));
        if (!ab) continue;   // unallocated block -> transparent, per the descent's `continue`
        df::tiletype tt = ab->tiletype[lx][ly];
        df::tiletype_shape    s = tileShape(tt);
        df::tiletype_material m = tileMaterial(tt);
        bool open = (s == df::tiletype_shape::EMPTY
                  || s == df::tiletype_shape::RAMP_TOP
                  || m == df::tiletype_material::AIR);
        if (!open) return false;
    }
    return true;
}

// Emits the in-view UNIT array elements, and runs the census over the FULL active list rather than
// this viewport. The sprite snapshot is taken ONCE per call: per unit it would be O(units^2).
static int emit_units(std::ostringstream& js, df::world* world,
                      int ox, int oy, int oz, int width, int height) {
    unit_census_pass(world->units.active);

    std::unordered_map<int32_t, UnitSpriteRecord> sprite_snapshot =
        unit_sprite_export_enabled() ? unit_sprite_snapshot()
                                      : std::unordered_map<int32_t, UnitSpriteRecord>{};

    int units_written = 0;
    bool firstUnit = true;
    for (size_t i = 0; i < world->units.active.size(); ++i) {
        df::unit* u = world->units.active[i];
        if (!u) continue;
        // units.active keeps killed records, and DF still draws real ghosts. NOT Units::isAlive():
        // it folds in the NOT_LIVING curse flag, which erased the fort's vampire and every undead.
        if (!Units::isGhost(u) &&
            (!Units::isActive(u) || !unit_is_animate(u))) continue;
        // Below-camera units ride only when see-down-visible, tagged "sd":1 so the client fog-dims
        // them by depth. Above-camera units never ride.
        bool seedown = false;
        if (u->pos.z != oz) {
            if (u->pos.z < oz && seedown_visible(u->pos.x, u->pos.y, u->pos.z, oz)) seedown = true;
            else continue;
        }
        if (u->pos.x < ox || u->pos.x >= ox + width)  continue;
        if (u->pos.y < oy || u->pos.y >= oy + height) continue;

        // DF never draws/composites an undetected ambusher or a unit standing
        // on an unrevealed (fog-of-war) tile -- leaking either would show players
        // dots for units they cannot actually see. Dead units are already excluded
        // by units.active.
        //
        // CORRECTION: this comment used to assert "caged units stay visible (DF shows them
        // normally)". That is false. Native draws NO creature for a caged unit anywhere -- the
        // cage ITEM is what is drawn -- and the unit's pos stays frozen at the trap tile
        // (ledger 0020 R5/R12, §5.2). Because this emitter is recomputed per request, leaving it
        // out of the skip is what used to make the stale creature come back on a page refresh
        // even after the live stream was fixed. Same predicate as the stream (unit_status.h).
        if (!unit_is_map_present(u)) continue;
        {
            df::map_block* ublk = Maps::getTileBlock(u->pos);
            // A missing block cannot be classified as unrevealed: leave the unit visible rather
            // than guess.
            if (ublk && ublk->designation[u->pos.x & 15][u->pos.y & 15].bits.hidden)
                continue;
        }

        if (!firstUnit) js << ",";
        firstUnit = false;
        std::string name;
        if (u->name.has_name)
            name = Translation::translateName(&u->name, true);

        std::string rt, ct;
        if (u->race >= 0 && (size_t)u->race < world->raws.creatures.all.size()) {
            df::creature_raw* cr = world->raws.creatures.all[u->race];
            if (cr) {
                rt = cr->creature_id;
                if (u->caste >= 0 && (size_t)u->caste < cr->caste.size()) {
                    df::caste_raw* ca = cr->caste[u->caste];
                    if (ca) ct = ca->caste_id;
                }
            }
        }

        js << "{\"x\":" << u->pos.x << ",\"y\":" << u->pos.y << ",\"z\":" << u->pos.z
           << ",\"id\":" << u->id
           << ",\"race\":" << u->race << ",\"caste\":" << u->caste
           << ",\"rt\":\"" << json_escape_bytes(rt) << "\""
           << ",\"ct\":\"" << json_escape_bytes(ct) << "\""
           << ",\"name\":\"" << json_escape_bytes(name) << "\"";
        if (Units::isGhost(u)) js << ",\"gh\":1";
        if (seedown) js << ",\"sd\":1";
        // Same contract as append_unit_json: the shared unit_status_bits() value, emitted only when
        // non-zero. Omit it here and every snapshot / fresh-join path silently loses the bubbles.
        {
            const int st = unit_status_bits(u);
            if (st) js << ",\"st\":" << st;
            // st2 must ride the SAME shape, or snapshots lose the second status word.
            const int st2 = unit_status_bits2(u);
            if (st2) js << ",\"st2\":" << st2;
        }
        {
            auto sit = sprite_snapshot.find(u->id);
            if (sit != sprite_snapshot.end() && !sit->second.hash.empty()) {
                const UnitSpriteRecord& rec = sit->second;
                js << ",\"ah\":\"" << rec.hash << "\""
                   << ",\"sw\":" << rec.sw << ",\"sh\":" << rec.sh
                   << ",\"ax\":" << rec.ax << ",\"ay\":" << rec.ay;
            }
        }
        js << "}";
        ++units_written;
    }
    return units_written;
}

// Emits the in-view BUILDING array elements. Shared verbatim by the full-frame and delta paths.
static int emit_buildings(std::ostringstream& js, df::world* world,
                          int ox, int oy, int oz, int width, int height) {
    int buildings_written = 0;
    bool firstBld = true;
    for (size_t i = 0; i < world->buildings.all.size(); ++i) {
        df::building* b = world->buildings.all[i];
        if (!building_in_view(b, ox, oy, oz, width, height)) continue;
        if (!firstBld) js << ",";
        firstBld = false;
        js << "{\"x1\":" << b->x1 << ",\"y1\":" << b->y1
           << ",\"x2\":" << b->x2 << ",\"y2\":" << b->y2 << ",\"z\":" << b->z
           << ",\"type\":\"" << ENUM_KEY_STR(building_type, b->getType()) << "\""
           << ",\"subtype\":" << (int)b->getSubtype()
           << ",\"stage\":" << (int)b->getBuildStage();
        int bmt = b->mat_type, bmi = b->mat_index;
        js << ",\"mat_type\":" << bmt << ",\"mat_index\":" << bmi;
        if (bmt >= 0) {
            MaterialInfo mi(bmt, bmi);
            if (mi.isValid() && mi.material) {
                int cidx = mi.material->state_color[df::matter_state::Solid];
                if (cidx >= 0 && (size_t)cidx < world->raws.descriptors.colors.size()) {
                    df::descriptor_color* col = world->raws.descriptors.colors[cidx];
                    if (col) {
                        int rr = (int)(col->red * 255.0f + 0.5f);
                        int gg = (int)(col->green * 255.0f + 0.5f);
                        int bb = (int)(col->blue * 255.0f + 0.5f);
                        if (rr < 0) rr = 0; if (rr > 255) rr = 255;
                        if (gg < 0) gg = 0; if (gg > 255) gg = 255;
                        if (bb < 0) bb = 0; if (bb > 255) bb = 255;
                        js << ",\"rgb\":[" << rr << "," << gg << "," << bb << "]";
                    }
                }
            }
        }
        js << "}";
        ++buildings_written;
    }
    return buildings_written;
}

// Owns C++ objects that need unwinding, so MSVC forbids __try here (C2712); a C++ try/catch
// backstops std::exception instead. use_window_origin reads window_x/y/z for the host viewport.
static std::string build_map_json_impl(bool use_window_origin,
                                       int ox_in, int oy_in, int oz_in,
                                       int width, int height,
                                       bool emit_log, std::string* err) {
    try {
        // Suspend the core so DF's sim thread is not mutating the map, units or buildings while we
        // read them. CoreSuspender is reentrant, so this is safe even when the caller suspended.
        CoreSuspender suspend;

        if (!Maps::IsValid()) {
            if (err) *err = "map not loaded (no live fortress) -- capture skipped";
            return "";
        }
        auto world = df::global::world;
        if (!world) { if (err) *err = "world global unavailable"; return ""; }

        int ox = ox_in, oy = oy_in, oz = oz_in;
        if (use_window_origin) {
            if (!df::global::window_x || !df::global::window_y || !df::global::window_z) {
                if (err) *err = "DF window coordinates are unavailable";
                return "";
            }
            ox = *df::global::window_x;
            oy = *df::global::window_y;
            oz = *df::global::window_z;
        }

        // gps->dimx/dimy is graphicST -- a plain grid dimension, not graphic_viewportST's arrays.
        if (width <= 0 || height <= 0) {
            auto gps = df::global::gps;
            int gw = (gps && gps->dimx > 0) ? gps->dimx : 80;
            int gh = (gps && gps->dimy > 0) ? gps->dimy : 50;
            if (width <= 0)  width = gw;
            if (height <= 0) height = gh;
        }
        // Sanity clamp so a wild dim can never allocate/loop unbounded.
        if (width  > 512) width  = 512;
        if (height > 512) height = 512;

        int mx = 0, my = 0, mz = 0;
        Maps::getSize(mx, my, mz);           // in blocks
        const int tiles_x = mx * 16, tiles_y = my * 16;

        MapExtras::MapCache MC;

        std::ostringstream js;
        // wire:5. The field shapes live in emit_tile_fields / emit_units / emit_buildings.
        js << "{\"wire\":5,"
           << "\"origin\":{\"x\":" << ox << ",\"y\":" << oy << ",\"z\":" << oz << "},"
           << "\"width\":" << width << ",\"height\":" << height << ",\"z\":" << oz << ",";

        // Row-major (y outer, x inner). include_xy=false keeps this byte-identical to the legacy
        // inline reader.
        int tiles_written = 0, tiles_skipped = 0;
        js << "\"tiles\":[";
        bool firstTile = true;
        for (int ty = oy; ty < oy + height; ++ty) {
            for (int tx = ox; tx < ox + width; ++tx) {
                if (!firstTile) js << ",";
                firstTile = false;
                if (emit_tile_fields(js, MC, world, tiles_x, tiles_y, tx, ty, oz, false))
                    ++tiles_written;
                else
                    ++tiles_skipped;
            }
        }
        js << "],";

        // ---- UNITS / BUILDINGS in-view (shared emitters).
        js << "\"units\":[";
        int units_written = emit_units(js, world, ox, oy, oz, width, height);
        js << "],";
        js << "\"buildings\":[";
        int buildings_written = emit_buildings(js, world, ox, oy, oz, width, height);
        js << "]}";

        if (emit_log) {
            std::ostringstream note;
            note << "map-json: origin(" << ox << "," << oy << "," << oz << ") "
                 << width << "x" << height << " -> tiles " << tiles_written << " ("
                 << tiles_skipped << " null/edge), units " << units_written
                 << ", buildings " << buildings_written;
            diagnostics_log(note.str());
        }
        return js.str();
    }
    catch (const std::exception& e) {
        if (err) *err = std::string("map dump exception: ") + e.what();
        diagnostics_log(std::string("map-json exception: ") + e.what());
        return "";
    }
    catch (...) {
        if (err) *err = "map dump: unknown exception";
        diagnostics_log("map-json: unknown exception");
        return "";
    }
}

// Public: build wire:1 JSON for a player's camera viewport (origin = camera x/y/z).
std::string build_map_json_for_camera(const Camera& cam, int width, int height, std::string* err) {
    return build_map_json_impl(/*use_window_origin=*/false, cam.x, cam.y, cam.z, width, height,
                               /*emit_log=*/false, err);
}

// Existing command path: read the CURRENT host viewport (window_x/y/z) and write map.json.
bool dump_map_window(const std::string& out_dir, int width, int height, std::string* err) {
    std::string json = build_map_json_impl(/*use_window_origin=*/true, 0, 0, 0, width, height,
                                           /*emit_log=*/true, err);
    if (json.empty())
        return false;
    try {
        mkdirs(out_dir);
        std::ofstream f(out_dir + "/map.json", std::ios::binary);
        if (!f) { if (err) *err = "cannot open " + out_dir + "/map.json for writing"; return false; }
        f.write(json.data(), (std::streamsize)json.size());
        return true;
    }
    catch (const std::exception& e) {
        if (err) *err = std::string("map dump write exception: ") + e.what();
        return false;
    }
}

} // namespace dwf
