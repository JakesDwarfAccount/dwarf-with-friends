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

#include "placement.h"

#include "attribution.h"
#include "client_state.h"
#include "http_server.h"
#include "json_util.h"
#include "lua_bridge.h"
#include "route_helpers.h"

#include "diagnostics.h"
#include "sdl_capture.h"

#include "Core.h"
#include "TileTypes.h"
#include "modules/Constructions.h"
#include "modules/Designations.h"
#include "modules/DFSDL.h"
#include "modules/Items.h"
#include "modules/Job.h"
#include "modules/MapCache.h"
#include "modules/Maps.h"
#include "modules/Materials.h"

#include "df/global_objects.h"
#include "df/inorganic_raw.h"
#include "df/item.h"
#include "df/job.h"
#include "df/job_list_link.h"
#include "df/job_type.h"
#include "df/map_block.h"
#include "df/material.h"
#include "df/plant.h"
#include "df/plant_tree_info.h"
#include "df/plotinfost.h"   // B233-4: plotinfo.main.traffic_cost_* (the live path-cost fields)
#include "df/tile_designation.h"
#include "df/tile_dig_designation.h"
#include "df/tile_occupancy.h"
#include "df/tile_traffic.h"
#include "df/tiletype.h"
#include "df/tiletype_material.h"
#include "df/tiletype_shape.h"
#include "df/tiletype_shape_basic.h"
#include "df/tiletype_special.h"
#include "df/world.h"

#include <algorithm>
#include <future>
#include <memory>
#include <mutex>
#include <sstream>
#include <vector>

