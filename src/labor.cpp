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

#include "labor.h"

#include "api_response.h"
#include "http_server.h"

#include "Core.h"
#include "json_util.h"
#include "sdl_capture.h"

#include "modules/Units.h"

#include "df/global_objects.h"
#include "df/job_skill.h"
#include "df/plotinfost.h"
#include "df/skill_rating.h"
#include "df/unit.h"
#include "df/unit_labor.h"
#include "df/unit_labor_category.h"
#include "df/work_detail.h"
#include "df/work_detail_icon_type.h"
#include "df/work_detail_mode.h"
#include "df/world.h"

#include <algorithm>
#include <cctype>
#include <mutex>
#include <sstream>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_labor_mutex;

template <typename Fn>
bool run_labor_locked(Fn&& fn) {
    std::lock_guard<std::recursive_mutex> labor_lock(g_labor_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    return fn();
}

std::string readable_enum_key(std::string key) {
    for (char& c : key) {
        if (c == '_')
            c = ' ';
    }
    bool cap_next = true;
    for (char& c : key) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            cap_next = true;
        } else if (cap_next) {
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
            cap_next = false;
        } else {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
    }
    return key;
}

int labor_slot_count() {
    return static_cast<int>(df::enum_traits<df::unit_labor>::last_item_value) + 1;
}

bool valid_labor_index(int labor) {
    return labor >= 0 && labor < labor_slot_count() &&
           df::enum_traits<df::unit_labor>::is_valid(labor);
}

df::job_skill skill_for_labor(df::unit_labor labor) {
    if (labor == df::unit_labor::NONE)
        return df::job_skill::NONE;
    for (int i = 0; i <= df::enum_traits<df::job_skill>::last_item_value; ++i) {
        if (!df::enum_traits<df::job_skill>::is_valid(i))
            continue;
        auto skill = static_cast<df::job_skill>(i);
        if (df::enum_traits<df::job_skill>::attrs(skill).labor == labor)
            return skill;
    }
    return df::job_skill::NONE;
}

df::job_skill detail_primary_skill(df::work_detail* detail) {
    if (!detail)
        return df::job_skill::NONE;
    for (int i = 0; i <= df::enum_traits<df::unit_labor>::last_item_value; ++i) {
        if (df::enum_traits<df::unit_labor>::is_valid(i) && detail->allowed_labors[i]) {
            auto skill = skill_for_labor(static_cast<df::unit_labor>(i));
            if (skill != df::job_skill::NONE)
                return skill;
        }
    }
    return df::job_skill::NONE;
}

const char* job_skill_caption(df::job_skill skill) {
    if (skill == df::job_skill::NONE)
        return nullptr;
    return df::enum_traits<df::job_skill>::attrs(skill).caption;
}

std::string skill_label(df::unit* unit, df::job_skill skill) {
    if (skill == df::job_skill::NONE || !unit)
        return "";
    int rating = Units::getEffectiveSkill(unit, skill);
    if (rating <= df::skill_rating::Dabbling)
        return "";

    const char* skill_name = df::enum_traits<df::job_skill>::attrs(skill).caption_noun;
    if (!skill_name)
        skill_name = job_skill_caption(skill);

    const char* rating_name = nullptr;
    if (rating >= 0 && rating <= df::enum_traits<df::skill_rating>::last_item_value) {
        rating_name = df::enum_traits<df::skill_rating>::attrs(
            static_cast<df::skill_rating>(rating)).caption;
    }

    std::string label;
    if (rating_name)
        label = rating_name;
    if (skill_name) {
        if (!label.empty())
            label += " ";
        label += skill_name;
    }
    return label;
}

std::string labor_caption(df::unit_labor labor) {
    const char* caption = df::enum_traits<df::unit_labor>::attrs(labor).caption;
    if (caption && *caption)
        return caption;
    return readable_enum_key(DFHack::enum_item_key(labor));
}

bool labor_is_visible_in_picker(df::unit_labor labor) {
    if (labor == df::unit_labor::NONE)
        return false;
    std::string key = DFHack::enum_item_key(labor);
    return key.rfind("UNUSED_", 0) != 0;
}

std::string work_detail_icon_key(df::work_detail_icon_type icon) {
    int value = static_cast<int>(icon);
    if (!df::enum_traits<df::work_detail_icon_type>::is_valid(value))
        return "NONE";
    return DFHack::enum_item_key(icon);
}

