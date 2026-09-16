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
// Hauling routes: routes, stops, depart conditions, and minecart binding.

#include "hauling.h"

#include "Core.h"
#include "client_state.h"
#include "http_server.h"
#include "json_util.h"
#include "panel_http.h"
#include "route_helpers.h"
#include "sdl_capture.h"
#include "write_guards.h"

#include "df/building.h"
#include "df/building_stockpilest.h"
#include "df/global_objects.h"
#include "df/hauling_infost.h"
#include "df/hauling_route.h"
#include "df/hauling_stop.h"
#include "df/item.h"
#include "df/item_toolst.h"
#include "df/itemdef_toolst.h"
#include "df/plotinfost.h"
#include "df/route_stockpile_link.h"
#include "df/stop_depart_condition.h"
#include "df/vehicle.h"
#include "df/world.h"

#include "modules/Items.h"

#include "lua_bridge.h"

#include <algorithm>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_hauling_mutex;

template <typename Fn>
bool run_hauling_locked(Fn&& fn) {
    return run_panel_locked(g_hauling_mutex, std::forward<Fn>(fn));
}

df::hauling_route* find_route(int32_t id) {
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo)
        return nullptr;
    for (auto route : plotinfo->hauling.routes) {
        if (route && route->id == id)
            return route;
    }
    return nullptr;
}

df::hauling_stop* find_stop(df::hauling_route* route, int32_t stop_id) {
    if (!route)
        return nullptr;
    for (auto stop : route->stops) {
        if (stop && stop->id == stop_id)
            return stop;
    }
    return nullptr;
}

int32_t next_hauling_id() {
    auto plotinfo = df::global::plotinfo;
    return plotinfo ? plotinfo->hauling.next_id++ : -1;
}

// A hauling route carries MINECARTS (df::tool_uses::TRACK_CART). A wheelbarrow is stockpile
// equipment: it has no df::vehicle record, and getVehicleID() returns -1.
bool item_is_minecart(df::item* item) {
    if (!item)
        return false;
    auto tool = virtual_cast<df::item_toolst>(item);
    if (!tool || !tool->subtype)
        return false;
    for (auto use : tool->subtype->tool_use) {
        if (use == df::tool_uses::TRACK_CART)
            return true;
    }
    return false;
}

// item -> its df::vehicle through DF's own vmethod; nullptr when the item has no vehicle record.
df::vehicle* vehicle_for_item(df::item* item) {
    if (!item)
        return nullptr;
    int32_t vid = item->getVehicleID();
    if (vid < 0)
        return nullptr;
    return df::vehicle::find(vid);
}

// plotinfo.hauling.view_routes / view_stops / view_bad are the native menu's caches of raw pointers
// into these objects, so purge them BEFORE any free. view_bad is index-parallel to view_stops.
void purge_view_stop(df::plotinfost* plotinfo, df::hauling_stop* stop) {
    auto& vs = plotinfo->hauling.view_stops;
    auto& vb = plotinfo->hauling.view_bad;
    for (size_t i = vs.size(); i-- > 0;) {
        if (vs[i] != stop) continue;
        vs.erase(vs.begin() + i);
        if (i < vb.size()) vb.erase(vb.begin() + i);
    }
}

void purge_view_route(df::plotinfost* plotinfo, df::hauling_route* route) {
    auto& vr = plotinfo->hauling.view_routes;
    for (size_t i = vr.size(); i-- > 0;) {
        if (vr[i] == route) vr.erase(vr.begin() + i);
    }
    for (auto stop : route->stops) {
        if (stop) purge_view_stop(plotinfo, stop);
    }
}

// Drops every vehicle binding, clearing vehicle.route_id before releasing the cart to the pool.
void release_route_vehicles(df::hauling_route* route) {
    if (!route)
        return;
    for (int32_t vid : route->vehicle_ids) {
        if (auto vehicle = df::vehicle::find(vid))
            vehicle->route_id = -1;
    }
    route->vehicle_ids.clear();
    route->vehicle_stops.clear();
}

