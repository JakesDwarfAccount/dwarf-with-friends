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
#include "panel_http.h"
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
#include "df/building_supportst.h"
#include "df/building_trapst.h"
#include "df/building_type.h"
#include "df/building_weaponst.h"
#include "df/general_ref.h"
#include "df/general_ref_building_holderst.h"
#include "df/general_ref_building_triggertargetst.h"
#include "df/general_ref_type.h"
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
    return run_panel_locked(g_lever_link_mutex, std::forward<Fn>(fn));
}

struct MechanismRow {
    int32_t id = -1;
    std::string name;
    int32_t x = 0, y = 0, z = 0;
};

struct TargetKind {
    std::string label;
    std::string effect;
    bool one_shot = false;
    bool responds_to_state = true;  // false = the target ignores the trigger's state byte
    bool danger = false;
};

struct TargetRow {
    int32_t id = -1;
    std::string name;
    std::string type;
    int32_t x = 0, y = 0, z = 0;
    int32_t distance = 0;
    TargetKind kind;
};

struct LinkedRow {
    int32_t id = -1;
    std::string name;
    std::string type;
    bool built = false;
    TargetKind kind;
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

df::building_trapst* trigger_source(df::building* b) {
    auto trap = virtual_cast<df::building_trapst>(b);
    if (!trap || !built_actual(b)) return nullptr;
    if (trap->trap_type == df::trap_type::Lever ||
        trap->trap_type == df::trap_type::PressurePlate) return trap;
    return nullptr;
}

bool is_lever(df::building* b) {
    auto trap = trigger_source(b);
    return trap && trap->trap_type == df::trap_type::Lever;
}

// No build-stage test here, deliberately: collect_linked_targets needs unbuilt linked targets
// named too. linkable_target is the built-only gate used when offering new targets.
bool trigger_target_kind(df::building* b, TargetKind& kind) {
    const auto gate = [&kind](const char* label) {
        kind = { label, "Toggles open and shut", false, true, false };
    };
    if (!b) return false;
    switch (b->getType()) {
    case df::building_type::Floodgate:
        if (virtual_cast<df::building_floodgatest>(b)) { gate("Floodgate"); return true; }
        return false;
    case df::building_type::Bridge:
        if (virtual_cast<df::building_bridgest>(b)) {
            kind = { "Bridge", "Toggles raised and lowered", false, true, false };
            return true;
        }
        return false;
    case df::building_type::Door:
        if (virtual_cast<df::building_doorst>(b)) { gate("Door"); return true; }
        return false;
    case df::building_type::Hatch:
        if (virtual_cast<df::building_hatchst>(b)) { gate("Hatch"); return true; }
        return false;
    case df::building_type::GrateFloor:
        if (virtual_cast<df::building_grate_floorst>(b)) { gate("Floor Grate"); return true; }
        return false;
    case df::building_type::GrateWall:
        if (virtual_cast<df::building_grate_wallst>(b)) { gate("Wall Grate"); return true; }
        return false;
    case df::building_type::BarsFloor:
        if (virtual_cast<df::building_bars_floorst>(b)) { gate("Floor Bars"); return true; }
        return false;
    case df::building_type::BarsVertical:
        if (virtual_cast<df::building_bars_verticalst>(b)) { gate("Vertical Bars"); return true; }
        return false;
    case df::building_type::Cage:
        if (virtual_cast<df::building_cagest>(b)) {
            kind = { "Cage", "One-shot: releases the occupants, on any pull", true, false, false };
            return true;
        }
        return false;
    case df::building_type::Chain:
        if (virtual_cast<df::building_chainst>(b)) {
            kind = { "Chain", "One-shot: releases whatever is chained, on any pull", true, false, false };
            return true;
        }
        return false;
    case df::building_type::Support:
        if (virtual_cast<df::building_supportst>(b)) {
            kind = { "Support", "One-shot: brings the support down, on any pull", true, false, true };
            return true;
        }
        return false;
    case df::building_type::GearAssembly:
        if (virtual_cast<df::building_gear_assemblyst>(b)) {
            kind = { "Gear Assembly", "Toggles engaged and disengaged on every pull", false, false, false };
            return true;
        }
        return false;
    case df::building_type::Weapon:
        if (virtual_cast<df::building_weaponst>(b)) {
            kind = { "Spike", "Toggles retracted and extended", false, true, false };
            return true;
        }
        return false;
    case df::building_type::Trap:
        if (auto trap = virtual_cast<df::building_trapst>(b)) {
            if (trap->trap_type == df::trap_type::TrackStop) {
                kind = { "Track Stop", "Toggles enabled and disabled", false, true, false };
                return true;
            }
        }
        return false;
    default:
        return false;
    }
}

bool linkable_target(df::building* b, TargetKind& kind) {
    return built_actual(b) && trigger_target_kind(b, kind);
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
        TargetKind kind;
        if (!linkable_target(b, kind)) continue;
        int dz = std::abs(b->z - lever->z);
        int dist = std::abs(b->centerx - lever->centerx) + std::abs(b->centery - lever->centery) + dz * 10;
        rows.push_back({b->id, building_name_or_fallback(b, kind.label), kind.label,
                        b->centerx, b->centery, b->z, dist, kind});
    }
    std::sort(rows.begin(), rows.end(), [](const TargetRow& a, const TargetRow& b) {
        if (a.distance != b.distance) return a.distance < b.distance;
        return a.id < b.id;
    });
    return rows;
}

