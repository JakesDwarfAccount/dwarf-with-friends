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

#include "stockpile_panel.h"

#include "client_state.h"
#include "lua_bridge.h"
#include "route_helpers.h"
#include "ui_cache_purge.h"

#include "Core.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Buildings.h"

#include "df/building.h"
#include "df/building_extents_type.h"
#include "df/building_stockpilest.h"
#include "df/building_type.h"
#include "df/stockpile_group_set.h"
#include "df/stockpile_settings.h"
#include "df/world.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <mutex>
#include <new>
#include <sstream>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_stockpile_mutex;

template <typename Fn>
bool run_stockpile_locked(Fn&& fn) {
    return run_panel_locked(g_stockpile_mutex, std::forward<Fn>(fn));
}

df::building_stockpilest* find_stockpile(int32_t id) {
    auto b = df::building::find(id);
    if (b && b->getType() == df::building_type::Stockpile)
        return virtual_cast<df::building_stockpilest>(b);
    return nullptr;
}

template <typename T>
bool ptr_vector_contains(const std::vector<T*>& vec, T* value) {
    return std::find(vec.begin(), vec.end(), value) != vec.end();
}

template <typename T>
void ptr_vector_add_unique(std::vector<T*>& vec, T* value) {
    if (value && !ptr_vector_contains(vec, value))
        vec.push_back(value);
}

template <typename T>
bool ptr_vector_remove_all(std::vector<T*>& vec, T* value) {
    auto old_size = vec.size();
    vec.erase(std::remove(vec.begin(), vec.end(), value), vec.end());
    return vec.size() != old_size;
}

template <typename T>
void ptr_vector_replace_all(std::vector<T*>& vec, T* old_value, T* new_value) {
    for (auto& entry : vec) {
        if (entry == old_value)
            entry = new_value;
    }
}

std::string stockpile_building_label(df::building* b) {
    if (!b)
        return "";
    std::string name = Buildings::getName(b);
    if (!name.empty())
        return name;
    if (auto sp = virtual_cast<df::building_stockpilest>(b))
        return "Stockpile #" + std::to_string(sp->stockpile_number);
    return "Building " + std::to_string(b->id);
}

const char* stockpile_target_kind(df::building* b) {
    if (!b)
        return "building";
    if (b->getType() == df::building_type::Stockpile)
        return "stockpile";
    return "workshop";
}

void append_stockpile_building_ref(std::ostringstream& out, df::building* b) {
    if (!b)
        return;
    out << "{\"id\":" << b->id
        << ",\"kind\":" << json_string(stockpile_target_kind(b))
        << ",\"name\":" << json_string(stockpile_building_label(b))
        << ",\"pos\":{\"x\":" << b->centerx << ",\"y\":" << b->centery
        << ",\"z\":" << b->z << "}}";
}

template <typename T>
void append_stockpile_ref_array(std::ostringstream& out, const std::vector<T*>& vec) {
    out << "[";
    bool first = true;
    for (auto b : vec) {
        if (!b)
            continue;
        if (!first)
            out << ",";
        first = false;
        append_stockpile_building_ref(out, static_cast<df::building*>(b));
    }
    out << "]";
}

bool is_stockpile_link_target(df::building_stockpilest* selected, df::building* candidate) {
    if (!candidate || candidate == selected)
        return false;
    if (candidate->getType() == df::building_type::Stockpile)
        return true;
    return candidate->canLinkToStockpile() && candidate->getStockpileLinks();
}

void append_stockpile_link_targets(std::ostringstream& out, df::building_stockpilest* selected) {
    out << "[";
    bool first = true;
    auto world = df::global::world;
    if (world) {
        for (auto b : world->buildings.all) {
            if (!is_stockpile_link_target(selected, b))
                continue;
            if (!first)
                out << ",";
            first = false;
            append_stockpile_building_ref(out, b);
        }
    }
    out << "]";
}

