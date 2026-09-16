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

#include "standing_orders.h"

#include "Core.h"
#include "http_server.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/global_objects.h"
#include "df/building_type.h"
#include "df/furnace_type.h"
#include "df/labor_infost.h"
#include "df/plotinfost.h"
#include "df/reaction.h"
#include "df/reaction_flags.h"
#include "df/unit.h"
#include "df/unit_labor.h"
#include "df/workshop_type.h"
#include "df/world.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_standing_orders_mutex;

template <typename Fn>
bool run_standing_orders_locked(Fn&& fn) {
    return run_panel_locked(g_standing_orders_mutex, std::forward<Fn>(fn));
}

// The table holds uint8_t** -- the address of DFHack's own pointer variable. *addr is null when
// this DF build does not expose the toggle; **addr is the live value.
enum class StandingOrderCapability : uint8_t {
    Always,
    AutomaticKitchen,
    AutomaticTannery,
    AutomaticKiln,
    AutomaticSmelter,
    AutomaticOther,
};

struct StandingOrderDef {
    const char* key;
    uint8_t** addr;
    const char* group_id;
    uint8_t state_count;
    std::array<const char*, 4> states;
    StandingOrderCapability capability = StandingOrderCapability::Always;
};

struct WorkshopCapabilities {
    bool kitchen = false;
    bool tannery = false;
    bool kiln = false;
    bool smelter = false;
    bool other = false;
};

WorkshopCapabilities workshop_capabilities() {
    WorkshopCapabilities result;
    auto world = df::global::world;
    if (!world)
        return result;
    for (auto* reaction : world->raws.reactions.reactions) {
        if (!reaction || !reaction->flags.is_set(df::reaction_flags::AUTOMATIC))
            continue;
        const size_t count = std::min(reaction->building.type.size(), reaction->building.subtype.size());
        for (size_t i = 0; i < count; ++i) {
            const auto type = reaction->building.type[i];
            const int32_t subtype = reaction->building.subtype[i];
            if (type == df::building_type::Workshop) {
                result.kitchen |= subtype == static_cast<int32_t>(df::workshop_type::Kitchen);
                result.tannery |= subtype == static_cast<int32_t>(df::workshop_type::Tanners);
                result.other |= subtype == static_cast<int32_t>(df::workshop_type::Custom);
            } else if (type == df::building_type::Furnace) {
                result.kiln |= subtype == static_cast<int32_t>(df::furnace_type::Kiln);
                result.smelter |= subtype == static_cast<int32_t>(df::furnace_type::Smelter);
                result.other |= subtype == static_cast<int32_t>(df::furnace_type::Custom);
            }
        }
    }
    return result;
}

bool order_available(const StandingOrderDef& def, const WorkshopCapabilities& capabilities) {
    switch (def.capability) {
    case StandingOrderCapability::AutomaticKitchen: return capabilities.kitchen;
    case StandingOrderCapability::AutomaticTannery: return capabilities.tannery;
    case StandingOrderCapability::AutomaticKiln: return capabilities.kiln;
    case StandingOrderCapability::AutomaticSmelter: return capabilities.smelter;
    case StandingOrderCapability::AutomaticOther: return capabilities.other;
    default: return true;
    }
}

struct StandingOrderGroup {
    const char* id;
    const char* label;
};

// DF's real 7 Standing Orders tabs, in on-screen order (df::standing_orders_category_type,
// 16b-labor-standing-orders.png: Workshops/Hauling/Refuse/Forbidding/Petitions/Chores/Other).
const std::vector<StandingOrderGroup>& groups() {
    static const std::vector<StandingOrderGroup> value = {
        {"workshops", "Workshops"},
        {"hauling", "Hauling"},
        {"refuse", "Refuse"},
        {"forbidding", "Forbidding"},
        {"petitions", "Petitions"},
        {"chores", "Chores"},
        {"other", "Other"},
    };
    return value;
}