// ---- serialization --------------------------------------------------------

// `desired` gates departure on the stop's own settings filter rather than raw fullness;
// `at_most` inverts the test to "leave once emptied".
void append_conditions(std::ostringstream& body, const df::hauling_stop* stop) {
    body << "[";
    for (size_t i = 0; i < stop->conditions.size(); ++i) {
        if (i) body << ",";
        auto c = stop->conditions[i];
        static const char* kDir[] = {"north", "south", "east", "west"};
        static const char* kMode[] = {"push", "ride", "guide"};
        int dir = static_cast<int>(c->direction);
        int mode = static_cast<int>(c->mode);
        body << "{\"index\":" << i
             << ",\"timeout\":" << c->timeout
             << ",\"direction\":" << json_string(dir >= 0 && dir < 4 ? kDir[dir] : "north")
             << ",\"mode\":" << json_string(mode >= 0 && mode < 3 ? kMode[mode] : "push")
             << ",\"loadPercent\":" << c->load_percent
             << ",\"atMost\":" << (c->flags.bits.at_most ? "true" : "false")
             << ",\"desired\":" << (c->flags.bits.desired ? "true" : "false")
             << ",\"guidePath\":[";
        // Read-only: DF owns guide_path. Guard on the shortest of the parallel x/y/z vectors in
        // case DF is mid-write.
        size_t n = std::min(c->guide_path.x.size(),
                            std::min(c->guide_path.y.size(), c->guide_path.z.size()));
        for (size_t p = 0; p < n; ++p) {
            if (p) body << ",";
            body << "{\"x\":" << c->guide_path.x[p]
                 << ",\"y\":" << c->guide_path.y[p]
                 << ",\"z\":" << c->guide_path.z[p] << "}";
        }
        body << "]}";
    }
    body << "]";
}

void append_stockpiles(std::ostringstream& body, const df::hauling_stop* stop) {
    body << "[";
    for (size_t i = 0; i < stop->stockpiles.size(); ++i) {
        if (i) body << ",";
        auto link = stop->stockpiles[i];
        body << "{\"buildingId\":" << link->building_id
             << ",\"take\":" << (link->mode.bits.take ? "true" : "false")
             << ",\"give\":" << (link->mode.bits.give ? "true" : "false")
             << "}";
    }
    body << "]";
}

// hauling_stop.settings IS a df::stockpile_settings -- the same struct a stockpile carries. Only
// the top-level groups are summarised here; item detail rides /hauling-stop-settings-snapshot.
void append_desired_groups(std::ostringstream& body, const df::hauling_stop* stop) {
    const auto& f = stop->settings.flags.bits;
    auto jb = [](bool v) { return v ? "true" : "false"; };
    body << "{\"animals\":" << jb(f.animals) << ",\"food\":" << jb(f.food)
         << ",\"furniture\":" << jb(f.furniture) << ",\"corpses\":" << jb(f.corpses)
         << ",\"refuse\":" << jb(f.refuse) << ",\"stone\":" << jb(f.stone)
         << ",\"ammo\":" << jb(f.ammo) << ",\"coins\":" << jb(f.coins)
         << ",\"bars_blocks\":" << jb(f.bars_blocks) << ",\"gems\":" << jb(f.gems)
         << ",\"finished_goods\":" << jb(f.finished_goods) << ",\"leather\":" << jb(f.leather)
         << ",\"cloth\":" << jb(f.cloth) << ",\"wood\":" << jb(f.wood)
         << ",\"weapons\":" << jb(f.weapons) << ",\"armor\":" << jb(f.armor)
         << ",\"sheet\":" << jb(f.sheet) << "}";
}

void append_stop(std::ostringstream& body, const df::hauling_stop* stop) {
    body << "{\"id\":" << stop->id
         << ",\"name\":" << json_string(stop->name)
         << ",\"x\":" << stop->pos.x << ",\"y\":" << stop->pos.y << ",\"z\":" << stop->pos.z
         << ",\"cartId\":" << stop->cart_id
         << ",\"timeWaiting\":" << stop->time_waiting
         << ",\"desired\":";
    append_desired_groups(body, stop);
    body << ",\"conditions\":";
    append_conditions(body, stop);
    body << ",\"stockpiles\":";
    append_stockpiles(body, stop);
    body << "}";
}