void remove_self_links(df::building_stockpilest* sp) {
    if (!sp)
        return;
    ptr_vector_remove_all(sp->links.give_to_pile, sp);
    ptr_vector_remove_all(sp->links.take_from_pile, sp);
    ptr_vector_remove_all(sp->links.give_to_workshop, static_cast<df::building*>(sp));
    ptr_vector_remove_all(sp->links.take_from_workshop, static_cast<df::building*>(sp));
}

void replace_stockpile_link_refs(df::building_stockpilest* old_sp,
                                 df::building_stockpilest* new_sp) {
    auto world = df::global::world;
    if (!world || !old_sp || !new_sp)
        return;
    for (auto b : world->buildings.all) {
        if (!b)
            continue;
        auto links = b->getStockpileLinks();
        if (!links)
            continue;
        ptr_vector_replace_all(links->give_to_pile, old_sp, new_sp);
        ptr_vector_replace_all(links->take_from_pile, old_sp, new_sp);
        ptr_vector_replace_all(links->give_to_workshop, static_cast<df::building*>(old_sp),
                               static_cast<df::building*>(new_sp));
        ptr_vector_replace_all(links->take_from_workshop, static_cast<df::building*>(old_sp),
                               static_cast<df::building*>(new_sp));
    }
    remove_self_links(new_sp);
}

int16_t clamp_storage_value(int value) {
    return static_cast<int16_t>(std::max(0, std::min(3000, value)));
}

} // namespace

std::string stockpile_info_json_on_core_thread(int32_t id) {
    std::string json;
    bool ok = run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        if (!sp)
            return false;
        const auto& f = sp->settings.flags.bits;
        auto jb = [](bool v) { return v ? "true" : "false"; };
        std::ostringstream b;
        b << "{\"ok\":true,\"id\":" << sp->id
          << ",\"name\":" << json_string(sp->name)
          << ",\"displayName\":" << json_string(Buildings::getName(sp))
          << ",\"number\":" << sp->stockpile_number
          << ",\"pos\":{\"x\":" << sp->x1 << ",\"y\":" << sp->y1 << ",\"z\":" << sp->z << "}"
          << ",\"size\":{\"w\":" << (sp->x2 - sp->x1 + 1)
          << ",\"h\":" << (sp->y2 - sp->y1 + 1) << "}"
          << ",\"extents\":\"";
        // extents: row-major '0'/'1' membership bitmap over pos/size, the shape /zones also emits.
        {
            const int ew = sp->x2 - sp->x1 + 1;
            const int eh = sp->y2 - sp->y1 + 1;
            const bool shaped = sp->room.extents && sp->isExtentShaped() &&
                sp->room.width == ew && sp->room.height == eh;
            for (int i = 0; i < ew * eh; ++i)
                b << ((!shaped ||
                       sp->room.extents[i] != df::building_extents_type::None) ? '1' : '0');
        }
        b << "\""
          << ",\"linksOnly\":" << jb(sp->stockpile_flag.bits.use_links_only)
          << ",\"storage\":{\"barrels\":" << sp->storage.max_barrels
          << ",\"bins\":" << sp->storage.max_bins
          << ",\"wheelbarrows\":" << sp->storage.max_wheelbarrows << "}"
          << ",\"groups\":{\"animals\":" << jb(f.animals)
          << ",\"food\":" << jb(f.food)
          << ",\"furniture\":" << jb(f.furniture)
          << ",\"corpses\":" << jb(f.corpses)
          << ",\"refuse\":" << jb(f.refuse)
          << ",\"stone\":" << jb(f.stone)
          << ",\"ammo\":" << jb(f.ammo)
          << ",\"coins\":" << jb(f.coins)
          << ",\"bars_blocks\":" << jb(f.bars_blocks)
          << ",\"gems\":" << jb(f.gems)
          << ",\"finished_goods\":" << jb(f.finished_goods)
          << ",\"leather\":" << jb(f.leather)
          << ",\"cloth\":" << jb(f.cloth)
          << ",\"wood\":" << jb(f.wood)
          << ",\"weapons\":" << jb(f.weapons)
          << ",\"armor\":" << jb(f.armor)
          << ",\"sheet\":" << jb(f.sheet) << "}"
          << ",\"links\":{\"give\":";
        append_stockpile_ref_array(b, sp->links.give_to_pile);
        b << ",\"giveWorkshops\":";
        append_stockpile_ref_array(b, sp->links.give_to_workshop);
        b << ",\"take\":";
        append_stockpile_ref_array(b, sp->links.take_from_pile);
        b << ",\"takeWorkshops\":";
        append_stockpile_ref_array(b, sp->links.take_from_workshop);
        b << "},\"targets\":";
        append_stockpile_link_targets(b, sp);
        b << "}\n";
        json = b.str();
        return true;
    });
    return ok ? json : "";
}