const std::vector<StandingOrderDef>& order_defs() {
    using C = StandingOrderCapability;
    static const std::vector<StandingOrderDef> value = {
        // Workshops
        {"auto_loom", &df::global::standing_orders_auto_loom, "workshops", 3,
            {"No automatic weaving", "Automatically weave dyed thread", "Automatically weave all thread"}},
        {"use_dyed_cloth", &df::global::standing_orders_use_dyed_cloth, "workshops", 2,
            {"Use any cloth", "Use only dyed cloth"}},
        {"auto_collect_webs", &df::global::standing_orders_auto_collect_webs, "workshops", 2,
            {"No automatic web collection", "Automatically collect webs"}},
        {"auto_slaughter", &df::global::standing_orders_auto_slaughter, "workshops", 2,
            {"No automatic slaughter", "Slaughter any marked animal"}},
        {"auto_butcher", &df::global::standing_orders_auto_butcher, "workshops", 2,
            {"No automatic butchery", "Automatically butcher carcasses"}},
        {"auto_fishery", &df::global::standing_orders_auto_fishery, "workshops", 2,
            {"No automatic fish cleaning", "Automatically clean fish"}},
        {"auto_kitchen", &df::global::standing_orders_auto_kitchen, "workshops", 2,
            {"Do not automate kitchen", "Automate kitchen"}, C::AutomaticKitchen},
        {"auto_tan", &df::global::standing_orders_auto_tan, "workshops", 2,
            {"Do not automate tannery", "Automate tannery"}, C::AutomaticTannery},
        {"auto_smelter", &df::global::standing_orders_auto_smelter, "workshops", 2,
            {"Do not automate smelter", "Automate smelter"}, C::AutomaticSmelter},
        {"auto_kiln", &df::global::standing_orders_auto_kiln, "workshops", 2,
            {"Do not automate kiln", "Automate kiln"}, C::AutomaticKiln},
        {"auto_other", &df::global::standing_orders_auto_other, "workshops", 2,
            {"Do not automate other shops", "Automate other shops"}, C::AutomaticOther},
        // Hauling
        {"gather_wood", &df::global::standing_orders_gather_wood, "hauling", 2,
            {"Workers ignore wood", "Workers gather wood"}},
        {"gather_food", &df::global::standing_orders_gather_food, "hauling", 2,
            {"Workers ignore food", "Workers gather food"}},
        {"gather_furniture", &df::global::standing_orders_gather_furniture, "hauling", 2,
            {"Workers ignore furniture", "Workers gather furniture"}},
        {"gather_minerals", &df::global::standing_orders_gather_minerals, "hauling", 2,
            {"Workers ignore minerals", "Workers gather minerals"}},
        {"gather_animals", &df::global::standing_orders_gather_animals, "hauling", 2,
            {"Workers ignore animals", "Workers gather animals"}},
        {"gather_refuse", &df::global::standing_orders_gather_refuse, "hauling", 2,
            {"Workers ignore refuse", "Workers gather refuse"}},
        {"gather_refuse_outside", &df::global::standing_orders_gather_refuse_outside, "hauling", 2,
            {"Workers ignore outdoor refuse", "Workers gather outdoor refuse"}},
        {"gather_vermin_remains", &df::global::standing_orders_gather_vermin_remains, "hauling", 2,
            {"Workers ignore outdoor vermin remains", "Workers gather outdoor vermin remains"}},
        {"zoneonly_drink", &df::global::standing_orders_zoneonly_drink, "hauling", 2,
            {"Prefer zones for water drinking", "Drink water only from designed zones"}},
        {"zoneonly_fish", &df::global::standing_orders_zoneonly_fish, "hauling", 2,
            {"Prefer zones for fishing", "Fish only in designated zones"}},
        // Refuse
        {"gather_bodies", &df::global::standing_orders_gather_bodies, "refuse", 2,
            {"Workers ignore bodies", "Workers gather bodies"}},
        {"dump_bones", &df::global::standing_orders_dump_bones, "refuse", 2,
            {"Workers save bones", "Workers dump bones"}},
        {"dump_corpses", &df::global::standing_orders_dump_corpses, "refuse", 2,
            {"Workers save corpses", "Workers dump corpses"}},
        {"dump_hair", &df::global::standing_orders_dump_hair, "refuse", 2,
            {"Workers save hair and wool", "Workers dump hair and wool"}},
        {"dump_shells", &df::global::standing_orders_dump_shells, "refuse", 2,
            {"Workers save shells", "Workers dump shells"}},
        {"dump_skins", &df::global::standing_orders_dump_skins, "refuse", 2,
            {"Workers save skins", "Workers dump skins"}},
        {"dump_skulls", &df::global::standing_orders_dump_skulls, "refuse", 2,
            {"Workers save skulls", "Workers dump skulls"}},
        {"dump_other", &df::global::standing_orders_dump_other, "refuse", 2,
            {"Workers save other objects", "Workers dump other objects"}},
        // Forbidding
        {"forbid_own_dead", &df::global::standing_orders_forbid_own_dead, "forbidding", 3,
            {"Claim your dead", "Forbid your dead", "Forbid your dead during sieges"}},
        {"forbid_own_dead_items", &df::global::standing_orders_forbid_own_dead_items, "forbidding", 3,
            {"Claim your death items", "Forbid your death items", "Forbid your death items during sieges"}},
        {"forbid_other_dead_items", &df::global::standing_orders_forbid_other_dead_items, "forbidding", 3,
            {"Claim other death items", "Forbid other death items", "Forbid other death items during sieges"}},
        {"forbid_other_nohunt", &df::global::standing_orders_forbid_other_nohunt, "forbidding", 3,
            {"Claim other dead", "Forbid other non-hunted dead", "Forbid other non-hunted dead during sieges"}},
        {"forbid_used_ammo", &df::global::standing_orders_forbid_used_ammo, "forbidding", 3,
            {"Claim used ammunition", "Forbid used ammunition", "Forbid used ammunition during sieges"}},
        {"forbid_rearming_traps", &df::global::standing_orders_forbid_rearming_traps, "forbidding", 3,
            {"Allow trap rearming", "Forbid trap rearming", "Forbid trap rearming during sieges"}},
        {"forbid_trap_cleaning", &df::global::standing_orders_forbid_trap_cleaning, "forbidding", 3,
            {"Allow trap cleaning", "Forbid trap cleaning", "Forbid trap cleaning during sieges"}},
        {"forbid_cages_from_sprung_traps", &df::global::standing_orders_forbid_cages_from_sprung_traps, "forbidding", 3,
            {"Claim cages from sprung traps", "Forbid cages from sprung traps", "Forbid cages from sprung traps during sieges"}},
        {"forbid_toppled_building_items", &df::global::standing_orders_forbid_toppled_building_items, "forbidding", 3,
            {"Claim toppled building items", "Forbid toppled building items", "Forbid toppled building items during sieges"}},
        {"forbid_floor_and_wall_cleaning", &df::global::standing_orders_forbid_floor_and_wall_cleaning, "forbidding", 3,
            {"Allow floor/wall cleaning", "Forbid floor/wall cleaning", "Forbid floor/wall cleaning during sieges"}},
        // Petitions
        {"petition_citizenship", &df::global::standing_orders_petition_citizenship, "petitions", 3,
            {"Citizenship petitions: reject", "Citizenship petitions: prompt", "Citizenship petitions: accept"}},
        {"petition_resident_performer", &df::global::standing_orders_petition_resident_performer, "petitions", 3,
            {"Performer petitions: reject", "Performer petitions: prompt", "Performer petitions: accept"}},
        {"petition_resident_monster_hunter", &df::global::standing_orders_petition_resident_monster_hunter, "petitions", 3,
            {"Monster slayer petitions: reject", "Monster slayer petitions: prompt", "Monster slayer petitions: accept"}},
        {"petition_resident_mercenary", &df::global::standing_orders_petition_resident_mercenary, "petitions", 3,
            {"Mercenary petitions: reject", "Mercenary petitions: prompt", "Mercenary petitions: accept"}},
        {"petition_resident_scholar", &df::global::standing_orders_petition_resident_scholar, "petitions", 3,
            {"Scholar petitions: reject", "Scholar petitions: prompt", "Scholar petitions: accept"}},
        {"petition_resident_sanctuary", &df::global::standing_orders_petition_resident_sanctuary, "petitions", 3,
            {"Sanctuary petitions: reject", "Sanctuary petitions: prompt", "Sanctuary petitions: accept"}},
        // Chores
        {"farmer_harvest", &df::global::standing_orders_farmer_harvest, "chores", 2,
            {"Only farmers harvest", "Everybody harvests"}},
        {"ignore_damp_stone", &df::global::standing_orders_ignore_damp_stone, "chores", 2,
            {"Mining cancelled near new damp stone", "Mining continues through new damp stone"}},
        {"ignore_warm_stone", &df::global::standing_orders_ignore_warm_stone, "chores", 2,
            {"Mining cancelled near new warm stone", "Mining continues through new warm stone"}},
        // Other
        {"job_cancel_announce", &df::global::standing_orders_job_cancel_announce, "other", 4,
            {"Announce no job cancellations", "Announce some job cancellations",
             "Announce most job cancellations", "Announce all job cancellations"}},
        {"mix_food", &df::global::standing_orders_mix_food, "other", 2,
            {"Do not mix similar food in barrels", "Mix similar foods in barrels"}},
    };
    return value;
}

