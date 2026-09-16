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

#include "fort_admin.h"

#include "Core.h"
#include "assignable_citizen.h"
#include "http_server.h"
#include "json_util.h"
#include "lua_bridge.h"
#include "noble_appointment.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Items.h"
#include "modules/Materials.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/agreement.h"
#include "df/agreement_details.h"
#include "df/agreement_details_data_citizenship.h"
#include "df/agreement_details_data_residency.h"
#include "df/agreement_details_type.h"
#include "df/agreement_flag.h"
#include "df/agreement_party.h"
#include "df/announcement_handlerst.h"
#include "df/building.h"
#include "df/building_civzonest.h"
#include "df/building_type.h"
#include "df/civzone_type.h"
#include "df/crime.h"
#include "df/crime_flag.h"
#include "df/crime_handlerst.h"
#include "df/crime_type.h"
#include "df/entity_position.h"
#include "df/entity_position_assignment.h"
#include "df/actor_entryst.h"
#include "df/counterintelligence_mode_type.h"
#include "df/gamest.h"
#include "df/info_interface_mode_type.h"
#include "df/info_interfacest.h"
#include "df/justice_interface_mode_type.h"
#include "df/justice_interfacest.h"
#include "df/main_interface.h"
#include "df/global_objects.h"
#include "df/histfig_entity_link_positionst.h"
#include "df/historical_entity.h"
#include "df/historical_figure.h"
#include "df/history_event_reason.h"
#include "df/incident_hfid.h"
#include "df/interrogation_report.h"
#include "df/interrogation_resultst.h"
#include "df/mandate.h"
#include "df/mandate_handlerst.h"
#include "df/plotinfost.h"
// df::punishment lives here; df/punishmentst.h declares the unrelated df::punishmentst.
#include "df/punishment.h"
#include "df/record_precision_level_type.h"
#include "df/squad.h"
#include "df/squad_position.h"
#include "df/unit.h"
#include "df/world.h"
#include "df/world_site.h"
#include "df/witness_reportst.h"

#include <algorithm>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_admin_mutex;

template <typename Fn>
bool run_admin_locked(Fn&& fn) {
    return run_panel_locked(g_admin_mutex, std::forward<Fn>(fn));
}

df::unit* unit_for_histfig(int32_t hf_id) {
    if (hf_id < 0)
        return nullptr;
    auto world = df::global::world;
    if (!world)
        return nullptr;
    for (auto unit : world->units.active) {
        if (unit && unit->hist_figure_id == hf_id)
            return unit;
    }
    return nullptr;
}

std::string histfig_name(int32_t hf_id) {
    if (hf_id < 0)
        return "";
    auto hf = df::historical_figure::find(hf_id);
    if (!hf)
        return "";
    std::string name = DFHack::Translation::translateName(&hf->name, true);
    return name.empty() ? ("Figure " + std::to_string(hf_id)) : name;
}

// ---------------------------------------------- Nobles / administrators

std::string position_display_name(df::entity_position* position) {
    if (!position)
        return "";
    if (!position->name[0].empty())
        return position->name[0];
    if (!position->name_male[0].empty())
        return position->name_male[0];
    return "Position " + std::to_string(position->id);
}

std::string position_requirements(df::entity_position* position) {
    std::vector<std::string> reqs;
    if (position->required_office > 0) reqs.push_back("office");
    if (position->required_bedroom > 0) reqs.push_back("bedroom");
    if (position->required_dining > 0) reqs.push_back("dining room");
    if (position->required_tomb > 0) reqs.push_back("tomb");
    std::string out;
    for (size_t i = 0; i < reqs.size(); ++i) {
        if (i) out += ", ";
        out += reqs[i];
    }
    return out;
}

std::string squad_name_for(int32_t squad_id) {
    if (squad_id < 0)
        return "";
    auto squad = df::squad::find(squad_id);
    if (!squad)
        return "";
    if (!squad->alias.empty())
        return squad->alias;
    return DFHack::Translation::translateName(&squad->name, true);
}

// A level > 0 means the position requires that room.
struct RoomReqs { int32_t office, bedroom, dining, tomb, box; };
RoomReqs position_room_reqs(df::entity_position* p) {
    return { p->required_office, p->required_bedroom, p->required_dining, p->required_tomb,
             p->required_boxes };
}

// A noble's rooms are CIVZONES: the kind is the civzone's own `type`, never the underlying
// furniture's building_type, which is building_type::Civzone for every owned_buildings entry.
struct RoomOwned { bool office = false, bedroom = false, dining = false, tomb = false; };
RoomOwned holder_owned_rooms(df::unit* holder) {
    RoomOwned owned;
    if (!holder)
        return owned;
    for (auto zone : holder->owned_buildings) {
        if (!zone)
            continue;
        switch (zone->type) {
            case df::civzone_type::Office:     owned.office  = true; break;
            case df::civzone_type::Bedroom:    owned.bedroom = true; break;
            case df::civzone_type::DiningHall: owned.dining  = true; break;
            case df::civzone_type::Tomb:       owned.tomb    = true; break;
            default: break;
        }
    }
    return owned;
}

int32_t next_assignment_id(df::historical_entity* fort) {
    int32_t next_id = 0;
    for (auto a : fort->positions.assignments)
        if (a && a->id >= next_id)
            next_id = a->id + 1;
    return next_id;
}

df::entity_position_assignment* create_assignment(df::historical_entity* fort, int32_t position_id) {
    auto assignment = new df::entity_position_assignment();
    assignment->id = next_assignment_id(fort);
    assignment->position_id = position_id;
    assignment->histfig = -1;    // vacant seat (ctor would leave 0 == histfig id 0)
    assignment->histfig2 = -1;   // no previous holder
    assignment->squad_id = -1;   // leads no squad (ctor would leave 0 == squad id 0)
    fort->positions.assignments.push_back(assignment);
    return assignment;
}

// The raws' cap is entity_position.number, where -1 = AS_NEEDED = unlimited.
int count_assignments(df::historical_entity* fort, int32_t position_id) {
    int n = 0;
    for (auto a : fort->positions.assignments)
        if (a && a->position_id == position_id)
            ++n;
    return n;
}

bool position_is_noble_screen_visible(df::historical_entity* fort, int32_t position_id) {
    if (!fort)
        return false;
    df::entity_position* position = nullptr;
    for (auto candidate : fort->positions.own)
        if (candidate && candidate->id == position_id) {
            position = candidate;
            break;
        }
    if (!position || position->flags.is_set(df::entity_position_flags::HAS_BEEN_REPLACED) ||
        (position->requires_population > 0 &&
         !position->flags.is_set(df::entity_position_flags::HAS_MET_POP_REQ)))
        return false;
    for (auto assignment : fort->positions.assignments) {
        if (assignment && assignment->position_id == position_id &&
            (assignment->histfig >= 0 || assignment->squad_id >= 0))
            return true;
    }
    return position_is_possible_appointable(fort, position_id);
}

