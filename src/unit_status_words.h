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
// ===========================================================================
// B280 -- the unit sheet's OVERVIEW STATUS BOX ("Thirsty") and UNMET-NEED LINES, and the
// DF-SIDE HALF OF THE BUBBLE CROSS-CHECK.
//
// WHERE THESE NUMBERS COME FROM. Not from a DFHack plugin, not from the wiki, not from a
// previous agent's comment. Every constant below was DECODED OUT OF `Dwarf Fortress.exe`
// by tools/harness/df_status_ladder.py, which finds each status word's string literal in
// .rdata, walks back to the `cmp dword [unit+FIELD], K` that gates it, and emits
// tools/harness/fixtures/df-status-ladder.json. tools/harness/status_truth_test.mjs then
// re-reads THIS FILE and fails if any constant here drifts from DF's.
//
// That is the whole point of the wave. Before B280 these three lines were "PROVISIONAL --
// cited, not measured" and nobody could tell whether the overhead bubbles were lying. They
// are now measured, and the test that checks them gets its expected values from DF rather
// than from us, so it cannot be satisfied by agreeing with our own mistake.
//
// DF'S FORTRESS-MODE LADDERS (decoded; see the spec for the code offsets):
//
//   soul->personality.longterm_stress  >= 100000 Harrowed | >= 50000 Haggard | >= 20000 Stressed
//     (LONGTERM_stress -- NOT the raw `stress` accumulator DFHack's getStressCategory grades.)
//   counters2.hunger_timer      >=  75000 Starving | >= 50000 Hungry
//   counters2.thirst_timer      >=  50000 Dehydrated | >= 25000 Thirsty
//   counters2.sleepiness_timer  >= 150000 Very drowsy | >= 57600 Drowsy
//   counters2.exhaustion        >=   6000 Exhausted | >= 4000 Over-exerted | >= 2000 Tired
//   counters2.paralysis         >=    100 Paralyzed | >= 50 Partially paralyzed | > 0 Sluggish
//   counters.pain               >=    100 Extreme pain | >= 50 Pain
//   counters2.numbness          >      0  Numb
//   counters2.fever             >      0  Fever
//   counters.unconscious        >      0  Unconscious
//   counters.stunned            >      0  Stunned
//   counters.nausea             >      0  Nauseous
//   counters.dizziness          >      0  Dizzy
//   counters.winded             >      0  Winded   (DF prints "Drowning" instead while drowning)
//   counters.webbed             >      0  Webbed / Partially webbed
//
// DF ALSO ships a SECOND ladder on the three need timers for ADVENTURE mode (57600..2592000).
// We are fortress mode. Those constants must never be used here -- and note that DFHack's own
// Units.cpp penalty tables interleave both, which is exactly the trap a "cited" constant falls
// into. The extractor separates them and reports both.
//
// NOT IMPLEMENTED HERE, HONESTLY (the extractor lists them as `ungated` -- DF computes them
// rather than testing one field, and this file will not guess):
//   * Pale / Faint            -- blood-loss bands off body.blood_count vs the caste maximum.
//   * Bleeding / Heavy bleeding -- a summed bleed rate over the wound vector.
//   * Injured / Seriously injured / Healthy -- a wound walk. (The overhead MINOR/MAJOR_INJURY
//     bubbles in unit_status.h grade the same wound vector; wiring the WORDS to the same
//     predicate is a candidate follow-up, but DF's exact severity test is not decoded, so
//     asserting the two agree would be asserting our own opinion twice. Left out on purpose.)
//   * Drowning vs Winded      -- both hang off counters.winded; the split flag is not decoded.
// A capture request for each of these is in the wave report. DO NOT fill them in from memory.
// ===========================================================================
#pragma once

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "DataDefs.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/historical_figure.h"
#include "df/need_type.h"
#include "df/personality_needst.h"
#include "df/unit.h"
#include "df/unit_personality.h"
#include "df/unit_soul.h"

