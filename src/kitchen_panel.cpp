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

#include "kitchen_panel.h"
#include "api_response.h"
#include "fort_stock.h"
#include "interaction.h"

#include "Core.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Kitchen.h"
#include "modules/Items.h"
#include "modules/Materials.h"

#include "df/global_objects.h"
#include "df/item.h"
#include "df/item_fish_rawst.h"
#include "df/item_fishst.h"
#include "df/item_type.h"
#include "df/items_other_id.h"
#include "df/kitchen_exc_type.h"
#include "df/material.h"
#include "df/material_flags.h"
#include "df/plant_material_def.h"
#include "df/plant_material_definition_handlerst.h"
#include "df/plant_raw.h"
#include "df/plant_raw_flags.h"
#include "df/creature_raw.h"
#include "df/world.h"

#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <tuple>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_kitchen_mutex;

template <typename Fn>
bool run_kitchen_locked(Fn&& fn) {
    return run_panel_locked(g_kitchen_mutex, std::forward<Fn>(fn));
}

df::kitchen_exc_type brew_exc_type() {
    df::kitchen_exc_type type;
    type.bits.Brew = true;
    return type;
}

df::kitchen_exc_type cook_exc_type() {
    df::kitchen_exc_type type;
    type.bits.Cook = true;
    return type;
}

bool is_cookable_item_type(df::item_type t) {
    switch (t) {
        case df::item_type::MEAT:
        case df::item_type::FISH:
        case df::item_type::FISH_RAW:
        case df::item_type::EGG:
        case df::item_type::CHEESE:
        case df::item_type::PLANT:
        case df::item_type::PLANT_GROWTH:
        case df::item_type::GLOB:
            return true;
        default:
            return false;
    }
}

bool plant_brew_capable(df::plant_raw* type) {
    return type && type->flags.is_set(df::plant_raw_flags::EXTRACT_BARREL);
}

bool material_cook_capable(int16_t mat_type, int32_t mat_index) {
    DFHack::MaterialInfo info(mat_type, mat_index);
    return info.material && info.material->flags.is_set(df::material_flags::EDIBLE_COOKED);
}

df::plant_raw* plant_of_material(int16_t mat_type, int32_t mat_index) {
    DFHack::MaterialInfo info(mat_type, mat_index);
    return info.mode == DFHack::MaterialInfo::Plant ? info.plant : nullptr;
}

bool item_brew_capable(df::item_type t, int16_t mat_type, int32_t mat_index) {
    if (t != df::item_type::PLANT)
        return false;
    return plant_brew_capable(plant_of_material(mat_type, mat_index));
}

// kind: 1 = plant raw token, 2 = creature raw token (the wire_v1 item-identity shape).
bool kitchen_item_identity(df::world* world, df::item* item, int16_t mat_type, int32_t mat_index,
                           int& kind, std::string& token) {
    if (!world || !item)
        return false;
    int race = -1;
    if (auto* fish = strict_virtual_cast<df::item_fishst>(item))
        race = fish->race;
    else if (auto* fish_raw = strict_virtual_cast<df::item_fish_rawst>(item))
        race = fish_raw->race;
    if (race >= 0 && static_cast<size_t>(race) < world->raws.creatures.all.size()) {
        auto* creature = world->raws.creatures.all[race];
        if (creature && !creature->creature_id.empty()) {
            kind = 2;
            token = creature->creature_id;
            return true;
        }
    }
    DFHack::MaterialInfo material(mat_type, mat_index);
    if (material.isValid()) {
        if (material.plant && !material.plant->id.empty()) {
            kind = 1;
            token = material.plant->id;
            return true;
        }
        if (material.creature && !material.creature->creature_id.empty()) {
            kind = 2;
            token = material.creature->creature_id;
            return true;
        }
    }
    return false;
}

bool is_brew_allowed(df::plant_raw* type) {
    if (!plant_brew_capable(type))
        return false;
    return DFHack::Kitchen::findExclusion(brew_exc_type(), df::item_type::PLANT, -1,
        type->material_defs.type[df::plant_material_def::drink],
        type->material_defs.idx[df::plant_material_def::drink]) < 0;
}