std::string build_nobles_json(const std::string& player, std::string* err) {
    std::ostringstream body;
    bool ok = run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        auto world = df::global::world;
        if (!plotinfo || !world) { if (err) *err = "world unavailable"; return false; }
        // Fort positions live on the fort GROUP entity (group_id); civ_id surfaces civ-level
        // positions such as the monarch instead.
        auto fort = df::historical_entity::find(plotinfo->group_id);
        if (!fort) { if (err) *err = "fort entity unavailable"; return false; }

        std::vector<df::entity_position*> visible_positions;
        for (auto position : fort->positions.own)
            if (position && position_is_noble_screen_visible(fort, position->id))
                visible_positions.push_back(position);
        std::stable_sort(visible_positions.begin(), visible_positions.end(),
                         [](df::entity_position* a, df::entity_position* b) {
                             return a->precedence < b->precedence;
                         });

        body << "{\"player\":" << json_string(player) << ",\"positions\":[";
        bool first = true;
        for (auto position : visible_positions) {
            int32_t holder_hf = -1;
            int32_t assignment_id = -1;
            int32_t squad_id = -1;
            for (auto asn : fort->positions.assignments) {
                if (!asn || asn->position_id != position->id)
                    continue;
                assignment_id = asn->id;
                if (asn->squad_id >= 0)
                    squad_id = asn->squad_id;
                if (asn->histfig != -1) {
                    holder_hf = asn->histfig;
                    break;
                }
            }
            df::unit* holder = unit_for_histfig(holder_hf);
            std::string holder_name = holder ? DFHack::Units::getReadableName(holder)
                                             : histfig_name(holder_hf);
            RoomReqs reqs = position_room_reqs(position);
            RoomOwned owned = holder_owned_rooms(holder);
            const bool can_create = position_is_possible_appointable(fort, position->id) &&
                (position->number < 0 ||
                 count_assignments(fort, position->id) < position->number);
            if (!first) body << ",";
            first = false;
            body << "{\"name\":" << json_string(position_display_name(position))
                 << ",\"positionId\":" << position->id
                 << ",\"assignmentId\":" << assignment_id
                 << ",\"squadSize\":" << position->squad_size
                 << ",\"squadName\":" << json_string(squad_name_for(squad_id))
                 << ",\"precedence\":" << position->precedence
                 << ",\"requirements\":" << json_string(position_requirements(position))
                 // per-icon room requirement levels; 0 = not required.
                 << ",\"rooms\":{\"office\":" << reqs.office << ",\"bedroom\":" << reqs.bedroom
                 << ",\"dining\":" << reqs.dining << ",\"tomb\":" << reqs.tomb
                 << ",\"box\":" << reqs.box << "}"
                 << ",\"roomsSatisfied\":{\"office\":" << (owned.office ? "true" : "false")
                 << ",\"bedroom\":" << (owned.bedroom ? "true" : "false")
                 << ",\"dining\":" << (owned.dining ? "true" : "false")
                 << ",\"tomb\":" << (owned.tomb ? "true" : "false") << "}"
                 << ",\"filled\":" << (holder_hf != -1 ? "true" : "false")
                 << ",\"holder\":" << json_string(holder_name)
                 << ",\"unitId\":" << (holder ? holder->id : -1)
                 << ",\"profession\":" << json_string(holder ? DFHack::Units::getProfessionName(holder) : "")
                 << ",\"professionColor\":" << (holder ? static_cast<int>(DFHack::Units::getProfessionColor(holder)) : -1)
                 // maxSeats is entity_position.number, -1 = AS_NEEDED. canCreate uses the same bound
                 // /position-create enforces, so a chooser row can never 400.
                 << ",\"seats\":" << count_assignments(fort, position->id)
                 << ",\"maxSeats\":" << static_cast<int>(position->number)
                 << ",\"canCreate\":" << (can_create ? "true" : "false")
                 << "}";
        }
        // record_precision_level_type: NONE=-1, nearest_10=0 .. all_accurate=4; the native
        // selector's button N is enum N-1.
        body << "],\"bookkeeperPrecision\":" << static_cast<int>(plotinfo->nobles.bookkeeper_settings)
             << ",\"mandates\":[";
        first = true;
        for (auto mandate : world->mandates.all) {
            if (!mandate)
                continue;
            df::unit* unit = mandate->unit;
            // ItemTypeInfo/MaterialInfo decode an invalid id to an empty label, so no nil-guard
            // beyond the mat_type >= 0 check is needed.
            DFHack::ItemTypeInfo iti(mandate->item_type, mandate->item_subtype);
            std::string item_label = iti.isValid() ? iti.toString() : "";
            std::string mat_label = mandate->mat_type >= 0
                ? DFHack::MaterialInfo(mandate->mat_type, mandate->mat_index).toString() : "";
            // timeout_counter ticks once per 10 frames; DF runs 1200 frames/day. A non-positive
            // limit means no deadline -> daysRemaining = -1 ("Ongoing", never a false "0 days").
            int days_remaining = -1;
            if (mandate->timeout_limit > 0) {
                long ticks_left = (long)mandate->timeout_limit - (long)mandate->timeout_counter;
                if (ticks_left < 0) ticks_left = 0;
                long frames_left = ticks_left * 10;
                days_remaining = (int)((frames_left + 1199) / 1200); // ceil
            }
            if (!first) body << ",";
            first = false;
            body << "{\"mode\":" << json_string(DFHack::enum_item_key(mandate->mode))
                 << ",\"item\":" << json_string(item_label)
                 << ",\"material\":" << json_string(mat_label)
                 << ",\"amountTotal\":" << mandate->amount_total
                 << ",\"amountRemaining\":" << mandate->amount_remaining
                 << ",\"timeoutCounter\":" << mandate->timeout_counter
                 << ",\"timeoutLimit\":" << mandate->timeout_limit
                 << ",\"daysRemaining\":" << days_remaining
                 << ",\"punishMultiple\":" << (mandate->punish_multiple ? "true" : "false")
                 << ",\"hammerstrikes\":" << mandate->punishment.hammerstrikes
                 << ",\"prisonTime\":" << mandate->punishment.prison_time
                 << ",\"unitId\":" << (unit ? unit->id : -1)
                 << ",\"by\":" << json_string(unit ? DFHack::Units::getReadableName(unit) : "")
                 << ",\"byProfessionColor\":" << (unit ? static_cast<int>(DFHack::Units::getProfessionColor(unit)) : -1)
                 << "}";
        }
        body << "]}\n";
        return true;
    });
    if (!ok)
        return "";
    return body.str();
}

// ------------------------------- Noble assignment: /noble-assign + /noble-candidates
// Assigning a squad-bearing position does not create the squad DF would auto-create.

df::entity_position* find_position(df::historical_entity* fort, int32_t position_id) {
    for (auto p : fort->positions.own)
        if (p && p->id == position_id)
            return p;
    return nullptr;
}

df::entity_position_assignment* find_assignment(df::historical_entity* fort, int32_t position_id) {
    for (auto a : fort->positions.assignments)
        if (a && a->position_id == position_id)
            return a;
    return nullptr;
}