std::string labor_category_key(df::unit_labor_category category) {
    int value = static_cast<int>(category);
    if (!df::enum_traits<df::unit_labor_category>::is_valid(value))
        return "Other";
    return DFHack::enum_item_key(category);
}

std::string labor_category_label(df::unit_labor_category category) {
    std::string key = labor_category_key(category);
    if (key == "Fishing")
        return "Fishing/Related";
    if (key == "Hunting")
        return "Hunting/Related";
    return readable_enum_key(key);
}

int labor_category_order(df::unit_labor_category category) {
    switch (category) {
    case df::unit_labor_category::Woodworking: return 10;
    case df::unit_labor_category::Stoneworking: return 20;
    case df::unit_labor_category::Hunting: return 30;
    case df::unit_labor_category::Healthcare: return 40;
    case df::unit_labor_category::Farming: return 50;
    case df::unit_labor_category::Fishing: return 60;
    case df::unit_labor_category::Metalsmithing: return 70;
    case df::unit_labor_category::Jewelry: return 80;
    case df::unit_labor_category::Crafts: return 90;
    case df::unit_labor_category::Engineering: return 100;
    case df::unit_labor_category::Hauling: return 110;
    case df::unit_labor_category::Other: return 120;
    default: return 130;
    }
}

df::work_detail_icon_type native_icon_for_labor(df::unit_labor labor) {
    switch (labor) {
    case df::unit_labor::MINE:
        return df::work_detail_icon_type::MINERS;
    case df::unit_labor::CUTWOOD:
        return df::work_detail_icon_type::WOODCUTTERS;
    case df::unit_labor::HUNT:
        return df::work_detail_icon_type::HUNTERS;
    case df::unit_labor::PLANT:
        return df::work_detail_icon_type::PLANTERS;
    case df::unit_labor::HERBALIST:
        return df::work_detail_icon_type::PLANT_GATHERERS;
    case df::unit_labor::FISH:
    case df::unit_labor::CLEAN_FISH:
    case df::unit_labor::DISSECT_FISH:
        return df::work_detail_icon_type::FISHERMEN;
    case df::unit_labor::STONECUTTER:
        return df::work_detail_icon_type::STONECUTTERS;
    case df::unit_labor::ENGRAVER:
        return df::work_detail_icon_type::ENGRAVERS;
    case df::unit_labor::HAUL_STONE:
    case df::unit_labor::HAUL_WOOD:
    case df::unit_labor::HAUL_BODY:
    case df::unit_labor::HAUL_FOOD:
    case df::unit_labor::HAUL_REFUSE:
    case df::unit_labor::HAUL_ITEM:
    case df::unit_labor::HAUL_FURNITURE:
    case df::unit_labor::HAUL_ANIMALS:
    case df::unit_labor::CLEAN:
    case df::unit_labor::HAUL_TRADE:
    case df::unit_labor::PULL_LEVER:
    case df::unit_labor::HAUL_WATER:
        return df::work_detail_icon_type::HAULERS;
    case df::unit_labor::DIAGNOSE:
    case df::unit_labor::SURGERY:
    case df::unit_labor::BONE_SETTING:
    case df::unit_labor::SUTURING:
    case df::unit_labor::DRESSING_WOUNDS:
    case df::unit_labor::FEED_WATER_CIVILIANS:
    case df::unit_labor::RECOVER_WOUNDED:
        return df::work_detail_icon_type::ORDERLIES;
    case df::unit_labor::SIEGEOPERATE:
        return df::work_detail_icon_type::SIEGE_OPERATORS;
    default:
        return df::work_detail_icon_type::NONE;
    }
}

df::work_detail_icon_type next_custom_work_detail_icon(const std::vector<df::work_detail*>& details) {
    int custom_count = 0;
    for (auto detail : details) {
        if (!detail)
            continue;
        int icon = static_cast<int>(detail->icon);
        if (icon >= static_cast<int>(df::work_detail_icon_type::CUSTOM_1) &&
            icon <= static_cast<int>(df::work_detail_icon_type::CUSTOM_8)) {
            ++custom_count;
        }
    }
    int icon = static_cast<int>(df::work_detail_icon_type::CUSTOM_1) + (custom_count % 8);
    return static_cast<df::work_detail_icon_type>(icon);
}

// Keep work-detail eligibility aligned with DFHack's living-unit predicates. isActive()
// covers flags1.inactive; isDead/isGhost cover retained corpses and real ghosts.
bool is_assignable_citizen(df::unit* unit) {
    return unit && Units::isCitizen(unit, true) && Units::isActive(unit) &&
           !Units::isDead(unit) && !Units::isGhost(unit);
}

