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

// The one answer to "may this citizen be handed a fortress assignment?".

#include "modules/Units.h"

#include "df/unit.h"

namespace dwf {

inline bool is_assignable_citizen(df::unit* unit) {
    return unit && DFHack::Units::isCitizen(unit) && DFHack::Units::isActive(unit) &&
           !DFHack::Units::isDead(unit) && !DFHack::Units::isGhost(unit) &&
           !DFHack::Units::isBaby(unit) && !DFHack::Units::isChild(unit);
}

} // namespace dwf