int32_t assignment_index(df::historical_entity* fort, df::entity_position_assignment* assignment) {
    for (size_t i = 0; i < fort->positions.assignments.size(); ++i)
        if (fort->positions.assignments[i] == assignment)
            return static_cast<int32_t>(i);
    return -1;
}

void unlink_position_holder(int32_t old_hf_id, int32_t fort_id, int32_t assignment_id) {
    auto hf = df::historical_figure::find(old_hf_id);
    if (!hf)
        return;
    for (size_t i = 0; i < hf->entity_links.size(); ++i) {
        auto link = virtual_cast<df::histfig_entity_link_positionst>(hf->entity_links[i]);
        if (link && link->entity_id == fort_id && link->assignment_id == assignment_id) {
            delete hf->entity_links[i];
            hf->entity_links.erase(hf->entity_links.begin() + i);
            return;
        }
    }
}

std::string build_noble_candidates_json(int32_t position_id, const std::string& player, std::string* err) {
    std::ostringstream body;
    bool ok = run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        auto world = df::global::world;
        if (!plotinfo || !world) { if (err) *err = "world unavailable"; return false; }
        auto fort = df::historical_entity::find(plotinfo->group_id);
        if (!fort) { if (err) *err = "fort entity unavailable"; return false; }
        auto position = find_position(fort, position_id);
        if (!position || !position_is_noble_screen_visible(fort, position_id)) {
            if (err) *err = "position is not currently offered by DF";
            return false;
        }
        auto assignment = find_assignment(fort, position_id);
        int32_t current_hf = assignment ? assignment->histfig : -1;

        body << "{\"player\":" << json_string(player)
             << ",\"positionId\":" << position_id
             << ",\"positionName\":" << json_string(position ? position_display_name(position) : "")
             << ",\"candidates\":[";
        bool first = true;
        // Positions are citizen-only in native DF, so long-term residents are not candidates.
        for (auto unit : world->units.active) {
            if (!is_assignable_citizen(unit))
                continue;
            bool is_current = (unit->hist_figure_id >= 0 && unit->hist_figure_id == current_hf);
            if (!first) body << ",";
            first = false;
            body << "{\"unitId\":" << unit->id
                 << ",\"name\":" << json_string(DFHack::Units::getReadableName(unit))
                 << ",\"profession\":" << json_string(DFHack::Units::getProfessionName(unit))
                 << ",\"professionColor\":" << static_cast<int>(DFHack::Units::getProfessionColor(unit))
                 << ",\"current\":" << (is_current ? "true" : "false")
                 << "}";
        }
        body << "]}\n";
        return true;
    });
    if (!ok)
        return "";
    return body.str();
}

// unit_id < 0 unassigns; otherwise the unit's histfig takes the seat, creating one if the
// position has none yet.
bool do_noble_assign(int32_t position_id, int32_t unit_id, std::string* err) {
    return run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        auto fort = df::historical_entity::find(plotinfo->group_id);
        if (!fort) { if (err) *err = "fort entity unavailable"; return false; }
        auto position = find_position(fort, position_id);
        if (!position) { if (err) *err = "unknown position"; return false; }
        if (!position_is_noble_screen_visible(fort, position_id)) {
            if (err) *err = "position is not currently offered by DF";
            return false;
        }

        // Re-find the unit under the lock: it can vanish between the candidate snapshot and this
        // click.
        df::unit* unit = nullptr;
        if (unit_id >= 0) {
            unit = df::unit::find(unit_id);
            if (!unit) { if (err) *err = "unit not found"; return false; }
            if (DFHack::Units::isBaby(unit) || DFHack::Units::isChild(unit)) {
                if (err) *err = "unit is a child";
                return false;
            }
            if (!is_assignable_citizen(unit)) { if (err) *err = "unit is not an assignable living citizen"; return false; }
            if (unit->hist_figure_id < 0) { if (err) *err = "unit has no historical figure"; return false; }
        }

        auto assignment = find_assignment(fort, position_id);
        if (!assignment) {
            assignment = create_assignment(fort, position_id);
        }
        int32_t idx = assignment_index(fort, assignment);

        if (unit_id < 0) {
            if (assignment->histfig != -1)
                unlink_position_holder(assignment->histfig, fort->id, assignment->id);
            assignment->histfig = -1;
            return true;
        }

        if (assignment->histfig != -1 && assignment->histfig != unit->hist_figure_id)
            unlink_position_holder(assignment->histfig, fort->id, assignment->id);
        assignment->histfig = unit->hist_figure_id;

        auto newfig = df::historical_figure::find(unit->hist_figure_id);
        if (newfig) {
            bool already_linked = false;
            for (auto link : newfig->entity_links) {
                auto pos_link = virtual_cast<df::histfig_entity_link_positionst>(link);
                if (pos_link && pos_link->entity_id == fort->id && pos_link->assignment_id == assignment->id) {
                    already_linked = true;
                    break;
                }
            }
            if (!already_linked) {
                auto link = df::allocate<df::histfig_entity_link_positionst>();
                link->entity_id = fort->id;
                link->link_strength = 100;
                link->assignment_id = assignment->id;
                link->assignment_vector_idx = idx;
                link->start_year = df::global::cur_year ? *df::global::cur_year : 0;
                newfig->entity_links.push_back(link);
            }
        }
        return true;
    });
}

bool do_position_create(int32_t position_id, int32_t& out_id, std::string* err) {
    return run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        auto fort = df::historical_entity::find(plotinfo->group_id);
        if (!fort) { if (err) *err = "fort entity unavailable"; return false; }
        auto position = find_position(fort, position_id);
        if (!position) { if (err) *err = "unknown position"; return false; }
        if (!position_is_possible_appointable(fort, position_id) &&
            !position_is_as_needed_squad_appointable(fort, position)) {
            if (err) *err = "position is neither currently offered by DF nor eligible as an "
                            "AS_NEEDED squad office";
            return false;
        }
        const int held = count_assignments(fort, position_id);
        if (position->number >= 0 && held >= position->number) {
            if (err) *err = "this position allows no more holders (the raws cap it at " +
                            std::to_string(position->number) + ")";
            return false;
        }
        auto assignment = create_assignment(fort, position_id);
        out_id = assignment->id;
        return true;
    });
}

// level is the enum value 0..4 (nearest_10 .. all_accurate); the client sends button_index - 1.
bool do_noble_precision(int level, std::string* err) {
    if (level < 0 || level > 4) { if (err) *err = "level out of range (0-4)"; return false; }
    return run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        plotinfo->nobles.bookkeeper_settings = static_cast<df::record_precision_level_type>(level);
        return true;
    });
}

// ---------------------------------------------- Justice (read-only)

std::string unit_name_or_blank(int32_t unit_id) {
    if (unit_id < 0)
        return "";
    auto unit = df::unit::find(unit_id);
    return unit ? DFHack::Units::getReadableName(unit) : "";
}

// DF stores no open/closed/cold flag; this split is derived from the three df::crime_flag bits.
std::string crime_case_state(df::crime* crime) {
    if (!crime) return "";
    if (!crime->flags.bits.discovered) return "cold";
    if (crime->flags.bits.sentenced) return "closed";
    return "open";
}

