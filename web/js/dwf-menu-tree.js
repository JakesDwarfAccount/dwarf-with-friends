// dwf-menu-tree.js -- TRUEMENU WP-1 client-side forge menu-tree helpers.
//
// Pure logic (no DOM) for the workshop add-task DRILL-DOWN: category -> metal -> leaf, matching
// DF's native forge menu (interface_category_building rows + per-metal material_selector rows +
// new_job leaves). The server (dfcapture.lua forge_task_tree) sends the nested `taskTree`; this
// module composes the self-describing `t:` task key the server's add_tree_task parses back, and
// exposes small selectors the panel renders. Kept separate + exported so the harness unit test
// (tools/harness/truemenu_client_test.mjs) can exercise composeTaskKey without a browser -- the
// same convention as dwf-adjacency.js.
//
// Task-key GRAMMAR (must stay in lock-step with dfcapture.lua parse_tree_task_key):
//   t:<JobType>[|it:<ItemType>][|st:<subtype>][|mat:<matType>:<matIndex>][|rc:<reactionCode>][|b:<batch>]
// e.g.  t:MakeWeapon|it:WEAPON|st:1|mat:0:0            (Forge iron battle axe)
//       t:ConstructTable|mat:0:12                       (Make gold table)
//       t:MakeAmmo|it:AMMO|st:0|mat:0:0|b:25            (Forge twenty-five iron bolts)
//       t:CustomReaction|rc:MAKE_ENT291 INP2_BODY       (an instrument-piece reaction)
(function (root) {
  "use strict";

  // Compose the queue key for a leaf selected under a given container node (a forge metal, or a
  // Craftsdwarf material-selector submenu -- both carry matType/matIndex). `metal` may be null for a
  // reaction (materials come from the reaction) or for a root leaf that pins its OWN material (a
  // Smelter "Smelt hematite ore" carries matType/matIndex directly).
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

  // A forge tree: every root row is a category / custom_category (the two forges). Kept for the
  // WP-1 forge callers + the existing forge unit test.
  function isForgeTree(taskTree) {
    return Array.isArray(taskTree) && taskTree.length > 0 &&
      taskTree.every(c => c && (c.kind === "category" || c.kind === "custom_category"));
  }

  // A menu tree: any non-empty `taskTree` whose rows are typed nodes -- covers the forge tree AND the
  // flat-shop trees (Smelter/Kennels leaf-at-root, Craftsdwarf mixed root). A flat legacy task list
  // ({key,name} objects, no `kind`) is NOT a menu tree, so the panel keeps its flat picker for it.
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

  // Navigate the tree by a path of indices [containerIdx, metalIdx]. Returns {level, rows, node}.
  //   level 0 -> root rows (may MIX containers + leaves: Craftsdwarf); 1 -> metals of a forge
  //   category; 2 -> leaves (of a forge metal, or a leaf-holding container drilled one level).
  function levelAt(taskTree, path) {
    path = Array.isArray(path) ? path : [];
    if (!isMenuTree(taskTree)) return { level: 0, rows: [], node: null };
    if (path.length === 0) return { level: 0, rows: taskTree, node: null };
    const cat = taskTree[path[0]];
    if (!cat) return { level: 0, rows: taskTree, node: null };
    // Container that holds leaves directly (instrument custom category B41; Craftsdwarf material
    // selector): drilling one level lands straight on the leaves. The node carries the material pin.
    if (Array.isArray(cat.leaves) && cat.leaves.length && !(cat.metals && cat.metals.length)) {
      return { level: 2, rows: cat.leaves, node: cat, category: cat };
    }
    if (path.length === 1) return { level: 1, rows: cat.metals || [], node: cat };
    const metal = (cat.metals || [])[path[1]];
    if (!metal) return { level: 1, rows: cat.metals || [], node: cat };
    return { level: 2, rows: metal.leaves || [], node: metal, category: cat };
  }

  // ---- B144: every "make X" ITEM list sorts alphabetically. ----------------------------
  // NATIVE DIVERGENCE, deliberate: DF's own menus keep category/raw order (forge root: Weapons
  // and ammunition -> Armor -> Furniture...; metals: iron, silver, copper...; and even leaf
  // lists put "Forge twenty-five iron bolts" LAST -- see the metalsmithing oracle screenshots).
  // The owner asked for alphabetical, so queueable item rows sort A->Z; navigation rows (categories /
  // metals / material-selector submenus) keep DF's native order so the drill-down still reads
  // like DF's menu. Both helpers are PURE (new arrays, inputs untouched) and exported for the
  // harness (truemenu_client_test.mjs B144 cells).
  function rowSortLabel(node) {
    return String((node && (node.label || node.name)) || "").toLowerCase();
  }
  // Tree-picker order for one level's rows. Returns [{node, idx}] (idx = ORIGINAL index, so the
  // panel's data-ws-tree-cat / data-ws-tree-metal drill attributes keep addressing the served
  // tree): containers first in native order, then leaves A->Z (original order breaks ties).
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
  try { root.DwfMenuTree = api; } catch (_) { /* non-browser context */ }
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