namespace dwf {
namespace {

using DFHack::DFCoord;

enum class DesignationKind {
    Dig,
    Smooth,
    Engrave,
    Track,
    Fortify,
    Chop,
    Gather,
    Traffic,
    RemoveStairsRamps,
    Clear,
    // WD-8.3: marker<->standard conversion on tiles that already carry a dig/smooth
    // designation (flips DES_MARKER_ONLY, never creates a new designation).
    ConvertToMarker,
    ConvertToStandard,
    // WD-10: item designations (claim/forbid/dump/no-dump/melt/no-melt/hide/visible).
    // The specific flag to flip is read back out of req.request.tool -- see
    // apply_item_flag_designations -- so this is one kind for all eight tool strings.
    ItemFlag,
};

std::recursive_mutex g_designation_mutex;

int clamp_int(int value, int low, int high) {
    return std::max(low, std::min(high, value));
}

// Job types DF queues from dig/chop/gather/track/engrave designations. Once you press play,
// designations turn into these jobs and the tiles' designation bits clear -- so the eraser must
// cancel these jobs too, not just clear the bits. This is what DF's native erase does.
bool is_designation_job(df::job_type jt) {
    switch (jt) {
    case df::job_type::Dig:
    case df::job_type::CarveUpwardStaircase:
    case df::job_type::CarveDownwardStaircase:
    case df::job_type::CarveUpDownStaircase:
    case df::job_type::CarveRamp:
    case df::job_type::DigChannel:
    case df::job_type::CarveFortification:
    case df::job_type::CarveTrack:
    case df::job_type::SmoothWall:
    case df::job_type::SmoothFloor:
    case df::job_type::DetailWall:
    case df::job_type::DetailFloor:
    case df::job_type::FellTree:
    case df::job_type::GatherPlants:
    case df::job_type::RemoveConstruction:
        return true;
    default:
        return false;
    }
}

bool dig_from_tool(const std::string& tool, df::tile_dig_designation& out) {
    if (tool.empty() || tool == "dig" || tool == "mine") {
        out = df::tile_dig_designation::Default;
        return true;
    }
    if (tool == "channel") {
        out = df::tile_dig_designation::Channel;
        return true;
    }
    if (tool == "ramp") {
        out = df::tile_dig_designation::Ramp;
        return true;
    }
    if (tool == "stairs" || tool == "updown") {
        out = df::tile_dig_designation::UpDownStair;
        return true;
    }
    if (tool == "up" || tool == "upstair") {
        out = df::tile_dig_designation::UpStair;
        return true;
    }
    if (tool == "down" || tool == "downstair") {
        out = df::tile_dig_designation::DownStair;
        return true;
    }
    if (tool == "clear" || tool == "erase" || tool == "none" || tool == "off") {
        out = df::tile_dig_designation::No;
        return true;
    }
    return false;
}

bool kind_from_tool(const std::string& tool, DesignationKind& kind,
                    df::tile_dig_designation& dig) {
    dig = df::tile_dig_designation::No;
    if (tool == "smooth") {
        kind = DesignationKind::Smooth;
        return true;
    }
    if (tool == "engrave") {
        kind = DesignationKind::Engrave;
        return true;
    }
    if (tool == "track" || tool == "carve_track") {
        kind = DesignationKind::Track;
        return true;
    }
    if (tool == "fortify" || tool == "fortification") {
        kind = DesignationKind::Fortify;
        return true;
    }
    if (tool == "chop") {
        kind = DesignationKind::Chop;
        return true;
    }
    if (tool == "gather") {
      kind = DesignationKind::Gather;
      return true;
    }
    if (tool == "traffic-high" || tool == "traffic-normal" ||
            tool == "traffic-low" || tool == "traffic-restricted") {
        kind = DesignationKind::Traffic;
        return true;
    }
    // DF names the toolbar action DIG_REMOVE_STAIRS_RAMPS, distinct from the
    // RemoveConstruction job. df-structures says its Default/REGULAR designation removes
    // stairs and ramps; current native UI also applies this action to constructions.
    // Keep the old remove-construction spelling as a wire-compatible alias only.
    if (tool == "remove-stairs-ramps" || tool == "remove-construction") {
        kind = DesignationKind::RemoveStairsRamps;
        dig = df::tile_dig_designation::Default;
        return true;
    }
    if (tool == "clear" || tool == "erase" || tool == "remove" || tool == "none" || tool == "off") {
        kind = DesignationKind::Clear;
        return true;
    }
    // WD-8.3 ENDPOINT-EXTEND: marker-convert trio -- flips DES_MARKER_ONLY on already-
    // designated tiles; see the ConvertToMarker/ConvertToStandard branch in
    // apply_tile_designations_at for the rect walk.
    if (tool == "convert-to-marker") {
        kind = DesignationKind::ConvertToMarker;
        return true;
    }
    if (tool == "convert-to-standard") {
        kind = DesignationKind::ConvertToStandard;
        return true;
    }
    // WD-10 ENDPOINT-ADD: item designations. "claim" clears forbid; "no-dump"/"undump" and
    // "no-melt"/"unmelt" are accepted spellings for cancelling those designations; "visible"/
    // "unhide" clear the hidden flag. Buildings are NOT covered (see completion report).
    if (tool == "claim" || tool == "forbid" || tool == "dump" || tool == "no-dump" ||
            tool == "undump" || tool == "melt" || tool == "no-melt" || tool == "unmelt" ||
            tool == "hide" || tool == "visible" || tool == "unhide") {
        kind = DesignationKind::ItemFlag;
        return true;
    }
    if (dig_from_tool(tool, dig)) {
        kind = DesignationKind::Dig;
        return true;
    }
    return false;
}

bool is_visible_natural_stone(MapExtras::MapCache& map, const DFCoord& pos, df::tiletype& tt) {
    df::tile_designation des = map.designationAt(pos);
    if (des.bits.hidden)
        return false;
    tt = map.tiletypeAt(pos);
    df::tiletype_material mat = DFHack::tileMaterial(tt);
    return mat == df::tiletype_material::STONE ||
           mat == df::tiletype_material::MINERAL ||
           mat == df::tiletype_material::FEATURE ||
           mat == df::tiletype_material::LAVA_STONE;
}

bool natural_wall_or_floor(df::tiletype tt) {
    df::tiletype_shape_basic basic =
        ENUM_ATTR(tiletype_shape, basic_shape, DFHack::tileShape(tt));
    return basic == df::tiletype_shape_basic::Wall ||
           basic == df::tiletype_shape_basic::Floor;
}

bool can_smooth_tile(MapExtras::MapCache& map, const DFCoord& pos) {
    df::tiletype tt = df::tiletype::Void;
    if (!is_visible_natural_stone(map, pos, tt) || !natural_wall_or_floor(tt))
        return false;
    return DFHack::tileSpecial(tt) != df::tiletype_special::SMOOTH;
}

bool can_engrave_tile(MapExtras::MapCache& map, const DFCoord& pos) {
    df::tiletype tt = df::tiletype::Void;
    if (!is_visible_natural_stone(map, pos, tt) || !natural_wall_or_floor(tt))
        return false;
    return DFHack::tileSpecial(tt) == df::tiletype_special::SMOOTH;
}

bool can_fortify_tile(MapExtras::MapCache& map, const DFCoord& pos) {
    df::tiletype tt = df::tiletype::Void;
    if (!is_visible_natural_stone(map, pos, tt))
        return false;
    return DFHack::tileShape(tt) == df::tiletype_shape::WALL &&
           DFHack::tileSpecial(tt) == df::tiletype_special::SMOOTH;
}

bool can_track_tile(MapExtras::MapCache& map, const DFCoord& pos) {
    df::tiletype tt = df::tiletype::Void;
    if (!is_visible_natural_stone(map, pos, tt))
        return false;
    df::tiletype_shape shape = DFHack::tileShape(tt);
    return shape == df::tiletype_shape::FLOOR || shape == df::tiletype_shape::RAMP;
}

// DF's advanced-dig mine-mode row: 0=All (no restriction, today's default), 1=Auto,
// 2=Ore, 3=Gem. Interpretation (spec text was directive but not byte-exact, so documenting
// it here): Auto/Ore/Gem all restrict the rect to vein tiles (tiletype_material::MINERAL,
// matching dfhack's own "dig" plugin automine feature and dig-now.cpp's dug_tile_info),
// then Ore/Gem further narrow to the vein's actual raw material via the same
// df::inorganic_raw::isOre() / df::material::isGem() checks prospector.cpp and dig-now.cpp
// use for the canonical ore/gem classification. Auto additionally sets the tile's real DF
// DES_AUTOMINE_LIKE_MATERIAL occupancy bit (df.d_basics.xml) below in
// apply_tile_designations_at, so the game itself continues mining the vein's like material
// once a dwarf starts digging it -- Ore/Gem do NOT set that bit, since DF's own auto-mine
// flag doesn't discriminate ore vs. gem once triggered; restricting the *initial* rect to
// ore-only/gem-only tiles is the only faithful way to keep those two modes distinct.
bool mine_mode_allows_tile(MapExtras::MapCache& map, const DFCoord& pos, int mine_mode) {
    if (mine_mode <= 0)
        return true;
    df::tiletype tt = map.tiletypeAt(pos);
    if (DFHack::tileMaterial(tt) != df::tiletype_material::MINERAL)
        return false;
    if (mine_mode == 1) // Auto: any vein tile qualifies; DES_AUTOMINE_LIKE_MATERIAL does the rest.
        return true;
    DFHack::MaterialInfo mi(map.baseMaterialAt(pos));
    if (mine_mode == 2) // Ore
        return mi.inorganic && mi.inorganic->isOre();
    if (mine_mode == 3) // Gem
        return mi.material && mi.material->isGem();
    return true; // unknown mode value: fail open rather than silently drop the whole rect
}

bool can_apply_dig_designation(MapExtras::MapCache& map, const DFCoord& pos,
                               df::tile_dig_designation dig) {
    auto world = df::global::world;
    if (!world)
        return false;

    if (pos.x <= 0 || pos.y <= 0 ||
            pos.x >= world->map.x_count * 16 - 1 ||
            pos.y >= world->map.y_count * 16 - 1)
        return false;

    auto block = map.BlockAt(pos / 16);
    if (!block || !block->is_valid())
        return false;

    df::tiletype tt = map.tiletypeAt(pos);
    df::tile_designation des = map.designationAt(pos);
    if (DFHack::tileMaterial(tt) == df::tiletype_material::CONSTRUCTION && !des.bits.hidden)
        return false;

    df::tiletype_shape shape = DFHack::tileShape(tt);
    if (shape == df::tiletype_shape::EMPTY && !des.bits.hidden)
        return false;

    if (!des.bits.hidden) {
        df::tiletype_shape_basic basic = ENUM_ATTR(tiletype_shape, basic_shape, shape);
        if (basic == df::tiletype_shape_basic::Wall)
            return true;
        if (basic == df::tiletype_shape_basic::Floor &&
                (dig == df::tile_dig_designation::DownStair ||
                 dig == df::tile_dig_designation::Channel) &&
                shape != df::tiletype_shape::BRANCH &&
                shape != df::tiletype_shape::TRUNK_BRANCH &&
                shape != df::tiletype_shape::TWIG)
            return true;
        if (basic == df::tiletype_shape_basic::Stair &&
                dig == df::tile_dig_designation::Channel)
            return true;
        return false;
    }

    return true;
}

// DF's DIG_REMOVE_STAIRS_RAMPS action is broader than the RemoveConstruction job. In
// df-structures tile_dig_designation::Default is documented to "remove stairs and ramps";
// DFHack quickfort's do_remove_ramps accepts visible RAMP/STAIR_UP/STAIR_DOWN shapes and writes
// that value. Native's action tooltip also includes constructed tiles, which retain the existing
// construction/material check here. RAMP_TOP is the visible proxy one z above an upward ramp.
bool can_remove_stairs_ramps(MapExtras::MapCache& map, const DFCoord& pos, DFCoord& target) {
    df::tile_designation des = map.designationAt(pos);
    if (des.bits.hidden)
        return false;

    df::tiletype tt = map.tiletypeAt(pos);
    if (DFHack::tileMaterial(tt) == df::tiletype_material::CONSTRUCTION ||
            DFHack::Constructions::findAtTile(pos)) {
        target = pos;
        return true;
    }

    df::tiletype_shape shape = DFHack::tileShape(tt);
    if (shape == df::tiletype_shape::RAMP ||
            shape == df::tiletype_shape::STAIR_UP ||
            shape == df::tiletype_shape::STAIR_DOWN) {
        target = pos;
        return true;
    }

    if (shape == df::tiletype_shape::RAMP_TOP && pos.z > 0) {
        DFCoord below(pos.x, pos.y, pos.z - 1);
        df::tile_designation below_des = map.designationAt(below);
        df::tiletype below_tt = map.tiletypeAt(below);
        if (!below_des.bits.hidden && DFHack::tileShape(below_tt) == df::tiletype_shape::RAMP) {
            target = below;
            return true;
        }
    }
    return false;
}

// BUGFIX (cursor/selection misalignment -- the dig-designation path, so the highest-impact
// instance of this bug: a drag past DF's tiny native viewport used to designate the WRONG,
// clamped-edge tile instead of the one under the cursor). Was clamping/rescaling against
// effective_capture_viewport_dims (DF's own native viewport) instead of the client's real
// frame_w/frame_h -- see interaction.cpp's pixel_to_tile_coord banner for the root cause. px is
// already a plain tile-grid index into the client's rendered window; clamp against that window.
int pixel_to_tile(int pixel, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, pixel));
}

