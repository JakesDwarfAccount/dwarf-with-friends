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
// GET /texpos-conformance: DF's own per-raw texpos values, plus the tile-page texpos -> cell table.

#include "texpos_conformance.h"

#include <array>

#include "json_util.h"
#include "save_barrier.h"

#include "Core.h"
#include "DataDefs.h"

// Core.h pulls in <windows.h>, whose PURE macro rewrites the df enum member of the same name and
// breaks that header: this undef must stay above every df/ include.
#undef PURE

#include "df/caste_raw.h"
#include "df/creature_graphics_role.h"
#include "df/creature_handler.h"
#include "df/creature_raw.h"
#include "df/creature_raw_graphics.h"
#include "df/creature_small_texture_type.h"
#include "df/descriptor_color.h"
#include "df/descriptor_handlerst.h"
#include "df/descriptor_shape.h"
#include "df/global_objects.h"
#include "df/inorganic_raw.h"
#include "df/itemdef.h"
#include "df/itemdef_ammost.h"
#include "df/itemdef_armorst.h"
#include "df/itemdef_foodst.h"
#include "df/itemdef_glovesst.h"
#include "df/itemdef_handlerst.h"
#include "df/itemdef_helmst.h"
#include "df/itemdef_instrumentst.h"
#include "df/itemdef_pantsst.h"
#include "df/itemdef_shieldst.h"
#include "df/itemdef_shoesst.h"
#include "df/itemdef_siegeammost.h"
#include "df/itemdef_toolst.h"
#include "df/itemdef_toyst.h"
#include "df/itemdef_trapcompst.h"
#include "df/itemdef_weaponst.h"
#include "df/item_craft_graphics_infost.h"
#include "df/item_gem_graphics_infost.h"
#include "df/item_instrument_graphics_infost.h"
#include "df/item_rock_graphics_infost.h"
#include "df/item_shield_graphics_infost.h"
#include "df/item_shoes_graphics_infost.h"
#include "df/item_statue_graphics_infost.h"
#include "df/material.h"
#include "df/plant_raw.h"
#include "df/profession.h"
#include "df/pmd_tree_texture_infost.h"
#include "df/texture_handlerst.h"
#include "df/tile_pagest.h"
#include "df/world.h"

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

constexpr int kDefaultRows = 200;
constexpr int kMaxRows = 2000;
constexpr size_t kIntBudget = 250000;

std::atomic<bool> g_sweep_active{false};

constexpr int kCreatureRoles = df::enum_traits<df::creature_graphics_role>::last_item_value + 1;
constexpr int kSmallTexTypes =
    df::enum_traits<df::creature_small_texture_type>::last_item_value + 1;
constexpr int kProfessions = df::enum_traits<df::profession>::last_item_value + 1;

struct IntSink {
    std::ostringstream& body;
    size_t emitted = 0;
    explicit IntSink(std::ostringstream& b) : body(b) {}

    void one(long value) {
        body << value;
        ++emitted;
    }
    void array(const int32_t* values, size_t count) {
        body << "[";
        for (size_t i = 0; i < count; ++i) {
            if (i) body << ",";
            one(values[i]);
        }
        body << "]";
    }
    void array(const long* values, size_t count) {
        body << "[";
        for (size_t i = 0; i < count; ++i) {
            if (i) body << ",";
            one(values[i]);
        }
        body << "]";
    }
    template <typename T, size_t N>
    void array(const std::array<T, N>& values, size_t count) {
        array(values.data(), count);
    }
    void vec(const std::vector<int32_t>& values) {
        array(values.empty() ? nullptr : values.data(), values.size());
    }
    void vec(const std::vector<long>& values) {
        array(values.empty() ? nullptr : values.data(), values.size());
    }
};

struct Window {
    int offset = 0;
    int max = kDefaultRows;
    int total = 0;
    int returned = 0;
    // Rows consumed from the window, null-pointer skips included; nextOffset advances by this and
    // not by `returned`, or the next page re-serves rows the caller already had.
    int consumed = 0;
    bool budget_stop = false;
};

bool in_window(const Window& w, int index) {
    return index >= w.offset && index < w.offset + w.max;
}