const StandingOrderDef* find_def(const std::string& key) {
    for (const auto& def : order_defs())
        if (key == def.key)
            return &def;
    return nullptr;
}

std::string build_standing_orders_json() {
    std::ostringstream body;
    const bool ok = run_standing_orders_locked([&]() -> bool {
        const auto capabilities = workshop_capabilities();
        body << "{\"ok\":true,\"groups\":[";
        bool first_group = true;
        for (const auto& group : groups()) {
            if (!first_group) body << ",";
            first_group = false;
            body << "{\"id\":" << json_string(group.id) << ",\"label\":" << json_string(group.label) << ",\"items\":[";
            bool first_item = true;
            for (const auto& def : order_defs()) {
                if (std::string(def.group_id) != group.id)
                    continue;
                if (!def.addr || !*def.addr)
                    continue;
                const bool available = order_available(def, capabilities);
                if (!available)
                    continue;
                if (!first_item) body << ",";
                first_item = false;
                const int raw = static_cast<int>(**def.addr);
                const char* label = raw >= 0 && raw < def.state_count ? def.states[raw] : def.states[0];
                body << "{\"key\":" << json_string(def.key) << ",\"label\":" << json_string(label)
                     << ",\"value\":" << (raw != 0 ? "true" : "false")
                     << ",\"raw\":" << raw
                     << ",\"stateCount\":" << static_cast<int>(def.state_count)
                     << ",\"states\":[";
                for (uint8_t i = 0; i < def.state_count; ++i) {
                    if (i) body << ",";
                    body << json_string(def.states[i]);
                }
                body << "]}";
            }
            body << "]}";
        }
        body << "]}\n";
        return true;
    });
    if (!ok)
        return "{\"ok\":false,\"error\":\"world unavailable\"}\n";
    return body.str();
}