struct RenderDesignationRequest {
    Camera camera;
    DesignationRequest request;
    DesignationKind kind = DesignationKind::Dig;
    df::tile_dig_designation dig = df::tile_dig_designation::Default;
    DesignationResult result;
    std::string err;
    std::promise<bool> done;
    // World-tile box of the selection, recorded by apply_designation so the post-render
    // eraser job-cancel pass can run under CoreSuspender. box_x2 < box_x1 means "not set".
    int box_x1 = 0, box_y1 = 0, box_x2 = -1, box_y2 = -1, box_z = 0;
};

bool apply_tile_designations_at(RenderDesignationRequest& req, MapExtras::MapCache& map,
                                int tx1, int ty1, int tx2, int ty2, int wz,
                                df::tile_dig_designation dig_override) {
    int changed_count = 0;
    const int sel_w = tx2 - tx1 + 1;
    const int sel_h = ty2 - ty1 + 1;
    const bool track_ns = sel_h >= sel_w;
    const bool track_ew = sel_w >= sel_h;
    int priority = clamp_int(req.request.priority, 1, 7) * 1000;

    for (int ty = ty1; ty <= ty2; ++ty) {
        for (int tx = tx1; tx <= tx2; ++tx) {
            DFCoord pos(req.camera.x + tx, req.camera.y + ty, wz);
            if (req.kind == DesignationKind::RemoveStairsRamps) {
                DFCoord target;
                if (!can_remove_stairs_ramps(map, pos, target))
                    continue;
                pos = target;
            }
            df::tile_designation des = map.designationAt(pos);

            // WD-8.3: marker<->standard conversion only touches tiles that ALREADY carry a
            // dig or smooth-family designation -- it never creates one. Self-contained (no
            // des_priority/touch_occ bookkeeping below applies), so handle and continue.
            if (req.kind == DesignationKind::ConvertToMarker ||
                    req.kind == DesignationKind::ConvertToStandard) {
                if (des.bits.dig == df::tile_dig_designation::No && des.bits.smooth == 0)
                    continue;
                df::tile_occupancy occ = map.occupancyAt(pos);
                bool want_marked = req.kind == DesignationKind::ConvertToMarker;
                if (occ.bits.dig_marked != want_marked) {
                    occ.bits.dig_marked = want_marked;
                    map.setOccupancyAt(pos, occ);
                    ++changed_count;
                }
                continue;
            }

            bool changed = false;
            bool touch_occ = false;
            int des_priority = 0;

            if (req.kind == DesignationKind::Dig) {
                if (dig_override != df::tile_dig_designation::No &&
                        !can_apply_dig_designation(map, pos, dig_override))
                    continue;
                if (dig_override != df::tile_dig_designation::No &&
                        !mine_mode_allows_tile(map, pos, req.request.mine_mode))
                    continue;
                if (des.bits.dig != dig_override) {
                    des.bits.dig = dig_override;
                    changed = true;
                }
                des_priority = priority;
                touch_occ = true;
            } else if (req.kind == DesignationKind::Smooth ||
                       req.kind == DesignationKind::Engrave ||
                       req.kind == DesignationKind::Fortify) {
                if (req.kind == DesignationKind::Smooth && !can_smooth_tile(map, pos))
                    continue;
                if (req.kind == DesignationKind::Engrave && !can_engrave_tile(map, pos))
                    continue;
                if (req.kind == DesignationKind::Fortify && !can_fortify_tile(map, pos))
                    continue;
                uint32_t want = req.kind == DesignationKind::Engrave ? 2u : 1u;
                if (des.bits.smooth != want) {
                    des.bits.smooth = want;
                    changed = true;
                }
                des_priority = priority;
            } else if (req.kind == DesignationKind::Track) {
                if (!can_track_tile(map, pos))
                    continue;
                df::tile_occupancy occ = map.occupancyAt(pos);
                if (occ.bits.carve_track_north != track_ns ||
                        occ.bits.carve_track_south != track_ns ||
                        occ.bits.carve_track_east != track_ew ||
                        occ.bits.carve_track_west != track_ew) {
                    occ.bits.carve_track_north = track_ns;
                    occ.bits.carve_track_south = track_ns;
                    occ.bits.carve_track_east = track_ew;
                    occ.bits.carve_track_west = track_ew;
                    map.setOccupancyAt(pos, occ);
                    changed = true;
                }
                des_priority = priority;
            } else if (req.kind == DesignationKind::Traffic) {
                df::tile_traffic want = df::tile_traffic::Normal;
                if (req.request.tool == "traffic-high") want = df::tile_traffic::High;
                else if (req.request.tool == "traffic-low") want = df::tile_traffic::Low;
                else if (req.request.tool == "traffic-restricted") want = df::tile_traffic::Restricted;
                if (des.bits.traffic != want) {
                    des.bits.traffic = want;
                    changed = true;
                }
            } else if (req.kind == DesignationKind::RemoveStairsRamps) {
                // Default is both native removal's regular mining designation for natural
                // stairs/ramps and the value that queues RemoveConstruction for constructions.
                if (des.bits.dig != df::tile_dig_designation::Default) {
                    des.bits.dig = df::tile_dig_designation::Default;
                    changed = true;
                }
                des_priority = priority;
            } else if (req.kind == DesignationKind::Clear) {
                if (des.bits.dig != df::tile_dig_designation::No) {
                    des.bits.dig = df::tile_dig_designation::No;
                    changed = true;
                }
                if (des.bits.smooth != 0) {
                    des.bits.smooth = 0;
                    changed = true;
                }
                touch_occ = true;
            }

            if (touch_occ) {
                df::tile_occupancy occ = map.occupancyAt(pos);
                bool want_marked = req.kind == DesignationKind::Clear ? false : req.request.marker;
                // DES_AUTOMINE_LIKE_MATERIAL: pre-existing warm_damp wiring left as-is; ORed
                // with mine_mode==Auto (1), which is this bit's actual DF meaning (see
                // mine_mode_allows_tile's comment).
                bool want_auto = req.kind == DesignationKind::Clear
                    ? false
                    : (req.request.warm_damp || req.request.mine_mode == 1);
                if (occ.bits.dig_marked != want_marked || occ.bits.dig_auto != want_auto) {
                    occ.bits.dig_marked = want_marked;
                    occ.bits.dig_auto = want_auto;
                    map.setOccupancyAt(pos, occ);
                    changed = true;
                }
                if (req.kind == DesignationKind::Clear &&
                        (occ.bits.carve_track_north || occ.bits.carve_track_south ||
                         occ.bits.carve_track_east || occ.bits.carve_track_west)) {
                    occ.bits.carve_track_north = 0;
                    occ.bits.carve_track_south = 0;
                    occ.bits.carve_track_east = 0;
                    occ.bits.carve_track_west = 0;
                    map.setOccupancyAt(pos, occ);
                    changed = true;
                }
            }

            // A valid already-designated tile still reapplies priority and is a successful request.
            if ((changed || des_priority > 0) && map.setDesignationAt(pos, des, des_priority))
                ++changed_count;
        }
    }

    req.result.count += changed_count;
    return changed_count > 0;
}