// ---------------- pages -- one row per loaded tile page, texpos vector in row-major cell order
void emit_pages(std::ostringstream& body, IntSink& ints, Window& w) {
    auto* handler = df::global::texture;
    if (!handler) return;
    w.total = static_cast<int>(handler->page.size());
    bool first = true;
    for (int i = 0; i < w.total; ++i) {
        if (!in_window(w, i)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; break; }
        df::tile_pagest* page = handler->page[i];
        if (!page) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << i << ",\"token\":" << json_string(page->token)
             << ",\"file\":" << json_string(page->filename.generic_string())
             << ",\"dir\":" << json_string(page->graphics_dir.generic_string())
             << ",\"tileW\":" << page->tile_dim_x << ",\"tileH\":" << page->tile_dim_y
             << ",\"pageW\":" << page->page_dim_x << ",\"pageH\":" << page->page_dim_y
             << ",\"loaded\":" << (page->loaded ? "true" : "false") << ",\"texpos\":";
        ints.vec(page->texpos);
        body << ",\"texposGs\":";
        ints.vec(page->texpos_gs);
        body << "}";
        ++w.returned;
    }
}

// ---------------- creature -- per-race texpos arrays, flattened in declaration order
void emit_creatures(std::ostringstream& body, IntSink& ints, Window& w) {
    auto& all = df::global::world->raws.creatures.all;
    w.total = static_cast<int>(all.size());
    bool first = true;
    for (int i = 0; i < w.total; ++i) {
        if (!in_window(w, i)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; break; }
        df::creature_raw* cr = all[i];
        if (!cr) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << i << ",\"id\":" << json_string(cr->creature_id);
        body << ",\"castes\":[";
        for (size_t c = 0; c < cr->caste.size(); ++c) {
            if (c) body << ",";
            body << json_string(cr->caste[c] ? cr->caste[c]->caste_id : std::string());
        }
        body << "]";
        body << ",\"statue\":";
        ints.array(cr->statue_texpos, 2);
        df::creature_raw_graphics* g = cr->graphics;
        if (!g) {
            body << ",\"graphics\":null}";
            ++w.returned;
            continue;
        }
        body << ",\"tex\":";
        ints.array(&g->creature_texture_texpos[0][0][0][0],
                   static_cast<size_t>(2) * kCreatureRoles * 3 * 2);
        body << ",\"sheetIcon\":";
        ints.array(&g->creature_texture_sheet_icon_texpos[0][0],
                   static_cast<size_t>(2) * kCreatureRoles);
        body << ",\"small\":";
        ints.array(g->creature_small_texpos, kSmallTexTypes);
        body << ",\"egg\":";
        ints.one(g->egg_texpos);
        body << ",\"listIcon\":";
        ints.one(g->list_icon_texpos);
        body << ",\"skeleton\":";
        ints.one(g->skeleton_texpos);
        body << ",\"skeletonSkull\":";
        ints.one(g->skeleton_with_skull_texpos);
        body << ",\"glow\":[";
        ints.one(g->texpos_glow);
        body << ",";
        ints.one(g->texpos_glow_left_gone);
        body << ",";
        ints.one(g->texpos_glow_right_gone);
        body << ",";
        ints.one(g->texpos_glow_child);
        body << "]";
        body << ",\"layerSets\":" << g->graphics_layer_set.size();
        body << "}";
        ++w.returned;
    }
}