bool incident_person_matches(const df::incident_hfid* queued, const df::incident_hfid* party,
                             const df::unit* unit) {
    if (!queued)
        return false;
    std::vector<int32_t> party_hfids;
    if (party) {
        party_hfids = {party->hfid, party->visual_hfid, party->historical_hfid};
        for (int32_t identity : queued->all_witnessed_ident)
            if (std::find(party->all_witnessed_ident.begin(), party->all_witnessed_ident.end(),
                          identity) != party->all_witnessed_ident.end())
                return true;
    }
    if (unit)
        party_hfids.push_back(unit->hist_figure_id);
    for (int32_t hfid : party_hfids) {
        if (hfid >= 0 && (queued->hfid == hfid || queued->visual_hfid == hfid ||
                          queued->historical_hfid == hfid))
            return true;
    }
    return false;
}

bool crime_person_listed(const std::vector<df::incident_hfid*>& entries,
                         const df::incident_hfid* party, const df::unit* unit) {
    return std::any_of(entries.begin(), entries.end(), [&](df::incident_hfid* entry) {
        return incident_person_matches(entry, party, unit);
    });
}

std::string incident_person_name(const df::incident_hfid& ihf, int32_t unit_id,
                                 const char* fallback) {
    std::string name = unit_name_or_blank(unit_id);
    if (name.empty()) name = histfig_name(ihf.historical_hfid);
    if (name.empty()) name = histfig_name(ihf.visual_hfid);
    if (name.empty()) name = histfig_name(ihf.hfid);
    return name.empty() ? fallback : name;
}

void append_witnesses_json(std::ostringstream& body, df::crime* crime) {
    body << ",\"witnesses\":[";
    bool first = true;
    for (auto report : crime->witnesses) {
        if (!report) continue;
        if (!first) body << ",";
        first = false;
        body << "{\"type\":" << json_string(DFHack::enum_item_key(report->type))
             << ",\"year\":" << report->year
             << ",\"tick\":" << report->year_tick
             << ",\"reportedYear\":" << report->reported_year
             << ",\"reportedTick\":" << report->reported_year_tick
             << ",\"witnessId\":" << report->witness_id
             << ",\"witness\":" << json_string(incident_person_name(
                    report->witness_ihf, report->witness_id, "Identity unresolved"))
             << ",\"accusedId\":" << report->accused_id
             << ",\"accused\":" << json_string(report->accused_id >= 0
                    ? incident_person_name(report->accused_ihf, report->accused_id, "Person unresolved")
                    : "")
             << "}";
    }
    body << "]";
}

void append_crime_json(std::ostringstream& body, df::crime* crime) {
    df::unit* accused = df::unit::find(crime->accused);
    df::unit* criminal = df::unit::find(crime->criminal);
    df::unit* victim = df::unit::find(crime->victim);
    const bool accused_scheduled = crime_person_listed(crime->reports, &crime->accused_hf, accused);
    const bool accused_interviewed = crime_person_listed(
        crime->counterintelligence, &crime->accused_hf, accused);
    const bool criminal_scheduled = crime_person_listed(crime->reports, &crime->criminal_hf, criminal);
    const bool criminal_interviewed = crime_person_listed(
        crime->counterintelligence, &crime->criminal_hf, criminal);
    body << "{\"id\":" << crime->id
         << ",\"mode\":" << json_string(DFHack::enum_item_key(crime->mode))
         << ",\"sentenced\":" << (crime->flags.bits.sentenced ? "true" : "false")
         << ",\"discovered\":" << (crime->flags.bits.discovered ? "true" : "false")
         << ",\"needsTrial\":" << (crime->flags.bits.needs_trial ? "true" : "false")
         << ",\"year\":" << crime->event_year
         << ",\"prisonTime\":" << crime->punishment.prison_time
         << ",\"hammerstrikes\":" << crime->punishment.hammerstrikes
         << ",\"witnessCount\":" << static_cast<int>(crime->witnesses.size())
         << ",\"accusedId\":" << (accused ? accused->id : -1)
         << ",\"accused\":" << json_string(accused ? DFHack::Units::getReadableName(accused)
                                                   : unit_name_or_blank(crime->accused))
         << ",\"accusedProfessionColor\":" << (accused ? static_cast<int>(DFHack::Units::getProfessionColor(accused)) : -1)
         << ",\"accusedScheduled\":" << (accused_scheduled ? "true" : "false")
         << ",\"accusedInterviewed\":" << (accused_interviewed ? "true" : "false")
         << ",\"criminalId\":" << (criminal ? criminal->id : -1)
         << ",\"criminal\":" << json_string(criminal ? DFHack::Units::getReadableName(criminal) : "")
         << ",\"criminalProfessionColor\":" << (criminal ? static_cast<int>(DFHack::Units::getProfessionColor(criminal)) : -1)
         << ",\"criminalScheduled\":" << (criminal_scheduled ? "true" : "false")
         << ",\"criminalInterviewed\":" << (criminal_interviewed ? "true" : "false")
         << ",\"victimId\":" << (victim ? victim->id : -1)
         << ",\"victim\":" << json_string(victim ? DFHack::Units::getReadableName(victim) : "")
         << ",\"victimProfessionColor\":" << (victim ? static_cast<int>(DFHack::Units::getProfessionColor(victim)) : -1);
    append_witnesses_json(body, crime);
    body << "}";
}

// The preparer is position_enid + position_eppid -- the office the interrogation was conducted
// under, NOT the officer's identity (officer_hf). "" when it cannot be resolved, never a guess.
std::string report_preparer_position(const df::interrogation_resultst& result) {
    auto entity = df::historical_entity::find(result.position_enid);
    if (!entity)
        return "";
    for (auto assignment : entity->positions.assignments) {
        if (!assignment || assignment->id != result.position_eppid)
            continue;
        for (auto position : entity->positions.own) {
            if (position && position->id == assignment->position_id)
                return position_display_name(position);
        }
        break;
    }
    return "";
}

// justice_interfacest's actor/organization/plot lists are SCREEN state, not world state: they stay
// empty unless the player has the tab open, so these keys ship only while that surface is live.
void append_counterintel_state_json(std::ostringstream& body) {
    auto game = df::global::game;
    if (!game)
        return;
    const auto& info = game->main_interface.info;
    if (!info.open || info.current_mode != df::info_interface_mode_type::JUSTICE)
        return;
    const auto& justice = info.justice;
    if (justice.current_mode != df::justice_interface_mode_type::COUNTERINTELLIGENCE)
        return;
    const bool any_intel = !justice.base_actor_entry.empty() ||
                           !justice.base_organization_entry.empty() ||
                           !justice.base_plot_entry.empty();
    body << ",\"hasIntelligence\":" << (any_intel ? "true" : "false");
    if (justice.counterintelligence_mode != df::counterintelligence_mode_type::ACTORS)
        return;
    const int32_t selected = justice.counterintelligence_selected;
    if (selected < 0 || selected >= static_cast<int32_t>(justice.base_actor_entry.size()))
        return;
    auto actor = justice.base_actor_entry[selected];
    if (!actor)
        return;
    body << ",\"selectedActor\":{\"index\":" << selected
         << ",\"name\":" << json_string(actor->list_name)
         << ",\"hfid\":" << actor->historical_hfid
         << ",\"identityId\":" << actor->identity_id << "}";
}

