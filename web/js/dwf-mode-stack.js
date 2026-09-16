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
// ---- The input close law: Escape and right-click are one path, and popOne() pops exactly one level. ----
(function (root) {
  "use strict";

  var levels = [];   // { id, flow, depth, active, pop }
  var lastPopped = null;

  // The declared back-out chains, rung ids deepest-first. `exclusive` pairs may share a depth because
  // their predicates can never both hold. A registered rung that appears in NO chain is a violation.
  var CHAINS = {
    "global-overlays": { order: ["host-settings", "context-help", "help-reference", "keymap-reference"] },
    // DF's own screen stack, above every client tool; chat-ping still outranks it, so a transient pick is
    // always one press from gone.
    "screen-stack": { order: ["world-screen", "esc-menu"] },
    "camera-selection": { order: ["chat-ping", "selection-sheet", "client-panel"] },
    // A pending paint corner outranks every session it could belong to.
    "paint-gesture": { order: ["paint-anchor"] },
    // 0080 modes handled by the designation surface: pending box, then the armed tool.
    "designations": { order: ["designation-anchor", "designation-tool"] },
    // ONE close arm for menu, placement and materials: build-menu and build-armed share a depth because
    // the menu's own predicate excludes the armed state.
    "building-placement": { order: ["build-anchor", "build-menu", "build-armed"],
      exclusive: [["build-menu", "build-armed"]] },
    // 0080 modes 3/4 (zone / zone paint): repaint session, paint stage, then the mode.
    "zones": { order: ["zone-repaint", "zone-paint", "zone-mode"] },
    // 0080 modes 5/6 (stockpile / stockpile paint).
    "stockpile-paint": { order: ["stock-repaint", "stock-mode"] },
    // 0080 mode 7 + R5: burrow is ONE level -- a single press closes the symbol picker WITH the
    // mode (the deselect helper's two-instruction arm), so there is deliberately no picker rung.
    "burrows-alerts": { order: ["burrow-mode"] },
    // 0080 mode 9 + R8: hauling's close arm backs out its own armed stop placement inside the
    // mode close (closeHaulingMode() disarms it), so it too is one declared level.
    "hauling": { order: ["hauling-mode"] },
    "squads-orders": { order: ["squad-order-mode", "squad-subview", "squad-scope"] },
    "work-orders": { order: ["work-order-chooser", "work-order-subscreen"] },
    "creatures": { order: ["trainer-chooser"] },
    // Two armed pickers over building sheets; their predicates cannot both hold.
    "building-interact": { order: ["lever-link-target", "workshop-task-picker"],
      exclusive: [["lever-link-target", "workshop-task-picker"]] },
  };

  function chains() { return CHAINS; }

  // Returns a list of violation strings; empty means the law holds.
  function validateChains() {
    var problems = [];
    var byId = {};
    for (var i = 0; i < levels.length; i++) byId[levels[i].id] = levels[i];
    var declared = {};
    Object.keys(CHAINS).forEach(function (flow) {
      var chain = CHAINS[flow];
      var exclusive = chain.exclusive || [];
      var isExclusive = function (a, b) {
        return exclusive.some(function (p) { return p.indexOf(a) >= 0 && p.indexOf(b) >= 0; });
      };
      chain.order.forEach(function (id, idx) {
        declared[id] = true;
        var rung = byId[id];
        if (!rung) { problems.push(flow + ": declared rung \"" + id + "\" is not registered"); return; }
        if (rung.flow !== flow)
          problems.push(flow + ": rung \"" + id + "\" is registered under flow \"" + rung.flow + "\"");
        if (idx > 0 && byId[chain.order[idx - 1]]) {
          var above = byId[chain.order[idx - 1]];
          var ok = isExclusive(above.id, id) ? above.depth >= rung.depth : above.depth > rung.depth;
          if (!ok) problems.push(flow + ": \"" + above.id + "\" (depth " + above.depth +
            ") must outrank \"" + id + "\" (depth " + rung.depth + ")");
        }
      });
    });
    for (var j = 0; j < levels.length; j++)
      if (!declared[levels[j].id])
        problems.push("registered rung \"" + levels[j].id + "\" appears in no declared chain -- " +
          "declare it in CHAINS, next to the law");
    return problems;
  }

  function fail() { return false; }

  // depth: bigger = deeper = popped first. The numbers only have to be consistent WITHIN one flow, and
  // where two flows do collide, registration order breaks the tie.
  function register(level) {
    if (!level || !level.id) return false;
    if (typeof level.active !== "function" || typeof level.pop !== "function") return false;
    unregister(level.id);
    levels.push({
      id: String(level.id),
      flow: String(level.flow || "unknown"),
      depth: Number(level.depth) || 0,
      active: level.active,
      pop: level.pop,
    });
    return true;
  }

  function unregister(id) {
    var before = levels.length;
    levels = levels.filter(function (level) { return level.id !== id; });
    return levels.length !== before;
  }

  function all() { return levels.slice(); }

  function levelsFor(flow) {
    return levels.filter(function (level) { return level.flow === flow; })
      .sort(function (a, b) { return b.depth - a.depth; });
  }

  // Occupied levels, deepest first. A predicate that throws counts as unoccupied: a back-out must
  // never be the thing that takes the client down.
  function occupied(flow) {
    var out = [];
    for (var i = 0; i < levels.length; i++) {
      var level = levels[i];
      if (flow && level.flow !== flow) continue;
      var live = false;
      try { live = !!level.active(); } catch (_) { live = false; }
      if (live) out.push(level);
    }
    out.sort(function (a, b) {
      if (b.depth !== a.depth) return b.depth - a.depth;
      return levels.indexOf(a) - levels.indexOf(b);
    });
    return out;
  }

  function top(flow) {
    var stack = occupied(flow);
    return stack.length ? stack[0] : null;
  }

  // Pops EXACTLY ONE level, and a pop whose handler reports failure does NOT cascade further down:
  // eating a second level to hide a refused rung is how "Escape unwinds too many levels" happens.
  function popOne(reason, flow) {
    var level = top(flow);
    if (!level) { lastPopped = null; return null; }
    var done = false;
    try { done = level.pop(reason || "back") !== false; } catch (_) { done = false; }
    lastPopped = done ? level.id : null;
    return done ? level.id : null;
  }

  // Pops one NAMED level, deepest or not. NOT a back-out verb: this is the hard-modal teardown's
  // primitive, walked by tearDownForDesignation() in dwf-controls-placement.js.
  function popLevel(id, reason) {
    for (var i = 0; i < levels.length; i++) {
      if (levels[i].id !== id) continue;
      var done = false;
      try { done = levels[i].pop(reason || "back") !== false; } catch (_) { done = false; }
      if (done) lastPopped = id;
      return done;
    }
    return false;
  }

  function reset() { levels = []; lastPopped = null; }

  root.DwfModeStack = {
    register: register,
    unregister: unregister,
    all: all,
    levelsFor: levelsFor,
    occupied: occupied,
    top: top,
    popOne: popOne,
    popLevel: popLevel,
    chains: chains,
    validateChains: validateChains,
    lastPopped: function () { return lastPopped; },
    reset: reset,
    _fail: fail,
  };
})(typeof window !== "undefined" ? window : globalThis);
