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

#include "lever_link.h"
#include "fort_stock.h"
#include "interaction.h"

#include "Core.h"
#include "http_server.h"
#include "json_util.h"
#include "sdl_capture.h"

#include "modules/Buildings.h"
#include "modules/Items.h"
#include "modules/Job.h"

#include "df/building.h"
#include "df/item_trappartsst.h"
#include "df/building_actual.h"
#include "df/building_bars_floorst.h"
#include "df/building_bars_verticalst.h"
#include "df/building_bridgest.h"
#include "df/building_cagest.h"
#include "df/building_chainst.h"
#include "df/building_doorst.h"
#include "df/building_floodgatest.h"
#include "df/building_gear_assemblyst.h"
#include "df/building_grate_floorst.h"
#include "df/building_grate_wallst.h"
#include "df/building_hatchst.h"
#include "df/building_rollersst.h"
#include "df/building_trapst.h"
#include "df/building_type.h"
#include "df/building_weaponst.h"
#include "df/general_ref_building_holderst.h"
#include "df/general_ref_building_triggertargetst.h"
#include "df/item.h"
#include "df/item_flags.h"
#include "df/items_other.h"
#include "df/job.h"
#include "df/job_role_type.h"
#include "df/job_type.h"
#include "df/trap_type.h"
#include "df/world.h"
#include "df/global_objects.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_lever_link_mutex;

