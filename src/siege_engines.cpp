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
// GET /siege-engine        -- one siege engine's state, read-only.
// POST /siege-engine/action          -- set the action mode, which also
//                                       cancels queued fire jobs on the two low rows.
// POST /siege-engine/resting-facing  -- set the bolt thrower's parking direction.
//
// Evidence: rules ledger 0014 and its addendum
// (static reads of the pinned DF 53.15 executable). The facts that
// shape this file:
//
//   * THERE ARE THREE ENGINE KINDS (S3). The bolt thrower is fully live -- its own job types, its
//     own operator routine, and the only kind that re-aims after placement. A two-kind panel is
//     wrong for this build.
//   * THE ACTION FIELD IS A THRESHOLD LADDER, NOT A MODE SWITCH (F1). Every gate in the game is a
//     `<` against 1, 2 or 3 plus one `== 4`. Raising the mode never invalidates what a lower one
//     permitted, so this file reports the raw value and lets the client explain the thresholds.
//   * "LOADED" IS A ROLE TEST, NOT A COUNT. The native list walks contained_items
//     and keeps entries whose building-item role is not the permanent one -- the parts consumed to
//     build the engine carry the permanent role, ammunition does not. That supersedes the older
//     "vector longer than the part count" heuristic and survives a non-standard part count.
//   * THERE IS NO CREW (S4). The building carries no user record and no assigned-unit vector;
//     whoever performs the load or fire job is the operator. Staffing is the fortress-wide siege
//     operator work detail, so there is no per-engine crew list here and none to write.
//
// Writes are deliberately only the two GREEN ones. Facing, jobs, the three cadence timers and the
// engine kind are all RED in the ledger and this file has no path that writes any of them: the
// timers are counters the tick handler owns, an injected job passes none of the tick handler's own
// duplicate tests, and the kind is a bare field write that would leave the contained items and the
// ammo slot index describing a different engine. The focused fixture greps for that.

#include "siege_engines.h"

#include "Core.h"
#include "http_server.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Buildings.h"
#include "modules/Job.h"

#include "df/building.h"
#include "df/building_siegeenginest.h"
#include "df/buildingitemst.h"
#include "df/item.h"
#include "df/job.h"
#include "df/unit.h"

#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_siege_mutex;

template <typename Fn>
bool run_siege_locked(Fn&& fn) {
    return run_panel_locked(g_siege_mutex, std::forward<Fn>(fn));
}

static_assert(static_cast<int>(df::job_type::LoadCatapult) == 0x87, "ledger S3: load catapult");
static_assert(static_cast<int>(df::job_type::LoadBallista) == 0x88, "ledger S3: load ballista");
static_assert(static_cast<int>(df::job_type::FireCatapult) == 0x89, "ledger S3: fire catapult");
static_assert(static_cast<int>(df::job_type::FireBallista) == 0x8A, "ledger S3: fire ballista");
static_assert(static_cast<int>(df::job_type::LoadBoltThrower) == 0xF6, "ledger S3: load bolt thrower");
static_assert(static_cast<int>(df::job_type::FireBoltThrower) == 0xF7, "ledger S3: fire bolt thrower");

df::building_siegeenginest* siege_engine_find(int32_t id) {
    auto* b = df::building::find(id);
    return b ? virtual_cast<df::building_siegeenginest>(b) : nullptr;
}

const char* kind_name(df::siegeengine_type type) {
    switch (type) {
        case df::siegeengine_type::Catapult: return "catapult";
        case df::siegeengine_type::Ballista: return "ballista";
        case df::siegeengine_type::BoltThrower: return "bolt thrower";
        default: return "siege engine";
    }
}

bool is_bolt_thrower(df::building_siegeenginest* se) {
    return se && se->type == df::siegeengine_type::BoltThrower;
}

df::job_type fire_job_type(df::siegeengine_type type) {
    switch (type) {
        case df::siegeengine_type::Ballista: return df::job_type::FireBallista;
        case df::siegeengine_type::BoltThrower: return df::job_type::FireBoltThrower;
        default: return df::job_type::FireCatapult;
    }
}

bool is_load_job(df::job_type type) {
    return type == df::job_type::LoadCatapult || type == df::job_type::LoadBallista ||
           type == df::job_type::LoadBoltThrower;
}