bool rename_stockpile_on_core_thread(int32_t id, const std::string& name) {
    return run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        if (sp)
            sp->name = name;
        return sp != nullptr;
    });
}

bool remove_stockpile_on_core_thread(int32_t id) {
    return run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        if (!sp)
            return false;
        // Buildings::deconstruct frees the pile but leaves main_interface.custom_stockpile still
        // pointing at it, so DF renders freed memory next frame unless this purge runs first.
        purge_ui_caches_for_building(sp);
        return Buildings::deconstruct(sp);
    });
}

bool set_stockpile_links_only_on_core_thread(int32_t id, bool on) {
    return run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        if (sp)
            sp->stockpile_flag.bits.use_links_only = on;
        return sp != nullptr;
    });
}

bool set_stockpile_storage_on_core_thread(int32_t id, int barrels, int bins, int wheelbarrows) {
    return run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        if (!sp)
            return false;
        if (barrels >= 0)
            sp->storage.max_barrels = clamp_storage_value(barrels);
        if (bins >= 0)
            sp->storage.max_bins = clamp_storage_value(bins);
        if (wheelbarrows >= 0)
            sp->storage.max_wheelbarrows = clamp_storage_value(wheelbarrows);
        return true;
    });
}

bool set_stockpile_link_on_core_thread(int32_t id, int32_t target_id, const std::string& mode,
                                       bool on, std::string* err) {
    return run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        auto target = df::building::find(target_id);
        if (!sp) {
            if (err) *err = "not a stockpile";
            return false;
        }
        if (!is_stockpile_link_target(sp, target)) {
            if (err) *err = "target cannot link to stockpiles";
            return false;
        }
        // DF stores no vector for "exchange": it is the give and take passes applied together.
        const bool exchange = mode == "exchange";
        const bool give = exchange || mode == "give";
        const bool take = exchange || mode == "take";
        if (!give && !take) {
            if (err) *err = "mode must be give, take or exchange";
            return false;
        }

        df::stockpile_links* target_links = nullptr;
        auto target_sp = virtual_cast<df::building_stockpilest>(target);
        if (!target_sp) {
            target_links = target->getStockpileLinks();
            if (!target_links) {
                if (err) *err = "target has no stockpile link data";
                return false;
            }
        }

        auto apply_direction = [&](bool giving) {
            if (target_sp) {
                auto& ours = giving ? sp->links.give_to_pile : sp->links.take_from_pile;
                auto& theirs = giving ? target_sp->links.take_from_pile
                                      : target_sp->links.give_to_pile;
                if (on) {
                    ptr_vector_add_unique(ours, target_sp);
                    ptr_vector_add_unique(theirs, sp);
                } else {
                    ptr_vector_remove_all(ours, target_sp);
                    ptr_vector_remove_all(theirs, sp);
                }
            } else {
                auto& ours = giving ? sp->links.give_to_workshop : sp->links.take_from_workshop;
                auto& theirs = giving ? target_links->take_from_pile
                                      : target_links->give_to_pile;
                if (on) {
                    ptr_vector_add_unique(ours, target);
                    ptr_vector_add_unique(theirs, sp);
                } else {
                    ptr_vector_remove_all(ours, target);
                    ptr_vector_remove_all(theirs, sp);
                }
            }
        };

        if (give)
            apply_direction(true);
        if (take)
            apply_direction(false);

        return true;
    });
}