// Old-name wrapper: single-z callers (none currently outside apply_designation, but kept so any
// future/external call site compiles unchanged) get the pre-multi-z behavior of designating
// exactly req.dig at wz.
bool apply_tile_designations(RenderDesignationRequest& req, MapExtras::MapCache& map,
                             int tx1, int ty1, int tx2, int ty2, int wz) {
    return apply_tile_designations_at(req, map, tx1, ty1, tx2, ty2, wz, req.dig);
}

bool apply_plant_designations(RenderDesignationRequest& req, MapExtras::MapCache& map,
                              int wx1, int wy1, int wx2, int wy2, int wz) {
    auto world = df::global::world;
    if (!world)
        return false;

    int changed_count = 0;
    int priority = clamp_int(req.request.priority, 1, 7) * 1000;
    for (df::plant* plant : world->plants.all) {
        if (!plant)
            continue;
        bool is_tree = plant->tree_info != nullptr;
        if (req.kind == DesignationKind::Chop && !is_tree)
            continue;

        df::coord pos = DFHack::Designations::getPlantDesignationTile(plant);
        if (pos.z != wz || pos.x < wx1 || pos.x > wx2 || pos.y < wy1 || pos.y > wy2)
            continue;
        // tree_info==nullptr includes both shrubs and saplings. Native gather rectangles target
        // shrubs only; using that proxy marked saplings (which then resolved as chop/dig glyphs)
        // and made the rectangle appear to miss its real shrubs (B126). Read the live tile here:
        // touching MapCache before markPlant would snapshot the block's pre-mark designations.
        if (req.kind == DesignationKind::Gather) {
            df::tiletype* tiletype = DFHack::Maps::getTileType(pos);
            if (!tiletype || DFHack::tileShape(*tiletype) != df::tiletype_shape::SHRUB)
                continue;
        }

        bool ok = req.kind == DesignationKind::Clear
            ? DFHack::Designations::unmarkPlant(plant)
            : DFHack::Designations::markPlant(plant);
        if (!ok)
            continue;

        if (req.kind != DesignationKind::Clear) {
            // markPlant writes the live block outside MapCache. Re-read its live values so an
            // existing cached block cannot erase this plant's mark when WriteAll flushes it.
            df::tile_designation* live_des = DFHack::Maps::getTileDesignation(pos);
            df::tile_occupancy* live_occ = DFHack::Maps::getTileOccupancy(pos);
            if (!live_des || !live_occ)
                continue;
            df::tile_designation des = *live_des;
            df::tile_occupancy occ = *live_occ;
            if (occ.bits.dig_marked != req.request.marker) {
                occ.bits.dig_marked = req.request.marker;
                map.setOccupancyAt(pos, occ);
            }
            map.setDesignationAt(pos, des, priority);
        }
        ++changed_count;
    }

    req.result.count += changed_count;
    return changed_count > 0;
}