// vehicle_ids holds df::vehicle ids, and vehicle_stops is its PARALLEL vector of indexes into
// route->stops. The client gets the cart's item id and the stop it is currently at.
void append_route_vehicles(std::ostringstream& body, const df::hauling_route* route) {
    body << "[";
    for (size_t i = 0; i < route->vehicle_ids.size(); ++i) {
        if (i) body << ",";
        int32_t vid = route->vehicle_ids[i];
        auto vehicle = df::vehicle::find(vid);
        int32_t stop_index = i < route->vehicle_stops.size() ? route->vehicle_stops[i] : -1;
        int32_t stop_id = -1;
        if (stop_index >= 0 && stop_index < static_cast<int32_t>(route->stops.size()) &&
                route->stops[stop_index])
            stop_id = route->stops[stop_index]->id;
        body << "{\"vehicleId\":" << vid
             << ",\"itemId\":" << (vehicle ? vehicle->item_id : -1)
             << ",\"stopIndex\":" << stop_index
             << ",\"stopId\":" << stop_id
             << ",\"onTrack\":" << (vehicle && vehicle->flag.bits.ON_TRACK ? "true" : "false")
             << "}";
    }
    body << "]";
}

void append_route(std::ostringstream& body, const df::hauling_route* route) {
    body << "{\"id\":" << route->id
         << ",\"name\":" << json_string(route->name)
         << ",\"stops\":[";
    for (size_t i = 0; i < route->stops.size(); ++i) {
        if (i) body << ",";
        append_stop(body, route->stops[i]);
    }
    body << "],\"vehicleIds\":[";
    for (size_t i = 0; i < route->vehicle_ids.size(); ++i) {
        if (i) body << ",";
        body << route->vehicle_ids[i];
    }
    body << "],\"vehicles\":";
    append_route_vehicles(body, route);
    body << "}";
}

// Free minecarts: every df::vehicle whose route_id is -1. Feeds the client's vehicle picker.
std::string free_vehicles_json() {
    std::ostringstream body;
    run_hauling_locked([&]() -> bool {
        body << "{\"vehicles\":[";
        bool first = true;
        auto world = df::global::world;
        if (world) {
            for (auto vehicle : world->vehicles.active) {
                if (!vehicle || vehicle->route_id != -1)
                    continue;
                auto item = df::item::find(vehicle->item_id);
                if (!first) body << ",";
                first = false;
                body << "{\"vehicleId\":" << vehicle->id
                     << ",\"itemId\":" << vehicle->item_id
                     << ",\"name\":"
                     << json_string(item ? Items::getDescription(item, 0, false) : "minecart")
                     << "}";
            }
        }
        body << "]}\n";
        return true;
    });
    return body.str();
}

std::string hauling_list_json(const std::string& player) {
    std::ostringstream body;
    run_hauling_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        body << "{\"player\":" << json_string(player) << ",\"routes\":[";
        if (plotinfo) {
            bool first = true;
            for (auto route : plotinfo->hauling.routes) {
                if (!route)
                    continue;
                if (!first) body << ",";
                first = false;
                append_route(body, route);
            }
        }
        body << "]}\n";
        return true;
    });
    return body.str();
}

// ---- mutations (all under run_hauling_locked -> CoreSuspender) -------------

int32_t do_route_create(const std::string& name, std::string* err) {
    int32_t new_id = -1;
    run_hauling_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        auto route = df::allocate<df::hauling_route>();
        if (!route) { if (err) *err = "allocation failed"; return false; }
        route->id = next_hauling_id();
        route->name = name;
        plotinfo->hauling.routes.push_back(route);
        new_id = route->id;
        return true;
    });
    return new_id;
}