bool is_fire_job(df::job_type type) {
    return type == df::job_type::FireCatapult || type == df::job_type::FireBallista ||
           type == df::job_type::FireBoltThrower;
}

// Indexed by df::siegeengine_orientation: index 0 is the muzzle pointing screen-up, then
// clockwise (+x East, +y South). windmill_dir8, SIEGE_DIR and siege8 carry the same table.
struct FacingDelta { int dx; int dy; };

FacingDelta facing_delta(int octant) {
    static const FacingDelta table[8] = {
        { 0, -1 }, { 1, -1 }, { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 }, { -1, 0 }, { -1, -1 },
    };
    if (octant < 0 || octant > 7) return { 0, 0 };
    return table[octant];
}

struct LoadedState {
    bool loaded = false;
    int32_t quantity = 0;
};

LoadedState loaded_state(df::building_siegeenginest* se) {
    LoadedState state;
    if (!se) return state;
    const bool bolt = is_bolt_thrower(se);
    for (auto* held : se->contained_items) {
        if (!held || !held->item) continue;
        if (held->use_mode == df::building_item_role_type::PERM) continue;
        if (bolt && held->item->getType() != df::item_type::AMMO) continue;
        state.loaded = true;
        int32_t stack = held->item->getStackSize();
        state.quantity += stack > 0 ? stack : 1;
    }
    return state;
}

std::string operator_state(df::building_siegeenginest* se) {
    if (!se || se->jobs.empty() || !se->jobs[0]) return "none";
    df::job* job = se->jobs[0];
    if (is_load_job(job->job_type))
        return Job::getWorker(job) ? "loading" : "load-unclaimed";
    if (!is_fire_job(job->job_type)) return "other";
    df::unit* worker = Job::getWorker(job);
    if (!worker) return "fire-unclaimed";
    const int dx = worker->pos.x - se->centerx;
    const int dy = worker->pos.y - se->centery;
    if (dx > -2 && dx < 2 && dy > -2 && dy < 2 && worker->pos.z == se->z) return "operator-present";
    return "operator-walking";
}

void write_jobs(std::ostringstream& out, df::building_siegeenginest* se) {
    out << "[";
    bool first = true;
    for (auto* job : se->jobs) {
        if (!job) continue;
        if (!first) out << ",";
        first = false;
        const bool centred = job->pos.x == se->centerx && job->pos.y == se->centery &&
                             job->pos.z == se->z;
        out << "{\"id\":" << job->id
            << ",\"kind\":\"" << (is_load_job(job->job_type) ? "load"
                                : is_fire_job(job->job_type) ? "fire" : "other") << "\""
            << ",\"atCentre\":" << (centred ? "true" : "false")
            << ",\"x\":" << job->pos.x << ",\"y\":" << job->pos.y << ",\"z\":" << job->pos.z
            << ",\"claimed\":" << (Job::getWorker(job) ? "true" : "false") << "}";
    }
    out << "]";
}

void write_engine(std::ostringstream& out, df::building_siegeenginest* se) {
    const int kind = static_cast<int>(se->type);
    const int stage = se->construction_stage;
    const int max_stage = se->getMaxBuildStage();
    const int facing = static_cast<int>(se->facing);
    const int resting = static_cast<int>(se->resting_orientation);
    const FacingDelta face = facing_delta(facing);
    const FacingDelta rest = facing_delta(resting);
    const LoadedState load = loaded_state(se);
    std::string name = Buildings::getName(se);

    out << "{\"ok\":true,\"isSiegeEngine\":true"
        << ",\"id\":" << se->id
        << ",\"name\":" << json_string(name.empty() ? kind_name(se->type) : name)
        << ",\"kind\":" << kind
        << ",\"kindName\":" << json_string(kind_name(se->type))
        << ",\"canAim\":" << (is_bolt_thrower(se) ? "true" : "false")
        << ",\"buildStage\":" << stage
        << ",\"maxBuildStage\":" << max_stage
        << ",\"built\":" << (stage >= max_stage ? "true" : "false")
        << ",\"action\":" << static_cast<int>(se->action)
        << ",\"facing\":" << facing
        << ",\"facingDx\":" << face.dx << ",\"facingDy\":" << face.dy
        << ",\"restingFacing\":" << resting
        << ",\"restingDx\":" << rest.dx << ",\"restingDy\":" << rest.dy
        << ",\"loaded\":" << (load.loaded ? "true" : "false")
        << ",\"loadedQuantity\":" << load.quantity
        << ",\"forbidden\":" << (se->isForbidden() ? "true" : "false")
        << ",\"cycling\":" << (se->fire_timer != 0 ? "true" : "false")
        << ",\"searching\":" << (se->fill_timer > 0 ? "true" : "false")
        << ",\"turning\":" << (se->rotate_delay > 0 ? "true" : "false")
        << ",\"operatorState\":" << json_string(operator_state(se))
        << ",\"jobs\":";
    write_jobs(out, se);
    out << "}\n";
}