void append_interrogation_reports_json(std::ostringstream& body, df::world* world) {
    body << "\"reports\":[";
    bool first = true;
    for (size_t i = 0; i < world->status.interrogation_reports.size(); ++i) {
        auto report = world->status.interrogation_reports[i];
        if (!report) continue;
        if (!first) body << ",";
        first = false;
        const auto& result = report->intcr;
        const int method = static_cast<int>(result.method);
        const bool method_set = method >= 0 && result.method_modifier != -1000000;
        auto relevant_entity = method_set && result.relevant_id >= 0
            ? df::historical_entity::find(result.relevant_id) : nullptr;
        body << "{\"index\":" << i
             << ",\"title\":" << json_string(report->title)
             << ",\"officerHf\":" << report->officer_hf
             << ",\"officer\":" << json_string(report->officer_name.empty()
                    ? histfig_name(report->officer_hf) : report->officer_name)
             << ",\"subjectHf\":" << report->subject_hf
             << ",\"subject\":" << json_string(histfig_name(report->subject_hf))
             << ",\"preparer\":" << json_string(report_preparer_position(report->intcr))
             << ",\"preparerEntityId\":" << report->intcr.position_enid
             << ",\"preparerAssignmentId\":" << report->intcr.position_eppid
             << ",\"viewed\":" << (report->flags.bits.viewed ? "true" : "false")
             << ",\"year\":" << report->year
             << ",\"tick\":" << report->tick
             << ",\"details\":[";
        bool first_detail = true;
        for (auto detail : report->details) {
            if (!detail) continue;
            if (!first_detail) body << ",";
            first_detail = false;
            body << json_string(*detail);
        }
        body << "],\"result\":{\"methodSet\":" << (method_set ? "true" : "false")
             << ",\"method\":" << (method_set ? json_string(DFHack::enum_item_key(result.method)) : "null")
             << ",\"successful\":" << (result.flags.bits.successful ? "true" : "false")
             << ",\"misjudged\":" << (result.flags.bits.failed_judgment_test ? "true" : "false")
             << ",\"methodModifier\":" << (method_set ? result.method_modifier : 0)
             << ",\"methodPerceivedModifier\":" << (method_set ? result.method_perceived_modifier : 0)
             << ",\"facet\":" << json_string(DFHack::enum_item_key(result.facet))
             << ",\"facetRating\":" << result.facet_rating
             << ",\"facetModifier\":" << result.facet_modifier
             << ",\"value\":" << json_string(DFHack::enum_item_key(result.value))
             << ",\"valueRating\":" << result.value_rating
             << ",\"valueModifier\":" << result.value_modifier
             << ",\"relationshipFactor\":" << json_string(
                    DFHack::enum_item_key(result.relationship_factor))
             << ",\"relationshipRating\":" << result.relationship_rating
             << ",\"relationshipModifier\":" << result.relationship_modifier
             << ",\"relevantId\":" << result.relevant_id
             << ",\"relevantName\":" << json_string(relevant_entity
                    ? DFHack::Translation::translateName(&relevant_entity->name, true) : "")
             << "},\"confessedCrimeIds\":[";
        for (size_t n = 0; n < report->confessed_target_crime_id.size(); ++n) {
            if (n) body << ",";
            body << report->confessed_target_crime_id[n];
        }
        body << "],\"confessedIdentityIds\":[";
        for (size_t n = 0; n < report->confessed_identity_id.size(); ++n) {
            if (n) body << ",";
            body << report->confessed_identity_id[n];
        }
        body << "],\"revealedAgreementIds\":[";
        for (size_t n = 0; n < report->revealed_agreement_id.size(); ++n) {
            if (n) body << ",";
            body << report->revealed_agreement_id[n];
        }
        body << "],\"revealedEventIds\":[";
        for (size_t n = 0; n < report->revealed_event_id.size(); ++n) {
            if (n) body << ",";
            body << report->revealed_event_id[n];
        }
        body << "]}";
    }
    body << "]";
}

void append_guard_json(std::ostringstream& body, df::historical_entity* fort) {
    int32_t squad_id = -1;
    if (fort) {
        for (auto position : fort->positions.own) {
            if (!position) continue;
            if (position->code != "CAPTAIN_OF_THE_GUARD" && position->code != "SHERIFF")
                continue;
            auto assignment = find_assignment(fort, position->id);
            if (assignment && assignment->squad_id >= 0) {
                squad_id = assignment->squad_id;
                if (position->code == "CAPTAIN_OF_THE_GUARD")
                    break; // prefer the Captain's squad over the Sheriff's if both exist
            }
        }
    }
    auto squad = squad_id >= 0 ? df::squad::find(squad_id) : nullptr;
    // desiredCagesChains has no backing DF field; null so the client renders nothing rather than
    // a fabricated count.
    body << "\"guard\":{\"squadId\":" << (squad ? squad->id : -1)
         << ",\"desiredCagesChains\":null"
         << ",\"unsupported\":" << (squad ? "false" : "true") << ",\"members\":[";
    bool first = true;
    if (squad) {
        for (auto pos : squad->positions) {
            if (!pos || pos->occupant < 0) continue;
            auto hf = df::historical_figure::find(pos->occupant);
            df::unit* unit = nullptr;
            if (hf) {
                for (auto u : df::global::world->units.active)
                    if (u && u->hist_figure_id == hf->id) { unit = u; break; }
            }
            if (!first) body << ",";
            first = false;
            body << "{\"unitId\":" << (unit ? unit->id : -1)
                 << ",\"name\":" << json_string(unit ? DFHack::Units::getReadableName(unit) : histfig_name(pos->occupant))
                 << ",\"profession\":" << json_string(unit ? DFHack::Units::getProfessionName(unit) : "")
                 << ",\"professionColor\":" << (unit ? static_cast<int>(DFHack::Units::getProfessionColor(unit)) : -1)
                 << ",\"portraitTexpos\":" << (unit ? unit->portrait_texpos : -1)
                 << "}";
        }
    }
    body << "]}";
}