// ---------------- plant -- `plant_raw::texpos` rows; joining the per-species `tree` object to the
// client's tree map is recorded as blocked (DEF-005).
void emit_plants(std::ostringstream& body, IntSink& ints, Window& w, bool with_tree) {
    auto& all = df::global::world->raws.plants.all;
    w.total = static_cast<int>(all.size());
    bool first = true;
    for (int i = 0; i < w.total; ++i) {
        if (!in_window(w, i)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; break; }
        df::plant_raw* p = all[i];
        if (!p) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << i << ",\"id\":" << json_string(p->id);
        if (!with_tree) {
            body << ",\"texpos\":";
            ints.array(p->texpos, 18);
            body << ",\"hasTree\":" << (p->tree_texture_info ? "true" : "false") << "}";
            ++w.returned;
            continue;
        }
        df::pmd_tree_texture_infost* t = p->tree_texture_info;
        if (!t) {
            body << ",\"tree\":null}";
            ++w.returned;
            continue;
        }
        body << ",\"tree\":{\"wood\":";
        ints.array(t->texpos_tree_wood_tile, 216);
        body << ",\"twigsFull\":";
        ints.array(t->texpos_tree_twigs_full, 12);
        body << ",\"twigs\":";
        ints.array(t->texpos_tree_twigs, 16);
        body << ",\"overleaves\":";
        ints.array(t->texpos_overleaves, 15);
        body << ",\"heavyBranch\":";
        ints.array(t->texpos_tree_overleaves_heavy_branch, 15);
        body << ",\"capPillar\":";
        ints.one(t->texpos_tree_cap_pillar);
        body << ",\"capWallThick\":";
        ints.array(t->texpos_tree_cap_wall_thick, 8);
        body << ",\"capWall\":";
        ints.array(t->texpos_tree_cap_wall, 15);
        body << ",\"capThickInterior\":";
        ints.one(t->texpos_tree_cap_thick_interior);
        body << ",\"capFloor\":";
        ints.array(t->texpos_tree_cap_floor, 4);
        body << ",\"capRamp\":";
        ints.array(t->texpos_tree_cap_ramp, 16);
        body << ",\"twigsAutumn\":";
        ints.array(&t->texpos_tree_twigs_autumn[0][0], 28 * 3);
        body << ",\"overleavesTrunkAutumn\":";
        ints.array(&t->texpos_overleaves_trunk_autumn[0][0], 15 * 3);
        body << ",\"overleavesHeavyBranchAutumn\":";
        ints.array(&t->texpos_overleaves_heavy_branch_autumn[0][0], 15 * 3);
        body << ",\"coreTrunk\":";
        ints.array(&t->texpos_tree_core_trunk[0][0], 3 * 3);
        body << ",\"coreShadow\":";
        ints.array(&t->texpos_tree_core_shadow[0][0], 3 * 3);
        body << "}}";
        ++w.returned;
    }
}

// ---------------- itemdef -- every subtype definition, keyed by raw token; JSON field names
// mirror the df-structures member names one-for-one.
void emit_itemdef_common(std::ostringstream& body, IntSink& ints, df::itemdef* def, int index,
                         const char* family) {
    body << "{\"i\":" << index << ",\"fam\":\"" << family << "\""
         << ",\"id\":" << json_string(def->id) << ",\"subtype\":" << def->subtype
         << ",\"statue\":[";
    ints.one(def->statue_texpos_top);
    body << ",";
    ints.one(def->statue_texpos_bottom);
    body << "]";
}

struct ItemdefSlot {
    const char* name;
    size_t count;
};

void emit_itemdefs(std::ostringstream& body, IntSink& ints, Window& w) {
    auto& d = df::global::world->raws.itemdefs;
    const ItemdefSlot slots[] = {
        {"weapon", d.weapons.size()},   {"trapcomp", d.trapcomps.size()},
        {"toy", d.toys.size()},         {"tool", d.tools.size()},
        {"instrument", d.instruments.size()}, {"armor", d.armor.size()},
        {"ammo", d.ammo.size()},        {"siegeammo", d.siege_ammo.size()},
        {"gloves", d.gloves.size()},    {"shoes", d.shoes.size()},
        {"shield", d.shields.size()},   {"helm", d.helms.size()},
        {"pants", d.pants.size()},      {"food", d.food.size()},
    };
    const size_t slot_count = sizeof(slots) / sizeof(slots[0]);
    for (size_t s = 0; s < slot_count; ++s) w.total += static_cast<int>(slots[s].count);

    int index = 0;
    bool first = true;
    auto want = [&]() -> bool {
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; return false; }
        return true;
    };
    auto open = [&](df::itemdef* def, const char* fam) {
        if (!first) body << ",";
        first = false;
        emit_itemdef_common(body, ints, def, index, fam);
    };

