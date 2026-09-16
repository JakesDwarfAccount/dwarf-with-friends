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
// The shared per-unit overhead-status words `st` / `st2`, and the unit predicates the map-unit
// serializers (append_unit_json, emit_units) gate on.
//
// NAMED-APPROXIMATION (TERRIFIED, SB-SERVER; R1): the overhead selector FUN_1402685d0 (sel:262-284)
// DEF-007: registered deferral
// reaches row 22 (0x16) as the DEFAULT case of a switch on unit->mood, entered when (mood not in
// {-1,8}) OR flags3.emotionally_overloaded (bit25, 0x2000000). There is NO emotion-type inspection
// whatsoever -- the earlier "dominant unovercome emotion == TERROR" walk was INVENTED (it read
// personality.emotions, which the native path never touches) and is removed. The honest v1 shipped
// here is: fire on flags3.emotionally_overloaded (df original name PERSONALITY_MOOD_PREVENTS_WORK),
// DF's transient "an emotion is currently preventing this unit from working" flag. Worst case this
// badges a unit overloaded by some OTHER strong emotion (grief, rage) as terrified; it cannot spam a
// healthy fort, since the flag is transient. The alternative honest disposition -- DISABLE the bubble
// entirely -- sits behind kUStat2TerrifiedApproxEnabled (flip to false; one-line revert). R1 asks for
// the exact fields DF uses to pick between the mood-switch cases so this can become EXACT.
//
// RESERVED, NOT SET (NO_DESTINATION, row 2): honestly unresolved, and deliberately NOT guessed. The
// DEF-008: registered deferral
// bit is allocated and the CLIENT maps it, so the probe's answer is a one-line server enable, but
// unit_status_bits2 never sets it today. Two incompatible readings survive the df-structures dig and
// the pause-only state cannot separate them: (a) a PATHING FAILURE -- the unit holds a goal it cannot
// reach (path.goal != None with an empty path.path); or (b) the animal-side twin of NO_JOB -- an idle
// fort creature that takes no jobs and has nowhere to be (path.goal == None). Reading (b) is
// attractive because rows 1 and 2 sit adjacent and would then partition citizens vs livestock, but a
// bare `path.goal == None` ALSO holds for every dwarf standing still for a tick, so shipping it blind
// would badge most of the fort most of the time -- the exact coincidental-pass trap the completeness
// protocol forbids. Probe P3 discriminates.
#pragma once

#include <climits>

#include "DataDefs.h"
#include "modules/Units.h"

#include "df/activity_event.h"
#include "df/activity_event_make_believest.h"
#include "df/activity_event_performancest.h"
#include "df/activity_event_type.h"
#include "df/emotion_type.h"
#include "df/job.h"
#include "df/job_type.h"
#include "df/misc_trait_type.h"
#include "df/mood_type.h"
#include "df/performance_participant_type.h"
#include "df/performance_rolest.h"
#include "df/personality_moodst.h"
#include "df/soldier_mood_type.h"
#include "df/unit.h"
#include "df/unit_action.h"
#include "df/unit_action_type.h"
#include "df/unit_item_wrestle.h"
#include "df/unit_misc_trait.h"
#include "df/unit_personality.h"
#include "df/unit_soul.h"
#include "df/unit_wound.h"
#include "df/unit_wound_layerst.h"