bool parse_integer_exact(const std::string& text, int& value) {
    if (text.empty())
        return false;
    const char* first = text.data();
    const char* last = first + text.size();
    const auto parsed = std::from_chars(first, last, value);
    return parsed.ec == std::errc{} && parsed.ptr == last;
}

bool set_standing_order(const std::string& key, int raw, std::string* err) {
    return run_standing_orders_locked([&]() -> bool {
        const StandingOrderDef* def = find_def(key);
        if (!def) { if (err) *err = "unknown standing-order key"; return false; }
        if (!def->addr || !*def->addr) { if (err) *err = "field unavailable in this DF build"; return false; }
        if (!order_available(*def, workshop_capabilities())) {
            if (err) *err = "order unavailable for this world's reactions";
            return false;
        }
        if (raw < 0 || raw >= def->state_count) {
            if (err) *err = "value is outside this order's state range";
            return false;
        }
        **def->addr = static_cast<uint8_t>(raw);
        return true;
    });
}

// ---- children roster + chore-type flags, off plotinfo.labor_info ----------------------------
struct ChoreType {
    const char* key;
    const char* label;
    df::unit_labor labor;
};

const std::vector<ChoreType>& chore_types() {
    using L = df::unit_labor;
    static const std::vector<ChoreType> value = {
        {"feed_patients_prisoners", "Feed Patients/Prisoners", L::FEED_WATER_CIVILIANS},
        {"milking", "Milking", L::MILK},
        {"stone_hauling", "Stone Hauling", L::HAUL_STONE},
        {"wood_hauling", "Wood Hauling", L::HAUL_WOOD},
        {"item_hauling", "Item Hauling", L::HAUL_ITEM},
        {"burial", "Burial", L::HAUL_BODY},
        {"food_hauling", "Food Hauling", L::HAUL_FOOD},
        {"refuse_hauling", "Refuse Hauling", L::HAUL_REFUSE},
        {"furniture_hauling", "Furniture Hauling", L::HAUL_FURNITURE},
        {"animal_hauling", "Animal Hauling", L::HAUL_ANIMALS},
        {"trade_good_hauling", "Trade Good Hauling", L::HAUL_TRADE},
        {"water_hauling", "Water Hauling", L::HAUL_WATER},
        {"cleaning", "Cleaning", L::CLEAN},
        {"lever_operation", "Lever Operation", L::PULL_LEVER},
    };
    return value;
}