void recompute_all_citizen_professions() {
    auto world = df::global::world;
    if (!world)
        return;
    for (auto unit : world->units.active) {
        if (is_assignable_citizen(unit))
            Units::setAutomaticProfessions(unit);
    }
}

std::string clean_work_detail_name(std::string name) {
    auto first = std::find_if_not(name.begin(), name.end(), [](unsigned char c) {
        return std::isspace(c);
    });
    auto last = std::find_if_not(name.rbegin(), name.rend(), [](unsigned char c) {
        return std::isspace(c);
    }).base();
    if (first >= last)
        return "";
    name = std::string(first, last);
    if (name.size() > 64)
        name.resize(64);
    return name;
}

} // namespace

ApiResult<LaborState> build_labor_state(int selected) {
    LaborState out;
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        auto world = df::global::world;
        if (!plotinfo || !world) {
            failure = {503, "world_unavailable", "plotinfo/world unavailable"};
            return false;
        }

        auto& details = plotinfo->labor_info.work_details;
        for (size_t i = 0; i < details.size(); ++i) {
            auto wd = details[i];
            if (!wd)
                continue;
            LaborDetail detail;
            detail.index = static_cast<int>(i);
            detail.name = wd->name;
            detail.mode = static_cast<int>(wd->flags.bits.mode);
            if (auto caption = job_skill_caption(detail_primary_skill(wd)))
                detail.skill_name = caption;
            detail.no_modify = wd->flags.bits.no_modify;
            detail.icon_key = work_detail_icon_key(wd->icon);
            out.details.push_back(detail);
        }

        out.selected = selected;
        if (selected < 0 || selected >= static_cast<int>(details.size()) || !details[selected])
            return true;

        auto wd = details[selected];
        auto skill = detail_primary_skill(wd);
        if (auto caption = job_skill_caption(skill))
            out.selected_skill_name = caption;
        out.selected_no_modify = wd->flags.bits.no_modify;

        for (int i = 0; i < labor_slot_count(); ++i) {
            if (!valid_labor_index(i))
                continue;
            auto labor = static_cast<df::unit_labor>(i);
            if (!labor_is_visible_in_picker(labor))
                continue;
            LaborTask task;
            task.id = i;
            task.key = DFHack::enum_item_key(labor);
            task.name = labor_caption(labor);
            auto category = df::enum_traits<df::unit_labor>::attrs(labor).category;
            task.category_key = labor_category_key(category);
            task.category = labor_category_label(category);
            task.category_order = labor_category_order(category);
            auto task_skill = skill_for_labor(labor);
            if (auto caption = job_skill_caption(task_skill))
                task.skill_name = caption;
            task.icon_key = work_detail_icon_key(native_icon_for_labor(labor));
            task.allowed = wd->allowed_labors[i];
            out.tasks.push_back(std::move(task));
        }
        std::stable_sort(out.tasks.begin(), out.tasks.end(), [](const LaborTask& a, const LaborTask& b) {
            if (a.category_order != b.category_order)
                return a.category_order < b.category_order;
            return a.id < b.id;
        });

        auto& assigned = wd->assigned_units;
        for (auto unit : world->units.active) {
            if (!is_assignable_citizen(unit))
                continue;
            LaborRow row;
            row.id = unit->id;
            row.portrait_texpos = unit->portrait_texpos;
            row.name = Units::getReadableName(unit);
            row.profession_color = Units::getProfessionColor(unit);
            row.assigned = std::binary_search(assigned.begin(), assigned.end(), unit->id);
            row.skill = skill != df::job_skill::NONE ? Units::getEffectiveSkill(unit, skill) : 0;
            row.skill_label = skill_label(unit, skill);
            row.specialist = unit->flags4.bits.only_do_assigned_jobs;
            for (auto other : details) {
                if (!other)
                    continue;
                if (std::binary_search(other->assigned_units.begin(), other->assigned_units.end(), unit->id)) {
                    if (!row.assigned_to.empty())
                        row.assigned_to += ", ";
                    row.assigned_to += other->name;
                }
            }
            out.rows.push_back(std::move(row));
        }
        std::stable_sort(out.rows.begin(), out.rows.end(), [](const LaborRow& a, const LaborRow& b) {
            if (a.skill != b.skill)
                return a.skill > b.skill;
            return a.name < b.name;
        });
        return true;
    });
    if (!ok) return ApiResult<LaborState>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<LaborState>::success(std::move(out));
}

