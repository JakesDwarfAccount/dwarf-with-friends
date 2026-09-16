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

#include "missions.h"

#include "Core.h"
#include "diagnostics.h"
#include "json_util.h"
#include "lua_bridge.h"
#include "panel_http.h"
#include "sdl_capture.h"
#include "world_site_readonly.h"

#include "modules/Military.h"
#include "modules/Translation.h"

#include "df/global_objects.h"
#include "df/army.h"
#include "df/army_controller.h"
#include "df/army_controller_goal_type.h"
#include "df/army_controller_goal_make_requestst.h"
#include "df/army_controller_goal_recover_artifactst.h"
#include "df/army_controller_goal_rescue_hfst.h"
#include "df/army_controller_goal_site_invasionst.h"
#include "df/army_flags.h"
#include "df/artifact_record.h"
#include "df/historical_entity.h"
#include "df/historical_figure.h"
#include "df/historical_figure_info.h"
#include "df/entity_position_assignment.h"
#include "df/entity_position_responsibility.h"
#include "df/historical_entity_type.h"
#include "df/mission_report.h"
#include "df/plotinfost.h"
#include "df/squad.h"
#include "df/squad_position.h"
#include "df/state_profilest.h"
#include "df/world.h"
#include "df/world_data.h"
#include "df/world_site.h"
#include "df/world_site_type.h"

#include <algorithm>
#include <array>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

// The commit body does not exist. Flipping this true only re-labels do_mission_create's refusal
// and makes /missions advertise create as supported.
constexpr bool kMissionCommitEnabled = false;

std::recursive_mutex g_missions_mutex;

template <typename Fn>
bool run_missions_locked(Fn&& fn) {
    return run_panel_locked(g_missions_mutex, std::forward<Fn>(fn));
}

const char* kNativeOnlyReason =
    "Dwarf Fortress creates missions only inside its own world screen (viewscreen_worldst): the "
    "per-goal eligibility verdicts live in that screen's new_mission[] array and nowhere in world "
    "state, and the confirm itself allocates an army_controller + an army + one army_nemesis "
    "record per dwarf and hands them to DF's dwarf-mode departure. DFHack exposes no API for any "
    "of that, so writing it would mean guessing DF's own allocator -- and a wrong guess strands "
    "the squad or corrupts the save rather than failing loudly. The order below is fully "
    "validated and staged; only the commit is withheld.";

std::string site_name_of(df::world_site* site) {
    return site ? DFHack::Translation::translateName(&site->name, true) : std::string();
}

df::world_site* find_site(int32_t site_id) {
    auto world = df::global::world;
    if (!world || !world->world_data || site_id < 0) return nullptr;
    for (auto* site : world->world_data->sites)
        if (site && site->id == site_id) return site;
    return nullptr;
}

std::string entity_name_of(df::historical_entity* entity) {
    return entity ? DFHack::Translation::translateName(&entity->name, true) : std::string();
}

std::string hf_name_of(int32_t hfid) {
    auto* hf = df::historical_figure::find(hfid);
    return hf ? DFHack::Translation::translateName(&hf->name, true) : std::string();
}

std::string artifact_name_of(int32_t artifact_id) {
    auto* rec = df::artifact_record::find(artifact_id);
    return rec ? DFHack::Translation::translateName(&rec->name, true) : std::string();
}

int squad_member_count(df::squad* squad) {
    if (!squad) return 0;
    int n = 0;
    for (auto* pos : squad->positions)
        if (pos && pos->occupant != -1) ++n;
    return n;
}

df::army* squad_army(df::squad* squad) {
    if (!squad) return nullptr;
    for (auto* pos : squad->positions) {
        if (!pos || pos->occupant == -1) continue;
        auto* hf = df::historical_figure::find(pos->occupant);
        if (!hf || !hf->info || !hf->info->whereabouts) continue;
        auto* army = df::army::find(hf->info->whereabouts->army_id);
        if (army) return army;
    }
    return nullptr;
}

// The stuck sentinel is controller_id != 0, not != -1.
bool army_is_stuck(df::army* army) {
    return army && army->controller_id != 0 && !army->controller;
}