bool do_route_rename(int32_t id, const std::string& name, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(id);
        if (!route) { if (err) *err = "route not found"; return false; }
        route->name = name;
        return true;
    });
}

// Same two-step lookup and the same error strings as do_stop_link, so a bad route id and a bad
// stop id stay distinguishable.
bool do_stop_rename(int32_t route_id, int32_t stop_id, const std::string& name, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto stop = find_stop(route, stop_id);
        if (!stop) { if (err) *err = "stop not found"; return false; }
        stop->name = name;
        return true;
    });
}

bool do_route_remove(int32_t id, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        auto route = find_route(id);
        if (!route) { if (err) *err = "route not found"; return false; }
        // Release the carts FIRST: freeing the route while a vehicle still carries its id leaves
        // DF's hauling tick binsearching for a route that no longer exists.
        release_route_vehicles(route);
        // Purge the native menu's pointer caches of this route and its stops BEFORE any free.
        purge_view_route(plotinfo, route);
        // Null-guard before walking a stop's children -- a null slot is a deref-then-free hazard.
        // These deletes free objects this module allocated with df::allocate<T>().
        for (auto stop : route->stops) {
            if (!stop) continue;
            for (auto cond : stop->conditions) delete cond;
            for (auto link : stop->stockpiles) delete link;
            delete stop;
        }
        auto& list = plotinfo->hauling.routes;
        auto it = std::find(list.begin(), list.end(), route);
        if (it == list.end()) { if (err) *err = "route not tracked in plotinfo"; return false; }
        list.erase(it);
        delete route;
        return true;
    });
}

// A single tile, not a rect, converted to a world position the same way the paint routes do.
int32_t do_stop_add(const Camera& camera, int frame_w, int frame_h, int32_t route_id, int px,
                     int py, const std::string& name, std::string* err) {
    int32_t new_id = -1;
    run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        int probe_w = 0, probe_h = 0;
        if (!effective_capture_viewport_dims(camera, probe_w, probe_h, err)) {
            if (err && err->empty()) *err = "viewport unavailable";
            return false;
        }
        int tx = pixel_to_tile_index(px, frame_w);
        int ty = pixel_to_tile_index(py, frame_h);
        auto stop = df::allocate<df::hauling_stop>();
        if (!stop) { if (err) *err = "allocation failed"; return false; }
        stop->id = next_hauling_id();
        stop->name = name;
        stop->pos = df::coord(camera.x + tx, camera.y + ty, camera.z);
        stop->cart_id = -1;
        route->stops.push_back(stop);
        new_id = stop->id;
        return true;
    });
    return new_id;
}

bool do_stop_remove(int32_t route_id, int32_t stop_id, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto stop = find_stop(route, stop_id);
        if (!stop) { if (err) *err = "stop not found"; return false; }
        auto& list = route->stops;
        auto it = std::find(list.begin(), list.end(), stop);
        if (it == list.end()) { if (err) *err = "stop not tracked in route"; return false; }
        const int32_t removed_index = static_cast<int32_t>(std::distance(list.begin(), it));

        // Purge the native view_stops/view_bad caches of this stop BEFORE freeing it.
        if (auto plotinfo = df::global::plotinfo) purge_view_stop(plotinfo, stop);
        for (auto cond : stop->conditions) delete cond;
        for (auto link : stop->stockpiles) delete link;
        list.erase(it);
        delete stop;

        // vehicle_stops holds INDEXES into route->stops, so erasing a stop shifts every later one.
        // A route left with no stops must release its carts: DF will not bind one to a stopless route.
        if (list.empty()) {
            release_route_vehicles(route);
            return true;
        }
        const int32_t last = static_cast<int32_t>(list.size()) - 1;
        for (auto& idx : route->vehicle_stops) {
            if (idx > removed_index) idx -= 1;
            if (idx < 0) idx = 0;
            if (idx > last) idx = last;
        }
        return true;
    });
}