#define DWF_ITEMDEF_ROW(vec, fam, extra)                                                           \
    for (size_t k = 0; k < (vec).size(); ++k, ++index) {                                           \
        if (!in_window(w, index)) continue;                                                        \
        ++w.consumed;                                                                              \
        if (!want()) break;                                                                        \
        auto* def = (vec)[k];                                                                      \
        if (!def) continue;                                                                        \
        open(def, fam);                                                                            \
        extra;                                                                                     \
        body << "}";                                                                               \
        ++w.returned;                                                                              \
    }

    DWF_ITEMDEF_ROW(d.weapons, "weapon", {
        body << ",\"itemMaterial\":"; ints.one(def->texpos_item_material);
        body << ",\"itemWoodGrown\":"; ints.one(def->texpos_item_wood_grown);
        body << ",\"itemWood\":"; ints.one(def->texpos_item_wood);
        body << ",\"itemStone\":"; ints.one(def->texpos_item_stone);
        body << ",\"itemArtifact\":"; ints.one(def->texpos_item_artifact);
        body << ",\"itemSpecialMat\":"; ints.one(def->texpos_item_special_mat);
        body << ",\"itemDefault\":"; ints.one(def->texpos_item_default);
        body << ",\"weaponTrap\":"; ints.one(def->texpos_weapon_trap);
        body << ",\"upright\":"; ints.array(&def->texpos_upright[0][0], 10 * 2);
    })
    DWF_ITEMDEF_ROW(d.trapcomps, "trapcomp", {
        body << ",\"item\":"; ints.one(def->texpos_item);
        body << ",\"weaponTrap\":"; ints.one(def->texpos_weapon_trap);
        body << ",\"upright\":"; ints.array(&def->texpos_upright[0][0], 10 * 2);
    })
    DWF_ITEMDEF_ROW(d.toys, "toy", {
        body << ",\"item\":"; ints.one(def->texpos_item);
    })
    DWF_ITEMDEF_ROW(d.tools, "tool", {
        body << ",\"item\":"; ints.one(def->texpos_item);
        body << ",\"wood\":"; ints.array(def->texpos_wood, 7);
        body << ",\"stone\":"; ints.array(def->texpos_stone, 7);
        body << ",\"metal\":"; ints.array(def->texpos_metal, 7);
        body << ",\"glass\":"; ints.array(def->texpos_glass, 7);
        body << ",\"woodVariant\":"; ints.array(def->texpos_wood_variant, 4);
        body << ",\"stoneVariant\":"; ints.array(def->texpos_stone_variant, 4);
        body << ",\"metalVariant\":"; ints.array(def->texpos_metal_variant, 4);
        body << ",\"glassVariant\":"; ints.array(def->texpos_glass_variant, 4);
    })
    DWF_ITEMDEF_ROW(d.instruments, "instrument", {
        body << ",\"noOwnTexpos\":true";
    })
    DWF_ITEMDEF_ROW(d.armor, "armor", {
        body << ",\"item\":"; ints.one(def->texpos_item);
    })
    DWF_ITEMDEF_ROW(d.ammo, "ammo", {
        body << ",\"defaultDir\":[";
        ints.one(def->texpos_default_n); body << ",";
        ints.one(def->texpos_default_s); body << ",";
        ints.one(def->texpos_default_w); body << ",";
        ints.one(def->texpos_default_e); body << ",";
        ints.one(def->texpos_default_nw); body << ",";
        ints.one(def->texpos_default_ne); body << ",";
        ints.one(def->texpos_default_sw); body << ",";
        ints.one(def->texpos_default_se); body << "]";
        body << ",\"woodDir\":[";
        ints.one(def->texpos_wood_n); body << ",";
        ints.one(def->texpos_wood_s); body << ",";
        ints.one(def->texpos_wood_w); body << ",";
        ints.one(def->texpos_wood_e); body << ",";
        ints.one(def->texpos_wood_nw); body << ",";
        ints.one(def->texpos_wood_ne); body << ",";
        ints.one(def->texpos_wood_sw); body << ",";
        ints.one(def->texpos_wood_se); body << "]";
    })
    DWF_ITEMDEF_ROW(d.siege_ammo, "siegeammo", {
        body << ",\"defaultDir\":[";
        ints.one(def->texpos_default_n); body << ",";
        ints.one(def->texpos_default_s); body << ",";
        ints.one(def->texpos_default_w); body << ",";
        ints.one(def->texpos_default_e); body << ",";
        ints.one(def->texpos_default_nw); body << ",";
        ints.one(def->texpos_default_ne); body << ",";
        ints.one(def->texpos_default_sw); body << ",";
        ints.one(def->texpos_default_se); body << "]";
    })
    DWF_ITEMDEF_ROW(d.gloves, "gloves", {
        body << ",\"item\":"; ints.one(def->texpos_item);
    })
    DWF_ITEMDEF_ROW(d.shoes, "shoes", {
        body << ",\"item\":"; ints.one(def->texpos_item);
        body << ",\"itemMetal\":"; ints.one(def->texpos_item_metal);
    })
    DWF_ITEMDEF_ROW(d.shields, "shield", {
        body << ",\"item\":"; ints.one(def->texpos_item);
        body << ",\"itemWooden\":"; ints.one(def->texpos_item_wooden);
    })
    DWF_ITEMDEF_ROW(d.helms, "helm", {
        body << ",\"item\":"; ints.one(def->texpos_item);
    })
    DWF_ITEMDEF_ROW(d.pants, "pants", {
        body << ",\"item\":"; ints.one(def->texpos_item);
    })
    DWF_ITEMDEF_ROW(d.food, "food", {
        body << ",\"item\":"; ints.one(def->texpos_item);
        body << ",\"containerTop\":"; ints.one(def->texpos_food_container_top);
    })