df::army_controller* top_controller(df::army_controller* controller) {
    if (!controller) return nullptr;
    if (controller->master_id == controller->id) return controller;
    return df::army_controller::find(controller->master_id);
}

void army_valid_returning(df::army* army, bool& valid, bool& returning) {
    valid = false;
    returning = false;
    auto* c = top_controller(army ? army->controller : nullptr);
    if (!c) return;
    if (c->goal == df::army_controller_goal_type::SITE_INVASION && c->data.goal_site_invasion) {
        valid = true;
        returning = c->data.goal_site_invasion->flag.bits.RETURNING_HOME != 0;
    } else if (c->goal == df::army_controller_goal_type::MAKE_REQUEST && c->data.goal_make_request) {
        valid = true;
        returning = c->data.goal_make_request->flag.bits.RETURNING_HOME != 0;
    }
}

// army_controller::data is a true union: read only the member `goal` selects, or you are
// dereferencing an unrelated struct through a live pointer.
struct GoalDetail {
    std::string target_kind;   // "" | "artifact" | "hf" | "invasion"
    int32_t target_id = -1;
    std::string target_name;
    std::string invasion_intent;
    int returning = -1;        // -1 unknown / not tracked, 0 outbound, 1 returning home
};

GoalDetail goal_detail(df::army_controller* c) {
    GoalDetail d;
    if (!c) return d;
    switch (c->goal) {
    case df::army_controller_goal_type::RECOVER_ARTIFACT:
        if (c->data.goal_recover_artifact) {
            d.target_kind = "artifact";
            d.target_id = c->data.goal_recover_artifact->artifact_id;
            d.target_name = artifact_name_of(d.target_id);
            d.returning = c->data.goal_recover_artifact->flag.bits.RETURNING ? 1 : 0;
        }
        break;
    case df::army_controller_goal_type::RESCUE_HF:
        if (c->data.goal_rescue_hf) {
            d.target_kind = "hf";
            d.target_id = c->data.goal_rescue_hf->hfid;
            d.target_name = hf_name_of(d.target_id);
            d.returning = c->data.goal_rescue_hf->flag.bits.RETURNING ? 1 : 0;
        }
        break;
    case df::army_controller_goal_type::SITE_INVASION:
        if (c->data.goal_site_invasion) {
            d.target_kind = "invasion";
            d.invasion_intent = DFHack::enum_item_key(c->data.goal_site_invasion->invasion_intent);
            d.returning = c->data.goal_site_invasion->flag.bits.RETURNING_HOME ? 1 : 0;
        }
        break;
    case df::army_controller_goal_type::MAKE_REQUEST:
        if (c->data.goal_make_request)
            d.returning = c->data.goal_make_request->flag.bits.RETURNING_HOME ? 1 : 0;
        break;
    default:
        break;
    }
    return d;
}

struct MissionKind {
    const char* key;
    const char* label;
    const char* needs; // "site" | "artifact" | "hf"
};
const MissionKind kMissionKinds[] = {
    { "SITE_INVASION",    "Raid",              "site"     },
    { "RECOVER_ARTIFACT", "Recover artifact",  "artifact" },
    { "RESCUE_HF",        "Rescue prisoner",   "hf"       },
    { "MAKE_REQUEST",     "Request workers",   "site"     },
    { "DIPLOMACY",        "Diplomacy",         "site"     },
};

bool mission_kind_known(const std::string& key) {
    for (const auto& k : kMissionKinds)
        if (key == k.key) return true;
    return false;
}

// ---- the fort's own view of the mission domain -------------------------------------------------

struct FortView {
    df::historical_entity* group = nullptr;
    df::historical_entity* civ = nullptr;
    int32_t own_site = -1;
};

bool has_filled_responsibility(df::historical_entity* entity,
                               df::entity_position_responsibility responsibility) {
    if (!entity) return false;
    const auto& assignments = entity->assignments_by_type[static_cast<int>(responsibility)];
    return std::any_of(assignments.begin(), assignments.end(),
                       [](df::entity_position_assignment* assignment) {
                           return assignment && assignment->histfig >= 0;
                       });
}

