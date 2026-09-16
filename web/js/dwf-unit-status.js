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

// Renderer-neutral unit-status bubble selection.
(function (root) {
  "use strict";

  var UNIT_STATUS_SHEET = "unit_status.png";
  var USTAT_SLEEPING = 0x01;
  var USTAT_UNCONSCIOUS = 0x02;
  var USTAT_STRESSED = 0x04;
  var USTAT_STRANGE_MOOD = 0x08;
  var USTAT_CAGED = 0x10;
  var USTAT_CHAINED = 0x20;
  var USTAT_WINDED = 0x00000200;
  var USTAT_STUNNED = 0x00000400;
  var USTAT_NAUSEA = 0x00000800;
  var USTAT_WEBBED = 0x00001000;
  var USTAT_PARALYZED = 0x00002000;
  var USTAT_FEVERED = 0x00004000;
  var USTAT_GROUNDED = 0x00008000;
  var USTAT_PROJECTILE = 0x00010000;
  var USTAT_CLIMBING = 0x00020000;
  var USTAT_MELANCHOLY = 0x00040000;
  var USTAT_MADNESS = 0x00080000;
  var USTAT_BERSERK = 0x00100000;
  var USTAT_MARTIAL_TRANCE = 0x00200000;
  var USTAT_ENRAGED = 0x00400000;
  var USTAT_TANTRUM = 0x00800000;
  var USTAT_DEPRESSION = 0x01000000;
  var USTAT_OBLIVIOUS = 0x02000000;
  var USTAT_HUNGRY = 0x04000000;
  var USTAT_THIRSTY = 0x08000000;
  var USTAT_DROWSY = 0x10000000;
  var USTAT_MOOD_SHIFT = 6;
  var USTAT_MOOD_MASK = 0x7 << USTAT_MOOD_SHIFT;
  var MOOD_CELL = Object.freeze({
    1: Object.freeze({ row: 9, token: "UNIT_STATUS:FEY_MOOD" }),
    2: Object.freeze({ row: 10, token: "UNIT_STATUS:POSSESSED" }),
    3: Object.freeze({ row: 11, token: "UNIT_STATUS:SECRETIVE_MOOD" }),
    4: Object.freeze({ row: 12, token: "UNIT_STATUS:FELL_MOOD" }),
    5: Object.freeze({ row: 13, token: "UNIT_STATUS:MACABRE_MOOD" }),
  });
  var USTAT2_MIGRANT = 0x00000001;
  var USTAT2_NO_JOB = 0x00000002;
  var USTAT2_NO_DESTINATION = 0x00000004;
  var USTAT2_DISTRACTED = 0x00000008;
  var USTAT2_TERRIFIED = 0x00000010;
  var USTAT2_WRESTLING = 0x00000020;
  var USTAT2_MINOR_INJURY = 0x00000040;
  var USTAT2_MAJOR_INJURY = 0x00000080;
  var USTAT2_MAKE_BELIEVE = 0x00000100;
  var USTAT2_TELLING_A_STORY = 0x00000200;
  var USTAT2_RECITING_POETRY = 0x00000400;
  var USTAT2_PERFORMING = 0x00000800;

  function usCell(row, name) {
    return { sheet: UNIT_STATUS_SHEET, col: 0, row: row, token: "UNIT_STATUS:" + name };
  }

  function unitStatusIconForBits(st, st2) {
    st = st | 0;
    st2 = st2 | 0;
    if (st & USTAT_SLEEPING) return usCell(8, "SLEEPING");
    if (st & USTAT_UNCONSCIOUS) return usCell(30, "UNCONSCIOUS");
    if (st & USTAT_PARALYZED) return usCell(26, "PARALYZED");
    if (st2 & USTAT2_TELLING_A_STORY) return usCell(34, "TELLING_A_STORY");
    if (st2 & USTAT2_RECITING_POETRY) return usCell(35, "RECITING_POETRY");
    if (st2 & USTAT2_PERFORMING) return usCell(36, "PERFORMING");
    if (st2 & USTAT2_MAKE_BELIEVE) return usCell(33, "PLAYING_MAKE_BELIEVE");
    if (st2 & USTAT2_WRESTLING) return usCell(23, "WRESTLING");
    if (st & USTAT_NAUSEA) return usCell(28, "NAUSEA");
    if (st & USTAT_STUNNED) return usCell(27, "STUNNED");
    if (st & USTAT_WINDED) return usCell(29, "WINDED");
    if (st2 & USTAT2_MAJOR_INJURY) return usCell(25, "MAJOR_INJURY");
    if (st2 & USTAT2_MINOR_INJURY) return usCell(24, "MINOR_INJURY");
    if (st & USTAT_FEVERED) return usCell(31, "FEVERED");
    if (st & USTAT_THIRSTY) return usCell(4, "THIRSTY");
    if (st & USTAT_HUNGRY) return usCell(3, "HUNGRY");
    if (st & USTAT_DROWSY) return usCell(5, "DROWSY");
    if (st & USTAT_STRESSED) return usCell(6, "STRESSED");
    if (st2 & USTAT2_DISTRACTED) return usCell(7, "DISTRACTED");
    if (st & USTAT_MARTIAL_TRANCE) return usCell(21, "MARTIAL_TRANCE");
    if (st & USTAT_ENRAGED) return usCell(20, "ENRAGED");
    if (st & USTAT_TANTRUM) return usCell(14, "TANTRUM");
    if (st & USTAT_DEPRESSION) return usCell(16, "DEPRESSION");
    if (st & USTAT_OBLIVIOUS) return usCell(15, "OBLIVIOUS");
    if (st2 & USTAT2_NO_JOB) return usCell(1, "NO_JOB");
    if (st2 & USTAT2_NO_DESTINATION) return usCell(2, "NO_DESTINATION");
    if (st & USTAT_BERSERK) return usCell(19, "BERSERK");
    if (st & USTAT_MADNESS) return usCell(17, "MADNESS");
    if (st & USTAT_MELANCHOLY) return usCell(18, "MELANCHOLY");
    if (st & USTAT_STRANGE_MOOD) {
      var mc = MOOD_CELL[(st & USTAT_MOOD_MASK) >> USTAT_MOOD_SHIFT] || MOOD_CELL[1];
      return { sheet: UNIT_STATUS_SHEET, col: 0, row: mc.row, token: mc.token };
    }
    if (st2 & USTAT2_TERRIFIED) return usCell(22, "TERRIFIED");
    if (st2 & USTAT2_MIGRANT) return usCell(0, "MIGRANT");
    if (st & USTAT_PROJECTILE) return usCell(37, "PROJECTILE");
    if (st & USTAT_GROUNDED) return usCell(38, "GROUNDED");
    if (st & USTAT_CLIMBING) return usCell(40, "CLIMBING");
    if (st & USTAT_WEBBED) return usCell(39, "WEBBED");
    if (st & (USTAT_CAGED | USTAT_CHAINED)) return null;
    return null;
  }

  var NATIVE_BUBBLE_PERIOD_MS = 7000;
  var NATIVE_BUBBLE_ID_STRIDE = 0x86e8;
  var NATIVE_BUBBLE_ORDINARY_MS = 5001;
  function nativeBubblePhase(unitId, nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    var id = unitId >>> 0;
    var idPhase = ((id % NATIVE_BUBBLE_PERIOD_MS) *
      (NATIVE_BUBBLE_ID_STRIDE % NATIVE_BUBBLE_PERIOD_MS)) % NATIVE_BUBBLE_PERIOD_MS;
    var t = Math.floor(nowMs) % NATIVE_BUBBLE_PERIOD_MS;
    if (t < 0) t += NATIVE_BUBBLE_PERIOD_MS;
    return (idPhase + t) % NATIVE_BUBBLE_PERIOD_MS;
  }

  function physicalStatusIconForBits(st) {
    st = st | 0;
    if (st & USTAT_PROJECTILE) return usCell(37, "PROJECTILE");
    if (st & USTAT_GROUNDED) return usCell(38, "GROUNDED");
    if (st & USTAT_CLIMBING) return usCell(40, "CLIMBING");
    if (st & USTAT_WEBBED) return usCell(39, "WEBBED");
    return null;
  }

  function ordinaryStatusIconForBits(st, st2) {
    var full = unitStatusIconForBits(st, st2);
    if (!full) return null;
    if (full.row === 37 || full.row === 38 || full.row === 39 || full.row === 40) return null;
    return full;
  }

  function unitStatusIconNow(st, st2, unitId, nowMs) {
    return nativeBubblePhase(unitId, nowMs) < NATIVE_BUBBLE_ORDINARY_MS
      ? physicalStatusIconForBits(st)
      : ordinaryStatusIconForBits(st, st2);
  }

  root.DwfUnitStatus = Object.freeze({
    MOOD_CELL: MOOD_CELL,
    NATIVE_BUBBLE_PERIOD_MS: NATIVE_BUBBLE_PERIOD_MS,
    NATIVE_BUBBLE_ID_STRIDE: NATIVE_BUBBLE_ID_STRIDE,
    NATIVE_BUBBLE_ORDINARY_MS: NATIVE_BUBBLE_ORDINARY_MS,
    unitStatusIconForBits: unitStatusIconForBits,
    nativeBubblePhase: nativeBubblePhase,
    physicalStatusIconForBits: physicalStatusIconForBits,
    ordinaryStatusIconForBits: ordinaryStatusIconForBits,
    unitStatusIconNow: unitStatusIconNow,
  });
})(typeof window !== "undefined" ? window : globalThis);