bool finish_stockpile_repaint_on_core_thread(int32_t old_id, int32_t new_id,
                                             int32_t& final_id, std::string* err) {
    return run_stockpile_locked([&]() -> bool {
        auto old_sp = find_stockpile(old_id);
        auto new_sp = find_stockpile(new_id);
        if (!old_sp || !new_sp) {
            if (err) *err = "old or new stockpile not found";
            return false;
        }

        const auto settings = old_sp->settings;
        const auto stockpile_flag = old_sp->stockpile_flag;
        const auto links = old_sp->links;
        const auto name = old_sp->name;
        const int32_t stockpile_number = old_sp->stockpile_number;
        const int16_t max_barrels = old_sp->storage.max_barrels;
        const int16_t max_bins = old_sp->storage.max_bins;
        const int16_t max_wheelbarrows = old_sp->storage.max_wheelbarrows;

        new_sp->settings = settings;
        new_sp->stockpile_flag = stockpile_flag;
        new_sp->links = links;
        new_sp->name = name;
        new_sp->storage.max_barrels = max_barrels;
        new_sp->storage.max_bins = max_bins;
        new_sp->storage.max_wheelbarrows = max_wheelbarrows;
        new_sp->storage.container_type.clear();
        new_sp->storage.container_item_id.clear();
        new_sp->storage.container_x.clear();
        new_sp->storage.container_y.clear();

        replace_stockpile_link_refs(old_sp, new_sp);

        old_sp->stockpile_number = -1;
        purge_ui_caches_for_building(old_sp);
        if (!Buildings::deconstruct(old_sp)) {
            if (err) *err = "old stockpile could not be removed";
            return false;
        }

        new_sp->stockpile_number = stockpile_number;
        final_id = new_sp->id;
        return true;
    });
}

// Mutate the pile in place, never carve a replacement: a replacement overlaps the original, so
// Buildings::checkFreeTiles (via constructAbstract) withholds the tiles it already held.
bool apply_stockpile_repaint_in_place_on_core_thread(int32_t id, int x1, int y1, int x2, int y2,
                                                     int z, const std::string& mask,
                                                     std::string* err) {
    return run_stockpile_locked([&]() -> bool {
        auto sp = find_stockpile(id);
        if (!sp) {
            if (err) *err = "not a stockpile";
            return false;
        }
        if (sp->z != z) {
            if (err) *err = "repaint footprint is on a different z-level than the stockpile";
            return false;
        }
        const int width = x2 - x1 + 1;
        const int height = y2 - y1 + 1;
        const int64_t cells = static_cast<int64_t>(width) * height;
        if (width <= 0 || height <= 0 || static_cast<int64_t>(mask.size()) != cells) {
            if (err) *err = "repaint bitmap size does not match its bounds";
            return false;
        }
        int64_t remaining = 0;
        for (char c : mask)
            if (c == '1')
                ++remaining;
        if (!remaining) {
            if (err) *err = "repaint cannot erase an entire stockpile; stockpile left unchanged";
            return false;
        }
        // `next` is allocated and filled before any DF field moves, so a failure changes nothing.
        std::unique_ptr<df::building_extents_type[]> next(
            new (std::nothrow) df::building_extents_type[static_cast<size_t>(cells)]);
        if (!next) {
            if (err) *err = "not enough memory to repaint stockpile safely";
            return false;
        }
        // extents value Stockpile (1) marks an included tile; None (0) is a shaped hole.
        for (size_t i = 0; i < static_cast<size_t>(cells); ++i)
            next[i] = mask[i] == '1' ? df::building_extents_type::Stockpile
                                     : df::building_extents_type::None;

        auto old_extents = sp->room.extents;
        sp->room.extents = next.release();
        sp->room.x = x1;
        sp->room.y = y1;
        sp->room.width = width;
        sp->room.height = height;
        sp->x1 = x1;
        sp->y1 = y1;
        sp->x2 = x2;
        sp->y2 = y2;
        sp->centerx = x1 + width / 2;
        sp->centery = y1 + height / 2;
        delete[] old_extents;

        sp->storage.container_type.clear();
        sp->storage.container_item_id.clear();
        sp->storage.container_x.clear();
        sp->storage.container_y.clear();
        return true;
    });
}