constexpr int kUStatSleeping    = 0x01;
constexpr int kUStatUnconscious = 0x02;
constexpr int kUStatStressed    = 0x04;
constexpr int kUStatStrangeMood = 0x08;
constexpr int kUStatCaged       = 0x10;
constexpr int kUStatChained     = 0x20;
constexpr int kUStatWinded        = 0x00000200;
constexpr int kUStatStunned       = 0x00000400;
constexpr int kUStatNausea        = 0x00000800;
constexpr int kUStatWebbed        = 0x00001000;
constexpr int kUStatParalyzed     = 0x00002000;
constexpr int kUStatFevered       = 0x00004000;
constexpr int kUStatGrounded      = 0x00008000;
constexpr int kUStatProjectile    = 0x00010000;
constexpr int kUStatClimbing      = 0x00020000;
constexpr int kUStatMelancholy    = 0x00040000;
constexpr int kUStatMadness       = 0x00080000;
constexpr int kUStatBerserk       = 0x00100000;
constexpr int kUStatMartialTrance = 0x00200000;
constexpr int kUStatEnraged       = 0x00400000;
constexpr int kUStatTantrum       = 0x00800000;
constexpr int kUStatDepression    = 0x01000000;
constexpr int kUStatOblivious     = 0x02000000;
constexpr int kUStatHungry        = 0x04000000;
constexpr int kUStatThirsty       = 0x08000000;
constexpr int kUStatDrowsy        = 0x10000000;
constexpr int kUStatHungerTimer   = 50000;   // == DF's "Hungry"
constexpr int kUStatThirstTimer   = 25000;   // == DF's "Thirsty"
constexpr int kUStatSleepTimer    = 57600;   // == DF's "Drowsy"
constexpr int kUStatStressLevel   = 20000;   // == DF's unit-SHEET "Stressed"
constexpr int kUStatBubbleStress  = 10000;   // overhead bubble: raw personality.stress, NOT longterm_stress
// NAMED-APPROXIMATION (DEF-009): true ships TERRIFIED off flags3.emotionally_overloaded alone,
// false disables the bubble; there is no emotion-type test behind either disposition.
constexpr bool kUStat2TerrifiedApproxEnabled = true;
// The mood subtype code is 1-BASED and 0x08 STRANGE_MOOD stays set for every mood, so a client that
// reads only 0x08, or sees subtype 0, still draws the default strange-mood cell.
constexpr int kUStatMoodShift = 6;                       // low bit of the mood subtype field
constexpr int kUStatMoodMask  = 0x7 << kUStatMoodShift;
constexpr int kUMoodNone      = 0;
constexpr int kUMoodFey       = 1;
constexpr int kUMoodPossessed = 2;
constexpr int kUMoodSecretive = 3;
constexpr int kUMoodFell      = 4;
constexpr int kUMoodMacabre   = 5;

// ---------------------------------------------- the SECOND status word, shipped as JSON int `st2`
constexpr int kUStat2Migrant        = 0x00000001;
constexpr int kUStat2NoJob          = 0x00000002;
constexpr int kUStat2NoDestination  = 0x00000004;
constexpr int kUStat2Distracted     = 0x00000008;
constexpr int kUStat2Terrified      = 0x00000010;
constexpr int kUStat2Wrestling      = 0x00000020;
constexpr int kUStat2MinorInjury    = 0x00000040;
constexpr int kUStat2MajorInjury    = 0x00000080;
constexpr int kUStat2MakeBelieve    = 0x00000100;
constexpr int kUStat2TellingStory   = 0x00000200;
constexpr int kUStat2RecitingPoetry = 0x00000400;
constexpr int kUStat2Performing     = 0x00000800;

// A caged unit's `unit->pos` stays frozen at the tile it was trapped on, so map sites must gate on
// this predicate, never on pos; hidden_in_ambush rides along because DF draws neither unit.
inline bool unit_is_map_present(df::unit* u) {
    if (!u) return false;
    if (u->flags1.bits.caged) return false;
    if (u->flags1.bits.hidden_in_ambush) return false;
    return true;
}

// Gate drawing on this, never on DFHack::Units::isAlive(): isAlive() also folds in the NOT_LIVING
// caste flag, so vampires and every raised undead would vanish from the map.
inline bool unit_is_animate(df::unit* u) {
    if (!u) return false;
    return !DFHack::Units::isDead(u);   // flags2.killed || flags3.ghostly
}