bool do_stop_link(int32_t route_id, int32_t stop_id, int32_t building_id, bool take, bool give,
                  std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto stop = find_stop(route, stop_id);
        if (!stop) { if (err) *err = "stop not found"; return false; }
        auto building = df::building::find(building_id);
        if (!virtual_cast<df::building_stockpilest>(building)) {
            if (err) *err = "building is not a stockpile";
            return false;
        }
        for (auto link : stop->stockpiles) {
            if (link->building_id == building_id) {
                link->mode.bits.take = take;
                link->mode.bits.give = give;
                return true;
            }
        }
        auto link = df::allocate<df::route_stockpile_link>();
        if (!link) { if (err) *err = "allocation failed"; return false; }
        link->building_id = building_id;
        link->mode.bits.take = take;
        link->mode.bits.give = give;
        stop->stockpiles.push_back(link);
        return true;
    });
}

bool do_stop_link_remove(int32_t route_id, int32_t stop_id, int32_t building_id,
                         std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto stop = find_stop(route, stop_id);
        if (!stop) { if (err) *err = "stop not found"; return false; }
        auto& list = stop->stockpiles;
        auto it = std::find_if(list.begin(), list.end(),
                               [&](df::route_stockpile_link* l) { return l->building_id == building_id; });
        if (it == list.end()) { if (err) *err = "link not found"; return false; }
        delete *it;
        list.erase(it);
        return true;
    });
}

// Appends a depart condition. DF supports several simultaneous leave conditions; this offers add
// and index-based remove only, so an edit is delete-then-re-add.
bool do_stop_condition_add(int32_t route_id, int32_t stop_id, int timeout,
                           const std::string& direction, const std::string& mode,
                           int load_percent, bool at_most, bool desired, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto stop = find_stop(route, stop_id);
        if (!stop) { if (err) *err = "stop not found"; return false; }
        auto cond = df::allocate<df::stop_depart_condition>();
        if (!cond) { if (err) *err = "allocation failed"; return false; }
        cond->timeout = timeout;
        if (direction == "south") cond->direction = df::stop_depart_condition::South;
        else if (direction == "east") cond->direction = df::stop_depart_condition::East;
        else if (direction == "west") cond->direction = df::stop_depart_condition::West;
        else cond->direction = df::stop_depart_condition::North;
        if (mode == "ride") cond->mode = df::stop_depart_condition::Ride;
        else if (mode == "guide") cond->mode = df::stop_depart_condition::Guide;
        else cond->mode = df::stop_depart_condition::Push;
        // DF renders load_percent only at 0, 50 or 100, so snap rather than write a value the
        // player can never read back.
        cond->load_percent = load_percent <= 25 ? 0 : (load_percent >= 75 ? 100 : 50);
        cond->flags.bits.at_most = at_most;   // leave when at MOST load% full
        cond->flags.bits.desired = desired;   // gate on stop->settings, not bulk fullness
        // guide_path is DELIBERATELY left empty: DF's own pathfinder authors it on the first run.
        stop->conditions.push_back(cond);
        return true;
    });
}

bool do_stop_condition_remove(int32_t route_id, int32_t stop_id, int index, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto stop = find_stop(route, stop_id);
        if (!stop) { if (err) *err = "stop not found"; return false; }
        if (index < 0 || index >= static_cast<int>(stop->conditions.size())) {
            if (err) *err = "condition index out of range";
            return false;
        }
        delete stop->conditions[index];
        stop->conditions.erase(stop->conditions.begin() + index);
        return true;
    });
}