std::vector<LinkedRow> collect_linked_targets(df::building_trapst* trigger) {
    std::vector<LinkedRow> rows;
    if (!trigger) return rows;
    for (auto* mech : trigger->linked_mechanisms) {
        if (!mech) continue;
        for (auto* ref : mech->general_refs) {
            if (!ref || ref->getType() != df::general_ref_type::BUILDING_HOLDER) continue;
            auto* target = ref->getBuilding();
            if (target) {
                TargetKind kind;
                trigger_target_kind(target, kind);
                const std::string label = kind.label.empty() ? std::string("Building") : kind.label;
                rows.push_back({target->id, building_name_or_fallback(target, label), label,
                                target->getBuildStage() >= target->getMaxBuildStage(), kind});
            }
            break;
        }
    }
    return rows;
}

bool pull_job_queued(df::building* lever) {
    if (!lever) return false;
    for (auto* job : lever->jobs)
        if (job && job->job_type == df::job_type::PullLever) return true;
    return false;
}

void append_kind_json(std::ostringstream& out, const TargetKind& kind) {
    out << ",\"effect\":" << json_string(kind.effect)
        << ",\"oneShot\":" << (kind.one_shot ? "true" : "false")
        << ",\"respondsToState\":" << (kind.responds_to_state ? "true" : "false")
        << ",\"danger\":" << (kind.danger ? "true" : "false");
}

void append_linked_json(std::ostringstream& out, const std::vector<LinkedRow>& rows) {
    out << "[";
    for (size_t i = 0; i < rows.size(); ++i) {
        const auto& r = rows[i];
        if (i) out << ",";
        out << "{\"id\":" << r.id
            << ",\"name\":" << json_string(r.name)
            << ",\"type\":" << json_string(r.type)
            << ",\"built\":" << (r.built ? "true" : "false");
        append_kind_json(out, r.kind);
        out << "}";
    }
    out << "]";
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
            << ",\"distance\":" << r.distance;
        append_kind_json(out, r.kind);
        out << "}";
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
        auto trigger = trigger_source(lever);
        if (!trigger) {
            out << "{\"ok\":true,\"id\":" << lever_id << ",\"isLever\":false,\"isTrigger\":false}\n";
            return true;
        }
        const bool lever_source = trigger->trap_type == df::trap_type::Lever;
        const char* source_type = lever_source ? "Lever" : "Pressure Plate";
        auto mechanisms = collect_mechanisms();
        auto targets = collect_targets(lever);
        auto linked = collect_linked_targets(trigger);
        out << "{\"ok\":true,\"id\":" << lever_id
            << ",\"isLever\":" << (lever_source ? "true" : "false")
            << ",\"isTrigger\":true"
            << ",\"sourceType\":" << json_string(source_type)
            << ",\"state\":" << static_cast<int>(trigger->state)
            << ",\"pullQueued\":" << (pull_job_queued(lever) ? "true" : "false")
            << ",\"name\":" << json_string(building_name_or_fallback(lever, source_type))
            << ",\"linkedTargets\":";
        append_linked_json(out, linked);
        out << ",\"mechanismCount\":" << mechanisms.size()
            << ",\"needsMechanisms\":" << (mechanisms.size() < 2 ? "true" : "false")
            << ",\"mechanisms\":";
        append_mechanisms_json(out, mechanisms);
        out << ",\"legalTargets\":";
        append_targets_json(out, targets);
        out << "}\n";
        return true;
    });
    if (!ok) return "";
    return out.str();
}