#undef DWF_ITEMDEF_ROW
}

// ---------------- descriptor -- cut-gem cells on `descriptor_shape`, plus the color swatches
void emit_descriptors(std::ostringstream& body, IntSink& ints, Window& w) {
    auto& d = df::global::world->raws.descriptors;
    w.total = static_cast<int>(d.shapes.size() + d.colors.size());
    int index = 0;
    bool first = true;
    for (size_t k = 0; k < d.shapes.size(); ++k, ++index) {
        if (!in_window(w, index)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; return; }
        df::descriptor_shape* s = d.shapes[k];
        if (!s) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << index << ",\"fam\":\"shape\",\"id\":" << json_string(s->id)
             << ",\"largeGem\":";
        ints.one(s->texpos_large_gem);
        body << ",\"smallGemElement\":";
        ints.one(s->texpos_small_gem_element);
        body << ",\"smallGemVariant\":";
        ints.array(s->texpos_small_gem_variant, 4);
        body << "}";
        ++w.returned;
    }
    for (size_t k = 0; k < d.colors.size(); ++k, ++index) {
        if (!in_window(w, index)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; return; }
        df::descriptor_color* c = d.colors[k];
        if (!c) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << index << ",\"fam\":\"color\",\"id\":" << json_string(c->id)
             << ",\"swatch\":";
        ints.one(c->texpos_swatch);
        body << "}";
        ++w.returned;
    }
}

// ---------------- material -- inorganic boulder/rough/bar/cheese cells only
void emit_materials(std::ostringstream& body, IntSink& ints, Window& w) {
    auto& all = df::global::world->raws.inorganics.all;
    w.total = static_cast<int>(all.size());
    bool first = true;
    for (int i = 0; i < w.total; ++i) {
        if (!in_window(w, i)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; break; }
        df::inorganic_raw* m = all[i];
        if (!m) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << i << ",\"fam\":\"inorganic\",\"id\":" << json_string(m->id)
             << ",\"wood\":";
        ints.one(m->material.wood_texpos);
        body << ",\"boulder\":[";
        ints.one(m->material.boulder_texpos1);
        body << ",";
        ints.one(m->material.boulder_texpos2);
        body << "],\"rough\":[";
        ints.one(m->material.rough_texpos1);
        body << ",";
        ints.one(m->material.rough_texpos2);
        body << "],\"bar\":";
        ints.one(m->material.bar_texpos);
        body << ",\"cheese\":[";
        ints.one(m->material.cheese_texpos1);
        body << ",";
        ints.one(m->material.cheese_texpos2);
        body << "]}";
        ++w.returned;
    }
}