std::string labor_json(const LaborState& state) {
    std::ostringstream body;
    body << "{\"details\":[";
    for (size_t i = 0; i < state.details.size(); ++i) {
        if (i) body << ",";
        const auto& d = state.details[i];
        body << "{\"index\":" << d.index
             << ",\"name\":" << json_string(d.name)
             << ",\"mode\":" << d.mode
             << ",\"skillName\":" << json_string(d.skill_name)
             << ",\"iconKey\":" << json_string(d.icon_key)
             << ",\"noModify\":" << (d.no_modify ? "true" : "false") << "}";
    }
    body << "],\"selected\":" << state.selected
         << ",\"skillName\":" << json_string(state.selected_skill_name)
         << ",\"selectedNoModify\":" << (state.selected_no_modify ? "true" : "false")
         << ",\"tasks\":[";
    for (size_t i = 0; i < state.tasks.size(); ++i) {
        if (i) body << ",";
        const auto& t = state.tasks[i];
        body << "{\"id\":" << t.id
             << ",\"key\":" << json_string(t.key)
             << ",\"name\":" << json_string(t.name)
             << ",\"categoryKey\":" << json_string(t.category_key)
             << ",\"category\":" << json_string(t.category)
             << ",\"categoryOrder\":" << t.category_order
             << ",\"skillName\":" << json_string(t.skill_name)
             << ",\"iconKey\":" << json_string(t.icon_key)
             << ",\"allowed\":" << (t.allowed ? "true" : "false") << "}";
    }
    body << "],\"rows\":[";
    for (size_t i = 0; i < state.rows.size(); ++i) {
        if (i) body << ",";
        const auto& r = state.rows[i];
        body << "{\"id\":" << r.id
             << ",\"name\":" << json_string(r.name)
             << ",\"professionColor\":" << static_cast<int>(r.profession_color)
             << ",\"portraitTexpos\":" << r.portrait_texpos
             << ",\"assigned\":" << (r.assigned ? "true" : "false")
             << ",\"skill\":" << r.skill
             << ",\"skillLabel\":" << json_string(r.skill_label)
             << ",\"specialist\":" << (r.specialist ? "true" : "false")
             << ",\"assignedTo\":" << json_string(r.assigned_to) << "}";
    }
    body << "]}\n";
    return body.str();
}

// cpp-batch (Item 3): the full assignable unit_labor enum, for the Workers-tab checkboxes.
// /workshop-info (lua) only carries currently-BLOCKED labors; this serves the complete pickable
// set so the UI can render every checkbox. Mod-safe: iterates the LIVE enum_traits table (never a
// hardcoded list), same selection/ordering as /labor's tasks[] (labor.cpp visible-picker filter +
// category sort), minus the per-work-detail `allowed` flag. Enum_traits are static, so no
// suspender/world access is needed -- this route is lock-free.
std::string labor_list_json() {
    struct Item { int id; std::string key, name, cat_key, cat; int cat_order; };
    std::vector<Item> items;
    for (int i = 0; i < labor_slot_count(); ++i) {
        if (!valid_labor_index(i))
            continue;
        auto labor = static_cast<df::unit_labor>(i);
        if (!labor_is_visible_in_picker(labor))
            continue;
        auto category = df::enum_traits<df::unit_labor>::attrs(labor).category;
        items.push_back({ i, DFHack::enum_item_key(labor), labor_caption(labor),
                          labor_category_key(category), labor_category_label(category),
                          labor_category_order(category) });
    }
    std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
        if (a.cat_order != b.cat_order) return a.cat_order < b.cat_order;
        return a.id < b.id;
    });
    std::ostringstream body;
    body << "{\"labors\":[";
    for (size_t i = 0; i < items.size(); ++i) {
        if (i) body << ",";
        const auto& it = items[i];
        body << "{\"id\":" << it.id
             << ",\"key\":" << json_string(it.key)
             << ",\"name\":" << json_string(it.name)
             << ",\"categoryKey\":" << json_string(it.cat_key)
             << ",\"category\":" << json_string(it.cat)
             << ",\"categoryOrder\":" << it.cat_order
             << "}";
    }
    body << "]}\n";
    return body.str();
}

