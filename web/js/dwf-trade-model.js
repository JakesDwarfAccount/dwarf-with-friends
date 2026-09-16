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

// Shared trade-family row shaping.

(function (root) {
  "use strict";

  function depotGoodsRows(goods) {
    const list = (goods && Array.isArray(goods.goods)) ? goods.goods.filter(Boolean) : [];
    return list.map(g => ({
      id: Number(g && g.id),
      desc: (g && g.desc) || "(item)",
      value: Number((g && g.value) || 0),
      dist: Number((g && g.dist) || 0),
      pending: !!(g && g.pending),
      atDepot: !!(g && g.atDepot),
      forbidden: !!(g && g.forbidden),
      requested: !!(g && g.requested),
    })).filter(r => Number.isFinite(r.id) && r.id >= 0);
  }

  function barterRows(trade, side, { detail = false } = {}) {
    const key = side === 0 ? "caravanGoods" : "fortGoods";
    const list = (trade && Array.isArray(trade[key])) ? trade[key].filter(Boolean) : [];
    return list.map(g => {
      const row = {
        id: Number(g && g.id),
        idx: Number(g && g.idx),
        desc: (g && g.desc) || "(item)",
        value: Number((g && g.value) || 0),
        selected: !!(g && g.selected),
        contained: !!(g && g.contained),
      };
      if (!detail) return row;
      return Object.assign(row, {
        weight: Number((g && g.weight) || 0),
        weightFr: Number((g && g.weightFr) || 0),
        weightText: (g && typeof g.weightText === "string") ? g.weightText : null,
        group: (g && g.group) || "",
        spriteRef: (g && g.spriteRef) || null,
      });
    }).filter(r => Number.isFinite(r.id) && r.id >= 0);
  }

  const api = Object.freeze({ depotGoodsRows, barterRows });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DwfTradeModel = api;
})(typeof window !== "undefined" ? window : globalThis);