// WD-10 ENDPOINT-ADD: item designations (claim/forbid/dump/no-dump/melt/no-melt/hide/
// visible). Rect walk over items resting on the ground in the box, one z-level at a time --
// reuses the exact block->items scan tile_map_dump.cpp's emit_tile_fields already relies on
// (every pointer null-checked, so it's crash-safe against items deleted mid-scan).
//
// Melt/no-melt go through DFHack::Items::markForMelting/cancelMelting rather than hand-
// rolling the world->items.other.ANY_MELT_DESIGNATED vector sync the WD-10 spec worried
// about being fragile -- DFHack already ships that exact recipe (library/modules/Items.cpp),
// including the canMelt() eligibility check (artifacts, non-standard-material items, and
// items in unit inventories/nonempty containers correctly refuse to be marked).
//
// PENDING (not implemented here): buildings. The spec's "buildings only respond to claim/
// forbid, match RFR/dfhack gui/mass-remove semantics" lead doesn't hold up -- mass-remove.lua
// deconstructs/cancels-deconstruction, it does not touch forbid/claim -- and this df-
// structures tree has no building-level forbid bit and no `contained_items` accessor on
// df::building. A building's real "forbid" state is presumably reached through its
// constituent item(s) via a general_ref this pass doesn't resolve. Flagging as a follow-up
// rather than guessing at an unverified field path.
bool apply_item_flag_designations(RenderDesignationRequest& req, int wx1, int wy1, int wx2,
                                  int wy2, int wz) {
    const std::string& tool = req.request.tool;
    int changed_count = 0;
    const size_t kItemScanCap = 1024;

    int bx1 = wx1 >> 4, bx2 = wx2 >> 4;
    int by1 = wy1 >> 4, by2 = wy2 >> 4;
    for (int by = by1; by <= by2; ++by) {
        for (int bx = bx1; bx <= bx2; ++bx) {
            df::map_block* block = DFHack::Maps::getTileBlock(bx * 16, by * 16, wz);
            if (!block)
                continue;
            size_t scanned = 0;
            for (size_t ii = 0; ii < block->items.size() && scanned < kItemScanCap;
                    ++ii, ++scanned) {
                df::item* item = df::item::find(block->items[ii]);
                if (!item)
                    continue;
                if (item->pos.z != wz || item->pos.x < wx1 || item->pos.x > wx2 ||
                        item->pos.y < wy1 || item->pos.y > wy2)
                    continue;

                bool changed = false;
                if (tool == "claim") {
                    if (item->flags.bits.forbid) { item->flags.bits.forbid = false; changed = true; }
                } else if (tool == "forbid") {
                    if (!item->flags.bits.forbid) { item->flags.bits.forbid = true; changed = true; }
                } else if (tool == "dump") {
                    if (!item->flags.bits.dump) { item->flags.bits.dump = true; changed = true; }
                } else if (tool == "no-dump" || tool == "undump") {
                    if (item->flags.bits.dump) { item->flags.bits.dump = false; changed = true; }
                } else if (tool == "melt") {
                    changed = DFHack::Items::markForMelting(item);
                } else if (tool == "no-melt" || tool == "unmelt") {
                    changed = DFHack::Items::cancelMelting(item);
                } else if (tool == "hide") {
                    if (!item->flags.bits.hidden) { item->flags.bits.hidden = true; changed = true; }
                } else if (tool == "visible" || tool == "unhide") {
                    if (item->flags.bits.hidden) { item->flags.bits.hidden = false; changed = true; }
                }
                if (changed)
                    ++changed_count;
            }
        }
    }

    req.result.count += changed_count;
    return changed_count > 0;
}