// -------------------------------------------------------------------------------- HTTP routes
void register_stockpile_routes(httplib::Server& server) {
    server.Get("/stockpile-info", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string json = stockpile_info_json_on_core_thread(id);
        if (json.empty()) {
            res.status = 404;
            res.set_content("not a stockpile\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    auto stockpile_rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("name")) {
            res.status = 400;
            res.set_content("missing id/name\n", "text/plain; charset=utf-8");
            return;
        }
        bool ok = rename_stockpile_on_core_thread(id, req.get_param_value("name"));
        res.set_header("Cache-Control", "no-store");
        res.set_content(ok ? "{\"ok\":true}\n" : "{\"ok\":false}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/stockpile-rename", stockpile_rename_handler);
    server.Post("/stockpile-rename", stockpile_rename_handler);

    auto stockpile_remove_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        bool ok = remove_stockpile_on_core_thread(id);
        res.set_header("Cache-Control", "no-store");
        res.set_content(ok ? "{\"ok\":true}\n" : "{\"ok\":false}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/stockpile-remove", stockpile_remove_handler);
    server.Post("/stockpile-remove", stockpile_remove_handler);

    auto stockpile_links_only_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int on = 0;
        if (!query_int(req, "id", id) || !query_int(req, "on", on)) {
            res.status = 400;
            res.set_content("missing id/on\n", "text/plain; charset=utf-8");
            return;
        }
        bool ok = set_stockpile_links_only_on_core_thread(id, on != 0);
        res.set_header("Cache-Control", "no-store");
        res.set_content(ok ? "{\"ok\":true}\n" : "{\"ok\":false}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/stockpile-links-only", stockpile_links_only_handler);
    server.Post("/stockpile-links-only", stockpile_links_only_handler);

    auto stockpile_storage_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        int barrels = -1;
        int bins = -1;
        int wheelbarrows = -1;
        query_int(req, "barrels", barrels);
        query_int(req, "bins", bins);
        query_int(req, "wheelbarrows", wheelbarrows);
        bool ok = set_stockpile_storage_on_core_thread(id, barrels, bins, wheelbarrows);
        res.set_header("Cache-Control", "no-store");
        res.set_content(ok ? "{\"ok\":true}\n" : "{\"ok\":false}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/stockpile-storage", stockpile_storage_handler);
    server.Post("/stockpile-storage", stockpile_storage_handler);

    auto stockpile_link_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int target = -1;
        int on = 1;
        if (!query_int(req, "id", id) || !query_int(req, "target", target) ||
            !req.has_param("mode")) {
            res.status = 400;
            res.set_content("missing id/target/mode\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "on", on);
        std::string err;
        if (!set_stockpile_link_on_core_thread(id, target, req.get_param_value("mode"),
                                               on != 0, &err)) {
            res.status = 400;
            res.set_content("link failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/stockpile-link", stockpile_link_handler);
    server.Post("/stockpile-link", stockpile_link_handler);

    auto stockpile_set_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("preset")) {
            res.status = 400;
            res.set_content("missing id/preset\n", "text/plain; charset=utf-8");
            return;
        }
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "set";
        std::string err;
        if (!stockpile_set_preset_via_lua(id, req.get_param_value("preset"), mode, &err)) {
            res.status = 400;
            res.set_content("set failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/stockpile-set", stockpile_set_handler);
    server.Post("/stockpile-set", stockpile_set_handler);

    auto stockpile_group_from_request = [](const httplib::Request& req) {
        return req.has_param("group") ? req.get_param_value("group") : std::string();
    };

    server.Get("/stockpile-cat-groups", [](const httplib::Request& req, httplib::Response& res) {
        if (!req.has_param("cat")) {
            res.status = 400;
            res.set_content("missing cat\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = stockpile_groups_via_lua(req.get_param_value("cat"), &err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("groups failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    server.Get("/stockpile-items", [stockpile_group_from_request](const httplib::Request& req,
                                                                 httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("cat")) {
            res.status = 400;
            res.set_content("missing id/cat\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = stockpile_items_via_lua(id, req.get_param_value("cat"),
                                                   stockpile_group_from_request(req), &err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("items failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    server.Get("/stockpile-settings-snapshot", [](const httplib::Request& req,
                                                   httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = stockpile_settings_snapshot_via_lua(id, &err);
        if (json.empty()) {
            res.status = 500;
            res.set_content("snapshot failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    auto stockpile_toggle_item_handler =
        [stockpile_group_from_request](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int idx = -1;
        int on = 0;
        if (!query_int(req, "id", id) || !req.has_param("cat") ||
                !query_int(req, "idx", idx)) {
            res.status = 400;
            res.set_content("missing id/cat/idx\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "on", on);
        std::string err;
        if (!stockpile_toggle_item_via_lua(id, req.get_param_value("cat"),
                                           stockpile_group_from_request(req),
                                           idx, on != 0, &err)) {
            res.status = 400;
            res.set_content("toggle failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/stockpile-toggle-item", stockpile_toggle_item_handler);
    server.Post("/stockpile-toggle-item", stockpile_toggle_item_handler);

    auto stockpile_toggle_all_handler =
        [stockpile_group_from_request](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        int on = 0;
        if (!query_int(req, "id", id) || !req.has_param("cat")) {
            res.status = 400;
            res.set_content("missing id/cat\n", "text/plain; charset=utf-8");
            return;
        }
        query_int(req, "on", on);
        std::string err;
        if (!stockpile_toggle_all_via_lua(id, req.get_param_value("cat"),
                                          stockpile_group_from_request(req),
                                          on != 0, &err)) {
            res.status = 400;
            res.set_content("toggle-all failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/stockpile-toggle-all", stockpile_toggle_all_handler);
    server.Post("/stockpile-toggle-all", stockpile_toggle_all_handler);

    auto stockpile_repaint_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "";
        if (mode == "replace") {
            int rx1 = 0, ry1 = 0, rx2 = 0, ry2 = 0, rz = 0;
            if (!query_int(req, "x1", rx1) || !query_int(req, "y1", ry1) ||
                    !query_int(req, "x2", rx2) || !query_int(req, "y2", ry2) ||
                    !query_int(req, "z", rz)) {
                res.status = 400;
                res.set_content("missing x1/y1/x2/y2/z\n", "text/plain; charset=utf-8");
                return;
            }
            const int lx = std::min(rx1, rx2), hx = std::max(rx1, rx2);
            const int ly = std::min(ry1, ry2), hy = std::max(ry1, ry2);
            const int64_t mw = static_cast<int64_t>(hx) - lx + 1;
            const int64_t mh = static_cast<int64_t>(hy) - ly + 1;
            const int64_t cells = mw * mh;
            constexpr int64_t kMaxStockpileRepaintTiles = 1024 * 1024;
            const std::string& mask = req.body;
            if (mw <= 0 || mh <= 0 || cells > kMaxStockpileRepaintTiles) {
                res.status = 400;
                res.set_content("stockpile-repaint failed: repaint footprint is too large\n",
                                "text/plain; charset=utf-8");
                return;
            }
            if (static_cast<int64_t>(mask.size()) != cells) {
                res.status = 400;
                res.set_content("stockpile-repaint failed: repaint bitmap size does not match "
                                "its bounds\n", "text/plain; charset=utf-8");
                return;
            }
            if (std::any_of(mask.begin(), mask.end(),
                            [](char c) { return c != '0' && c != '1'; })) {
                res.status = 400;
                res.set_content("stockpile-repaint failed: repaint bitmap contains an invalid "
                                "tile value\n", "text/plain; charset=utf-8");
                return;
            }
            int tx1 = hx + 1, ty1 = hy + 1, tx2 = lx - 1, ty2 = ly - 1;
            for (int y = ly; y <= hy; ++y)
                for (int x = lx; x <= hx; ++x)
                    if (mask[static_cast<size_t>(x - lx) +
                             static_cast<size_t>(y - ly) * mw] == '1') {
                        tx1 = std::min(tx1, x); ty1 = std::min(ty1, y);
                        tx2 = std::max(tx2, x); ty2 = std::max(ty2, y);
                    }
            if (tx2 < tx1 || ty2 < ty1) {
                res.status = 409;
                res.set_content("stockpile-repaint refused: repaint cannot erase an entire "
                                "stockpile; stockpile left unchanged\n",
                                "text/plain; charset=utf-8");
                return;
            }
            std::string trimmed;
            trimmed.reserve(static_cast<size_t>(tx2 - tx1 + 1) *
                            static_cast<size_t>(ty2 - ty1 + 1));
            for (int y = ty1; y <= ty2; ++y)
                for (int x = tx1; x <= tx2; ++x)
                    trimmed += mask[static_cast<size_t>(x - lx) +
                                    static_cast<size_t>(y - ly) * mw];

            std::string err;
            if (!apply_stockpile_repaint_in_place_on_core_thread(id, tx1, ty1, tx2, ty2, rz,
                                                                 trimmed, &err)) {
                const bool refusal = err.find("erase an entire stockpile") != std::string::npos;
                res.status = refusal ? 409 : 400;
                res.set_content(std::string(refusal ? "stockpile-repaint refused: "
                                                    : "stockpile-repaint failed: ") + err + "\n",
                                "text/plain; charset=utf-8");
                return;
            }
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":true,\"id\":" + std::to_string(id) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        int px = 0;
        int py = 0;
        int px2 = 0;
        int py2 = 0;
        int frame_w = 0;
        int frame_h = 0;
        if (!parse_frame_rect(req, px, py, px2, py2, frame_w, frame_h)) {
            res.status = 400;
            res.set_content("missing id/px/py/w/h\n", "text/plain; charset=utf-8");
            return;
        }

        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            res.status = 503;
            res.set_content("camera failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        int new_id = -1;
        normalize_frame_to_viewport(camera, frame_w, frame_h);
        // The temp pile must be created with preset "none": the game can tick before
        // finish_stockpile_repaint_on_core_thread copies the real settings, and "all" attracts haulers.
        if (!create_stockpile_via_lua(camera, px, py, px2, py2, frame_w, frame_h,
                                      "none", new_id, &err)) {
            res.status = 400;
            res.set_content("repaint failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        int final_id = new_id;
        if (!finish_stockpile_repaint_on_core_thread(id, new_id, final_id, &err)) {
            remove_stockpile_on_core_thread(new_id);
            res.status = 400;
            res.set_content("repaint failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"id\":" + std::to_string(final_id) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/stockpile-repaint", stockpile_repaint_handler);
    server.Post("/stockpile-repaint", stockpile_repaint_handler);
}

} // namespace dwf