std::string plate_json(int32_t plate_id, std::string* err) {
    std::ostringstream out;
    bool ok = run_lever_link_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { if (err) *err = "world unavailable"; return false; }
        auto building = df::building::find(plate_id);
        if (!building) { if (err) *err = "building not found"; return false; }
        auto trap = trigger_source(building);
        if (!trap || trap->trap_type != df::trap_type::PressurePlate) {
            out << "{\"ok\":true,\"id\":" << plate_id << ",\"isPlate\":false}\n";
            return true;
        }
        const auto& info = trap->plate_info;
        auto linked = collect_linked_targets(trap);
        out << "{\"ok\":true,\"id\":" << plate_id
            << ",\"isPlate\":true"
            << ",\"name\":" << json_string(building_name_or_fallback(building, "Pressure Plate"))
            << ",\"readyTimeout\":" << trap->ready_timeout
            << ",\"ready\":" << (trap->ready_timeout <= 0 ? "true" : "false")
            << ",\"state\":" << static_cast<int>(trap->state)
            << ",\"resets\":" << (info.flags.bits.resets ? "true" : "false")
            << ",\"citizensTrigger\":" << (info.flags.bits.citizens ? "true" : "false")
            << ",\"units\":" << (info.flags.bits.units ? "true" : "false")
            << ",\"unitMin\":" << info.unit_min << ",\"unitMax\":" << info.unit_max
            << ",\"water\":" << (info.flags.bits.water ? "true" : "false")
            << ",\"waterMin\":" << static_cast<int>(info.water_min)
            << ",\"waterMax\":" << static_cast<int>(info.water_max)
            << ",\"magma\":" << (info.flags.bits.magma ? "true" : "false")
            << ",\"magmaMin\":" << static_cast<int>(info.magma_min)
            << ",\"magmaMax\":" << static_cast<int>(info.magma_max)
            << ",\"track\":" << (info.flags.bits.track ? "true" : "false")
            << ",\"trackMin\":" << info.track_min << ",\"trackMax\":" << info.track_max
            << ",\"linkedTargets\":";
        append_linked_json(out, linked);
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
        if (!trigger_source(lever)) { if (err) *err = "building is not a built lever or plate"; return false; }
        auto target = df::building::find(target_id);
        TargetKind target_kind;
        if (!target || !linkable_target(target, target_kind)) {
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

bool queue_pull_job(int32_t lever_id, int32_t& job_id, std::string* err) {
    return run_lever_link_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { if (err) *err = "world unavailable"; return false; }
        auto lever = df::building::find(lever_id);
        if (!is_lever(lever)) { if (err) *err = "building is not a built lever"; return false; }
        if (pull_job_queued(lever)) { if (err) *err = "a pull is already queued"; return false; }

        auto holder_ref = df::allocate<df::general_ref_building_holderst>();
        auto job = new df::job();
        if (!holder_ref || !job) {
            delete holder_ref;
            delete job;
            if (err) *err = "allocation failed";
            return false;
        }
        holder_ref->building_id = lever->id;
        job->job_type = df::job_type::PullLever;
        job->pos = df::coord(lever->centerx, lever->centery, lever->z);
        job->general_refs.push_back(holder_ref);
        lever->jobs.push_back(job);
        if (!Job::linkIntoWorld(job)) {
            auto it = std::find(lever->jobs.begin(), lever->jobs.end(), job);
            if (it != lever->jobs.end()) lever->jobs.erase(it);
            delete_unlinked_job(job);
            if (err) *err = "failed to queue pull job";
            return false;
        }
        job_id = job->id;
        return true;
    });
}

} // namespace

void register_lever_link_routes(httplib::Server& server) {
    // GET /trigger-info?id= -> read-only lever/pressure-plate sheet: links, mechanisms, legal targets.
    server.Get("/trigger-info", [](const httplib::Request& req, httplib::Response& res) {
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
            res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? "trigger info unavailable" : err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    server.Get("/plate", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing id\"}\n", "application/json; charset=utf-8");
            return;
        }
        std::string err;
        std::string json = plate_json(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? "plate unavailable" : err) + "}\n",
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

    server.Post("/lever-pull", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing id\"}\n", "application/json; charset=utf-8");
            return;
        }
        int32_t job_id = -1;
        std::string err;
        if (!queue_pull_job(id, job_id, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? "pull failed" : err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"jobId\":" + std::to_string(job_id) + "}\n",
                        "application/json; charset=utf-8");
    });
}

} // namespace dwf