void append_convicts_json(std::ostringstream& body, df::world* world) {
    body << "\"convicts\":[";
    bool first = true;
    int count = 0;
    for (auto crime : world->crimes.all) {
        if (!crime || !crime->flags.bits.sentenced)
            continue;
        int32_t unit_id = crime->accused >= 0 ? crime->accused : crime->criminal;
        df::unit* unit = df::unit::find(unit_id);
        df::unit* victim = df::unit::find(crime->victim);
        if (!first) body << ",";
        first = false;
        body << "{\"crimeId\":" << crime->id
             << ",\"unitId\":" << (unit ? unit->id : -1)
             << ",\"name\":" << json_string(unit ? DFHack::Units::getReadableName(unit) : unit_name_or_blank(unit_id))
             << ",\"profession\":" << json_string(unit ? DFHack::Units::getProfessionName(unit) : "")
             << ",\"professionColor\":" << (unit ? static_cast<int>(DFHack::Units::getProfessionColor(unit)) : -1)
             << ",\"portraitTexpos\":" << (unit ? unit->portrait_texpos : -1)
             << ",\"mode\":" << json_string(DFHack::enum_item_key(crime->mode))
             << ",\"prisonTime\":" << crime->punishment.prison_time
             << ",\"hammerstrikes\":" << crime->punishment.hammerstrikes
             << ",\"victimId\":" << (victim ? victim->id : -1)
             << ",\"victim\":" << json_string(victim ? DFHack::Units::getReadableName(victim) : "")
             << ",\"victimProfessionColor\":" << (victim ? static_cast<int>(DFHack::Units::getProfessionColor(victim)) : -1)
             << "}";
        if (++count >= 200) break;
    }
    body << "]";
}

std::string build_justice_json(const std::string& player, const std::string& mode, std::string* err) {
    std::ostringstream body;
    bool ok = run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        auto world = df::global::world;
        if (!world) { if (err) *err = "world unavailable"; return false; }

        body << "{\"player\":" << json_string(player)
             << ",\"justiceActive\":" << (plotinfo && plotinfo->justice_active ? "true" : "false");

        if (mode.empty()) {
            // No mode = the legacy full-crime-list shape; keep it unchanged.
            body << ",\"crimes\":[";
            bool first = true;
            int count = 0;
            for (auto crime : world->crimes.all) {
                if (!crime) continue;
                if (!first) body << ",";
                first = false;
                append_crime_json(body, crime);
                if (++count >= 200) break;
            }
            body << "]}\n";
            return true;
        }

        body << ",\"mode\":" << json_string(mode);
        if (mode == "open" || mode == "closed" || mode == "cold") {
            body << ",\"crimes\":[";
            bool first = true;
            int count = 0;
            for (auto crime : world->crimes.all) {
                if (!crime || crime_case_state(crime) != mode)
                    continue;
                if (!first) body << ",";
                first = false;
                append_crime_json(body, crime);
                if (++count >= 200) break;
            }
            body << "]}\n";
        } else if (mode == "guard") {
            auto fort = plotinfo ? df::historical_entity::find(plotinfo->group_id) : nullptr;
            body << ",";
            append_guard_json(body, fort);
            body << "}\n";
        } else if (mode == "convicts") {
            body << ",";
            append_convicts_json(body, world);
            body << ",\"wireBatch\":" << json_string(kWireBatchMarker) << "}\n";
        } else if (mode == "counterintel") {
            body << ",";
            append_interrogation_reports_json(body, world);
            append_counterintel_state_json(body);
            body << ",\"unsupported\":false}\n";
        } else {
            if (err) *err = "unknown justice mode";
            return false;
        }
        return true;
    });
    if (!ok)
        return "";
    return body.str();
}

// ---------------------------------------------- Petitions / agreements

std::string agreement_detail_summary(df::agreement* agreement) {
    if (!agreement || agreement->details.empty())
        return "Agreement";
    std::vector<std::string> parts;
    for (auto detail : agreement->details) {
        if (!detail)
            continue;
        parts.push_back(DFHack::enum_item_key(detail->type));
        if (parts.size() >= 3)
            break;
    }
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i) out += ", ";
        out += parts[i];
    }
    return out.empty() ? "Agreement" : out;
}

std::string agreement_petitioner(df::agreement* agreement) {
    if (!agreement)
        return "";
    for (auto party : agreement->parties) {
        if (party && !party->histfig_ids.empty())
            return histfig_name(party->histfig_ids[0]);
    }
    return "";
}

struct PetitionDetail {
    std::string site;
    std::string purpose;
    uint8_t* policy = nullptr;
};

std::string enum_words(const std::string& key) {
    std::string out = key;
    std::replace(out.begin(), out.end(), '_', ' ');
    return out;
}

PetitionDetail petition_detail(df::agreement* agreement) {
    PetitionDetail out;
    if (!agreement)
        return out;
    for (auto detail : agreement->details) {
        if (!detail)
            continue;
        int32_t site_id = -1;
        if (detail->type == df::agreement_details_type::Citizenship && detail->data.Citizenship) {
            site_id = detail->data.Citizenship->site;
            out.purpose = enum_words(DFHack::enum_item_key(detail->type));
            out.policy = df::global::standing_orders_petition_citizenship;
        } else if (detail->type == df::agreement_details_type::Residency && detail->data.Residency) {
            auto reason = detail->data.Residency->reason;
            site_id = detail->data.Residency->site;
            out.purpose = enum_words(DFHack::enum_item_key(reason));
            switch (reason) {
            case df::history_event_reason::entertain_people:
            case df::history_event_reason::hire_on_as_performer:
                out.policy = df::global::standing_orders_petition_resident_performer;
                break;
            case df::history_event_reason::eradicate_beasts:
                out.policy = df::global::standing_orders_petition_resident_monster_hunter;
                break;
            case df::history_event_reason::make_a_living_as_a_warrior:
            case df::history_event_reason::hire_on_as_mercenary:
                out.policy = df::global::standing_orders_petition_resident_mercenary;
                break;
            case df::history_event_reason::study:
            case df::history_event_reason::scholarship:
            case df::history_event_reason::hire_on_as_scholar:
                out.policy = df::global::standing_orders_petition_resident_scholar;
                break;
            case df::history_event_reason::seek_sanctuary:
                out.policy = df::global::standing_orders_petition_resident_sanctuary;
                break;
            default:
                break;
            }
        } else {
            continue;
        }
        if (auto site = df::world_site::find(site_id))
            out.site = DFHack::Translation::translateName(&site->name, true);
        break;
    }
    return out;
}

const char* petition_policy_name(uint8_t value) {
    static const char* names[] = {"prompt", "accept", "reject"};
    return value < 3 ? names[value] : "";
}