ApiResult<bool> set_plant_brew_allowed(int32_t plant_id, bool allow) {
    ApiError failure;
    const bool ok = run_kitchen_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { failure = {503, "world_unavailable", "world unavailable"}; return false; }
        if (plant_id < 0 || plant_id >= static_cast<int32_t>(world->raws.plants.all.size())) {
            failure = {400, "invalid_plant", "invalid plant id"};
            return false;
        }
        auto* type = world->raws.plants.all[plant_id];
        if (!plant_brew_capable(type)) {
            failure = {400, "plant_not_brewable", "plant cannot be brewed"};
            return false;
        }
        int16_t mat_type = type->material_defs.type[df::plant_material_def::drink];
        int32_t mat_idx = type->material_defs.idx[df::plant_material_def::drink];
        if (allow)
            DFHack::Kitchen::removeExclusion(brew_exc_type(), df::item_type::PLANT, -1, mat_type, mat_idx);
        else
            DFHack::Kitchen::addExclusion(brew_exc_type(), df::item_type::PLANT, -1, mat_type, mat_idx);
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<std::string> build_kitchen_json(const std::string& player) {
    ApiError failure;
    std::ostringstream body;
    bool ok = run_kitchen_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { failure = {503, "world_unavailable", "world unavailable"}; return false; }
        body << "{\"player\":" << json_string(player) << ",\"plants\":[";
        bool first = true;
        int count = 0;
        for (auto plant : world->raws.plants.all) {
            if (!plant || plant->name.empty())
                continue;
            if (!plant->flags.is_set(df::plant_raw_flags::SEED))
                continue;
            bool seed_cook = DFHack::Kitchen::isSeedCookeryAllowed(plant->index);
            bool plant_cook = DFHack::Kitchen::isPlantCookeryAllowed(plant->index);
            bool brew_capable = plant_brew_capable(plant);
            bool brew_allowed = brew_capable && is_brew_allowed(plant);
            // cook_capable is the SEED material's EDIBLE_COOKED (a plant row's cook cell IS the
            // seed toggle); plant_cook_capable is the structural material's.
            int16_t seed_mat = plant->material_defs.type[df::plant_material_def::seed];
            int32_t seed_idx = plant->material_defs.idx[df::plant_material_def::seed];
            int16_t basic_mat = plant->material_defs.type[df::plant_material_def::basic_mat];
            int32_t basic_idx = plant->material_defs.idx[df::plant_material_def::basic_mat];
            bool cook_capable = material_cook_capable(seed_mat, seed_idx);
            bool plant_cook_capable = material_cook_capable(basic_mat, basic_idx);
            if (!first) body << ",";
            first = false;
            body << "{\"id\":" << plant->index
                 << ",\"name\":" << json_string(plant->name)
                 << ",\"seedCookAllowed\":" << (seed_cook ? "true" : "false")
                 << ",\"plantCookAllowed\":" << (plant_cook ? "true" : "false")
                 << ",\"cookCapable\":" << (cook_capable ? "true" : "false")
                 << ",\"plantCookCapable\":" << (plant_cook_capable ? "true" : "false")
                 << ",\"brewCapable\":" << (brew_capable ? "true" : "false")
                 << ",\"brewAllowed\":" << (brew_allowed ? "true" : "false")
                 << ",\"spriteRef\":{\"itemType\":\"SEEDS\""
                 << ",\"itemSubtype\":-1"
                 << ",\"materialType\":" << seed_mat
                 << ",\"materialIndex\":" << seed_idx
                 << ",\"identKind\":1"
                 << ",\"ident\":" << json_string(plant->id) << "}"
                 << "}";
            if (++count >= 400)
                break;
        }
        // The full cookable-item list: in-play stock grouped by (item_type, material).
        struct ItemAgg {
            df::item_type type = df::item_type::NONE;
            int16_t mat = -1;
            int32_t mat_index = -1;
            int32_t subtype = -1;
            int64_t count = 0;
            std::string name;
            bool cook_allowed = false;
            bool cook_capable = false;
            bool brew_capable = false;
            bool brew_allowed = false;
            int ident_kind = 0;
            std::string ident;
        };
        std::map<std::tuple<int, int, int, int, std::string>, ItemAgg> groups;
        auto& in_play = world->items.other[df::items_other_id::IN_PLAY];
        for (auto item : in_play) {
            if (!is_fort_stock_item(item, FortItemPurpose::Kitchen))
                continue;
            df::item_type t = item->getType();
            if (!is_cookable_item_type(t))
                continue;
            if (item->flags.bits.dump || item->flags.bits.garbage_collect)
                continue;
            int16_t mat = item->getMaterial();
            int32_t midx = item->getMaterialIndex();
            int32_t stack = item->getStackSize();
            if (stack <= 0)
                continue;
            int ident_kind = 0;
            std::string ident;
            kitchen_item_identity(world, item, mat, midx, ident_kind, ident);
            auto key = std::make_tuple(static_cast<int>(t), static_cast<int>(mat), midx,
                                       ident_kind, ident);
            auto it = groups.find(key);
            if (it == groups.end()) {
                ItemAgg agg;
                agg.type = t;
                agg.mat = mat;
                agg.mat_index = midx;
                agg.subtype = item->getSubtype();
                agg.name = item_display_name(item, 0, true);
                agg.cook_allowed = DFHack::Kitchen::findExclusion(cook_exc_type(), t, -1, mat, midx) < 0;
                agg.cook_capable = material_cook_capable(mat, midx);
                auto* brew_plant = plant_of_material(mat, midx);
                agg.brew_capable = item_brew_capable(t, mat, midx);
                agg.brew_allowed = agg.brew_capable && is_brew_allowed(brew_plant);
                agg.ident_kind = ident_kind;
                agg.ident = ident;
                agg.count = stack;
                groups.emplace(key, std::move(agg));
            } else {
                it->second.count += stack;
            }
        }
        body << "],\"items\":[";
        bool item_first = true;
        int item_count = 0;
        for (auto& kv : groups) {
            const ItemAgg& a = kv.second;
            if (a.count <= 0)
                continue;
            if (!item_first) body << ",";
            item_first = false;
            body << "{\"type\":" << static_cast<int>(a.type)
                 << ",\"category\":" << json_string(DFHack::enum_item_key(a.type))
                 << ",\"mat\":" << a.mat
                 << ",\"matIndex\":" << a.mat_index
                 << ",\"name\":" << json_string(a.name)
                 << ",\"count\":" << a.count
                 << ",\"cookAllowed\":" << (a.cook_allowed ? "true" : "false")
                 << ",\"cookCapable\":" << (a.cook_capable ? "true" : "false")
                 << ",\"brewCapable\":" << (a.brew_capable ? "true" : "false")
                 << ",\"brewAllowed\":" << (a.brew_allowed ? "true" : "false")
                 << ",\"spriteRef\":{\"itemType\":" << json_string(DFHack::enum_item_key(a.type))
                 << ",\"itemSubtype\":" << a.subtype
                 << ",\"materialType\":" << a.mat
                 << ",\"materialIndex\":" << a.mat_index;
            if (a.ident_kind != 0 && !a.ident.empty())
                body << ",\"identKind\":" << a.ident_kind
                     << ",\"ident\":" << json_string(a.ident);
            body << "}"
                 << "}";
            if (++item_count >= 600)
                break;
        }
        body << "],\"wireBatch\":" << json_string(kWireBatchMarker) << "}\n";
        return true;
    });
    if (!ok) return ApiResult<std::string>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<std::string>::success(body.str());
}