inline int unit_status_bits(df::unit* u) {
    if (!u || !unit_is_animate(u)) return 0;
    int st = 0;
    // NAMED-APPROXIMATION (DEF-010): native also gates SLEEPING on counters.unconscious and an
    // occupied bed/hospital ref; this ships current_job job_type Sleep OR Rest alone.
    if (u->job.current_job
        && (u->job.current_job->job_type == df::job_type::Sleep
            || u->job.current_job->job_type == df::job_type::Rest))
        st |= kUStatSleeping;
    if (u->counters.unconscious > 0)   st |= kUStatUnconscious;
    if (df::unit_soul* stress_soul = u->status.current_soul)
        if (stress_soul->personality.stress >= kUStatBubbleStress
            && u->mood == df::mood_type::None
            && u->counters.soldier_mood == df::soldier_mood_type::None)
            st |= kUStatStressed;
    // NAMED-APPROXIMATION (DEF-011): the !drowning split is native's, but native only shows WINDED
    // inside a per-unit physical sub-window; that cadence is left to the client.
    if (u->counters.winded > 0 && !u->flags1.bits.drowning) st |= kUStatWinded;
    if (u->counters.stunned > 0 || u->counters.dizziness > 0) st |= kUStatStunned;
    if (u->counters.nausea > 0)        st |= kUStatNausea;
    // NAMED-APPROXIMATION (DEF-012): the > 9 boundary is native's, but native only shows WEBBED
    // inside that same per-unit sub-window, which is not modelled here.
    if (u->counters.webbed > 9)        st |= kUStatWebbed;
    if (u->counters2.paralysis >= 100) st |= kUStatParalyzed;
    if (u->counters2.fever > 0)        st |= kUStatFevered;
    if (u->flags1.bits.on_ground)      st |= kUStatGrounded;
    if (u->flags1.bits.projectile)     st |= kUStatProjectile;
    for (df::unit_action* act : u->actions)
        if (act && act->type == df::unit_action_type::Climb) { st |= kUStatClimbing; break; }
    switch (u->mood) {
        case df::mood_type::Melancholy: st |= kUStatMelancholy; break;
        case df::mood_type::Raving:     st |= kUStatMadness;    break;
        case df::mood_type::Berserk:    st |= kUStatBerserk;    break;
        default: break;
    }
    switch (u->counters.soldier_mood) {
        case df::soldier_mood_type::MartialTrance: st |= kUStatMartialTrance; break;
        case df::soldier_mood_type::Enraged:       st |= kUStatEnraged;       break;
        case df::soldier_mood_type::Tantrum:       st |= kUStatTantrum;       break;
        case df::soldier_mood_type::Depressed:     st |= kUStatDepression;    break;
        case df::soldier_mood_type::Oblivious:     st |= kUStatOblivious;     break;
        default: break;
    }
    if (u->counters2.hunger_timer     >= kUStatHungerTimer) st |= kUStatHungry;
    if (u->counters2.thirst_timer     >= kUStatThirstTimer) st |= kUStatThirsty;
    if (u->counters2.sleepiness_timer >= kUStatSleepTimer)  st |= kUStatDrowsy;
    if (u->flags1.bits.has_mood) {
        st |= kUStatStrangeMood;
        int mood_code = kUMoodNone;
        switch (u->mood) {
            case df::mood_type::Fey:       mood_code = kUMoodFey;       break;
            case df::mood_type::Possessed: mood_code = kUMoodPossessed; break;
            case df::mood_type::Secretive: mood_code = kUMoodSecretive; break;
            case df::mood_type::Fell:      mood_code = kUMoodFell;      break;
            case df::mood_type::Macabre:   mood_code = kUMoodMacabre;   break;
            default: break;
        }
        st |= (mood_code << kUStatMoodShift) & kUStatMoodMask;
    }
    if (u->flags1.bits.caged)          st |= kUStatCaged;
    if (u->flags1.bits.chained)        st |= kUStatChained;
    return st;
}