ApiResult<bool> set_labor_assignment(int detail, int unit_id, bool on) {
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "plotinfo_unavailable", "no plotinfo"};
            return false;
        }
        auto& details = plotinfo->labor_info.work_details;
        if (detail < 0 || detail >= static_cast<int>(details.size()) || !details[detail]) {
            failure = {404, "labor_detail_not_found", "bad detail index"};
            return false;
        }
        auto unit = df::unit::find(unit_id);
        if (!is_assignable_citizen(unit)) {
            failure = {400, "unit_not_assignable", "unit is not an assignable living citizen"};
            return false;
        }
        auto& units = details[detail]->assigned_units;
        auto it = std::lower_bound(units.begin(), units.end(), unit_id);
        bool present = it != units.end() && *it == unit_id;
        if (on && !present)
            units.insert(it, unit_id);
        else if (!on && present)
            units.erase(it);
        Units::setAutomaticProfessions(unit);
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> set_labor_mode(int detail, int mode) {
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        auto world = df::global::world;
        if (!plotinfo || !world) {
            failure = {503, "world_unavailable", "plotinfo/world unavailable"};
            return false;
        }
        auto& details = plotinfo->labor_info.work_details;
        if (detail < 0 || detail >= static_cast<int>(details.size()) || !details[detail]) {
            failure = {404, "labor_detail_not_found", "bad detail index"};
            return false;
        }
        if (mode < 0 || mode > 3) {
            failure = {400, "invalid_labor_mode", "bad mode"};
            return false;
        }
        details[detail]->flags.bits.mode = static_cast<df::work_detail_mode>(mode);
        recompute_all_citizen_professions();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> set_labor_specialist(int unit_id, bool on) {
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto unit = df::unit::find(unit_id);
        if (!is_assignable_citizen(unit)) {
            failure = {400, "unit_not_assignable", "unit is not an assignable living citizen"};
            return false;
        }
        unit->flags4.bits.only_do_assigned_jobs = on;
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<int> create_labor_detail(const std::string& requested_name) {
    ApiError failure;
    int index = -1;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "plotinfo_unavailable", "no plotinfo"};
            return false;
        }
        auto& details = plotinfo->labor_info.work_details;
        auto detail = new df::work_detail();
        if (!detail) {
            failure = {500, "labor_detail_allocation_failed", "could not allocate work detail"};
            return false;
        }

        std::string name = clean_work_detail_name(requested_name);
        if (name.empty())
            name = "Custom Detail " + std::to_string(static_cast<int>(details.size()) + 1);
        detail->name = name;
        detail->flags.whole = 0;
        detail->flags.bits.mode = df::work_detail_mode::OnlySelectedDoesThis;
        detail->icon = next_custom_work_detail_icon(details);
        for (int i = 0; i < labor_slot_count(); ++i)
            detail->allowed_labors[i] = false;

        details.push_back(detail);
        index = static_cast<int>(details.size()) - 1;
        recompute_all_citizen_professions();
        return true;
    });
    if (!ok) return ApiResult<int>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<int>::success(index);
}

ApiResult<bool> rename_labor_detail(int detail, const std::string& requested_name) {
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "plotinfo_unavailable", "no plotinfo"};
            return false;
        }
        auto& details = plotinfo->labor_info.work_details;
        if (detail < 0 || detail >= static_cast<int>(details.size()) || !details[detail]) {
            failure = {404, "labor_detail_not_found", "bad detail index"};
            return false;
        }
        std::string name = clean_work_detail_name(requested_name);
        if (name.empty()) {
            failure = {400, "empty_labor_name", "name cannot be empty"};
            return false;
        }
        details[detail]->name = name;
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> delete_labor_detail(int detail) {
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "plotinfo_unavailable", "no plotinfo"};
            return false;
        }
        auto& details = plotinfo->labor_info.work_details;
        if (detail < 0 || detail >= static_cast<int>(details.size()) || !details[detail]) {
            failure = {404, "labor_detail_not_found", "bad detail index"};
            return false;
        }
        if (details[detail]->flags.bits.no_modify) {
            failure = {400, "labor_detail_protected", "default work details cannot be deleted"};
            return false;
        }
        auto old = details[detail];
        details.erase(details.begin() + detail);
        delete old;
        recompute_all_citizen_professions();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

