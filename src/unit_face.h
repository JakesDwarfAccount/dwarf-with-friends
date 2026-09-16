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

// The happiness FACE, in one place. The overhead-bubble stress predicates live in unit_status.h,
// which must never call getStressCategory -- keep the two questions in their two homes.
#pragma once

#include "modules/Units.h"

#include "df/mood_type.h"
#include "df/unit.h"

// The DISPLAYED face index (0 = happiest .. 6 = miserable), the reverse of getStressCategory's
// axis -- callers must not pass a raw stress category through as a face.
constexpr int kUnitFaceWorst = 6;

inline bool unit_has_insane_mood(df::unit* u) {
    if (!u) return false;
    return u->mood == df::mood_type::Melancholy
        || u->mood == df::mood_type::Raving
        || u->mood == df::mood_type::Berserk;
}

inline int unit_happiness_face(df::unit* u) {
    if (!u) return kUnitFaceWorst;
    if (unit_has_insane_mood(u)) return kUnitFaceWorst;
    int cat = DFHack::Units::getStressCategory(u);
    cat = cat < 0 ? 0 : (cat > 6 ? 6 : cat);
    return 6 - cat;
}

