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

// Curated one-line supplements for the ? help reference. A note NEVER forks the harvested text:
// keys are {surface, text} matched EXACTLY, so an orphan key fails the drift guard.
(function (root) {
  "use strict";

  var DFHelpCurated = {
    version: "help-curated v1 (B207)",
    // surface id -> { exact harvested text : curated one-liner }
    notes: {
      tools: {
        "Justice.": "Review crime reports, convict wrongdoers, and interrogate suspects.",
        "Labor management.": "Choose which jobs each dwarf is allowed to perform.",
        "Military and squads.": "Form squads, set uniforms, and give military orders.",
        "World and civilizations.": "See the world map, neighbors, and launch missions or raids.",
        "Place information.": "Guildhalls, temples, hospitals, taverns and other fort locations.",
        "Nobles and administrators.": "Assign the manager, bookkeeper, sheriff, and other officials.",
        "Fortress job list.": "Every job dwarves are currently doing or waiting to do.",
      },
      topbar: {
        "Fortress activity": "A dashboard of what your fort has been building and who has been busy.",
        "Players / lobby": "See who is connected and jump to their camera.",
      },
    },
  };

  root.DFHelpCurated = DFHelpCurated;
  if (typeof module !== "undefined" && module.exports) module.exports = DFHelpCurated;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