std::string siege_engine_json(int32_t building_id, std::string* err) {
    std::ostringstream out;
    bool ok = run_siege_locked([&]() -> bool {
        auto* b = df::building::find(building_id);
        if (!b) { if (err) *err = "building not found"; return false; }
        auto* se = virtual_cast<df::building_siegeenginest>(b);
        if (!se) {
            out << "{\"ok\":true,\"id\":" << building_id << ",\"isSiegeEngine\":false}\n";
            return true;
        }
        write_engine(out, se);
        return true;
    });
    if (!ok) return "";
    return out.str();
}

// Dropping to KeepLoaded or Idle must also cancel queued fire jobs: the tick handler neither
// re-creates nor removes them, so a dwarf would fire a round the player just cancelled.
bool set_action_mode(int32_t building_id, int mode, int32_t& cancelled, std::string* err) {
    cancelled = 0;
    return run_siege_locked([&]() -> bool {
        auto* se = siege_engine_find(building_id);
        if (!se) { if (err) *err = "not a siege engine"; return false; }
        if (mode < 0 || mode > 4) { if (err) *err = "mode must be 0-4"; return false; }
        se->action = static_cast<df::siegeengine_action>(mode);
        if (mode > static_cast<int>(df::siegeengine_action::KeepLoaded)) return true;
        const df::job_type fire = fire_job_type(se->type);
        for (int i = static_cast<int>(se->jobs.size()) - 1; i >= 0; --i) {
            df::job* job = se->jobs[i];
            if (job && job->job_type == fire && Job::removeJob(job)) ++cancelled;
        }
        return true;
    });
}

bool set_resting_facing(int32_t building_id, int dir, std::string* err) {
    return run_siege_locked([&]() -> bool {
        auto* se = siege_engine_find(building_id);
        if (!se) { if (err) *err = "not a siege engine"; return false; }
        if (!is_bolt_thrower(se)) { if (err) *err = "only a bolt thrower can be re-aimed"; return false; }
        if (dir < 0 || dir > 7) { if (err) *err = "direction must be 0-7"; return false; }
        se->resting_orientation = static_cast<df::siegeengine_orientation>(dir);
        return true;
    });
}

void send_error(httplib::Response& res, const std::string& err, const char* fallback) {
    res.status = 400;
    res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? fallback : err) + "}\n",
                    "application/json; charset=utf-8");
}

} // namespace

void register_siege_engine_routes(httplib::Server& server) {
    server.Get("/siege-engine", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) {
            send_error(res, "", "missing id");
            return;
        }
        std::string err;
        std::string json = siege_engine_json(id, &err);
        if (json.empty()) {
            send_error(res, err, "siege engine unavailable");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });

    server.Post("/siege-engine/action", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1, mode = -1;
        if (!query_int(req, "id", id) || !query_int(req, "mode", mode)) {
            send_error(res, "", "missing id/mode");
            return;
        }
        int32_t cancelled = 0;
        std::string err;
        if (!set_action_mode(id, mode, cancelled, &err)) {
            send_error(res, err, "action mode not set");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"mode\":" + std::to_string(mode) +
                        ",\"cancelledFireJobs\":" + std::to_string(cancelled) + "}\n",
                        "application/json; charset=utf-8");
    });

    server.Post("/siege-engine/resting-facing", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1, dir = -1;
        if (!query_int(req, "id", id) || !query_int(req, "dir", dir)) {
            send_error(res, "", "missing id/dir");
            return;
        }
        std::string err;
        if (!set_resting_facing(id, dir, &err)) {
            send_error(res, err, "resting facing not set");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"dir\":" + std::to_string(dir) + "}\n",
                        "application/json; charset=utf-8");
    });
}

} // namespace dwf