const char* verdict_reason_key(int code) {
    switch (code) {
    case -1: return "native-verdict-unavailable";
    case 2: case 11: return nullptr;
    case 3: return "own-civilization";
    case 4: return "outside-authority";
    case 5: return "no-settled-populace";
    case 6: return "no-requestable-workers";
    case 7: return "unreachable";
    case 8: return "no-military-leader";
    case 9: return "no-general-leader";
    case 10: return "no-contact";
    case 12: return "already-at-war";
    case 13: return "peace-already-stands";
    case 14: return "alliance-already-stands";
    case 15: return "at-war";
    case 16: return "cannot-communicate";
    case 17: return "implacably-hostile";
    case 18: return "no-trade";
    case 19: return "already-trading";
    case 20: return "no-civilization-military-leader";
    default: return nullptr;
    }
}

void append_verdict(std::ostringstream& body, int code) {
    body << "{\"code\":" << code << ",\"enabled\":" << (code == 0 ? "true" : "false")
         << ",\"reasonKey\":";
    const char* key = verdict_reason_key(code);
    if (key) body << json_string(key); else body << "null";
    body << "}";
}

void append_travel(std::ostringstream& body, int32_t cost) {
    const char* band = "unreachable";
    int days = -1;
    if (cost >= 18) { band = "days"; days = cost / 9; }
    else if (cost >= 11) band = "over-day";
    else if (cost >= 8) band = "day";
    else if (cost >= 6) band = "near-day";
    else if (cost >= 3) band = "half-day";
    else if (cost >= 0) band = "brief";
    body << "\"travelBand\":" << json_string(band) << ",\"travelDays\":";
    if (days >= 0) body << days; else body << "null";
}

// 27 and 18 are literal on purpose: enum_traits<army_controller_goal_type>::last_item_value + 1
// is 26 and meeting_topic's is 17, so sizing off either enum silently shrinks these arrays.
struct SiteVerdicts {
    std::array<int, 27> goals;
    std::array<int, 18> topics;
};

SiteVerdicts site_verdicts(const FortView& view, df::world_site* site, int32_t travel_cost) {
    SiteVerdicts out;
    out.goals.fill(1);
    out.topics.fill(1);
    auto* civ = site ? df::historical_entity::find(site->civ_id) : nullptr;
    const bool own = site && site->id == view.own_site;
    const bool military_leader =
        has_filled_responsibility(view.group, df::entity_position_responsibility::MILITARY_GOALS);
    const bool general_leader =
        has_filled_responsibility(view.group, df::entity_position_responsibility::MEET_WORKERS);

    out.goals[2] = own ? 2 : !military_leader ? 8 : travel_cost < 0 ? 7 :
                   civ == view.civ ? 3 : 0;

    out.goals[19] = own ? 2 : !general_leader ? 9 : travel_cost < 0 ? 7 : !civ ? 5 :
                    civ != view.civ ? 4 : site->populace.nemesis.empty() ? 6 : -1;

    out.goals[25] = own ? 2 : !general_leader ? 9 : travel_cost < 0 ? 7 : !civ ? 5 :
                    civ == view.civ ? 3 : -1;

    // These six diplomacy topics stay visible but honestly unavailable: their verdicts are
    // computed only inside DF's own world viewscreen. DEF-004
    for (int topic : {1, 10, 13, 14, 15, 16}) out.topics[topic] = -1;
    return out;
}

FortView fort_view() {
    FortView v;
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo) return v;
    v.own_site = plotinfo->site_id;
    v.group = df::historical_entity::find(plotinfo->group_id);
    v.civ = df::historical_entity::find(plotinfo->civ_id);
    return v;
}

std::vector<df::squad*> fort_squads(const FortView& v) {
    std::vector<df::squad*> out;
    if (!v.group) return out;
    for (int32_t id : v.group->squads)
        if (auto* squad = df::squad::find(id)) out.push_back(squad);
    return out;
}