std::string build_petitions_json(const std::string& player, std::string* err) {
    std::ostringstream body;
    bool ok = run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }

        // plotinfo->petitions holds only unapproved ids; accepted obligations live in
        // continuing_agreement_id. Not world.agreements -- that also holds intrigue/parley ones.
        struct FortAgreementRef {
            int32_t id;
            bool pending_list;
            bool continuing_list;
        };
        std::vector<FortAgreementRef> agreement_refs;
        auto append_ids = [&](const std::vector<int32_t>& ids, bool pending_list) {
            for (int32_t id : ids) {
                auto found = std::find_if(agreement_refs.begin(), agreement_refs.end(),
                    [id](const FortAgreementRef& ref) { return ref.id == id; });
                if (found == agreement_refs.end()) {
                    agreement_refs.push_back({id, pending_list, !pending_list});
                } else if (pending_list) {
                    found->pending_list = true;
                } else {
                    found->continuing_list = true;
                }
            }
        };
        append_ids(plotinfo->petitions, true);
        append_ids(plotinfo->continuing_agreement_id, false);

        body << "{\"player\":" << json_string(player)
             << ",\"agreementCoverage\":\"pending+continuing\",\"petitions\":[";
        bool first = true;
        for (const auto& ref : agreement_refs) {
            auto agreement = df::agreement::find(ref.id);
            if (!first) body << ",";
            first = false;
            bool pending = agreement && agreement->flags.bits.petition_not_accepted;
            PetitionDetail detail = petition_detail(agreement);
            body << "{\"id\":" << ref.id
                 << ",\"summary\":" << json_string(agreement_detail_summary(agreement))
                 << ",\"petitioner\":" << json_string(agreement_petitioner(agreement))
                 << ",\"site\":" << json_string(detail.site)
                 << ",\"purpose\":" << json_string(detail.purpose)
                 << ",\"futurePolicy\":" << json_string(detail.policy ? petition_policy_name(*detail.policy) : "")
                 << ",\"inPendingList\":" << (ref.pending_list ? "true" : "false")
                 << ",\"inContinuingList\":" << (ref.continuing_list ? "true" : "false")
                 << ",\"pending\":" << (pending ? "true" : "false")
                 << ",\"valid\":" << (agreement ? "true" : "false")
                 << "}";
        }
        body << "]}\n";
        return true;
    });
    if (!ok)
        return "";
    return body.str();
}

bool do_petition_policy(int32_t agreement_id, int value, std::string* err) {
    return run_admin_locked([&]() -> bool {
        if (value < 0 || value > 2) { if (err) *err = "petition value must be 0, 1 or 2"; return false; }
        PetitionDetail detail = petition_detail(df::agreement::find(agreement_id));
        if (!detail.policy) { if (err) *err = "petition policy unavailable"; return false; }
        *detail.policy = static_cast<uint8_t>(value);
        return true;
    });
}

constexpr const char* kPetitionNativeOnlyReason =
    "Approving or denying a petition is a native-only action. The plugin cannot grant the "
    "petitioner residency (on accept) or record the decision the way DF does, so a plugin write "
    "would only hide the row without actually resolving it. Decide it on the host, in the Steam "
    "client (the petition notification / Agreements screen). To auto-handle future petitions of "
    "this kind from the browser, set the standing-orders response below.";

// A bad id still 400s; only a well-formed pending petition earns the 501 native-only refusal.
bool validate_pending_petition(int32_t agreement_id, std::string* err) {
    return run_admin_locked([&]() -> bool {
        auto agreement = df::agreement::find(agreement_id);
        if (!agreement) { if (err) *err = "agreement not found"; return false; }
        if (!agreement->flags.bits.petition_not_accepted) {
            if (err) *err = "not a pending petition";
            return false;
        }
        return true;
    });
}

// ---------------------------------------------- Justice write-actions
bool validate_justice_trial_action(int32_t crime_id, int32_t unit_id, std::string* err) {
    return run_admin_locked([&]() -> bool {
        auto crime = df::crime::find(crime_id);
        if (!crime) { if (err) *err = "crime not found"; return false; }
        if (!df::unit::find(unit_id)) { if (err) *err = "unit not found"; return false; }
        if (!crime->flags.bits.needs_trial || crime->flags.bits.sentenced) {
            if (err) *err = "the trial action panel is not available for this case";
            return false;
        }
        return true;
    });
}

// Commutes by zeroing plotinfo->punishments counters only: no history events, crime record intact.
// Returns how many rows were commuted, or -1 on a hard failure.
int do_justice_pardon(int32_t unit_id, std::string* err) {
    int commuted = 0;
    bool ok = run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "world unavailable"; return false; }
        for (auto punishment : plotinfo->punishments) {
            if (!punishment || punishment->criminal != unit_id)
                continue;
            punishment->prison_counter = 0;
            punishment->beating = 0;
            punishment->hammer_strikes = 0;
            ++commuted;
        }
        return true;
    });
    if (!ok)
        return -1;
    if (commuted == 0 && err)
        *err = "unit is not currently serving a sentence";
    return commuted;
}

// ---- Recenter hotkey locations (plotinfo->main.hotkeys[16]) -----------------------
// A slot is a live location when cmd == Zoom and x >= 0; DF's empty sentinel is -30000.
constexpr int kHotkeyEmpty = -30000;

std::string build_hotkeys_json() {
    std::ostringstream js;
    js << "{\"hotkeys\":[";
    bool ok = run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) return false;
        for (int i = 0; i < 16; ++i) {
            df::ui_hotkey& hk = plotinfo->main.hotkeys[i];
            bool set = (hk.cmd == df::hotkey_type::Zoom) && hk.x >= 0;
            if (i) js << ",";
            js << "{\"slot\":" << i
               << ",\"name\":" << json_string(hk.name)
               << ",\"cmd\":" << (int)hk.cmd
               << ",\"set\":" << (set ? "true" : "false")
               << ",\"x\":" << hk.x << ",\"y\":" << hk.y << ",\"z\":" << hk.z << "}";
        }
        return true;
    });
    if (!ok) return std::string();
    js << "]}\n";
    return js.str();
}

bool do_hotkey_action(int slot, const std::string& action, bool has_xyz,
                      int x, int y, int z, const std::string& name, std::string* err) {
    if (slot < 0 || slot >= 16) { if (err) *err = "slot out of range (0-15)"; return false; }
    return run_admin_locked([&]() -> bool {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) { if (err) *err = "plotinfo unavailable"; return false; }
        df::ui_hotkey& hk = plotinfo->main.hotkeys[slot];
        if (action == "set") {
            if (!has_xyz) { if (err) *err = "set requires x/y/z"; return false; }
            hk.cmd = df::hotkey_type::Zoom;
            hk.x = x; hk.y = y; hk.z = z;
            std::string nm = name;
            if (nm.size() > 128) nm.resize(128);
            if (nm.empty() && hk.name.empty())
                nm = "Location " + std::to_string(slot + 1);
            if (!nm.empty()) hk.name = nm;
            return true;
        }
        if (action == "clear") {
            hk.cmd = df::hotkey_type::None;
            hk.name.clear();
            hk.x = hk.y = hk.z = kHotkeyEmpty;
            return true;
        }
        if (action == "rename") {
            std::string nm = name;
            if (nm.size() > 128) nm.resize(128);
            hk.name = nm;
            return true;
        }
        if (err) *err = "unknown action: " + action;
        return false;
    });
}

} // namespace