ApiResult<bool> set_seed_cook_allowed(int32_t plant_id, bool allow) {
    ApiError failure;
    const bool ok = run_kitchen_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { failure = {503, "world_unavailable", "world unavailable"}; return false; }
        if (plant_id < 0 || plant_id >= static_cast<int32_t>(world->raws.plants.all.size())) {
            failure = {400, "invalid_plant", "invalid plant id"};
            return false;
        }
        if (allow)
            DFHack::Kitchen::allowPlantSeedCookery(plant_id);
        else
            DFHack::Kitchen::denyPlantSeedCookery(plant_id);
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> set_item_kitchen_allowed(
        int type, int mat, int mat_index, bool allow, bool brew) {
    ApiError failure;
    const bool ok = run_kitchen_locked([&]() -> bool {
        if (type < 0) { failure = {400, "invalid_item_type", "invalid item type"}; return false; }
        df::item_type it = static_cast<df::item_type>(type);
        int16_t exc_mat = static_cast<int16_t>(mat);
        int32_t exc_idx = mat_index;
        if (brew) {
            // A brew exclusion is keyed on the plant's DRINK material def, never on the item's own
            // structural material: the wrong key stamps an exclusion nothing ever reads.
            auto* plant = plant_of_material(exc_mat, exc_idx);
            if (it != df::item_type::PLANT || !plant_brew_capable(plant)) {
                failure = {400, "item_not_brewable", "item cannot be brewed"};
                return false;
            }
            exc_mat = plant->material_defs.type[df::plant_material_def::drink];
            exc_idx = plant->material_defs.idx[df::plant_material_def::drink];
        }
        df::kitchen_exc_type exc = brew ? brew_exc_type() : cook_exc_type();
        if (allow)
            DFHack::Kitchen::removeExclusion(exc, it, -1, exc_mat, exc_idx);
        else
            DFHack::Kitchen::addExclusion(exc, it, -1, exc_mat, exc_idx);
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

} // namespace

void register_kitchen_routes(httplib::Server& server) {
    // GET /kitchen -> seed-bearing plants + the full cookable-stock item list.
    server.Get("/kitchen", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        const auto result = build_kitchen_json(player);
        if (!result.ok) { send_api_error(result, res); return; }
        set_no_store_json(res, result.value);
    });

    // POST /kitchen-toggle?on=1[&mode=cook|brew] -> allow(1)/deny(0). Address a full-list item
    // with &type=&mat=&matIndex=, or a plant with &id=.
    auto toggle_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "cook";
        int type = -1;
        if (query_int(req, "type", type)) {
            int on = 1;
            query_int(req, "on", on);
            int mat = -1, mat_index = -1;
            query_int(req, "mat", mat);
            query_int(req, "matIndex", mat_index);
            const auto result = set_item_kitchen_allowed(
                type, mat, mat_index, on != 0, mode == "brew");
            if (!result.ok) { send_api_error(result, res); return; }
            set_no_store_json(res, "{\"ok\":true}\n");
            return;
        }
        int id = -1;
        if (!query_int(req, "id", id)) { json_error(res, 400, "missing id"); return; }
        int on = 1;
        query_int(req, "on", on);
        const auto result = (mode == "brew") ? set_plant_brew_allowed(id, on != 0)
                                              : set_seed_cook_allowed(id, on != 0);
        if (!result.ok) { send_api_error(result, res); return; }
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/kitchen-toggle", toggle_handler);
    server.Post("/kitchen-toggle", toggle_handler);
}

} // namespace dwf