template <typename Fn>
bool run_lever_link_locked(Fn&& fn) {
    std::lock_guard<std::recursive_mutex> link_lock(g_lever_link_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    return fn();
}

struct MechanismRow {
    int32_t id = -1;
    std::string name;
    int32_t x = 0, y = 0, z = 0;
};

struct TargetRow {
    int32_t id = -1;
    std::string name;
    std::string type;
    int32_t x = 0, y = 0, z = 0;
    int32_t distance = 0;
};

std::string building_name_or_fallback(df::building* b, const std::string& fallback) {
    std::string name = Buildings::getName(b);
    if (!name.empty()) return name;
    return fallback + " #" + std::to_string(b ? b->id : -1);
}

bool built_actual(df::building* b) {
    return b && b->isActual() && b->getBuildStage() >= b->getMaxBuildStage() &&
           !Buildings::markedForRemoval(b);
}

bool is_lever(df::building* b) {
    auto trap = virtual_cast<df::building_trapst>(b);
    return trap && trap->trap_type == df::trap_type::Lever && built_actual(b);
}

bool linkable_target(df::building* b, std::string& label) {
    if (!built_actual(b)) return false;
    switch (b->getType()) {
    case df::building_type::Floodgate:
        if (virtual_cast<df::building_floodgatest>(b)) { label = "Floodgate"; return true; }
        return false;
    case df::building_type::Bridge:
        if (auto bridge = virtual_cast<df::building_bridgest>(b)) {
            if (bridge->direction == df::building_bridgest::Retracting) {
                label = "Bridge";
                return true;
            }
        }
        return false;
    case df::building_type::Door:
        if (virtual_cast<df::building_doorst>(b)) { label = "Door"; return true; }
        return false;
    case df::building_type::Hatch:
        if (virtual_cast<df::building_hatchst>(b)) { label = "Hatch"; return true; }
        return false;
    case df::building_type::GrateFloor:
        if (virtual_cast<df::building_grate_floorst>(b)) { label = "Floor Grate"; return true; }
        return false;
    case df::building_type::GrateWall:
        if (virtual_cast<df::building_grate_wallst>(b)) { label = "Wall Grate"; return true; }
        return false;
    case df::building_type::BarsFloor:
        if (virtual_cast<df::building_bars_floorst>(b)) { label = "Floor Bars"; return true; }
        return false;
    case df::building_type::BarsVertical:
        if (virtual_cast<df::building_bars_verticalst>(b)) { label = "Vertical Bars"; return true; }
        return false;
    case df::building_type::Cage:
        if (virtual_cast<df::building_cagest>(b)) { label = "Cage"; return true; }
        return false;
    case df::building_type::Chain:
        if (virtual_cast<df::building_chainst>(b)) { label = "Chain"; return true; }
        return false;
    case df::building_type::GearAssembly:
        if (virtual_cast<df::building_gear_assemblyst>(b)) { label = "Gear Assembly"; return true; }
        return false;
    case df::building_type::Weapon:
        if (virtual_cast<df::building_weaponst>(b)) { label = "Spike"; return true; }
        return false;
    case df::building_type::Trap:
        if (auto trap = virtual_cast<df::building_trapst>(b)) {
            if (trap->trap_type == df::trap_type::TrackStop) { label = "Track Stop"; return true; }
        }
        return false;
    case df::building_type::Rollers:
        if (virtual_cast<df::building_rollersst>(b)) { label = "Roller"; return true; }
        return false;
    default:
        return false;
    }
}

bool available_mechanism(df::item* item) {
    return is_fort_stock_item(item, FortItemPurpose::Available) &&
           item->getType() == df::item_type::TRAPPARTS && !item->flags.bits.hidden;
}

std::vector<MechanismRow> collect_mechanisms() {
    std::vector<MechanismRow> rows;
    auto world = df::global::world;
    if (!world) return rows;
    for (auto* item : world->items.other.TRAPPARTS) {
        if (!available_mechanism(item)) continue;
        df::coord pos = Items::getPosition(item);
        rows.push_back({item->id, item_display_name(item, 0, false), pos.x, pos.y, pos.z});
    }
    std::sort(rows.begin(), rows.end(), [](const MechanismRow& a, const MechanismRow& b) {
        return a.id < b.id;
    });
    return rows;
}

std::vector<TargetRow> collect_targets(df::building* lever) {
    std::vector<TargetRow> rows;
    auto world = df::global::world;
    if (!world || !lever) return rows;
    for (auto* b : world->buildings.all) {
        if (!b || b->id == lever->id) continue;
        std::string type;
        if (!linkable_target(b, type)) continue;
        int dz = std::abs(b->z - lever->z);
        int dist = std::abs(b->centerx - lever->centerx) + std::abs(b->centery - lever->centery) + dz * 10;
        rows.push_back({b->id, building_name_or_fallback(b, type), type, b->centerx, b->centery, b->z, dist});
    }
    std::sort(rows.begin(), rows.end(), [](const TargetRow& a, const TargetRow& b) {
        if (a.distance != b.distance) return a.distance < b.distance;
        return a.id < b.id;
    });
    return rows;
}

void append_mechanisms_json(std::ostringstream& out, const std::vector<MechanismRow>& rows) {
    out << "[";
    for (size_t i = 0; i < rows.size(); ++i) {
        const auto& r = rows[i];
        if (i) out << ",";
        out << "{\"id\":" << r.id
            << ",\"name\":" << json_string(r.name)
            << ",\"x\":" << r.x << ",\"y\":" << r.y << ",\"z\":" << r.z << "}";
    }
    out << "]";
}

void append_targets_json(std::ostringstream& out, const std::vector<TargetRow>& rows) {
    out << "[";
    for (size_t i = 0; i < rows.size(); ++i) {
        const auto& r = rows[i];
        if (i) out << ",";
        out << "{\"id\":" << r.id
            << ",\"name\":" << json_string(r.name)
            << ",\"type\":" << json_string(r.type)
            << ",\"x\":" << r.x << ",\"y\":" << r.y << ",\"z\":" << r.z
            << ",\"distance\":" << r.distance << "}";
    }
    out << "]";
}

std::string lever_link_json(int32_t lever_id, std::string* err) {
    std::ostringstream out;
    bool ok = run_lever_link_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { if (err) *err = "world unavailable"; return false; }
        auto lever = df::building::find(lever_id);
        if (!lever) { if (err) *err = "building not found"; return false; }
        if (!is_lever(lever)) {
            out << "{\"ok\":true,\"id\":" << lever_id << ",\"isLever\":false}\n";
            return true;
        }
        auto mechanisms = collect_mechanisms();
        auto targets = collect_targets(lever);
        out << "{\"ok\":true,\"id\":" << lever_id
            << ",\"isLever\":true"
            << ",\"name\":" << json_string(building_name_or_fallback(lever, "Lever"))
            << ",\"mechanismCount\":" << mechanisms.size()
            << ",\"needsMechanisms\":" << (mechanisms.size() < 2 ? "true" : "false")
            << ",\"mechanisms\":";
        append_mechanisms_json(out, mechanisms);
        out << ",\"targets\":";
        append_targets_json(out, targets);
        out << "}\n";
        return true;
    });
    if (!ok) return "";
    return out.str();
}