// ---------------- gi:* -- demand-cached {flags, texpos} memo tables
// `flags` is emitted as a decimal STRING: the wider bitfields are int64 and JSON's double truncates.
template <typename T, typename Emit>
void emit_gi(std::ostringstream& body, IntSink& ints, Window& w, const std::vector<T*>& vec,
             const char* name, Emit&& emit_texpos) {
    w.total = static_cast<int>(vec.size());
    bool first = true;
    for (int i = 0; i < w.total; ++i) {
        if (!in_window(w, i)) continue;
        ++w.consumed;
        if (ints.emitted >= kIntBudget) { w.budget_stop = true; break; }
        T* e = vec[i];
        if (!e) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"i\":" << i << ",\"fam\":\"" << name << "\",\"flags\":\""
             << static_cast<long long>(e->flags.whole) << "\"";
        emit_texpos(e);
        body << "}";
        ++w.returned;
    }
}

template <typename Def, typename Emit>
void emit_gi_owned(std::ostringstream& body, IntSink& ints, Window& w,
                   const std::vector<Def*>& defs, const char* name, Emit&& emit_texpos) {
    for (Def* def : defs)
        if (def) w.total += static_cast<int>(def->graphics_info.size());
    int index = 0;
    bool first = true;
    for (Def* def : defs) {
        if (!def) continue;
        for (size_t k = 0; k < def->graphics_info.size(); ++k, ++index) {
            if (!in_window(w, index)) continue;
            ++w.consumed;
            if (ints.emitted >= kIntBudget) { w.budget_stop = true; return; }
            auto* e = def->graphics_info[k];
            if (!e) continue;
            if (!first) body << ",";
            first = false;
            body << "{\"i\":" << index << ",\"fam\":\"" << name << "\",\"owner\":"
                 << json_string(def->id) << ",\"oi\":" << k << ",\"flags\":\""
                 << static_cast<long long>(e->flags.whole) << "\"";
            emit_texpos(e);
            body << "}";
            ++w.returned;
        }
    }
}

bool emit_gi_family(std::ostringstream& body, IntSink& ints, Window& w, const std::string& sub) {
    auto& d = df::global::world->raws.itemdefs;
    if (sub == "gem") {
        emit_gi(body, ints, w, d.gem_graphics_info, "gem", [&](df::item_gem_graphics_infost* e) {
            body << ",\"texpos\":";
            ints.one(e->texpos);
        });
        return true;
    }
    if (sub == "instrument") {
        emit_gi(body, ints, w, d.instrument_graphics_info, "instrument",
                [&](df::item_instrument_graphics_infost* e) {
                    body << ",\"texpos\":";
                    ints.one(e->texpos);
                });
        return true;
    }
    if (sub == "rock") {
        emit_gi(body, ints, w, d.rock_graphics_info, "rock", [&](df::item_rock_graphics_infost* e) {
            body << ",\"texpos\":";
            ints.one(static_cast<long>(e->texpos));
        });
        return true;
    }
    if (sub == "statue") {
        emit_gi(body, ints, w, d.statue_graphics_info, "statue",
                [&](df::item_statue_graphics_infost* e) {
                    body << ",\"texposTop\":";
                    ints.one(e->texpos_top);
                    body << ",\"texposBottom\":";
                    ints.one(e->texpos_bottom);
                });
        return true;
    }
    // shield/shoes memo vectors hang off each itemdef, so `i` is only a concatenation index: rows
    // carry `owner` + `oi`, and joining on `i` alone matches the wrong subtype.
    if (sub == "shield") {
        emit_gi_owned(body, ints, w, d.shields, "shield",
                      [&](df::item_shield_graphics_infost* e) {
                          body << ",\"texpos\":";
                          ints.one(e->texpos);
                          body << ",\"texposWooden\":";
                          ints.one(e->texpos_wooden);
                      });
        return true;
    }
    if (sub == "shoes") {
        emit_gi_owned(body, ints, w, d.shoes, "shoes", [&](df::item_shoes_graphics_infost* e) {
            body << ",\"texpos\":";
            ints.one(e->texpos);
            body << ",\"texposMetal\":";
            ints.one(e->texpos_metal);
        });
        return true;
    }
    struct CraftSlot {
        const char* name;
        std::vector<df::item_craft_graphics_infost*>* vec;
    };
    const CraftSlot crafts[] = {
        {"figurine", &d.figurine_graphics_info}, {"amulet", &d.amulet_graphics_info},
        {"scepter", &d.scepter_graphics_info},   {"crown", &d.crown_graphics_info},
        {"ring", &d.ring_graphics_info},         {"bracelet", &d.bracelet_graphics_info},
        {"earring", &d.earring_graphics_info},
    };
    for (const CraftSlot& slot : crafts) {
        if (sub != slot.name) continue;
        emit_gi(body, ints, w, *slot.vec, slot.name, [&](df::item_craft_graphics_infost* e) {
            body << ",\"texpos\":";
            ints.one(e->texpos);
        });
        return true;
    }
    return false;
}

