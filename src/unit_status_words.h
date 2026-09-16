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
// The unit sheet's Overview status-box words and its "Unmet need:" lines.
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

// ---- DF's fortress-mode status thresholds --------------------------------------------------
// DF's adventure-mode ladder on these same three need timers is far larger; never use it here.
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

// DF's own boundary for "Unmet need:": personality.flags.HAVE_NEGATIVE_NEED means a focus_level
// below -999, so a need at -1 is not printed.
constexpr int kDfNeedUnmetFocus = -999;

// DF's own words for each need, verbatim, not prettified enum keys.
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
    default:               return nullptr;   // NONE / an id DF added -> line omitted
    }
}

// deity_id is a historical_figure id; -1 is the unbound case, which DF prints as plain "Meditate".
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

// ---- the Overview status box: DF's own words, in DF's own emission order --------------------
inline std::vector<std::string> unit_status_words(df::unit* u) {
    std::vector<std::string> out;
    if (!u || !unit_is_animate(u))
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

    // DF prints "Drowning" here instead while the unit is drowning; the flag it picks on is unknown.
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

// ---- the Overview "Unmet need:" lines, most-starved first ----------------------------------
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