bool is_fort_controller(df::army_controller* c, const FortView& v) {
    if (!c || c->assigned_squads.empty()) return false;
    if (v.group) {
        for (int32_t squad_id : c->assigned_squads)
            if (std::find(v.group->squads.begin(), v.group->squads.end(), squad_id) != v.group->squads.end())
                return true;
    }
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo) return false;
    return c->entity_id == plotinfo->group_id || c->entity_id == plotinfo->civ_id;
}

// A fresh site government's known_sites can be empty, so group and civ relations are unioned.
std::vector<df::world_site*> candidate_targets(const FortView& v) {
    std::set<int32_t> ids;
    ids.insert(v.own_site);
    for (auto* e : { v.group, v.civ })
        if (e)
            for (int32_t id : e->relations.known_sites) ids.insert(id);
    std::vector<df::world_site*> out;
    for (int32_t id : ids) {
        if (auto* site = find_site(id)) out.push_back(site);
    }
    std::sort(out.begin(), out.end(), [](df::world_site* a, df::world_site* b) { return a->id < b->id; });
    return out;
}

// ---- GET /missions -----------------------------------------------------------------------------

std::string build_missions_json(const std::string& player, std::string* err) {
    std::ostringstream body;
    bool ok = run_missions_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world || !world->world_data) { if (err) *err = "world data unavailable"; return false; }
        FortView v = fort_view();
        auto* own_site = find_site(v.own_site);

        body << "{\"player\":" << json_string(player)
             << ",\"ownSiteId\":" << v.own_site
             << ",\"ownSite\":" << json_string(site_name_of(own_site))
             << ",\"civ\":" << json_string(entity_name_of(v.civ));

        // --- squads: ours, with DF's own "already committed" bit ----------------------------
        auto squads = fort_squads(v);
        body << ",\"squads\":[";
        bool first = true;
        for (auto* squad : squads) {
            if (!first) body << ",";
            first = false;
            auto* army = squad_army(squad);
            bool busy = squad->assigned_army_controller_id != -1 || army != nullptr;
            std::string why;
            if (squad->assigned_army_controller_id != -1) why = "Already assigned to a mission";
            else if (army) why = "Away from the fortress";
            body << "{\"id\":" << squad->id
                 << ",\"name\":" << json_string(DFHack::Military::getSquadName(squad->id))
                 << ",\"memberCount\":" << squad_member_count(squad)
                 << ",\"busy\":" << (busy ? "true" : "false")
                 << ",\"busyReason\":" << json_string(why)
                 << ",\"armyId\":" << (army ? army->id : -1)
                 << ",\"stuck\":" << (army_is_stuck(army) ? "true" : "false")
                 << "}";
        }

        // --- active missions --------------------------------------------------------------------
        body << "],\"active\":[";
        first = true;
        for (auto* c : world->army_controllers.all) {
            if (!is_fort_controller(c, v)) continue;
            if (!first) body << ",";
            first = false;
            GoalDetail d = goal_detail(c);
            std::string goal = DFHack::enum_item_key(c->goal);
            const bool messenger_mode =
                c->goal == df::army_controller_goal_type::MAKE_REQUEST ||
                c->goal == df::army_controller_goal_type::DIPLOMACY;
            int present_count = 0, travelling_count = 0;
            for (int32_t squad_id : c->assigned_squads) {
                auto* assigned = df::squad::find(squad_id);
                if (!assigned) continue;
                for (auto* position : assigned->positions) {
                    if (!position || position->occupant < 0) continue;
                    auto* hf = df::historical_figure::find(position->occupant);
                    uint32_t status = hf ? hf->flags.as_int<uint32_t>() : 0;
                    if (hf && (status & 0x102U) == 0 && (status & 0x80000000U) != 0)
                        ++present_count;
                    else
                        ++travelling_count;
                }
            }
            const bool alterable = travelling_count == 0 || present_count > 0;
            body << "{\"id\":" << c->id
                 << ",\"goal\":" << json_string(goal.empty() ? "Unknown mission" : goal)
                 << ",\"goalKey\":" << json_string(goal.empty() ? "UNKNOWN" : goal)
                 << ",\"targetSiteId\":" << c->site_id
                 << ",\"targetSite\":" << json_string(site_name_of(find_site(c->site_id)))
                 << ",\"targetSiteName\":" << json_string(site_name_of(find_site(c->site_id)))
                 << ",\"year\":" << c->year
                 << ",\"yearTick\":" << c->year_tick
                 << ",\"presentCount\":" << present_count
                 << ",\"travellingCount\":" << travelling_count
                 << ",\"alterable\":" << (alterable ? "true" : "false")
                 << ",\"roleNoun\":" << json_string(messenger_mode ? "messenger" : "commander")
                 << ",\"reportTitle\":" << json_string(c->mission_report ? c->mission_report->title : "")
                 << ",\"targetKind\":" << json_string(d.target_kind)
                 << ",\"targetId\":" << d.target_id
                 << ",\"targetName\":" << json_string(d.target_name)
                 << ",\"invasionIntent\":" << json_string(d.invasion_intent)
                 << ",\"returning\":" << d.returning
                 << ",\"squads\":[";
            bool sfirst = true;
            bool any_stuck = false;
            for (int32_t squad_id : c->assigned_squads) {
                auto* squad = df::squad::find(squad_id);
                if (!sfirst) body << ",";
                sfirst = false;
                auto* army = squad_army(squad);
                if (army_is_stuck(army)) any_stuck = true;
                body << "{\"id\":" << squad_id
                     << ",\"name\":" << json_string(squad ? DFHack::Military::getSquadName(squad_id) : "")
                     << ",\"memberCount\":" << squad_member_count(squad) << "}";
            }
            body << "],\"stuck\":" << (any_stuck ? "true" : "false")
                 << ",\"roster\":[";
            bool rfirst = true;
            for (auto* squad : squads) {
                if (!rfirst) body << ",";
                rfirst = false;
                int32_t assigned_id = squad->assigned_army_controller_id;
                const char* assignment = assigned_id == -1 ? "free" :
                                         assigned_id == c->id ? "this-mission" : "other-mission";
                std::string other_summary;
                if (assigned_id != -1 && assigned_id != c->id) {
                    auto* other = df::army_controller::find(assigned_id);
                    if (other) {
                        other_summary = DFHack::enum_item_key(other->goal);
                        std::string other_site = site_name_of(find_site(other->site_id));
                        if (!other_site.empty()) other_summary += " at " + other_site;
                    }
                }
                body << "{\"id\":" << squad->id
                     << ",\"name\":" << json_string(DFHack::Military::getSquadName(squad->id))
                     << ",\"emblem\":null"
                     << ",\"lockedIn\":" << (assigned_id != -1 ? "true" : "false")
                     << ",\"assignment\":" << json_string(assignment)
                     << ",\"orderSummary\":";
                if (assigned_id == -1)
                    body << json_string(squad->orders.empty() ? "No standing orders" : "Standing orders active");
                else
                    body << "null";
                body << ",\"otherMissionSummary\":";
                if (other_summary.empty()) body << "null"; else body << json_string(other_summary);
                body << "}";
            }
            body << "],\"messengers\":[],\"composer\":null}";
        }

        // --- candidate targets, straight off DF's known-sites relation ---------------------------
        body << "],\"targets\":[";
        first = true;
        for (auto* site : candidate_targets(v)) {
            if (!first) body << ",";
            first = false;
            auto* civ = df::historical_entity::find(site->civ_id);
            auto* government = site_government(site);
            int32_t travel_cost = site_travel_cost(world->world_data, site);
            SiteVerdicts verdicts = site_verdicts(v, site, travel_cost);
            body << "{\"id\":" << site->id
                 << ",\"name\":" << json_string(site_name_of(site))
                 << ",\"type\":" << json_string(DFHack::enum_item_key(site->type))
                 << ",\"subtypeKey\":" << json_string(site_subtype_key(site))
                 << ",\"x\":" << site->pos.x
                 << ",\"y\":" << site->pos.y
                 << ",\"civId\":" << site->civ_id
                 << ",\"civ\":" << json_string(entity_name_of(civ))
                 << ",\"civName\":";
            if (civ) body << json_string(entity_name_of(civ)); else body << "null";
            body << ",\"govName\":";
            if (government) body << json_string(entity_name_of(government)); else body << "null";
            body << ",\"isOwnFortress\":" << (site->id == v.own_site ? "true" : "false")
                 << ",\"hasGovernment\":" << (government ? "true" : "false") << ",";
            append_travel(body, travel_cost);
            body << ",\"populationBand\":";
            if (government) {
                SitePopulationBand band = site_population_band(site);
                body << "{\"index\":" << band.index
                     << ",\"advertised\":" << json_string(band.advertised) << "}";
            } else {
                body << "null";
            }
            body << ",\"goalVerdicts\":[";
            for (size_t i = 0; i < verdicts.goals.size(); ++i) {
                if (i) body << ",";
                body << verdicts.goals[i];
            }
            body << "],\"diplomacyVerdicts\":[";
            for (size_t i = 0; i < verdicts.topics.size(); ++i) {
                if (i) body << ",";
                body << verdicts.topics[i];
            }
            body << "],\"verdicts\":{\"attack\":";
            append_verdict(body, verdicts.goals[2]);
            body << ",\"requestWorkers\":";
            append_verdict(body, verdicts.goals[19]);
            body << ",\"diplomacy\":";
            append_verdict(body, verdicts.goals[25]);
            body << "},\"diplomacyTopics\":[";
            const int topic_ids[] = {1, 10, 13, 14, 15, 16};
            const char* topic_keys[] = {
                "seek-peace", "request-surrender", "declare-war",
                "seek-alliance", "open-contact", "improve-trade"
            };
            for (int i = 0; i < 6; ++i) {
                if (i) body << ",";
                int code = verdicts.topics[topic_ids[i]];
                body << "{\"topic\":" << topic_ids[i]
                     << ",\"labelKey\":" << json_string(topic_keys[i])
                     << ",\"code\":" << code
                     << ",\"enabled\":" << (code == 0 ? "true" : "false")
                     << ",\"reasonKey\":";
                const char* reason = verdict_reason_key(code);
                if (reason) body << json_string(reason); else body << "null";
                body << "}";
            }
            body << "]}";
        }

        // --- the mission types DF offers, each advertised as native-only -------------------------
        body << "],\"missionTypes\":[";
        first = true;
        for (const auto& k : kMissionKinds) {
            if (!first) body << ",";
            first = false;
            body << "{\"key\":" << json_string(k.key)
                 << ",\"label\":" << json_string(k.label)
                 << ",\"needs\":" << json_string(k.needs)
                 << ",\"available\":" << (kMissionCommitEnabled ? "true" : "false")
                 << "}";
        }

        // --- stranded squads + whether DFHack's repair can actually run right now -----------------
        body << "],\"stuckSquads\":[";
        first = true;
        int stuck_count = 0;
        bool have_returning = false, have_outbound = false;
        for (auto* squad : squads) {
            auto* army = squad_army(squad);
            if (army_is_stuck(army)) {
                if (!first) body << ",";
                first = false;
                ++stuck_count;
                body << "{\"squadId\":" << squad->id
                     << ",\"squadName\":" << json_string(DFHack::Military::getSquadName(squad->id))
                     << ",\"armyId\":" << army->id << "}";
                continue;
            }
            bool valid = false, returning = false;
            army_valid_returning(army, valid, returning);
            if (!valid) continue;
            if (returning) have_returning = true; else have_outbound = true;
        }
        body << "]";

        std::string rescue_reason;
        bool rescue_available = false;
        if (stuck_count == 0) {
            rescue_reason = "No stranded squads.";
        } else if (have_returning) {
            rescue_available = true;
            rescue_reason = "A returning army can carry them home.";
        } else if (have_outbound) {
            rescue_reason = "A squad is out but still outbound -- DFHack can only rescue once "
                            "something is on its way home. Try again when they turn back.";
        } else {
            rescue_reason = "Nothing is returning to the fortress. Send a squad or a messenger on "
                            "a mission that comes home, then rescue once they are on the way back.";
        }
        body << ",\"rescue\":{\"available\":" << (rescue_available ? "true" : "false")
             << ",\"stuckCount\":" << stuck_count
             << ",\"reason\":" << json_string(rescue_reason) << "}";

        // --- the capability advertisement --------------------------------------------------------
        body << ",\"create\":{\"supported\":" << (kMissionCommitEnabled ? "true" : "false")
             << ",\"blocked\":" << json_string(kMissionCommitEnabled ? "" : "native-only")
             << ",\"reason\":" << json_string(kMissionCommitEnabled ? "" : kNativeOnlyReason)
             << "}}\n";
        return true;
    });
    if (!ok) return "";
    return body.str();
}