// ---------------- index -- the catalog: per-family row counts and the declared omissions
template <typename Def>
size_t owned_gi_rows(const std::vector<Def*>& defs) {
    size_t n = 0;
    for (Def* def : defs)
        if (def) n += def->graphics_info.size();
    return n;
}

std::string index_payload() {
    auto* world = df::global::world;
    auto& d = world->raws.itemdefs;
    auto* handler = df::global::texture;
    std::ostringstream body;
    body << "{\"ok\":true,\"wire\":1,\"family\":\"index\"";
    body << ",\"evidence\":{\"rawStamped\":\"static, complete at world load; may carry a "
            "completeness claim\",\"demandCached\":\"populated only as DF draws; correctness "
            "claim only, never completeness\"}";
    body << ",\"families\":{";
    body << "\"pages\":{\"class\":\"bridge\",\"rows\":"
         << (handler ? handler->page.size() : 0) << "}";
    body << ",\"creature\":{\"class\":\"rawStamped\",\"rows\":" << world->raws.creatures.all.size()
         << "}";
    body << ",\"plant\":{\"class\":\"rawStamped\",\"rows\":" << world->raws.plants.all.size() << "}";
    body << ",\"tree\":{\"class\":\"rawStamped\",\"rows\":" << world->raws.plants.all.size() << "}";
    body << ",\"itemdef\":{\"class\":\"rawStamped\",\"rows\":"
         << (d.weapons.size() + d.trapcomps.size() + d.toys.size() + d.tools.size() +
             d.instruments.size() + d.armor.size() + d.ammo.size() + d.siege_ammo.size() +
             d.gloves.size() + d.shoes.size() + d.shields.size() + d.helms.size() + d.pants.size() +
             d.food.size())
         << "}";
    body << ",\"descriptor\":{\"class\":\"rawStamped\",\"rows\":"
         << (world->raws.descriptors.shapes.size() + world->raws.descriptors.colors.size()) << "}";
    body << ",\"material\":{\"class\":\"rawStamped\",\"rows\":" << world->raws.inorganics.all.size()
         << "}";
    const struct {
        const char* name;
        size_t rows;
    } gi[] = {
        {"gi:gem", d.gem_graphics_info.size()},
        {"gi:instrument", d.instrument_graphics_info.size()},
        {"gi:rock", d.rock_graphics_info.size()},
        {"gi:statue", d.statue_graphics_info.size()},
        {"gi:shield", owned_gi_rows(d.shields)},
        {"gi:shoes", owned_gi_rows(d.shoes)},
        {"gi:figurine", d.figurine_graphics_info.size()},
        {"gi:amulet", d.amulet_graphics_info.size()},
        {"gi:scepter", d.scepter_graphics_info.size()},
        {"gi:crown", d.crown_graphics_info.size()},
        {"gi:ring", d.ring_graphics_info.size()},
        {"gi:bracelet", d.bracelet_graphics_info.size()},
        {"gi:earring", d.earring_graphics_info.size()},
    };
    for (const auto& entry : gi)
        body << ",\"" << entry.name << "\":{\"class\":\"demandCached\",\"rows\":" << entry.rows
             << "}";
    body << "}";
    body << ",\"omitted\":["
         << "{\"field\":\"creature_raw_graphics::profession_texpos\",\"perCreature\":"
         << (2 * kCreatureRoles * kProfessions * 3 * 2)
         << ",\"why\":\"the browser models no per-profession creature art; dumping it would grow "
            "the payload ~100x to grade nothing\"}"
         << ",{\"field\":\"creature_raw_graphics::entity_link_texpos\",\"perCreature\":null,"
            "\"why\":\"same: no client model\"}"
         << ",{\"field\":\"creature_raw_graphics::site_link_texpos\",\"perCreature\":null,"
            "\"why\":\"same: no client model\"}"
         << ",{\"field\":\"creature_raw_graphics::layer_unitless_texpos\",\"perCreature\":null,"
            "\"why\":\"per-profession layered art; no client model\"}"
         << ",{\"field\":\"itemdef_instrumentst\",\"perCreature\":null,\"why\":\"declares no "
            "texpos member at all; instrument art resolves only through the demand-cached "
            "gi:instrument memo table\"}"
         << "]";
    body << ",\"budgets\":{\"maxRows\":" << kMaxRows << ",\"intBudget\":" << kIntBudget << "}";
    body << "}\n";
    return body.str();
}

} // namespace