void register_fort_admin_routes(httplib::Server& server) {
    // GET /nobles -> positions, holders (unit deep links), requirements, mandates.
    server.Get("/nobles", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string err;
        std::string json = build_nobles_json(player, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "nobles unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // GET /noble-candidates?position= -> assignable citizens, not DF's scored candidate list.
    server.Get("/noble-candidates", [](const httplib::Request& req, httplib::Response& res) {
        int position = -1;
        if (!query_int(req, "position", position)) { json_error(res, 400, "missing position"); return; }
        std::string player = query_player(req);
        std::string err;
        std::string json = build_noble_candidates_json(position, player, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "candidates unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // POST /noble-assign?position=&unit= (unit=-1 unassigns) -> set/clear the position holder.
    auto noble_assign_handler = [](const httplib::Request& req, httplib::Response& res) {
        int position = -1;
        if (!query_int(req, "position", position)) { json_error(res, 400, "missing position"); return; }
        int unit = -1;
        query_int(req, "unit", unit);
        std::string err;
        if (!do_noble_assign(position, unit, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/noble-assign", noble_assign_handler);
    server.Post("/noble-assign", noble_assign_handler);

    // POST /position-create?position= -> one new vacant seat, bounded by entity_position.number.
    // Returns the new assignment id, which /squad-create?position= takes directly.
    auto position_create_handler = [](const httplib::Request& req, httplib::Response& res) {
        int position = -1;
        if (!query_int(req, "position", position)) { json_error(res, 400, "missing position"); return; }
        int32_t assignment_id = -1;
        std::string err;
        if (!do_position_create(position, assignment_id, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true,\"assignmentId\":" + std::to_string(assignment_id) + "}\n");
    };
    server.Get("/position-create", position_create_handler);
    server.Post("/position-create", position_create_handler);

    // POST /noble-precision?level=0..4 -> the bookkeeper's record-precision goal.
    auto noble_precision_handler = [](const httplib::Request& req, httplib::Response& res) {
        int level = -1;
        if (!query_int(req, "level", level)) { json_error(res, 400, "missing level"); return; }
        std::string err;
        if (!do_noble_precision(level, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/noble-precision", noble_precision_handler);
    server.Post("/noble-precision", noble_precision_handler);

    // GET /justice[?mode=] -> one of DF's 6 Justice sub-tabs; no mode = the legacy crimes list.
    server.Get("/justice", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string mode = req.has_param("mode") ? req.get_param_value("mode") : "";
        std::string err;
        std::string json = build_justice_json(player, mode, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "justice unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // POST /justice-pardon?unit= -> commute that unit's active sentence.
    auto pardon_handler = [](const httplib::Request& req, httplib::Response& res) {
        int unit = -1;
        if (!query_int(req, "unit", unit) || unit < 0) { json_error(res, 400, "missing unit"); return; }
        std::string err;
        int commuted = do_justice_pardon(unit, &err);
        if (commuted < 0) { json_error(res, 503, err.empty() ? "pardon unavailable" : err); return; }
        if (commuted == 0) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true,\"commuted\":" + std::to_string(commuted) + "}\n");
    };
    server.Get("/justice-pardon", pardon_handler);
    server.Post("/justice-pardon", pardon_handler);

    // /justice-convict + /justice-interrogate are driven through DF's NATIVE justice UI via Lua;
    // the plugin never hand-writes crime.punishment, plotinfo.punishments or the history events.
    server.Get("/justice-convict", [](const httplib::Request& req, httplib::Response& res) {
        std::string err;
        std::string json = req.has_param("widgets")
            ? hostwrites_widgets_json_via_lua(req.get_param_value("widgets"), &err)
            : justice_state_json_via_lua(&err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "justice state unavailable" : err); return; }
        set_no_store_json(res, json);
    });
    auto justice_drive_handler = [](const char* action) {
        return [action](const httplib::Request& req, httplib::Response& res) {
            int crime = -1, unit = -1;
            if (!query_int(req, "crime", crime) || !query_int(req, "unit", unit)) {
                json_error(res, 400, "missing crime/unit"); return;
            }
            std::string err;
            if (!validate_justice_trial_action(crime, unit, &err)) {
                json_error(res, 400, err); return;
            }
            std::string json = justice_action_json_via_lua(action, crime, unit, &err);
            if (json.empty()) { json_error(res, 503, err.empty() ? "justice drive unavailable" : err); return; }
            res.status = hostwrites_status_for(json);
            res.set_header("Cache-Control", "no-store");
            res.set_content(json, "application/json; charset=utf-8");
            if (res.status == 200)
                notify_player_input();
        };
    };
    server.Post("/justice-convict", justice_drive_handler("convict"));
    server.Post("/justice-interrogate", justice_drive_handler("interrogate"));
    server.Get("/justice-interrogate", [](const httplib::Request& req, httplib::Response& res) {
        (void)req;
        std::string err;
        std::string json = justice_state_json_via_lua(&err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "justice state unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // GET /petitions -> pending + accepted agreements.
    server.Get("/petitions", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string err;
        std::string json = build_petitions_json(player, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "petitions unavailable" : err); return; }
        set_no_store_json(res, json);
    });

    // POST /petition-accept?id= and /petition-deny?id= -> validate, then refuse 501 native-only.
    auto native_only_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) { json_error(res, 400, "missing id"); return; }
        std::string err;
        if (!validate_pending_petition(id, &err)) { json_error(res, 400, err); return; }
        res.status = 501;
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":false,\"blocked\":\"native-only\",\"error\":" +
                            json_string(kPetitionNativeOnlyReason) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/petition-accept", native_only_handler);
    server.Post("/petition-accept", native_only_handler);
    server.Get("/petition-deny", native_only_handler);
    server.Post("/petition-deny", native_only_handler);

    // POST /petition-policy?id=&value=0|1|2 -> prompt/accept/reject for this petition category.
    server.Post("/petition-policy", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1, value = -1;
        if (!query_int(req, "id", id)) { json_error(res, 400, "missing id"); return; }
        if (!query_int(req, "value", value)) { json_error(res, 400, "missing value"); return; }
        std::string err;
        if (!do_petition_policy(id, value, &err)) { json_error(res, 400, err); return; }
        notify_player_input();
        set_no_store_json(res, "{\"ok\":true}\n");
    });

    // GET /hotkeys lists the 16 slots; POST /hotkey-action?slot=&action=set|clear|rename mutates
    // one. "set" takes the client's viewport centre as x/y/z; recentering goes through /camera.
    server.Get("/hotkeys", [](const httplib::Request& req, httplib::Response& res) {
        (void)req;
        std::string json = build_hotkeys_json();
        if (json.empty()) { json_error(res, 503, "hotkeys unavailable"); return; }
        set_no_store_json(res, json);
    });
    auto hotkey_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int slot = -1;
        if (!query_int(req, "slot", slot)) { json_error(res, 400, "missing slot"); return; }
        std::string action = req.has_param("action") ? req.get_param_value("action") : "";
        int x = 0, y = 0, z = 0;
        bool has_xyz = query_int(req, "x", x) & query_int(req, "y", y) & query_int(req, "z", z);
        std::string name = req.has_param("name") ? req.get_param_value("name") : "";
        std::string err;
        if (!do_hotkey_action(slot, action, has_xyz, x, y, z, name, &err)) {
            json_error(res, 400, err.empty() ? "hotkey action failed" : err);
            return;
        }
        set_no_store_json(res, "{\"ok\":true}\n");
    };
    server.Get("/hotkey-action", hotkey_action_handler);
    server.Post("/hotkey-action", hotkey_action_handler);
}

} // namespace dwf