// ---- POST /mission-create ----------------------------------------------------------------------

struct StagedOrder {
    std::string goal;
    int32_t site_id = -1;
    std::string site_name;
    std::vector<int32_t> squad_ids;
    std::vector<std::string> squad_names;
    int32_t target_id = -1;   // artifact / hf, when the goal needs one
};

bool do_mission_create(const std::string& goal, int32_t site_id, const std::vector<int32_t>& squad_ids,
                       int32_t target_id, bool goal_phase, StagedOrder& staged, std::string* err) {
    return run_missions_locked([&]() -> bool {
        if (!df::global::world || !df::global::plotinfo) {
            if (err) *err = "world unavailable";
            return false;
        }
        if (!mission_kind_known(goal)) {
            if (err) *err = "unknown mission type '" + goal + "'";
            return false;
        }
        FortView v = fort_view();
        if (!v.group) {
            if (err) *err = "no fortress government -- missions need a site government";
            return false;
        }

        auto* site = find_site(site_id);
        if (!site) {
            if (err) *err = "no such site";
            return false;
        }
        if (site_id == v.own_site) {
            if (err) *err = "that is your own fortress";
            return false;
        }
        auto targets = candidate_targets(v);
        if (std::find(targets.begin(), targets.end(), site) == targets.end()) {
            if (err) *err = "your civilization has not heard of that site";
            return false;
        }

        staged.goal = goal;
        staged.site_id = site_id;
        staged.site_name = site_name_of(site);
        staged.target_id = target_id;

        if (goal_phase) {
            int slot = goal == "SITE_INVASION" ? 2 : goal == "MAKE_REQUEST" ? 19 :
                       goal == "DIPLOMACY" ? 25 : -1;
            if (slot < 0) {
                if (err) *err = "that goal is not offered from the site-first expedition panel";
                return false;
            }
            int32_t travel_cost = site_travel_cost(df::global::world->world_data, site);
            int verdict = site_verdicts(v, site, travel_cost).goals[slot];
            if (verdict != 0) {
                if (err) *err = "that expedition goal is not currently available for this site";
                return false;
            }
        } else {
            if (squad_ids.empty()) {
                if (err) *err = "pick at least one squad";
                return false;
            }
            std::set<int32_t> seen;
            for (int32_t sid : squad_ids) {
                if (!seen.insert(sid).second) {
                    if (err) *err = "squad listed twice";
                    return false;
                }
                auto* squad = df::squad::find(sid);
                if (!squad || std::find(v.group->squads.begin(), v.group->squads.end(), sid) == v.group->squads.end()) {
                    if (err) *err = "squad " + std::to_string(sid) + " is not one of your squads";
                    return false;
                }
                if (squad->assigned_army_controller_id != -1 || squad_army(squad)) {
                    if (err) *err = DFHack::Military::getSquadName(sid) + " is already away on a mission";
                    return false;
                }
                if (squad_member_count(squad) == 0) {
                    if (err) *err = DFHack::Military::getSquadName(sid) + " has no members";
                    return false;
                }
                staged.squad_ids.push_back(sid);
                staged.squad_names.push_back(DFHack::Military::getSquadName(sid));
            }

        }

        if (goal == "RECOVER_ARTIFACT") {
            if (!df::artifact_record::find(target_id)) {
                if (err) *err = "recover-artifact needs a real artifact";
                return false;
            }
        } else if (goal == "RESCUE_HF") {
            if (!df::historical_figure::find(target_id)) {
                if (err) *err = "rescue needs a real historical figure";
                return false;
            }
        }

        // The commit is deliberately absent, and this is a hard stop rather than a fallthrough:
        // no partial army_controller and no dangling squad assignment may ever be written.
        if (!kMissionCommitEnabled) {
            if (err) *err = kNativeOnlyReason;
            return false;
        }
        if (err) *err = "mission commit is enabled but unimplemented";
        return false;
    });
}

