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

// ---- Pure workshop menu-tree helpers: the category -> metal -> leaf drill-down, no DOM. ----
// The task-key grammar must stay in lock-step with the lua parse_tree_task_key that reads it back.
(function (root) {
  "use strict";

  // `metal` may be null for a reaction, or for a root leaf that pins its OWN material.
  function composeTaskKey(leaf, metal) {
    if (!leaf) return null;
    // Reaction leaf: reuse the reaction code; the server matches it to the real getJobs def.
    if (leaf.kind === "reaction" || (leaf.reactionCode && !leaf.jobType)) {
      if (!leaf.reactionCode) return null;
      return "t:CustomReaction|rc:" + leaf.reactionCode;
    }
    if (!leaf.jobType) return null;
    let key = "t:" + leaf.jobType;
    if (leaf.itemType) key += "|it:" + leaf.itemType;
    if (leaf.itemSubtype !== undefined && leaf.itemSubtype !== null) key += "|st:" + leaf.itemSubtype;
    // material pin: prefer the container (metal/material-selector); else the leaf's own pin.
    const mt = (metal && metal.matType !== undefined && metal.matType !== null) ? metal.matType : leaf.matType;
    const mi = (metal && metal.matIndex !== undefined && metal.matIndex !== null) ? metal.matIndex : leaf.matIndex;
    if (mt !== undefined && mt !== null && mi !== undefined && mi !== null) key += "|mat:" + mt + ":" + mi;
    // material_category: DF's OTHER material discriminator (organic cloth/silk/bone/tooth/...); it is
    // what separates "Make cloth crafts" from "Make silk crafts" (same job type, no metal index).
    if (leaf.materialCategory) key += "|cat:" + leaf.materialCategory;
    if (leaf.batch) key += "|b:" + leaf.batch;
    return key;
  }

  // A forge tree: every root row is a category or custom_category.
  function isForgeTree(taskTree) {
    return Array.isArray(taskTree) && taskTree.length > 0 &&
      taskTree.every(c => c && (c.kind === "category" || c.kind === "custom_category"));
  }

  // A flat legacy task list ({key,name}, no `kind`) is NOT a menu tree, so the panel keeps its flat picker.
  function isMenuTree(taskTree) {
    return Array.isArray(taskTree) && taskTree.length > 0 &&
      taskTree.every(n => n && typeof n.kind === "string");
  }

  // A row that opens a submenu (has children) vs. a directly-queueable leaf. Categories drill to
  // metals; custom_category / material_selector hold leaves directly; job/reaction rows are leaves.
  function rowIsContainer(node) {
    if (!node) return false;
    return (Array.isArray(node.metals) && node.metals.length > 0) ||
           (Array.isArray(node.leaves) && node.leaves.length > 0);
  }

  // Container rows read "<X> (opens menu)" (DF's category/material-selector rows); leaf rows do not.
  function categoryRowLabel(cat) {
    return (cat && cat.label ? cat.label : "Category") + " (opens menu)";
  }

  // Returns {level, rows, node}: level 0 root rows, which may MIX containers and leaves; 1 metals; 2 leaves.
  function levelAt(taskTree, path) {
    path = Array.isArray(path) ? path : [];
    if (!isMenuTree(taskTree)) return { level: 0, rows: [], node: null };
    if (path.length === 0) return { level: 0, rows: taskTree, node: null };
    const cat = taskTree[path[0]];
    if (!cat) return { level: 0, rows: taskTree, node: null };
    // A container holding leaves directly: drilling one level lands on the leaves, and the node carries
    // the material pin.
    if (Array.isArray(cat.leaves) && cat.leaves.length && !(cat.metals && cat.metals.length)) {
      return { level: 2, rows: cat.leaves, node: cat, category: cat };
    }
    if (path.length === 1) return { level: 1, rows: cat.metals || [], node: cat };
    const metal = (cat.metals || [])[path[1]];
    if (!metal) return { level: 1, rows: cat.metals || [], node: cat };
    return { level: 2, rows: metal.leaves || [], node: metal, category: cat };
  }

  // ---- every "make X" item list sorts alphabetically -----------------------------------
  function rowSortLabel(node) {
    return String((node && (node.label || node.name)) || "").toLowerCase();
  }
  // idx is the ORIGINAL index, so the panel's drill attributes keep addressing the served tree.
  function orderRowsAlpha(rows) {
    const containers = [];
    const leaves = [];
    (Array.isArray(rows) ? rows : []).forEach((node, idx) => {
      (rowIsContainer(node) ? containers : leaves).push({ node, idx });
    });
    leaves.sort((a, b) => {
      const la = rowSortLabel(a.node), lb = rowSortLabel(b.node);
      if (la !== lb) return la < lb ? -1 : 1;
      return a.idx - b.idx;
    });
    return containers.concat(leaves);
  }
  // Flat-picker order (legacy `tasks` list + the shop work-order picker): groups keep their
  // served order (first appearance), tasks inside each group sort A->Z by display name.
  function sortTasksAlpha(tasks) {
    if (!Array.isArray(tasks)) return [];
    const groupOrder = [];
    const byGroup = Object.create(null);
    tasks.forEach(t => {
      const g = (t && t.group) || "Common";
      if (!byGroup[g]) { byGroup[g] = []; groupOrder.push(g); }
      byGroup[g].push(t);
    });
    const nameOf = t => String((t && (t.name || t.job)) || "").toLowerCase();
    groupOrder.forEach(g => byGroup[g].sort((a, b) => {
      const na = nameOf(a), nb = nameOf(b);
      if (na !== nb) return na < nb ? -1 : 1;
      const ka = String((a && a.key) || ""), kb = String((b && b.key) || "");
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    }));
    return groupOrder.reduce((out, g) => out.concat(byGroup[g]), []);
  }

  const api = { composeTaskKey, isForgeTree, isMenuTree, rowIsContainer, categoryRowLabel, levelAt,
    orderRowsAlpha, sortTasksAlpha };
  try { root.DwfMenuTree = api; } catch { /* Node loads through module.exports below */ }
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
