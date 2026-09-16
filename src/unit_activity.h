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

#pragma once

#include "unit_activity_logic.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "modules/Job.h"
#include "modules/Units.h"

#include "df/activity_entry.h"
#include "df/activity_event.h"
#include "df/activity_event_type.h"
#include "df/job.h"
#include "df/job_type.h"
#include "df/unit.h"

namespace dwf {

// One world-side activity scan for one serialization pass. The per-unit resolver only performs
// an O(1) lookup in this map; it never walks world.activities itself.
class WorldActivityIndex {
public:
    WorldActivityIndex();
    df::activity_event* find(int32_t unit_id) const;

private:
    std::unordered_map<int32_t, df::activity_event*> events_by_unit_;
};

// Last/last fallback for the three non-social channels (individual_drills, conversations,
// activities). The social channel must use social_activity_event() instead.
inline df::activity_event* last_unit_activity_event(const std::vector<int32_t>& activity_ids) {
    for (auto id = activity_ids.rbegin(); id != activity_ids.rend(); ++id) {
        auto activity = df::activity_entry::find(*id);
        if (!activity || activity->events.empty())
            continue;
        if (auto event = activity->events.back())
            return event;
    }
    return nullptr;
}

// True when `unit_id` appears in this event's own participant list. Defined in
// unit_activity.cpp, where the per-event-type participant extraction already lives.
bool event_has_participant(df::activity_event* event, int32_t unit_id);

// LEDGER 0063 R1 + R2. DF's own social-activity resolver, reproduced.
//
// Plain English: a dwarf can be attending several social things at once, and each of those things
// has a list of events -- the main one plus any sub-events that spun off it. DF describes the
// dwarf using the FIRST thing he joined, and within it the NEWEST event he is actually named in.
// We used to ask DFHack, which gave us the LAST thing he joined and its newest event whether or
// not he was named in it -- so a dwarf could be described by a conversation happening next to him.
//
// NOT reproduced here: R3's abort test (native additionally rejects a candidate whose
// `checkDrillInvalid` virtual reports a reason -- a demolished library, a removed archery target).
// Native's implementations of that virtual DISMISS the event as a side effect, so it cannot be
// called from a read-only serialization path like this one without mutating the world during a
// GET. We approximate it by skipping events DF's own simulation has already dismissed, which
// means a stale label can survive until DF next runs the test itself.
inline df::activity_event* social_activity_event(df::unit* unit) {
    if (!unit)
        return nullptr;
    // forward over the activities -- the EARLIEST the unit joined wins.
    for (int32_t activity_id : unit->social_activities) {
        auto* activity = df::activity_entry::find(activity_id);
        if (!activity)
            continue;
        // backward over the events -- the NEWEST acceptable event of that activity wins.
        for (size_t i = activity->events.size(); i-- > 0;) {
            auto* event = activity->events[i];
            if (!event || event->flags.bits.dismissed)
                continue;
            // index 0 is the parent event and is accepted without the membership test; every
            // subevent must name this unit among its own participants.
            if (i > 0 && !event_has_participant(event, unit->id))
                continue;
            return event;
        }
    }
    return nullptr;
}

inline df::activity_event* unit_current_activity_event(df::unit* unit) {
    if (!unit)
        return nullptr;

    // DF's own resolver, not DFHack's last/last helper.
    if (auto event = social_activity_event(unit))
        return event;
    if (auto event = last_unit_activity_event(unit->individual_drills))
        return event;
    if (auto event = last_unit_activity_event(unit->conversations))
        return event;
    return last_unit_activity_event(unit->activities);
}

inline bool is_idle_task_placeholder(const std::string& name) {
    return name.empty() || name == "No job" || name == "No Job" ||
           name == "No activity" || name == "No Activity";
}

// Empty when the sub-code carries no refinement; the caller then keeps DF's own generic wording.
inline std::string surgery_stage_label(df::job_subtype_surgery stage) {
    switch (stage) {
    case df::job_subtype_surgery::StopBleeding:
        return "Surgery: halt bleeding";
    case df::job_subtype_surgery::RepairCompoundFracture:
        return "Surgery: repair compound fracture";
    case df::job_subtype_surgery::RemoveRottenTissue:
        return "Surgery: remove decayed tissue";
    default:
        return {};
    }
}

// DF owns every word of a job label here, except the surgery sub-stage above -- the one wording
// DWF paraphrases, because DFHack's job-name path cannot carry the sub-code.
inline std::string native_job_name(df::job* job) {
    if (!job)
        return {};

    if (job->job_type == df::job_type::Surgery) {
        std::string stage = surgery_stage_label(job->job_subtype);
        if (!stage.empty())
            return stage;
    }

    std::string name = DFHack::Job::getName(job);
    if (!is_idle_task_placeholder(name))
        return name;

    const char* caption = ENUM_ATTR(job_type, caption, job->job_type);
    if (caption && !is_idle_task_placeholder(caption))
        return caption;

    return ENUM_KEY_STR(job_type, job->job_type);
}

// What PRODUCED the current-task label, carried beside it so no caller has to re-derive it by
// pattern-matching the wording.
enum class UnitTaskColorBucket : uint8_t {
    None,
    Job,
    Social,
    Need,
    Training,
};

struct UnitCurrentTask {
    std::string name;
    UnitTaskColorBucket color_bucket = UnitTaskColorBucket::None;
};

// Only SkillDemonstration, Socialize and Worship are confirmed against a native capture; every
// other mapping below is inferred from its activity family.
inline UnitTaskColorBucket activity_task_color_bucket(df::activity_event_type type) {
    switch (type) {
    case df::activity_event_type::TrainingSession:
    case df::activity_event_type::CombatTraining:
    case df::activity_event_type::SkillDemonstration:
    case df::activity_event_type::IndividualSkillDrill:
    case df::activity_event_type::Sparring:
    case df::activity_event_type::RangedPractice:
        return UnitTaskColorBucket::Training;

    case df::activity_event_type::Prayer:
    case df::activity_event_type::Worship:
        return UnitTaskColorBucket::Need;

    case df::activity_event_type::Harassment:
    case df::activity_event_type::Conversation:
    case df::activity_event_type::Conflict:
    case df::activity_event_type::Reunion:
    case df::activity_event_type::Socialize:
    case df::activity_event_type::Performance:
    case df::activity_event_type::DiscussTopic:
    case df::activity_event_type::TeachTopic:
    case df::activity_event_type::Read:
    case df::activity_event_type::Play:
    case df::activity_event_type::MakeBelieve:
    case df::activity_event_type::PlayWithToy:
    case df::activity_event_type::Encounter:
        return UnitTaskColorBucket::Social;

    case df::activity_event_type::Guard:
    case df::activity_event_type::Research:
    case df::activity_event_type::PonderTopic:
    case df::activity_event_type::FillServiceOrder:
    case df::activity_event_type::Write:
    case df::activity_event_type::CopyWrittenContent:
    case df::activity_event_type::StoreObject:
        return UnitTaskColorBucket::Job;

    case df::activity_event_type::NONE:
        return UnitTaskColorBucket::None;
    }
    return UnitTaskColorBucket::None;
}

// Return DF's exact native current-task wording. `activity_event::getName` IS DF's own virtual
// `get_idle_string` (df.activity.xml:178, vmethod slot 22), so every shipped event subclass -- all
// 28 activity_event_type values, present and future -- composes its own label inside DF. We never
// author a word. That is why this is not, and must never become, a local enum->label table: DF
// interpolates the deity ("Pray to Armok"), the topic ("Ponder Justice"), the toy, the value, the
// per-participant role (organizer vs trainee), the travel prefixes ("Go to Sparring Match"), the
// "/Resting" suffix, and the trailing '!' -- and it does so per-unit, which is why the vmethod takes
// a unit id.
//
// The '!' (the `Worship!` oracle). CORRECTED by LEDGER 0063 R5. This block used to claim DF's
// naming virtual appends the marker itself and that we therefore neither add nor strip it. That is
// wrong: the marker is appended by DF's current-task COMPOSER, outside the naming virtual, gated
// on the unbailable-social-activity predicate. Because we call the naming virtual directly, our
// label can never carry it.
//
// We deliberately do NOT append it here, for two reasons, and this is a considered omission rather
// than an oversight:
//   1. Ledger 0063 grades the marker CHARACTER itself as MEDIUM confidence -- it is read from a
//      rodata byte the sweep did not resolve -- so appending a literal would be guessing at a word.
//      Everywhere else in this file, DF owns every character we print.
//   2. The same fact is already served losslessly as its own field: info_panel.cpp sets
//      `job_need_driven` from Units::hasUnbailableSocialActivity, and info_panel.h states outright
//      that it is real DF state rather than punctuation parsed out of a string. A client that wants
//      to mark these units has the data without us inventing typography.
// DFHack's helper is also a loose fit: it returns true for ANY unit in more than one social
// activity and for any activity type it does not special-case, so it over-reports.
inline UnitCurrentTask unit_current_task(df::unit* unit,
                                         const WorldActivityIndex* world_activities = nullptr) {
    if (!unit)
        return {};
    // The social channel is resolved first and regardless of the job.
    df::activity_event* social_event = social_activity_event(unit);
    df::activity_event* unit_event = nullptr;
    df::activity_event* world_event = nullptr;
    if (!social_event && !unit->job.current_job) {
        unit_event = unit_current_activity_event(unit);
        if (!unit_event && world_activities)
            world_event = world_activities->find(unit->id);
    }
    auto event_name = [unit](df::activity_event* event) {
        std::string name;
        event->getName(unit->id, &name);
        if (!is_idle_task_placeholder(name))
            return name;
        return ENUM_KEY_STR(activity_event_type, event->getType());
    };
    std::string name = activity_detail::resolve_current_task(
        social_event,
        unit->job.current_job,
        unit_event,
        world_event,
        native_job_name,
        event_name);
    // colour bucket follows the SAME precedence as the label, or the two disagree on screen.
    if (social_event)
        return {std::move(name), activity_task_color_bucket(social_event->getType())};
    if (unit->job.current_job)
        return {std::move(name), UnitTaskColorBucket::Job};
    if (auto event = unit_event ? unit_event : world_event)
        return {std::move(name), activity_task_color_bucket(event->getType())};
    return {std::move(name), UnitTaskColorBucket::None};
}

inline std::string unit_current_task_name(df::unit* unit,
                                          const WorldActivityIndex* world_activities = nullptr) {
    return unit_current_task(unit, world_activities).name;
}

} // namespace dwf