std::string staged_json(const StagedOrder& s) {
    std::ostringstream body;
    body << "{\"goal\":" << json_string(s.goal)
         << ",\"targetSiteId\":" << s.site_id
         << ",\"targetSite\":" << json_string(s.site_name)
         << ",\"targetId\":" << s.target_id
         << ",\"squadIds\":[";
    for (size_t i = 0; i < s.squad_ids.size(); ++i) { if (i) body << ","; body << s.squad_ids[i]; }
    body << "],\"squadNames\":[";
    for (size_t i = 0; i < s.squad_names.size(); ++i) {
        if (i) body << ",";
        body << json_string(s.squad_names[i]);
    }
    body << "]}";
    return body.str();
}

std::vector<int32_t> parse_squads(const httplib::Request& req) {
    std::vector<int32_t> out;
    auto range = req.params.equal_range("squad");
    for (auto it = range.first; it != range.second; ++it) {
        std::stringstream ss(it->second);
        std::string part;
        while (std::getline(ss, part, ',')) {
            try {
                if (!part.empty()) out.push_back(static_cast<int32_t>(std::stol(part)));
            } catch (...) {
                // Drop the token rather than let a failed parse resolve to squad 0.
            }
        }
    }
    return out;
}

} // namespace

void register_mission_routes(httplib::Server& server) {
    server.Get("/missions", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string err;
        std::string json = build_missions_json(player, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "missions unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // 400 means the order itself is wrong; 501 means the order is good and DF will not take it
    // from us. The client must show those two differently.
    auto create_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string goal = req.has_param("goal") ? req.get_param_value("goal") : "";
        bool goal_phase = req.has_param("phase") && req.get_param_value("phase") == "goal";
        int site_id = -1, target_id = -1;
        query_int(req, "site", site_id);
        query_int(req, "target", target_id);
        std::vector<int32_t> squads = parse_squads(req);

        StagedOrder staged;
        std::string err;
        bool committed = do_mission_create(goal, site_id, squads, target_id, goal_phase, staged, &err);
        if (committed) {
            set_no_store_json(res, "{\"ok\":true,\"staged\":" + staged_json(staged) + "}\n");
            return;
        }
        if (err == kNativeOnlyReason) {
            diagnostics_log("missions: create validated + BLOCKED (native-only) goal=" + goal +
                            " site=" + std::to_string(site_id) +
                            " squads=" + std::to_string(staged.squad_ids.size()));
            res.status = 501;
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":false,\"blocked\":\"native-only\",\"error\":" +
                                json_string(kNativeOnlyReason) +
                                ",\"staged\":" + staged_json(staged) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        json_error(res, 400, err.empty() ? "invalid mission order" : err);
    };
    server.Get("/mission-create", create_handler);
    server.Post("/mission-create", create_handler);

    // POST /mission-rescue runs DFHack's own fix/stuck-squad script through the lua bridge.
    auto rescue_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string err;
        std::string output;
        int rescued = 0;
        if (!mission_rescue_stuck_via_lua(rescued, output, &err)) {
            json_error(res, 400, err.empty() ? "rescue failed" : err);
            return;
        }
        diagnostics_log("missions: fix/stuck-squad by " + player + " -> rescued=" +
                        std::to_string(rescued));
        std::ostringstream body;
        body << "{\"ok\":true,\"rescued\":" << rescued
             << ",\"output\":" << json_string(output) << "}\n";
        set_no_store_json(res, body.str());
    };
    server.Get("/mission-rescue", rescue_handler);
    server.Post("/mission-rescue", rescue_handler);
}

} // namespace dwf