// World/map reads AND designation writes. MUST be called with the CoreSuspender held --
// it walks map blocks (MapCache::designationAt/tiletypeAt/BlockAt), world->plants.all and
// per-block item vectors, and flushes designation/occupancy writes via MapCache::WriteAll,
// all racing the main thread's map mutation if unsuspended. It used to run VERBATIM on the
// render thread with no suspension (runOnRenderThread in designate_on_render_thread below)
// -- the same SIGSEGV-inside-Maps::getTileBlock class hud.cpp's fd56152 fixed
// (crash_2026-07-07-20-54-54.txt; both 07-04 crashlogs share the stack shape). The
// capture-viewport availability probe that used to sit at the top of this function is
// renderer state and stays on the render hop -- see designate_on_render_thread.
bool apply_designation(RenderDesignationRequest& req) {
    if (req.request.frame_w <= 0 || req.request.frame_h <= 0) {
        req.err = "viewport/frame unavailable";
        return false;
    }

    int tx1 = pixel_to_tile(std::min(req.request.px, req.request.px2), req.request.frame_w);
    int ty1 = pixel_to_tile(std::min(req.request.py, req.request.py2), req.request.frame_h);
    int tx2 = pixel_to_tile(std::max(req.request.px, req.request.px2), req.request.frame_w);
    int ty2 = pixel_to_tile(std::max(req.request.py, req.request.py2), req.request.frame_h);

    int wx1 = req.camera.x + tx1;
    int wy1 = req.camera.y + ty1;
    int wx2 = req.camera.x + tx2;
    int wy2 = req.camera.y + ty2;
    int wz = req.camera.z;

    // Record the world box so the eraser's post-render job-cancel pass knows what to clear,
    // even when the tile pass below changes nothing (the "designation became a job" case).
    req.box_x1 = wx1; req.box_y1 = wy1;
    req.box_x2 = wx2; req.box_y2 = wy2;
    req.box_z = wz;

    // Multi-z range: z_levels is relative to the camera (negative = downward). Clamped to the
    // loaded map so a big drag near the top/bottom of the world can't walk off the z-axis.
    int z_lo = std::min(wz, wz + req.request.z_levels);
    int z_hi = std::max(wz, wz + req.request.z_levels);
    auto world = df::global::world;
    if (world) {
        z_lo = std::max(0, z_lo);
        z_hi = std::min(world->map.z_count - 1, z_hi);
    }

    MapExtras::MapCache map;
    bool changed = false;
    for (int z = z_lo; z <= z_hi; ++z) {
        df::tile_dig_designation level_dig = req.dig;
        // Stair semantics across a range: top connects downward, bottom connects upward,
        // middles both -- matching what native DF builds for a stairwell.
        bool is_stair = req.dig == df::tile_dig_designation::DownStair ||
                        req.dig == df::tile_dig_designation::UpStair ||
                        req.dig == df::tile_dig_designation::UpDownStair;
        if (is_stair && z_hi > z_lo) {
            if (z == z_hi)      level_dig = df::tile_dig_designation::DownStair;
            else if (z == z_lo) level_dig = df::tile_dig_designation::UpStair;
            else                level_dig = df::tile_dig_designation::UpDownStair;
        }

        if (req.kind != DesignationKind::Chop && req.kind != DesignationKind::Gather &&
                req.kind != DesignationKind::ItemFlag)
            changed = apply_tile_designations_at(req, map, tx1, ty1, tx2, ty2, z, level_dig) || changed;

        if (req.kind == DesignationKind::Chop ||
                req.kind == DesignationKind::Gather ||
                req.kind == DesignationKind::Clear)
            changed = apply_plant_designations(req, map, wx1, wy1, wx2, wy2, z) || changed;

        if (req.kind == DesignationKind::ItemFlag)
            changed = apply_item_flag_designations(req, wx1, wy1, wx2, wy2, z) || changed;
    }

    if (changed) {
        map.WriteAll();
        return true;
    }

    req.err = "no valid tiles for that designation";
    std::ostringstream diag;
    diag << "designation had no effect: tool=" << req.request.tool
         << " box=" << wx1 << "," << wy1 << ".." << wx2 << "," << wy2
         << "," << wz << " frame=" << req.request.frame_w << "x" << req.request.frame_h;
    diagnostics_log(diag.str());
    return false;
}

} // namespace

bool designate_on_render_thread(const Camera& camera, const DesignationRequest& request,
                                DesignationResult& result, std::string* err) {
    DesignationKind kind = DesignationKind::Dig;
    df::tile_dig_designation dig = df::tile_dig_designation::Default;
    if (!kind_from_tool(request.tool, kind, dig)) {
        if (err) *err = "unsupported designation tool: " + request.tool;
        return false;
    }

    std::lock_guard<std::recursive_mutex> lock(g_designation_mutex);
    auto req = std::make_shared<RenderDesignationRequest>();
    req->camera = camera;
    req->request = request;
    req->kind = kind;
    req->dig = dig;
    req->result.tool = request.tool;
    auto future = req->done.get_future();

    // CRASH-CLASS FIX (same class as hud.cpp's fd56152; flagged there as "REMAINING
    // EXPOSURE ... owned by the B29 designation-lag investigation"): the old shape ran
    // apply_designation -- map-block reads AND designation writes -- on the RENDER thread
    // with no CoreSuspender, racing the main thread's map mutation (latent SIGSEGV inside
    // Maps::getTileBlock, crash_2026-07-07-20-54-54.txt's stack shape; also a torn-read
    // risk on the freshly-clicked tiles' designation/tiletype state). New shape: (1) a
    // render-thread hop for the ONE thing that genuinely lives there (the
    // effective_capture_viewport_dims availability probe -- gps->main_viewport renderer
    // state), then (2) apply_designation on the calling HTTP thread under CoreSuspender,
    // the same pattern every other route uses. Hop FIRST, suspend AFTER -- never wait on a
    // render hop while core-suspended (tile_dump.cpp's LAW).
    DFHack::runOnRenderThread([req]() {
        int probe_w = 0, probe_h = 0;
        req->done.set_value(
            effective_capture_viewport_dims(req->camera, probe_w, probe_h, &req->err));
    });
    bool ok = future.get();
    if (!ok) {
        if (req->err.empty())
            req->err = "viewport/frame unavailable";
    } else {
        std::lock_guard<std::recursive_mutex> cap_lock(capture_state_mutex());
        DFHack::CoreSuspender suspend;
        ok = apply_designation(*req);
    }

    // Eraser: cancel dig/smooth/engrave/chop/gather JOBS in the box -- off the render thread, under
    // CoreSuspender (main parked) so unlinking from the job list can't race DF's job manager
    // during play. Runs even when the tile pass found nothing (n==0): that is exactly the case
    // where pressing play turned the designations into jobs and cleared the tiles' dig bits, so
    // only clearing designation bits did nothing.
    if (kind == DesignationKind::Clear &&
            req->box_x2 >= req->box_x1 && req->box_y2 >= req->box_y1) {
        int canceled = 0;
        {
            std::lock_guard<std::recursive_mutex> cap_lock(capture_state_mutex());
            DFHack::CoreSuspender suspend;
            auto world = df::global::world;
            if (world) {
                std::vector<df::job*> to_cancel;
                for (auto* link = world->jobs.list.next; link; link = link->next) {
                    df::job* job = link->item;
                    if (!job)
                        continue;
                    if (job->pos.z == req->box_z &&
                            job->pos.x >= req->box_x1 && job->pos.x <= req->box_x2 &&
                            job->pos.y >= req->box_y1 && job->pos.y <= req->box_y2 &&
                            is_designation_job(job->job_type)) {
                        to_cancel.push_back(job);
                    }
                }
                for (df::job* job : to_cancel)
                    if (DFHack::Job::removeJob(job))
                        ++canceled;
            }
        }
        if (canceled > 0) {
            ok = true;
            req->result.count += canceled;
        }
    }

    result = req->result;
    if (!ok && err)
        *err = req->err;
    return ok;
}