// Binds or releases a MINECART. The write set is DFHack's own: vehicle_ids += vehicle.id (never
// the item id), vehicle_stops += 0 in lockstep, and vehicle.route_id = route.id.
bool do_vehicle_assign(int32_t route_id, int32_t item_id, bool on, std::string* err) {
    return run_hauling_locked([&]() -> bool {
        auto route = find_route(route_id);
        if (!route) { if (err) *err = "route not found"; return false; }
        auto item = df::item::find(item_id);
        if (!item) { if (err) *err = "item not found"; return false; }
        if (!item_is_minecart(item)) {
            // Wheelbarrows land here on purpose: stockpile equipment, with no vehicle to bind.
            if (err) *err = "only a minecart can be assigned to a hauling route "
                            "(a wheelbarrow is assigned to a stockpile instead)";
            return false;
        }
        auto vehicle = vehicle_for_item(item);
        if (!vehicle) {
            // DF creates a minecart's df::vehicle record; this module never allocates one.
            if (err) *err = "this minecart has no vehicle record yet -- DF creates one when the "
                            "cart is finished and hauled to the map";
            return false;
        }

        auto& ids = route->vehicle_ids;
        auto& stops = route->vehicle_stops;
        auto it = std::find(ids.begin(), ids.end(), vehicle->id);
        const bool present = it != ids.end();

        if (!on) {
            if (!present) return true;   // idempotent
            const size_t idx = static_cast<size_t>(std::distance(ids.begin(), it));
            vehicle->route_id = -1;                       // release BEFORE dropping the binding
            ids.erase(it);
            if (idx < stops.size())                       // keep the two vectors in lockstep
                stops.erase(stops.begin() + idx);
            return true;
        }

        if (present) return true;        // idempotent
        if (route->stops.empty()) {
            // vehicle_stops indexes into route.stops, so a stopless route would store an index
            // into an empty vector.
            if (err) *err = "add at least one stop before assigning a minecart to this route";
            return false;
        }
        if (vehicle->route_id != -1 && vehicle->route_id != route->id) {
            if (err) *err = "that minecart is already assigned to route " +
                            std::to_string(vehicle->route_id);
            return false;
        }

        ids.push_back(vehicle->id);   // VEHICLE id
        stops.push_back(0);           // parallel entry: cart starts at stop index 0
        vehicle->route_id = route->id;
        return true;
    });
}

} // namespace