const ChoreType* find_chore(const std::string& key) {
    for (const auto& c : chore_types())
        if (key == c.key)
            return &c;
    return nullptr;
}

bool labor_index_valid(df::unit_labor labor) {
    int idx = static_cast<int>(labor);
    return idx >= 0 && idx <= df::enum_traits<df::unit_labor>::last_item_value;
}

bool child_exempt(df::plotinfost* pi, int32_t uid) {
    for (int32_t id : pi->labor_info.chores_exempted_children)
        if (id == uid)
            return true;
    return false;
}

std::string build_chores_json() {
    std::ostringstream body;
    bool ok = run_standing_orders_locked([&]() -> bool {
        auto pi = df::global::plotinfo;
        auto world = df::global::world;
        if (!pi || !world)
            return false;
        body << "{\"ok\":true,\"childrenDoChores\":"
             << (pi->labor_info.flags.bits.children_do_chores ? "true" : "false")
             << ",\"choreTypes\":[";
        bool first = true;
        for (const auto& c : chore_types()) {
            bool enabled = labor_index_valid(c.labor) &&
                           pi->labor_info.chores[static_cast<int>(c.labor)];
            if (!first) body << ",";
            first = false;
            body << "{\"key\":" << json_string(c.key) << ",\"label\":" << json_string(c.label)
                 << ",\"enabled\":" << (enabled ? "true" : "false") << "}";
        }
        body << "],\"children\":[";
        first = true;
        for (auto unit : world->units.active) {
            // Seeded-bad guard: ONLY fortress children -- never an adult resident, and an empty
            // left pane on a fort with no children (isChild gates it, isCitizen scopes to the fort).
            if (!unit || !DFHack::Units::isCitizen(unit, true) || !DFHack::Units::isChild(unit))
                continue;
            std::string name = DFHack::Translation::translateName(&unit->name, true);
            if (name.empty())
                name = "Child " + std::to_string(unit->id);
            if (!first) body << ",";
            first = false;
            body << "{\"unitId\":" << unit->id << ",\"name\":" << json_string(name)
                 << ",\"portraitTexpos\":" << unit->portrait_texpos
                 << ",\"enabled\":" << (child_exempt(pi, unit->id) ? "false" : "true") << "}";
        }
        body << "]}\n";
        return true;
    });
    if (!ok)
        return "{\"ok\":false,\"error\":\"world unavailable\"}\n";
    return body.str();
}