// Every branch here must short-circuit on a cheap flag or emptiness test before any vector walk:
// this runs for every visible unit on every frame.
inline int unit_status_bits2(df::unit* u) {
    if (!u || !unit_is_animate(u)) return 0;
    int st2 = 0;

    if (df::unit_misc_trait* mt = DFHack::Units::getMiscTrait(u, df::misc_trait_type::Migrant, false))
        if (mt->value > 0) st2 |= kUStat2Migrant;

    // isJobAvailable() is stronger than a null current_job: a dwarf mid-conversation or mid-drill
    // holds no job but is not idle, and native does not badge them.
    if (!u->job.current_job
        && DFHack::Units::isCitizen(u)
        && DFHack::Units::isAdult(u)
        && DFHack::Units::isJobAvailable(u, false))
        st2 |= kUStat2NoJob;

    df::unit_soul* soul = u->status.current_soul;

    if (soul
        && u->mood == df::mood_type::None
        && u->counters.soldier_mood == df::soldier_mood_type::None) {
        const int32_t undistracted = soul->personality.undistracted_focus;
        const int32_t focus_pct = undistracted < 1
            ? 100
            : (soul->personality.current_focus * 100) / undistracted;
        if (focus_pct <= 80) st2 |= kUStat2Distracted;
    }

    // NAMED-APPROXIMATION (DEF-013): native reaches TERRIFIED as the default of a mood switch with
    // no emotion-type test at all; this fires on flags3.emotionally_overloaded alone.
    if (kUStat2TerrifiedApproxEnabled && u->flags3.bits.emotionally_overloaded)
        st2 |= kUStat2Terrified;

    // `unit == -1` rows are item grabs, not creature grapples.
    for (const auto& w : u->status.wrestle_items) {
        if (w && w->unit != -1) { st2 |= kUStat2Wrestling; break; }
    }

    // Graded off the transient body.wounds vector: body_part_status flags stay set forever, so a
    // veteran who lost a finger a decade ago would badge as permanently injured.
    if (!u->body.wounds.empty()) {
        bool severe = false;
        for (df::unit_wound* w : u->body.wounds) {
            if (!w) continue;
            if (w->flags.bits.severed_part || w->flags.bits.popped_out || w->flags.bits.infection) {
                severe = true; break;
            }
            for (df::unit_wound_layerst* p : w->parts) {
                if (!p) continue;
                if (p->flags1.bits.major_artery || p->flags1.bits.guts_spilled
                    || p->flags1.bits.compound_fracture) { severe = true; break; }
            }
            if (severe) break;
        }
        st2 |= severe ? kUStat2MajorInjury : kUStat2MinorInjury;
    }

    if (df::activity_event* ev = DFHack::Units::getMainSocialEvent(u)) {
        const df::activity_event_type et = ev->getType();
        if (et == df::activity_event_type::MakeBelieve) {
            st2 |= kUStat2MakeBelieve;
        } else if (et == df::activity_event_type::Performance) {
            if (auto* perf = virtual_cast<df::activity_event_performancest>(ev)) {
                for (df::performance_rolest* role : perf->participant_actions) {
                    if (!role || role->unit_id != u->id) continue;
                    switch (role->type) {
                        case df::performance_participant_type::PREACHER:
                        case df::performance_participant_type::STORYTELLER:
                            st2 |= kUStat2TellingStory;   break;
                        case df::performance_participant_type::POEM_RECITER:
                            st2 |= kUStat2RecitingPoetry; break;
                        case df::performance_participant_type::MUSICAL_VOICE:
                        case df::performance_participant_type::DANCER:
                            st2 |= kUStat2Performing;     break;
                        default: break;  // SPECTATOR / INCIDENTAL_SPECTATOR -> no bubble
                    }
                    break;  // a unit holds at most one role in a performance
                }
            }
        }
    }
    return st2;
}