void register_texpos_conformance_routes(httplib::Server& server) {
    server.Get("/texpos-conformance", [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");

        // Single-flight: a second concurrent sweep doubles the suspension pressure on DF's sim
        // thread for no new data.
        bool expected = false;
        if (!g_sweep_active.compare_exchange_strong(expected, true)) {
            res.status = 409;
            res.set_content("{\"ok\":false,\"err\":\"a texpos sweep is already running\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        struct ActiveGuard { ~ActiveGuard() { g_sweep_active.store(false); } } active_guard;

        const std::string family =
            req.has_param("family") ? req.get_param_value("family") : std::string("index");
        Window w;
        if (req.has_param("offset")) query_int(req, "offset", w.offset);
        if (req.has_param("max")) query_int(req, "max", w.max);
        if (w.offset < 0) w.offset = 0;
        if (w.max < 1) w.max = 1;
        if (w.max > kMaxRows) w.max = kMaxRows;

        std::ostringstream body;
        std::string err;
        bool ok = true;
        {
            DFHack::CoreSuspender suspend;
            // A request can clear the pre-route gate and only then queue for the core, so the save
            // barrier is re-checked here: touching a world pointer mid-save corrupts the save.
            if (save_barrier_active()) {
                ok = false;
                err = "Dwarf Fortress is saving";
            } else if (!df::global::world) {
                ok = false;
                err = "no world loaded";
            } else if (family == "index") {
                res.set_content(index_payload(), "application/json; charset=utf-8");
                return;
            } else {
                std::ostringstream rows;
                IntSink row_ints(rows);
                bool known = true;
                if (family == "pages") emit_pages(rows, row_ints, w);
                else if (family == "creature") emit_creatures(rows, row_ints, w);
                else if (family == "plant") emit_plants(rows, row_ints, w, false);
                else if (family == "tree") emit_plants(rows, row_ints, w, true);
                else if (family == "itemdef") emit_itemdefs(rows, row_ints, w);
                else if (family == "descriptor") emit_descriptors(rows, row_ints, w);
                else if (family == "material") emit_materials(rows, row_ints, w);
                else if (family.rfind("gi:", 0) == 0)
                    known = emit_gi_family(rows, row_ints, w, family.substr(3));
                else known = false;

                if (!known) {
                    ok = false;
                    err = "unknown family";
                } else {
                    const int next = w.offset + w.consumed;
                    body << "{\"ok\":true,\"wire\":1,\"family\":" << json_string(family)
                         << ",\"offset\":" << w.offset << ",\"max\":" << w.max
                         << ",\"returned\":" << w.returned << ",\"total\":" << w.total
                         << ",\"ints\":" << row_ints.emitted
                         << ",\"budgetStop\":" << (w.budget_stop ? "true" : "false")
                         << ",\"nextOffset\":";
                    if (next < w.total) body << next;
                    else body << "null";
                    body << ",\"rows\":[" << rows.str() << "]}\n";
                }
            }
        }

        if (!ok) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"err\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content(body.str(), "application/json; charset=utf-8");
    });
}

} // namespace dwf
