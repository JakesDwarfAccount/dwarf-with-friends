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

// Shared location-family data shaping. Caller policy enters through options.
(function (root) {
  "use strict";

  function candidateRows(data, query, options) {
    var opts = options || {};
    var list = (data && Array.isArray(data.candidates)) ? data.candidates.filter(Boolean) : [];
    var q = String(query == null ? "" : query).trim().toLowerCase();
    var rejected = 0;
    var rows = list.filter(function (candidate) {
      if (typeof opts.accept === "function" && !opts.accept(candidate)) {
        if (opts.reportRejected) rejected++;
        return false;
      }
      if (!q) return true;
      return (String(candidate.name || "") + " " + String(candidate.profession || ""))
        .toLowerCase().indexOf(q) >= 0;
    }).map(function (candidate) {
      return {
        unitId: Number(candidate.unitId),
        name: String(candidate.name || ("Unit " + candidate.unitId)),
        profession: String(candidate.profession || ""),
        professionColor: Number(candidate.professionColor),
        held: String(candidate.heldOccupation || ""),
      };
    });
    if (opts.validateUnitId)
      rows = rows.filter(function (row) { return Number.isFinite(row.unitId) && row.unitId >= 0; });
    return { rows: rows, rejected: rejected };
  }

  var api = { candidateRows: candidateRows };
  root.DwfLocationModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