ApiResult<bool> set_labor_task(int detail, int labor, bool on) {
    ApiError failure;
    const bool ok = run_labor_locked([&]() {
        auto plotinfo = df::global::plotinfo;
        if (!plotinfo) {
            failure = {503, "plotinfo_unavailable", "no plotinfo"};
            return false;
        }
        auto& details = plotinfo->labor_info.work_details;
        if (detail < 0 || detail >= static_cast<int>(details.size()) || !details[detail]) {
            failure = {404, "labor_detail_not_found", "bad detail index"};
            return false;
        }
        if (!valid_labor_index(labor) ||
            !labor_is_visible_in_picker(static_cast<df::unit_labor>(labor))) {
            failure = {400, "invalid_labor", "bad labor index"};
            return false;
        }
        details[detail]->allowed_labors[labor] = on;
        recompute_all_citizen_professions();
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_labor_routes(httplib::Server& server) {
    server.Get("/labor", [](const httplib::Request& req, httplib::Response& res) {
        int detail = -1;
        query_int(req, "detail", detail);
        const auto result = build_labor_state(detail);
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content(labor_json(result.value), "application/json; charset=utf-8");
    });

    auto labor_toggle_handler = [](const httplib::Request& req, httplib::Response& res) {
        int detail = -1;
        int unit_id = -1;
        int on = 0;
        if (!query_int(req, "detail", detail) || !query_int(req, "unit", unit_id) ||
            !query_int(req, "on", on)) {
            res.status = 400;
            res.set_content("missing detail/unit/on\n", "text/plain; charset=utf-8");
            return;
        }
        const auto result = set_labor_assignment(detail, unit_id, on != 0);
        if (!result.ok) { send_api_error(result, res); return; }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/labor-toggle", labor_toggle_handler);
    server.Post("/labor-toggle", labor_toggle_handler);

    auto labor_mode_handler = [](const httplib::Request& req, httplib::Response& res) {
        int detail = -1;
        int mode = -1;
        if (!query_int(req, "detail", detail) || !query_int(req, "mode", mode)) {
            res.status = 400;
            res.set_content("missing detail/mode\n", "text/plain; charset=utf-8");
            return;
        }
        const auto result = set_labor_mode(detail, mode);
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/labor-mode", labor_mode_handler);
    server.Post("/labor-mode", labor_mode_handler);

    auto labor_specialist_handler = [](const httplib::Request& req, httplib::Response& res) {
        int unit_id = -1;
        int on = 0;
        if (!query_int(req, "unit", unit_id) || !query_int(req, "on", on)) {
            res.status = 400;
            res.set_content("missing unit/on\n", "text/plain; charset=utf-8");
            return;
        }
        const auto result = set_labor_specialist(unit_id, on != 0);
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/labor-specialist", labor_specialist_handler);
    server.Post("/labor-specialist", labor_specialist_handler);

    auto labor_create_handler = [](const httplib::Request& req, httplib::Response& res) {
        std::string name = req.has_param("name") ? req.get_param_value("name") : "";
        const auto result = create_labor_detail(name);
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"index\":" + std::to_string(result.value) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Get("/labor-create", labor_create_handler);
    server.Post("/labor-create", labor_create_handler);

    auto labor_rename_handler = [](const httplib::Request& req, httplib::Response& res) {
        int detail = -1;
        if (!query_int(req, "detail", detail) || !req.has_param("name")) {
            res.status = 400;
            res.set_content("missing detail/name\n", "text/plain; charset=utf-8");
            return;
        }
        const auto result = rename_labor_detail(detail, req.get_param_value("name"));
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/labor-rename", labor_rename_handler);
    server.Post("/labor-rename", labor_rename_handler);

    auto labor_delete_handler = [](const httplib::Request& req, httplib::Response& res) {
        int detail = -1;
        if (!query_int(req, "detail", detail)) {
            res.status = 400;
            res.set_content("missing detail\n", "text/plain; charset=utf-8");
            return;
        }
        const auto result = delete_labor_detail(detail);
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/labor-delete", labor_delete_handler);
    server.Post("/labor-delete", labor_delete_handler);

    auto labor_task_handler = [](const httplib::Request& req, httplib::Response& res) {
        int detail = -1;
        int labor = -1;
        int on = 0;
        if (!query_int(req, "detail", detail) || !query_int(req, "labor", labor) ||
            !query_int(req, "on", on)) {
            res.status = 400;
            res.set_content("missing detail/labor/on\n", "text/plain; charset=utf-8");
            return;
        }
        const auto result = set_labor_task(detail, labor, on != 0);
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/labor-task-toggle", labor_task_handler);
    server.Post("/labor-task-toggle", labor_task_handler);

    // GET /labor-list -> full assignable unit_labor enum for the Workers-tab checkboxes
    // (cpp-batch Item 3). Additive; /workshop-info's blockedLabors[] only lists blocked ones.
    server.Get("/labor-list", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        res.set_content(labor_list_json(), "application/json; charset=utf-8");
    });
}

} // namespace dwf