namespace dwf {

// ---- DF's fortress-mode status thresholds (decoded from Dwarf Fortress.exe) ----------------
// status_truth_test.mjs parses these very lines out of this file and diffs them against
// df-status-ladder.json. Renaming a constant is fine; changing a NUMBER without DF changing
// underneath you turns the suite red.
constexpr int kDfStressHarrowed      = 100000;
constexpr int kDfStressHaggard       =  50000;
constexpr int kDfStressStressed      =  20000;
constexpr int kDfHungerStarving      =  75000;
constexpr int kDfHungerHungry        =  50000;
constexpr int kDfThirstDehydrated    =  50000;
constexpr int kDfThirstThirsty       =  25000;
constexpr int kDfSleepVeryDrowsy     = 150000;
constexpr int kDfSleepDrowsy         =  57600;
constexpr int kDfExhaustExhausted    =   6000;
constexpr int kDfExhaustOverExerted  =   4000;
constexpr int kDfExhaustTired        =   2000;
constexpr int kDfParalysisFull       =    100;
constexpr int kDfParalysisPartial    =     50;
constexpr int kDfPainExtreme         =    100;
constexpr int kDfPainSome            =     50;

// DF's own filter for which needs print as "Unmet need:". Its bookkeeping flag
// personality.flags.HAVE_NEGATIVE_NEED is documented in df-structures as "focus_level is below
// -999 for at least one need", so -999 is DF's boundary, not ours -- the same one unit_status.h's
// DISTRACTED bit already rides. A need at -1 is a dwarf who could use a drink sometime; DF does
// not print it, and neither do we.
constexpr int kDfNeedUnmetFocus = -999;

// The label DF prints for each need. Sourced from the string block in Dwarf Fortress.exe that sits
// contiguous with 'Unmet need: ' and 'No unmet needs' -- these are DF's words, verbatim, not
// prettified enum keys (our old unit_overview_need_lines() printed "Pray Deity" from the enum key;
// DF prints "Pray to Anan Stardreams").
inline const char* df_need_label(df::need_type id) {
    using namespace df::enums::need_type;
    switch (id) {
    case Socialize:        return "Socialize";
    case DrinkAlcohol:     return "Drink alcohol";
    case PrayOrMeditate:   return "Meditate";       // overridden to "Pray to <deity>" when bound
    case StayOccupied:     return "Stay occupied";
    case BeCreative:       return "Be creative";
    case Excitement:       return "Excitement";
    case LearnSomething:   return "Learn something";
    case BeWithFamily:     return "Be with family";
    case BeWithFriends:    return "Be with friends";
    case HearEloquence:    return "Hear eloquence";
    case UpholdTradition:  return "Uphold tradition";
    case SelfExamination:  return "Self-examination";
    case MakeMerry:        return "Make merry";
    case CraftObject:      return "Craft object";
    case MartialTraining:  return "Martial training";
    case PracticeSkill:    return "Practice skill";
    case TakeItEasy:       return "Take it easy";
    case MakeRomance:      return "Make romance";
    case SeeAnimal:        return "See animal";
    case SeeGreatBeast:    return "See great beast";
    case AcquireObject:    return "Acquire object";
    case EatGoodMeal:      return "Eat good meal";
    case Fight:            return "Fight";
    case CauseTrouble:     return "Cause trouble";
    case Argue:            return "Argue";
    case BeExtravagant:    return "Be extravagant";
    case Wander:           return "Wander";
    case HelpSomebody:     return "Help somebody";
    case ThinkAbstractly:  return "Think abstractly";
    case AdmireArt:        return "Admire art";
    default:               return nullptr;   // NONE / an id DF added -> line omitted, never faked
    }
}

// PrayOrMeditate carries a deity: personality_needst.deity_id is a historical_figure id (its
// df-structures original name is `spec_id`, "for pray need"), and DF prints "Pray to <figure>".
// deity_id == -1 is the unbound case, which DF prints as plain "Meditate".
inline std::string df_need_text(const df::personality_needst* need) {
    if (!need)
        return std::string();
    const char* base = df_need_label(need->id);
    if (!base)
        return std::string();
    if (need->id == df::need_type::PrayOrMeditate && need->deity_id != -1) {
        if (df::historical_figure* hf = df::historical_figure::find(need->deity_id)) {
            std::string name = DFHack::Translation::translateName(&hf->name, false);
            if (!name.empty())
                return "Pray to " + name;
        }
        return std::string("Pray");   // deity bound but unnameable -- DF's bare 'Pray ' string
    }
    return base;
}

// ---- the Overview status box -------------------------------------------------------------
// Returns DF's words for this unit, in DF's own emission order (stress, then the three needs,
// then the physical states). Empty vector == DF prints nothing, which is the healthy case.
//
// Reads only plain fields on an already-held unit; callers invoke this under their EXISTING
// CoreSuspender hold, exactly like unit_status_bits().
inline std::vector<std::string> unit_status_words(df::unit* u) {
    std::vector<std::string> out;
    if (!u || !DFHack::Units::isAlive(u))
        return out;

    if (df::unit_soul* soul = u->status.current_soul) {
        const int32_t s = soul->personality.longterm_stress;
        if (s >= kDfStressHarrowed)      out.push_back("Harrowed");
        else if (s >= kDfStressHaggard)  out.push_back("Haggard");
        else if (s >= kDfStressStressed) out.push_back("Stressed");
    }

    const int32_t hunger = u->counters2.hunger_timer;
    if (hunger >= kDfHungerStarving)    out.push_back("Starving");
    else if (hunger >= kDfHungerHungry) out.push_back("Hungry");

    const int32_t thirst = u->counters2.thirst_timer;
    if (thirst >= kDfThirstDehydrated)  out.push_back("Dehydrated");
    else if (thirst >= kDfThirstThirsty) out.push_back("Thirsty");

    const int32_t sleep = u->counters2.sleepiness_timer;
    if (sleep >= kDfSleepVeryDrowsy)  out.push_back("Very drowsy");
    else if (sleep >= kDfSleepDrowsy) out.push_back("Drowsy");

    if (u->counters.unconscious > 0) out.push_back("Unconscious");

    const int32_t par = u->counters2.paralysis;
    if (par >= kDfParalysisFull)         out.push_back("Paralyzed");
    else if (par >= kDfParalysisPartial) out.push_back("Partially paralyzed");
    else if (par > 0)                    out.push_back("Sluggish");

    if (u->counters.stunned > 0)   out.push_back("Stunned");
    if (u->counters.dizziness > 0) out.push_back("Dizzy");

    const int32_t ex = u->counters2.exhaustion;
    if (ex >= kDfExhaustExhausted)        out.push_back("Exhausted");
    else if (ex >= kDfExhaustOverExerted) out.push_back("Over-exerted");
    else if (ex >= kDfExhaustTired)       out.push_back("Tired");

    // DF prints "Drowning" instead of "Winded" while the unit is drowning. The flag that makes
    // that choice is NOT decoded (see the banner), so we print the word we can prove.
    if (u->counters.winded > 0) out.push_back("Winded");
    if (u->counters.nausea > 0) out.push_back("Nauseous");

    const int32_t pain = u->counters.pain;
    if (pain >= kDfPainExtreme)   out.push_back("Extreme pain");
    else if (pain >= kDfPainSome) out.push_back("Pain");

    if (u->counters2.numbness > 0) out.push_back("Numb");
    if (u->counters2.fever > 0)    out.push_back("Fever");
    if (u->counters.webbed > 0)    out.push_back("Webbed");

    return out;
}

// ---- the Overview "Unmet need:" lines ------------------------------------------------------
// DF's own filter (focus_level < -999), DF's own labels, DF's own ordering (most-starved first).
inline std::vector<std::string> unit_unmet_need_lines(df::unit* u) {
    std::vector<std::string> out;
    if (!u)
        return out;
    df::unit_soul* soul = u->status.current_soul;
    if (!soul)
        return out;
    std::vector<std::pair<int32_t, std::string>> ranked;
    for (df::personality_needst* need : soul->personality.needs) {
        if (!need || need->focus_level >= kDfNeedUnmetFocus)
            continue;
        std::string text = df_need_text(need);
        if (text.empty())
            continue;
        ranked.emplace_back(need->focus_level, "Unmet need: " + text);
    }
    std::sort(ranked.begin(), ranked.end(),
              [](const std::pair<int32_t, std::string>& a, const std::pair<int32_t, std::string>& b) {
                  return a.first < b.first;
              });
    for (const auto& entry : ranked)
        out.push_back(entry.second);
    return out;
}

} // namespace dwf