void register_hauling_routes(httplib::Server& server) {
    // GET /hauling?player= -> all routes with full stop detail (small dataset, no pagination).
    server.Get("/hauling", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        set_no_store_json(res, hauling_list_json(player));
    });

    // POST /hauling-route-create?name=
    auto route_create_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string name = req.has_param("name") ? req.get_param_value("name") : "New Route";
        if (name.size() > 64) name.resize(64);
        std::string err;
        int32_t id = do_route_create(name, &err);
        if (id < 0) { json_error(res, 400, err.empty() ? "create failed" : err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true,\"id\":" + std::to_string(id) + "}\n");
    };
    server.Get("/hauling-route-create", route_create_handler);
    server.Post("/hauling-route-create", route_create_handler);

    // POST /hauling-route-rename?id=&name=
    auto route_rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || !req.has_param("name")) {
            json_error(res, 400, "missing id/name");
            return;
        }
        std::string name = req.get_param_value("name");
        if (name.size() > 64) name.resize(64);
        std::string err;
        if (!do_route_rename(id, name, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-route-rename", route_rename_handler);
    server.Post("/hauling-route-rename", route_rename_handler);

    // POST /hauling-stop-rename?route=&stop=&name=
    auto stop_rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
            !req.has_param("name")) {
            json_error(res, 400, "missing route/stop/name");
            return;
        }
        std::string name = req.get_param_value("name");
        if (name.size() > 64) name.resize(64);
        std::string err;
        if (!do_stop_rename(route_id, stop_id, name, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-rename", stop_rename_handler);
    server.Post("/hauling-stop-rename", stop_rename_handler);

    // POST /hauling-route-remove?id=
    auto route_remove_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) { json_error(res, 400, "missing id"); return; }
        // Deleting a hauling route is open to every authenticated player: small-group co-op, no
        // anti-griefing gate. do_route_remove releases the carts and purges the caches first.
        std::string err;
        if (!do_route_remove(id, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-route-remove", route_remove_handler);
    server.Post("/hauling-route-remove", route_remove_handler);

    // POST /hauling-stop-add?player=&route=&px=&py=&w=&h=&name=
    auto stop_add_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int route_id = -1, px = 0, py = 0, frame_w = 0, frame_h = 0;
        if (!query_int(req, "route", route_id) || !query_int(req, "px", px) ||
                !query_int(req, "py", py) || !query_int(req, "w", frame_w) ||
                !query_int(req, "h", frame_h)) {
            json_error(res, 400, "missing route/px/py/w/h");
            return;
        }
        std::string name = req.has_param("name") ? req.get_param_value("name") : "Stop";
        if (name.size() > 64) name.resize(64);
        Camera camera;
        std::string err;
        if (!camera_for_player(player, camera, &err)) {
            json_error(res, 503, err.empty() ? "camera unavailable" : err);
            return;
        }
        int32_t id = do_stop_add(camera, frame_w, frame_h, route_id, px, py, name, &err);
        if (id < 0) { json_error(res, 400, err.empty() ? "stop add failed" : err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true,\"id\":" + std::to_string(id) + "}\n");
    };
    server.Get("/hauling-stop-add", stop_add_handler);
    server.Post("/hauling-stop-add", stop_add_handler);

    // POST /hauling-stop-remove?route=&stop=
    auto stop_remove_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id)) {
            json_error(res, 400, "missing route/stop");
            return;
        }
        // Same delete family as /hauling-route-remove: open to every authenticated player.
        std::string err;
        if (!do_stop_remove(route_id, stop_id, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-remove", stop_remove_handler);
    server.Post("/hauling-stop-remove", stop_remove_handler);

    // POST /hauling-stop-link?route=&stop=&building=&take=1&give=1
    auto stop_link_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1, building_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
                !query_int(req, "building", building_id)) {
            json_error(res, 400, "missing route/stop/building");
            return;
        }
        int take = 1, give = 1;
        query_int(req, "take", take);
        query_int(req, "give", give);
        std::string err;
        if (!do_stop_link(route_id, stop_id, building_id, take != 0, give != 0, &err)) {
            json_error(res, 400, err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-link", stop_link_handler);
    server.Post("/hauling-stop-link", stop_link_handler);

    // POST /hauling-stop-link-remove?route=&stop=&building=
    auto stop_link_remove_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1, building_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
                !query_int(req, "building", building_id)) {
            json_error(res, 400, "missing route/stop/building");
            return;
        }
        std::string err;
        if (!do_stop_link_remove(route_id, stop_id, building_id, &err)) {
            json_error(res, 400, err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-link-remove", stop_link_remove_handler);
    server.Post("/hauling-stop-link-remove", stop_link_remove_handler);

    // POST /hauling-stop-conditions?route=&stop=&timeout=&direction=&mode=&load=
    auto stop_conditions_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id)) {
            json_error(res, 400, "missing route/stop");
            return;
        }
        int timeout = 0, load = 100, at_most = 0, desired = 0;
        query_int(req, "timeout", timeout);
        query_int(req, "load", load);
        query_int(req, "atmost", at_most);
        query_int(req, "desired", desired);
        std::string direction = req.has_param("direction") ? req.get_param_value("direction") : "north";
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "push";
        std::string err;
        if (!do_stop_condition_add(route_id, stop_id, timeout, direction, mode, load,
                                   at_most != 0, desired != 0, &err)) {
            json_error(res, 400, err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-conditions", stop_conditions_handler);
    server.Post("/hauling-stop-conditions", stop_conditions_handler);

    // POST /hauling-stop-conditions-remove?route=&stop=&index=
    auto stop_conditions_remove_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1, index = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
                !query_int(req, "index", index)) {
            json_error(res, 400, "missing route/stop/index");
            return;
        }
        std::string err;
        if (!do_stop_condition_remove(route_id, stop_id, index, &err)) {
            json_error(res, 400, err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-conditions-remove", stop_conditions_remove_handler);
    server.Post("/hauling-stop-conditions-remove", stop_conditions_remove_handler);

    // POST /hauling-vehicle-assign?route=&item=&on=1
    auto vehicle_assign_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, item_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "item", item_id)) {
            json_error(res, 400, "missing route/item");
            return;
        }
        int on = 1;
        query_int(req, "on", on);
        std::string err;
        if (!do_vehicle_assign(route_id, item_id, on != 0, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-vehicle-assign", vehicle_assign_handler);
    server.Post("/hauling-vehicle-assign", vehicle_assign_handler);

    // GET /hauling-vehicles -> the free-minecart pool, so the client can offer a picker instead of
    // an item id the player has no way to discover.
    server.Get("/hauling-vehicles", [](const httplib::Request& req, httplib::Response& res) {
        (void)req;
        set_no_store_json(res, free_vehicles_json());
    });

    // hauling_stop.settings IS a stockpile_settings, so these four endpoints are the /stockpile-*
    // settings editor pointed at a stop, through the same Lua. No second copy of the filter exists.
    server.Get("/hauling-stop-settings-snapshot", [](const httplib::Request& req,
                                                     httplib::Response& res) {
        int route_id = -1, stop_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id)) {
            json_error(res, 400, "missing route/stop");
            return;
        }
        std::string err;
        std::string json = hauling_stop_settings_snapshot_via_lua(route_id, stop_id, &err);
        if (json.empty()) { json_error(res, 500, err.empty() ? "snapshot failed" : err); return; }
        set_no_store_json(res, json);
    });

    server.Get("/hauling-stop-items", [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
                !req.has_param("cat")) {
            json_error(res, 400, "missing route/stop/cat");
            return;
        }
        std::string group = req.has_param("group") ? req.get_param_value("group") : "";
        std::string err;
        std::string json = hauling_stop_items_via_lua(route_id, stop_id,
                                                      req.get_param_value("cat"), group, &err);
        if (json.empty()) { json_error(res, 500, err.empty() ? "items failed" : err); return; }
        set_no_store_json(res, json);
    });

    auto stop_toggle_item_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1, idx = -1, on = 0;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
                !req.has_param("cat") || !query_int(req, "idx", idx)) {
            json_error(res, 400, "missing route/stop/cat/idx");
            return;
        }
        query_int(req, "on", on);
        std::string group = req.has_param("group") ? req.get_param_value("group") : "";
        std::string err;
        if (!hauling_stop_toggle_item_via_lua(route_id, stop_id, req.get_param_value("cat"),
                                              group, idx, on != 0, &err)) {
            json_error(res, 400, err.empty() ? "toggle failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-toggle-item", stop_toggle_item_handler);
    server.Post("/hauling-stop-toggle-item", stop_toggle_item_handler);

    auto stop_toggle_all_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1, on = 0;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id) ||
                !req.has_param("cat")) {
            json_error(res, 400, "missing route/stop/cat");
            return;
        }
        query_int(req, "on", on);
        std::string group = req.has_param("group") ? req.get_param_value("group") : "";
        std::string err;
        if (!hauling_stop_toggle_all_via_lua(route_id, stop_id, req.get_param_value("cat"),
                                             group, on != 0, &err)) {
            json_error(res, 400, err.empty() ? "toggle-all failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-toggle-all", stop_toggle_all_handler);
    server.Post("/hauling-stop-toggle-all", stop_toggle_all_handler);

    // The group-level preset (stone, food, "none", ...), same vocabulary as /stockpile-set.
    auto stop_preset_handler = [](const httplib::Request& req, httplib::Response& res) {
        int route_id = -1, stop_id = -1;
        if (!query_int(req, "route", route_id) || !query_int(req, "stop", stop_id)) {
            json_error(res, 400, "missing route/stop");
            return;
        }
        std::string preset = req.has_param("preset") ? req.get_param_value("preset") : "all";
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "set";
        std::string err;
        if (!hauling_stop_set_preset_via_lua(route_id, stop_id, preset, mode, &err)) {
            json_error(res, 400, err.empty() ? "preset failed" : err);
            return;
        }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hauling-stop-preset", stop_preset_handler);
    server.Post("/hauling-stop-preset", stop_preset_handler);
}

} // namespace dwf