bool set_chore_global(bool on, std::string* err) {
    return run_standing_orders_locked([&]() -> bool {
        auto pi = df::global::plotinfo;
        if (!pi) { if (err) *err = "world unavailable"; return false; }
        pi->labor_info.flags.bits.children_do_chores = on;
        return true;
    });
}

bool set_chore_type(const std::string& key, bool on, std::string* err) {
    return run_standing_orders_locked([&]() -> bool {
        auto pi = df::global::plotinfo;
        if (!pi) { if (err) *err = "world unavailable"; return false; }
        const ChoreType* c = find_chore(key);
        if (!c) { if (err) *err = "unknown chore type"; return false; }
        if (!labor_index_valid(c->labor)) { if (err) *err = "bad chore labor"; return false; }
        pi->labor_info.chores[static_cast<int>(c->labor)] = on;
        return true;
    });
}

bool set_child_chore(int32_t uid, bool on, std::string* err) {
    return run_standing_orders_locked([&]() -> bool {
        auto pi = df::global::plotinfo;
        if (!pi) { if (err) *err = "world unavailable"; return false; }
        auto unit = df::unit::find(uid);
        if (!unit || !DFHack::Units::isChild(unit)) { if (err) *err = "not a child"; return false; }
        auto& vec = pi->labor_info.chores_exempted_children;
        auto it = std::find(vec.begin(), vec.end(), uid);
        if (on) {              // does chores => not exempt
            if (it != vec.end()) vec.erase(it);
        } else {               // opted out => exempt
            if (it == vec.end()) vec.push_back(uid);
        }
        return true;
    });
}

} // namespace

void register_standing_orders_routes(httplib::Server& server) {
    // GET /standing-orders -> every category + its toggles' current values.
    server.Get("/standing-orders", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        res.set_content(build_standing_orders_json(), "application/json; charset=utf-8");
    });

    // POST /standing-orders?key=&value=<raw-state> -> select one validated native state.
    auto toggle_handler = [](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("key")) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing key\"}\n", "application/json; charset=utf-8");
            return;
        }
        std::string key = req.get_param_value("key");
        int value = 0;
        if (!req.has_param("value") || !parse_integer_exact(req.get_param_value("value"), value)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"invalid value\"}\n", "application/json; charset=utf-8");
            return;
        }
        std::string err;
        if (!set_standing_order(key, value, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n", "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Post("/standing-orders", toggle_handler);

    server.Get("/chores", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        res.set_content(build_chores_json(), "application/json; charset=utf-8");
    });

    server.Post("/chores", [](const httplib::Request& req, httplib::Response& res) {
        std::string err;
        bool ok = false;
        if (req.has_param("global")) {
            int v = 1; query_int(req, "global", v);
            ok = set_chore_global(v != 0, &err);
        } else if (req.has_param("chore")) {
            int v = 1; query_int(req, "value", v);
            ok = set_chore_type(req.get_param_value("chore"), v != 0, &err);
        } else if (req.has_param("child")) {
            int cid = -1; query_int(req, "child", cid);
            int v = 1; query_int(req, "value", v);
            ok = set_child_chore(cid, v != 0, &err);
        } else {
            err = "missing global/chore/child param";
        }
        if (!ok) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n", "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    });
}

} // namespace dwf
