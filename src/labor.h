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

#include "httplib.h"

#include <cstdint>
#include <string>
#include <vector>

namespace dwf {

struct LaborRow {
    int id = 0;
    int32_t portrait_texpos = -1;
    std::string name;
    int8_t profession_color = -1; // Units::getProfessionColor; -1 means render without a hue.
    bool assigned = false;
    int skill = 0;
    std::string skill_label;
    bool specialist = false;
    std::string assigned_to;
};

struct LaborDetail {
    int index = 0;
    std::string name;
    int mode = 0;
    std::string skill_name;
    std::string icon_key;
    bool no_modify = false;
};

struct LaborTask {
    int id = 0;
    std::string key;
    std::string name;
    std::string category_key;
    std::string category;
    int category_order = 0;
    std::string skill_name;
    std::string icon_key;
    bool allowed = false;
};

struct LaborState {
    std::vector<LaborDetail> details;
    int selected = -1;
    std::string selected_skill_name;
    bool selected_no_modify = false;
    std::vector<LaborTask> tasks;
    std::vector<LaborRow> rows;
};

bool build_labor_state(int selected, LaborState& out, std::string* err = nullptr);
std::string labor_json(const LaborState& state);

// cpp-batch (Item 3): full assignable unit_labor enum ([{id,key,name,categoryKey,category,
// categoryOrder}]) for the Workers-tab checkboxes. Enum-only, lock-free (no world access).
std::string labor_list_json();

bool labor_toggle_impl(int detail, int unit_id, bool on, std::string* err = nullptr);
bool labor_mode_impl(int detail, int mode, std::string* err = nullptr);
bool labor_specialist_impl(int unit_id, bool on, std::string* err = nullptr);
bool labor_create_impl(const std::string& requested_name,
                       int* out_index = nullptr,
                       std::string* err = nullptr);
bool labor_rename_impl(int detail, const std::string& requested_name, std::string* err = nullptr);
bool labor_delete_impl(int detail, std::string* err = nullptr);
bool labor_task_toggle_impl(int detail, int labor, bool on, std::string* err = nullptr);

// Registers this module's HTTP routes (moved verbatim from http_server.cpp's
// register_routes monolith -- B212, 2026-07-13).
void register_labor_routes(httplib::Server& server);

} // namespace dwf