void delete_unlinked_job(df::job* job) {
    if (!job) return;
    for (auto* item_ref : job->items)
        Job::disconnectJobItem(job, item_ref);
    Job::deleteJobStruct(job, true);
}

bool queue_link_job(int32_t lever_id, int32_t target_id, int32_t& job_id,
                    int32_t& trigger_mech_id, int32_t& target_mech_id, std::string* err) {
    return run_lever_link_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { if (err) *err = "world unavailable"; return false; }
        auto lever = df::building::find(lever_id);
        if (!is_lever(lever)) { if (err) *err = "building is not a built lever"; return false; }
        auto target = df::building::find(target_id);
        std::string target_label;
        if (!target || !linkable_target(target, target_label)) {
            if (err) *err = "target is not linkable";
            return false;
        }
        auto mechanisms = collect_mechanisms();
        if (mechanisms.size() < 2) {
            if (err) *err = "needs mechanisms";
            return false;
        }
        auto trigger_mech = df::item::find(mechanisms[0].id);
        auto target_mech = df::item::find(mechanisms[1].id);
        if (!available_mechanism(trigger_mech) || !available_mechanism(target_mech) || trigger_mech == target_mech) {
            if (err) *err = "mechanisms no longer available";
            return false;
        }

        auto holder_ref = df::allocate<df::general_ref_building_holderst>();
        auto target_ref = df::allocate<df::general_ref_building_triggertargetst>();
        auto job = new df::job();
        if (!holder_ref || !target_ref || !job) {
            delete holder_ref;
            delete target_ref;
            delete job;
            if (err) *err = "allocation failed";
            return false;
        }
        holder_ref->building_id = lever->id;
        target_ref->building_id = target->id;
        job->job_type = df::job_type::LinkBuildingToTrigger;
        job->pos = df::coord(lever->centerx, lever->centery, lever->z);

        if (!Job::attachJobItem(job, trigger_mech, df::job_role_type::LinkToTrigger) ||
            !Job::attachJobItem(job, target_mech, df::job_role_type::LinkToTarget)) {
            delete_unlinked_job(job);
            delete holder_ref;
            delete target_ref;
            if (err) *err = "failed to reserve mechanisms";
            return false;
        }
        job->general_refs.push_back(holder_ref);
        job->general_refs.push_back(target_ref);
        lever->jobs.push_back(job);
        if (!Job::linkIntoWorld(job)) {
            auto it = std::find(lever->jobs.begin(), lever->jobs.end(), job);
            if (it != lever->jobs.end()) lever->jobs.erase(it);
            delete_unlinked_job(job);
            if (err) *err = "failed to queue link job";
            return false;
        }
        job_id = job->id;
        trigger_mech_id = trigger_mech->id;
        target_mech_id = target_mech->id;
        return true;
    });
}

} // namespace

void register_lever_link_routes(httplib::Server& server) {
    server.Get("/lever-link", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing id\"}\n", "application/json; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = lever_link_json(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? "lever-link unavailable" : err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    auto post_link = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1, target = -1;
        if (!query_int(req, "id", id) || !query_int(req, "target", target)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing id/target\"}\n", "application/json; charset=utf-8");
            return;
        }
        int32_t job_id = -1, trigger_mech = -1, target_mech = -1;
        std::string err;
        if (!queue_link_job(id, target, job_id, trigger_mech, target_mech, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? "link failed" : err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"jobId\":" + std::to_string(job_id) +
                        ",\"mechanisms\":[" + std::to_string(trigger_mech) + "," +
                        std::to_string(target_mech) + "]}\n",
                        "application/json; charset=utf-8");
    };
    server.Post("/lever-link", post_link);
}

} // namespace dwf
