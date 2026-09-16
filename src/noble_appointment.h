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

// The one answer to "which noble seat may a player be appointed to?".

#include "df/entity_position.h"
#include "df/entity_position_assignment.h"
#include "df/entity_position_flags.h"
#include "df/historical_entity.h"

#include <cstdint>

namespace dwf {

// possible_appointable already carries DF's population, market, replacement and appointer
// requirements; never infer availability from entity_position.number alone.
inline bool position_is_possible_appointable(df::historical_entity* fort, int32_t position_id) {
    if (!fort)
        return false;
    for (auto assignment : fort->positions.possible_appointable)
        if (assignment && assignment->position_id == position_id)
            return true;
    return false;
}

// AS_NEEDED squad offices (vanilla MILITIA_CAPTAIN) never appear in possible_appointable; this is
// the squad-only exception to the check above, and the raw requirements still apply.
inline bool position_is_as_needed_squad_appointable(df::historical_entity* fort,
                                                    df::entity_position* position) {
    if (!fort || !position || position->squad_size <= 0 || position->number >= 0 ||
        position->flags.is_set(df::entity_position_flags::HAS_BEEN_REPLACED) ||
        (position->requires_population > 0 &&
         !position->flags.is_set(df::entity_position_flags::HAS_MET_POP_REQ)) ||
        (position->flags.is_set(df::entity_position_flags::REQUIRES_MARKET) &&
         !position->flags.is_set(df::entity_position_flags::HAS_MET_MARKET_REQ)))
        return false;
    if (position->appointed_by.empty())
        return false;
    for (auto appointer_id : position->appointed_by)
        for (auto assignment : fort->positions.assignments)
            if (assignment && assignment->position_id == appointer_id && assignment->histfig >= 0)
                return true;
    return false;
}

} // namespace dwf