namespace {

std::string build_options_from_request(const httplib::Request& req) {
    static const char* option_names[] = {
        "hollow", "weapon_count",
        "plate_units", "plate_water", "plate_magma", "plate_track", "plate_citizens",
        "plate_resets", "unit_min", "unit_max", "water_min", "water_max", "magma_min",
        "magma_max", "track_min", "track_max", "track_dump", "dump_x", "dump_y",
        "friction", "speed",
    };
    std::ostringstream out;
    for (auto name : option_names) {
        int value = 0;
        if (query_int(req, name, value))
            out << name << "=" << value << ";";
    }
    for (int i = 0; i < 4; ++i) {
        std::string key = "mat" + std::to_string(i);
        if (!req.has_param(key.c_str()))
            continue;
        std::string value = req.get_param_value(key.c_str());
        bool clean = value == "closest";
        if (!clean) {
            clean = !value.empty() && value.size() < 32;
            for (char c : value) {
                if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '-' || c == ':')) {
                    clean = false;
                    break;
                }
            }
        }
        if (clean)
            out << key << "=" << value << ";";
    }
    return out.str();
}

} // namespace

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_placement_routes(httplib::Server& server) {
    auto placement_mode_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "none";
        bool active = !(mode.empty() || mode == "none" || mode == "0" || mode == "off");
        Camera camera;
        std::string err;
        if (!set_player_placement_mode(player, active, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"placementMode\":" +
                            std::string(camera.placement_mode ? "true" : "false") + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/placement-mode", placement_mode_handler);
    server.Post("/placement-mode", placement_mode_handler);

    auto placement_cursor_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int hx = -1;
        int hy = -1;
        int frame_w = 0;
        int frame_h = 0;
        int drag = 0;
        int drag_x = -1;
        int drag_y = -1;
        int build_w = 0;
        int build_h = 0;
        query_int(req, "hx", hx);
        query_int(req, "hy", hy);
        query_int(req, "w", frame_w);
        query_int(req, "h", frame_h);
        query_int(req, "drag", drag);
        query_int(req, "dx", drag_x);
        query_int(req, "dy", drag_y);
        query_int(req, "bw", build_w);
        query_int(req, "bh", build_h);

        Camera camera;
        std::string err;
        if (!set_player_placement_cursor(player, hx, hy, frame_w, frame_h, drag != 0,
                                         drag_x, drag_y, build_w, build_h, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/placement-cursor", placement_cursor_handler);
    server.Post("/placement-cursor", placement_cursor_handler);

    auto designate_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        DesignationRequest desig;
        if (!query_int(req, "px", desig.px) ||
                !query_int(req, "py", desig.py) ||
                !query_int(req, "w", desig.frame_w) ||
                !query_int(req, "h", desig.frame_h)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing px/py/w/h\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        desig.px2 = desig.px;
        desig.py2 = desig.py;
        query_int(req, "px2", desig.px2);
        query_int(req, "py2", desig.py2);
        desig.tool = req.has_param("tool") ? req.get_param_value("tool") : "dig";
        int marker = 0;
        int warm_damp = 0;
        query_int(req, "priority", desig.priority);
        query_int(req, "marker", marker);
        query_int(req, "warmdamp", warm_damp);
        query_int(req, "minemode", desig.mine_mode);
        query_int(req, "zlevels", desig.z_levels);
        desig.z_levels = std::max(-50, std::min(50, desig.z_levels));
        desig.marker = marker != 0;
        desig.warm_damp = warm_damp != 0;

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        // Map the client's grid indices through the DF viewport regardless of the tile
        // window's (canvas-sized) w/h -- see normalize_frame_to_viewport.
        normalize_frame_to_viewport(camera, desig.frame_w, desig.frame_h);

        DesignationResult result;
        if (!designate_on_render_thread(camera, desig, result, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"count\":" + std::to_string(result.count) +
                            ",\"tool\":" + json_string(result.tool) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/designate", designate_handler);
    server.Post("/designate", designate_handler);

    // B233-4: TRAFFIC COST FIELDS (the four 1/2/5/25 weights native shows next to its traffic
    // paints). These are NOT a client invention and they are NOT d_init: DF keeps the LIVE,
    // per-fort pathfinding costs in
    //     df.plotinfo.xml:1064-1067  plotinfo.main.traffic_cost_{high,normal,low,restricted}
    //         (original names path_cost_high_traffic ... -- the fields DF's own traffic menu
    //          edits; d_init_dwarfst.path_cost[4] (df.d_init.xml:100) is only the NEW-FORT
    //          default those four are seeded from, so writing d_init would change nothing in a
    //          running fort).
    // Four int32 scalars in a struct DF already owns; no vector surgery, no ids, so there is no
    // half-write state to land in. Written on the HTTP thread under CoreSuspender (the same
    // shape as designate_on_render_thread's write half). Missing/blank params are left alone,
    // so a partial POST (one slider moved) writes exactly one field.
    auto traffic_costs_handler = [](const httplib::Request& req, httplib::Response& res) {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"world unavailable\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        // DF's own traffic menu takes a typed number; clamp to a sane, DF-shaped band rather
        // than trusting the wire (a 0 cost would make restricted tiles free; a negative one is
        // undefined in DF's A*). 1..10000 covers native's 1/2/5/25 defaults with headroom.
        auto clamp_cost = [](int v) { return std::max(1, std::min(10000, v)); };
        int written = 0;
        {
            DFHack::CoreSuspender suspend;
            struct { const char* param; int32_t* field; } fields[] = {
                { "high",       &plotinfo->main.traffic_cost_high },
                { "normal",     &plotinfo->main.traffic_cost_normal },
                { "low",        &plotinfo->main.traffic_cost_low },
                { "restricted", &plotinfo->main.traffic_cost_restricted },
            };
            for (const auto& f : fields) {
                int v = 0;
                if (!query_int(req, f.param, v))
                    continue;
                *f.field = clamp_cost(v);
                ++written;
            }
            std::ostringstream body;
            body << "{\"ok\":true,\"written\":" << written
                 << ",\"costs\":{\"high\":" << plotinfo->main.traffic_cost_high
                 << ",\"normal\":" << plotinfo->main.traffic_cost_normal
                 << ",\"low\":" << plotinfo->main.traffic_cost_low
                 << ",\"restricted\":" << plotinfo->main.traffic_cost_restricted
                 << "}}\n";
            res.set_header("Cache-Control", "no-store");
            res.set_content(body.str(), "application/json; charset=utf-8");
        }
        if (written)
            notify_player_input();
    };
    server.Get("/traffic-costs", traffic_costs_handler);
    server.Post("/traffic-costs", traffic_costs_handler);

    server.Get("/build-catalog", [](const httplib::Request&, httplib::Response& res) {
        std::string err;
        std::string json = building_catalog_json_via_lua(&err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("catalog failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    server.Get("/build-materials", [](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("token")) {
            res.status = 400;
            res.set_content("missing token\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = build_materials_json_via_lua(req.get_param_value("token"), &err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("materials failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    // Finished furniture is chosen after the tile click in DF's native flow. This additive,
    // read-only endpoint deliberately returns no candidates for component/filter buildings.
    server.Get("/place-candidates", [](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("token")) {
            res.status = 400;
            res.set_content("missing token\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = place_candidates_json_via_lua(req.get_param_value("token"), &err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("candidates failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    // WP-C attribution: the current world's save dir keys the AttributionRegistry so ids can
    // never alias across worlds. save_dir is a stable std::string set at world-load (the UI is
    // blocked during a load), so this read is safe from the HTTP thread at a user-driven stamp.
    auto current_save_dir = []() -> std::string {
        auto world = df::global::world;
        if (!world) return "";
        return world->cur_savegame.save_dir;
    };

    auto build_place_handler = [current_save_dir](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
                !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h) ||
                !req.has_param("token")) {
            res.status = 400;
            res.set_content("missing px/py/w/h/token\n", "text/plain; charset=utf-8");
            return;
        }
        int px2 = px, py2 = py, direction = -1, selected_item_id = -1;
        query_int(req, "px2", px2);
        query_int(req, "py2", py2);
        query_int(req, "direction", direction);
        if (req.has_param("item_id") && !query_int(req, "item_id", selected_item_id)) {
            res.status = 400;
            res.set_content("invalid item_id\n", "text/plain; charset=utf-8");
            return;
        }

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        int count = 0;
        int id = -1;
        std::vector<int32_t> ids;
        std::string options = build_options_from_request(req);
        normalize_frame_to_viewport(camera, frame_w, frame_h);
        if (!place_building_via_lua(camera, px, py, px2, py2, frame_w, frame_h,
                                    req.get_param_value("token"), direction, options, selected_item_id,
                                    count, id, &err, &ids)) {
            res.status = 400;
            res.set_content("building failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        // WP-C (WT04): stamp the creator for EVERY created building. A multi-tile placement (a row
        // of constructions, a hollow rectangle, ...) now returns all its ids, so each tile is
        // attributed -- not just the first. Falls back to the single id when the lua returns no
        // list (older DLL / a create that yielded exactly one building).
        attrib_note_world(current_save_dir());
        if (ids.empty() && id >= 0) ids.push_back(id);
        for (int32_t bid : ids)
            attrib_stamp(AttribKind::Building, bid, player);
        notify_player_input();
        // Additive JSON only: "ids" lists every stamped building id (zero binary-wire surface).
        std::string ids_json;
        for (size_t i = 0; i < ids.size(); ++i)
            ids_json += (i ? "," : "") + std::to_string(ids[i]);
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"count\":" + std::to_string(count) +
                        ",\"id\":" + std::to_string(id) +
                        ",\"ids\":[" + ids_json + "]}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/build-place", build_place_handler);
    server.Post("/build-place", build_place_handler);

    auto stockpile_create_handler = [current_save_dir](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
                !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
            res.status = 400;
            res.set_content("missing px/py/w/h\n", "text/plain; charset=utf-8");
            return;
        }
        int px2 = px, py2 = py;
        query_int(req, "px2", px2);
        query_int(req, "py2", py2);
        std::string preset = req.has_param("preset") ? req.get_param_value("preset") : "all";

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        int id = -1;
        normalize_frame_to_viewport(camera, frame_w, frame_h);
        if (!create_stockpile_via_lua(camera, px, py, px2, py2, frame_w, frame_h,
                                      preset, id, &err)) {
            res.status = 400;
            res.set_content("stockpile failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        attrib_note_world(current_save_dir());
        attrib_stamp(AttribKind::Stockpile, id, player);
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"id\":" + std::to_string(id) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/stockpile", stockpile_create_handler);
    server.Post("/stockpile", stockpile_create_handler);

    auto zone_create_handler = [current_save_dir](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "px", px) || !query_int(req, "py", py) ||
                !query_int(req, "w", frame_w) || !query_int(req, "h", frame_h)) {
            res.status = 400;
            res.set_content("missing px/py/w/h\n", "text/plain; charset=utf-8");
            return;
        }
        int px2 = px, py2 = py;
        query_int(req, "px2", px2);
        query_int(req, "py2", py2);
        // The web sends the zone kind as the short key `zone` (e.g. zone=pen); Lua create_zone maps
        // it (meeting->MeetingHall, pen->Pen, ...). The refactor read "type" here, which the web
        // never sends -> it always fell back to the default -> every zone became a Meeting Area.
        std::string zonetype = req.has_param("zone") ? req.get_param_value("zone") : "meeting";

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        int id = -1;
        normalize_frame_to_viewport(camera, frame_w, frame_h);
        if (!create_zone_via_lua(camera, px, py, px2, py2, frame_w, frame_h, zonetype, id, &err)) {
            res.status = 400;
            res.set_content("zone failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        attrib_note_world(current_save_dir());
        attrib_stamp(AttribKind::Zone, id, player);
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"id\":" + std::to_string(id) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/zone", zone_create_handler);
    server.Post("/zone", zone_create_handler);
}

} // namespace dwf
