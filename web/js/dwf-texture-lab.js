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

(function () {
  "use strict";

  const root = document.getElementById("texture-lab");
  if (!root) return;

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => Array.from(root.querySelectorAll(selector));

  const PIPELINE_STAGES = [
    {
      short: "DF graphics",
      title: "DF raws define the available art",
      summary: "Vanilla graphics files name tile pages, source PNGs, sprite cells, layer sets, palettes, states, and material variants. This is the authored vocabulary—the set of pictures that actually exists.",
      input: "graphics_*.txt + tile_page_*.txt + images/*.png",
      output: "tokens, cells, layer rules, palette tables",
      knows: "Which art cells exist and the raw grammar that names them: CORPSE, GROWTH_PICKED, TREE_TILE, TILE_GRAPHICS, LAYER_SET, and material variants.",
      unknown: "Which live object is currently on a remote player’s tile. Raws describe possibilities, not world state.",
      danger: "A generator parses only the subset it originally needed. The missing key later falls through to a seed, living animal, or generic box.",
      source: "DF data/vanilla/*_graphics/graphics/{graphics_*.txt,tile_page_*.txt,images/*.png}",
    },
    {
      short: "DF world",
      title: "DFHack exposes stable world identity",
      summary: "The plugin reads map blocks, tiletype ordinals, materials, items, plants, constructions, units, buildings, flows, and designations through DFHack structures and modules. Reads are batched under one carefully bounded CoreSuspender pass.",
      input: "df::world, df::map_block, DFHack modules",
      output: "neutral C++ records with exact identity",
      knows: "What the tile or object is: type, subtype, material indices, species token, race token, location, state, and flags.",
      unknown: "A universal per-player premium texpos. Passive graphic_viewportst arrays describe only DF’s one native camera.",
      danger: "Reading broadly per frame while holding CoreSuspender starves DF’s simulation thread. A second bug class is reading the wrong identity source, such as a geolayer material instead of a construction’s built-from material.",
      source: "src/world_stream.cpp + src/wire_v1.cpp (single suspended global read pass)",
    },
    {
      short: "Wire",
      title: "The wire separates dense facts from sparse identity",
      summary: "Each map tile uses a fixed 12-byte record. Optional tails carry items, plants, spatter materials, flows, grass, engravings, designation priority, and vermin only where needed. Units and buildings travel in AUX JSON instead of the terrain cache.",
      input: "neutral records + 16×16 map blocks",
      output: "BLOCK_SET records/tails + AUX + enum dictionaries",
      knows: "Enough identity for deterministic client resolution without shipping rendered pixels for every player camera.",
      unknown: "Which browser sheet cell the resolver will choose. The protocol transports identity; the client owns most art policy.",
      danger: "Dropping a subtype, creature/plant token, inorganic id, material color, or construction material forces a later generic fallback even when the right art exists.",
      source: "src/wire_v1.h: TileRecord/tail kinds; src/wire_v1.cpp; src/world_stream.cpp AUX assembly",
    },
    {
      short: "Decode/cache",
      title: "The browser rebuilds world-addressed tile objects",
      summary: "The worker decodes block records and sparse tails into a world cache. tiletype_meta turns each numeric tiletype back into ttname, shape, material, and special. A camera asks for a window without changing the underlying world addresses.",
      input: "binary BLOCK_SET + tiletype_meta + AUX",
      output: "{ttname, shape, mat, base_mt, tails…} per world tile",
      knows: "The current identity and neighborhood of every cached tile, plus independent camera windows for several players.",
      unknown: "Whether a JSON map is complete or whether a real sheet cell is semantically correct.",
      danger: "A tail decoded but not copied into a lower-z substitution silently becomes terrain-only. Incorrect cache invalidation can keep correct data from reaching a renderer.",
      source: "web/js/dwf-wire-v1.js → dwf-cache-worker.js → dwf-cache.js",
    },
    {
      short: "Generated maps",
      title: "Offline generators distill DF’s art grammar",
      summary: "Python tools turn raw graphics and DFHack enum metadata into purpose-built maps: tiletype→token, item identity→cell, species→creature/corpse art, building geometry, tree variants, materials→palette rows, and overlay families.",
      input: "DF raws + df-structures metadata + verified conventions",
      output: "web/*_map.json derived lookup tables",
      knows: "How project identities are supposed to join to authored art—when the parser and classification rules are complete.",
      unknown: "Closed-binary choices that are not present in raws, and any class the generator never parsed.",
      danger: "This stage can produce an existing but wrong cell. A non-empty lookup audit will pass it. Derived JSON hand-edits also disappear on regeneration unless the generator or a pin owns the decision.",
      source: "tools/ws2/build_*_map.py → web/{tiletype,item,creatures,building,plant,tree,material,…}_map.json",
    },
    {
      short: "Resolver",
      title: "Client decision trees join identity to one or more cells",
      summary: "The renderer chooses terrain tokens, exact item subtypes, creature tiers, construction families, adjacency variants, material palette rows, tree structural cells, and kind-safe fallbacks. Many visual defects are a wrong branch here, not missing data.",
      input: "decoded identity + generated maps + neighbors",
      output: "sheet/col/row, tint, palette row, overlays, animation",
      knows: "The current object, its authored candidates, nearby topology, and the renderer’s explicit fallback policy.",
      unknown: "Whether a visually plausible choice matches native pixels until an independent oracle checks it.",
      danger: "Cross-kind fallbacks turn gaps into confident wrong art: a log becomes a seed, a corpse becomes a living animal, or a construction becomes natural rock.",
      source: "web/js/dwf-tiles.js resolveSprite/resolveItemVisual/buildingEntry/resolveUnitTier; mirrored in dwf-gl.js",
    },
    {
      short: "Atlas/composite",
      title: "Sheets become atlas cells and painter-ordered layers",
      summary: "Canvas2D crops source sheets directly. WebGL lazily packs cells into an append-only texture array, including consecutive animation runs, palette-remapped cells, generated stamps, and content-addressed unit composites. Instance order is painter’s order.",
      input: "resolved cells + source PNGs + palette transforms",
      output: "base fill + sprites + overlays + effects",
      knows: "Pixel rectangles, alpha, tint/palette operations, animation frames, and final layer order.",
      unknown: "Semantic correctness. The atlas faithfully draws the cell it was asked for, including a wrong one.",
      danger: "A sheet 404, bad geometry, atlas overflow, alpha-mode mismatch, or stale dynamic composite can fall back to flat color, a dot, or nothing. Transient misses must retry without request storms.",
      source: "web/js/dwf-gl-atlas.js + drawTileComposite/buildTile in the two renderers",
    },
    {
      short: "Oracle/gates",
      title: "Independent evidence decides whether the pixels are right",
      summary: "Coverage audits classify wrong-art separately from missing art; spritepick records human-adjudicated cells; renderer parity catches duplicated-logic drift; native window captures are required for downstream fog. This stage closes the feedback loop.",
      input: "browser pixels + native/Steam reference + exact identity",
      output: "verified fix, regression pin, or documented degradation",
      knows: "Whether the entire chain produced the intended pixels for the specific subject and state.",
      unknown: "Nothing beyond the evidence set: an untested species/material/state remains unverified, not assumed correct.",
      danger: "Self-certifying against the repo’s current map, or checking only that some sprite appeared, reproduces the exact blind spot that allowed plausible wrong art.",
      source: "tools/spritepick/*; tools/harness/texture_coverage_audit.py; gate_parity.py; sprite-range evidence",
    },
  ];

  const PIPELINE_PLAIN = [
    "Dwarf Fortress ships a giant picture dictionary. These files say which pictures exist and where each little picture sits inside a larger image.",
    "DFHack looks at the running fort and tells us what is really on a square: stone floor, oak log, cat corpse, dwarf, workshop, and so on.",
    "The server sends a compact description instead of a screenshot. Think of it as mailing a label that says ‘steel pick’ rather than mailing a photograph of the pick.",
    "The browser opens those compact labels and rebuilds normal named facts that its drawing code can understand.",
    "Offline tools turn DF’s complicated graphics files into searchable cheat sheets: this kind of object should use that picture cell.",
    "The resolver combines the object’s identity with those cheat sheets. This is the moment where the program decides which picture to use.",
    "The renderer cuts the chosen little picture from its sheet, recolors it when needed, and stacks it with the ground, blood, water, buildings, units, and UI.",
    "Finally, we compare the browser result with the real game. ‘A picture appeared’ is not enough—the picture must be the correct one.",
  ];

  const GUIDED_STAGES = [
    {
      short: "Meet it",
      title: "One square has an identity and an appearance",
      plain: "First separate two questions: What is this thing? What picture should represent it? Most texture mistakes happen when those questions get mixed together.",
      technical: "World identity comes from DF structures; rendered appearance comes later from token maps, source cells, palette rules, adjacency, and compositing.",
      source: "concept boundary: identity ≠ sprite selection",
      question: "Which fact should we establish first?",
      hint: "A picture cannot tell us reliably what the underlying game object is.",
      answers: ["Exactly what the game object is", "Whichever picture looks close"],
      correct: 0,
      success: "Exactly. Identity is the anchor for every later decision.",
      failure: "That is the tempting shortcut. A plausible picture can still be completely wrong.",
      visual: "meet",
    },
    {
      short: "Read it",
      title: "DFHack reads what the game says is there",
      plain: "We ask the game for facts, not pixels. For example: ‘this is a stone floor made from microcline’ or ‘this item is a steel pick.’",
      technical: "The plugin reads df::map_block, df::item, df::plant, df::building, constructions, raws, and related metadata during one bounded CoreSuspender pass.",
      source: "src/world_stream.cpp + src/wire_v1.cpp",
      question: "What is DFHack giving this pipeline at this step?",
      hint: "The native camera’s finished picture is not usable for every independent player camera.",
      answers: ["Structured identity and state", "A finished screenshot for each player"],
      correct: 0,
      success: "Right. Stable facts can be reused for every player’s independent camera.",
      failure: "The game has only one native camera. Per-player screenshots would fight over it.",
      visual: "read",
    },
    {
      short: "Send it",
      title: "The server packs those facts into a small message",
      plain: "Instead of sending every picture, the server sends a compact label. Empty/common facts stay tiny; unusual facts are added only where needed.",
      technical: "Terrain uses a fixed 12-byte TileRecord. Sparse tails carry ITEM, PLANT, SPATTER_MAT, FLOW, GRASS, ENGRAVING, DESIG_PRIORITY, and VERMIN data. Units/buildings use AUX.",
      source: "src/wire_v1.h TileRecord + tail kinds",
      question: "Why send identity instead of finished pixels?",
      hint: "Several players may look at different places at the same time.",
      answers: ["It is compact and camera-independent", "It makes the PNG files larger"],
      correct: 0,
      success: "Yes. One world description can feed many independent views.",
      failure: "The wire is designed to avoid repeatedly shipping rendered frames.",
      visual: "wire",
    },
    {
      short: "Name it",
      title: "The browser turns numbers back into meaningful names",
      plain: "The browser opens the package. A number becomes ‘StoneFloor1’; separate bits become water depth, hidden status, and designation information.",
      technical: "dwf-wire-v1.js decodes binary fields; tiletype_meta joins the tt ordinal to ttname/shape/material; the worker stores dense arrays plus sparse tails in a world-addressed cache.",
      source: "dwf-wire-v1.js → cache-worker.js → cache.js",
      question: "What does the cache know now?",
      hint: "We still have not selected a sprite-sheet cell.",
      answers: ["Named object facts at world coordinates", "The guaranteed correct final picture"],
      correct: 0,
      success: "Correct. The browser now understands the facts, but art selection is still ahead.",
      failure: "Not yet. The cache knows what the thing is; the resolver chooses its art next.",
      visual: "decode",
    },
    {
      short: "Match it",
      title: "Lookup rules choose the authored picture",
      plain: "Now the program uses cheat sheets. It looks up the exact kind, state, material, and neighbors, then chooses a picture. A safe fallback stays inside the same kind.",
      technical: "Generated *_map.json tables and resolver priority chains join ttname/itemdef/species/building keys to token or {sheet,col,row}; adjacency and palette selection add context.",
      source: "tools/ws2/build_*_map.py + the two client resolvers",
      question: "A cat corpse key is missing. Which fallback is safer?",
      hint: "A live cat is the right species but the wrong state.",
      answers: ["A corpse/bone-pile fallback", "The living cat sprite"],
      correct: 0,
      success: "Exactly. A visible limitation is safer than confident wrong art.",
      failure: "That creates the classic ‘plausible but wrong’ bug: species-correct, state-wrong.",
      visual: "lookup",
    },
    {
      short: "Build it",
      title: "The renderer crops, recolors, and stacks layers",
      plain: "The chosen picture is usually one small 32×32 cell inside a big sheet. We cut it out, recolor it if the material requires that, then place transparent layers on top in order.",
      technical: "Canvas2D crops sheets directly. WebGL packs source cells, animation runs, palette-remapped cells, stamps, and dynamic unit composites into a texture array; instance order is painter’s order.",
      source: "dwf-gl-atlas.js + drawTileComposite/buildTile",
      question: "Why can STONE_FLOOR_1 look almost blank by itself?",
      hint: "Some authored cells are details intended to sit over a dense base.",
      answers: ["It is a sparse overlay layer", "The PNG failed to decode"],
      correct: 0,
      success: "Right. Valid art can still be wrong when used in the wrong role or layer.",
      failure: "It can decode perfectly and still be nearly transparent because it is only a detail layer.",
      visual: "build",
    },
    {
      short: "Prove it",
      title: "The real game—not our own map—decides whether it is correct",
      plain: "We compare the browser with the real Dwarf Fortress picture. If they disagree, we trace backward to the first wrong handoff instead of randomly swapping pictures.",
      technical: "Native-window or Steam evidence is the independent oracle; spritepick records adjudicated cells, coverage selftests catch wrong-art, and renderer parity fixtures catch Canvas2D/GL drift.",
      source: "tools/spritepick/* + texture_coverage_audit.py + parity gates",
      question: "What proves a texture fix?",
      hint: "A non-empty sprite only proves that a lookup returned something.",
      answers: ["It matches independent native evidence", "Any non-placeholder sprite appears"],
      correct: 0,
      success: "Exactly. Correctness comes from independent evidence, not self-certification.",
      failure: "That was the old audit blind spot: wrong art often returns a perfectly real sprite.",
      visual: "prove",
    },
  ];

  const GLOSSARY = {
    tiletype: "DF’s numeric category for what a map tile physically is, such as StoneFloor1 or ConstructedWall.",
    token: "A name used by DF’s graphics files for an authored picture or animation, such as STONE_FLOOR_5.",
    "sprite cell": "One small picture cut from a larger sprite-sheet image. Most map cells are 32×32 pixels.",
    atlas: "A GPU-friendly collection where many source cells are packed so WebGL can draw them efficiently.",
    tail: "Optional extra wire data attached only to tiles that need it, such as an item, plant, blood spatter, or flow.",
    fallback: "The backup picture or behavior used when an exact lookup cannot be completed.",
    palette: "DF’s indexed color table. Replacing one palette row with another recolors authored art without changing its shape.",
    compositing: "Drawing transparent layers in a specific order to create the final tile image.",
    oracle: "Independent evidence used to decide what correct looks like—normally the real native game window or a trusted Steam reference.",
  };

  const TRACE_SCENARIOS = [
    {
      id: "stone-floor",
      title: "Natural stone floor",
      subtitle: "Dense base plus sparse detail overlay",
      steps: [
        ["DF world", "Identity in the map block", "Exact tiletype and geologic material are readable without asking DF to render this camera.", { tiletype: "StoneFloor1", shape: "FLOOR", material: "STONE", base_material: { mat_type: 0, mat_index: 233, example_id: "MICROCLINE" } }, "DFHack Maps + df::tiletype metadata", "known"],
        ["Wire", "Fixed 12-byte tile record", "The ordinal is compact; session metadata restores its name and shape. No sprite cell crosses the wire.", { tt: "<u16 ordinal>", base_mt: 0, base_mi: 233, bits: { liquid: 0, flow: 0, hidden: 0, outside: 0 }, desig1: 0, desig2: 0, spatter_amt: 0, flags2: 0 }, "src/wire_v1.h TileRecord", "encoded"],
        ["Decode", "Legacy-shaped tile object", "The cache joins tt with tiletype_meta and keeps the world coordinate stable across independent cameras.", { ttname: "StoneFloor1", shape: "FLOOR", mat: "STONE", base_mt: 0, base_mi: 233, hidden: false }, "web/js/dwf-cache.js decodeTile", "decoded"],
        ["Resolve", "Tiletype map chooses two tokens", "The opaque center cell is the base. Stone floor variant 1 is genuinely sparse detail and must be composited on top—not substituted for the base.", { lookup: "tiletype_token_map.json → StoneFloor1", token: "STONE_FLOOR_5", overlay: "STONE_FLOOR_1", tint: null }, "web/js/dwf-tiles.js resolveSprite", "mapped"],
        ["Atlas", "Tokens become source cells", "Each token resolves through /sprites/map.json to a sheet and grid cell, then Canvas2D crops it or WebGL packs it into an atlas.", { base: "spriteMap.STONE_FLOOR_5 → floors.png cell", detail: "spriteMap.STONE_FLOOR_1 → floors.png cell" }, "src/sprite_map.cpp + web/js/dwf-gl-atlas.js", "pixels"],
        ["Composite", "Painter’s order preserves texture", "Material fill is underneath, then the dense stone base, then the sparse per-tile detail. Later spatter/items/units are independent layers.", { order: ["material base", "STONE_FLOOR_5", "STONE_FLOOR_1 detail", "sparse tile layers", "buildings", "units/overlays"] }, "drawTileComposite / buildTile", "rendered"],
      ],
      layers: ["Material fill", "Dense floor base", "Sparse variant detail", "Spatter/items", "Buildings", "Units/UI"],
      result: "The crucial lesson: STONE_FLOOR_1 is valid art but wrong when used alone. Existence is not correctness.",
      ref: { catalog: "tiletypes", path: "StoneFloor1" },
    },
    {
      id: "wood-construction",
      title: "Oak construction floor",
      subtitle: "Silhouette and material color are separate joins",
      steps: [
        ["DF world", "Construction owns its built-from material", "The tiletype only says CONSTRUCTION. The actual wood species lives in world.constructions and must replace the geolayer answer.", { tiletype: "ConstructedFloor", tiletype_material: "CONSTRUCTION", built_from: "PLANT_MAT:OAK:WOOD" }, "Constructions::findAtTile in src/wire_v1.cpp", "known"],
        ["Wire", "Built-from material rides base_mt/base_mi", "The same two fields used for natural material now carry the resolved construction material.", { tt: "ConstructedFloor ordinal", base_mt: "<plant material type>", base_mi: "<OAK raw index>" }, "src/wire_v1.cpp encode_block construction branch", "encoded"],
        ["Decode", "Tile identity remains material-blind at first", "ttname maps to a generic dressed-stone token, but the material pair is preserved for a higher-priority client override.", { ttname: "ConstructedFloor", mat: "CONSTRUCTION", base_mt: "plant", base_mi: "oak" }, "web/js/dwf-cache.js", "decoded"],
        ["Resolve", "Construction resolver selects family then color", "The resolver chooses WOOD_FLOOR for silhouette and material_map’s OAK.WOOD palette row for color. The generic FLOOR_STONE_BLOCK token is only the unresolved fallback.", { family: "WOOD", token: "WOOD_FLOOR", palette_row: "material_map.plant.OAK.WOOD" }, "resolveConstructionFloor + constructionMaterial", "mapped"],
        ["Atlas", "Palette remap creates a derived cell", "Every pixel that exactly matches one of the default palette’s 18 colors is replaced by the corresponding OAK row color. This is not a multiply tint.", { source_cell: "WOOD_FLOOR", transform: "default palette row → OAK WOOD row", cache_key: "sheet|col|row|paletteRow" }, "dwf-gl-atlas.js resolvePalette", "pixels"],
        ["Composite", "Wood parquet appears over the tile base", "The right silhouette with the wrong row would be oak-shaped but wrong-colored; the right row on FLOOR_STONE_BLOCK would be brown rock. Both joins must be right.", { result: "oak-colored authored wood floor" }, "drawTileComposite / buildTile", "rendered"],
      ],
      layers: ["Terrain base", "WOOD_FLOOR cell", "Exact palette swap", "Track overlay if any", "Objects above"],
      result: "A construction texture bug can be identity loss, family selection, or palette selection. Treat those as separate questions.",
      ref: { catalog: "materials", path: "plant.OAK" },
    },
    {
      id: "steel-pick",
      title: "Steel pick on the ground",
      subtitle: "Subtype token chooses shape; material chooses palette",
      steps: [
        ["DF world", "The item carries type, subtype, and material", "WEAPON alone is too coarse. The subtype indexes a raw item definition; material identifies STEEL.", { item_type: "WEAPON", subtype: "ITEM_WEAPON_PICK", material: "INORGANIC:STEEL" }, "df::item + world.raws.itemdefs", "known"],
        ["Wire", "Sparse ITEM tail", "Only the occupied tile gets an ITEM tail. The one-shot ITEMDEF_DICT maps subtype ordinals to raw tokens for this world epoch.", { tail_kind: "0x01 ITEM", item_type: "WEAPON", subtype: "<pick index>", mat_type: 0, mat_index: "STEEL", ident_kind: "INORGANIC", ident: "STEEL" }, "src/wire_v1.cpp make_item_tail + ITEMDEF_DICT", "encoded"],
        ["Decode", "The sparse tail is attached to its tile", "The cache keeps subtype, identity, material, stack, quality, artifact, and wear fields without widening every tile record.", { item: { item_type: "WEAPON", subtype: "pick", identKind: 3, ident: "STEEL" } }, "dwf-wire-v1.js decodeTailData", "decoded"],
        ["Resolve", "bytoken beats generic bytype", "The itemdef token resolves item_map.bytoken.ITEM_WEAPON_PICK. A generic WEAPON fallback would lose the pick silhouette.", { priority: ["identity/material special", "raw bytoken", "matvariant", "bytype", "corpse fallback", "missing"], selected: "item_map.bytoken.ITEM_WEAPON_PICK" }, "resolveItemVisual / resolveItemEntry", "mapped"],
        ["Atlas", "Pick cell receives STEEL palette row", "material_map.inorganic joins the stable token/index to a palette row. The atlas caches the recolored cell.", { cell: "item_weapons.png @ pick", palette: "STEEL row" }, "material_map.json + resolvePalette", "pixels"],
        ["Composite", "One authored pick, correctly recolored", "Quality and wear decorate text surfaces; the ground map keeps the authored silhouette instead of inventing quality glyphs.", { result: "steel-colored pick sprite" }, "emitItem / drawItem", "rendered"],
      ],
      layers: ["Terrain", "Spatter", "Pick cell", "Palette color", "Other tile occupants"],
      result: "If subtype is missing, no amount of sheet-cell swapping can recover which weapon this is.",
      ref: { catalog: "items", path: "bytoken.ITEM_WEAPON_PICK" },
    },
    {
      id: "cat-corpse",
      title: "Cat corpse item",
      subtitle: "A creature-derived item must stay in the dead-art class",
      steps: [
        ["DF world", "The item’s derived class carries race", "CORPSE/CORPSEPIECE inherit the race field. The raw creature token CAT is the useful identity, not just item_type CORPSE.", { item_type: "CORPSE", race: "CAT", state: "dead" }, "item_corpsest + creature_raw::creature_id", "known"],
        ["Wire", "ITEM identity extension names the creature", "The tail carries identKind=CREATURE and token CAT so the browser never needs a race-index dictionary tied to load order.", { tail_kind: "ITEM", item_type: "CORPSE", identKind: 2, ident: "CAT" }, "resolve_item_identity in src/wire_v1.cpp", "encoded"],
        ["Decode", "Dead identity survives normalization", "The tile object now contains both the item class and the species token.", { item: { type: "CORPSE", identKind: "CREATURE", ident: "CAT" } }, "dwf-wire-v1.js + cache worker", "decoded"],
        ["Resolve", "Corpse art is preferred over living art", "creatures_map.races.CAT.corpse is a different cell. If it is absent, the resolver must use a corpse-family fallback—not CAT’s living cell.", { lookup: "creatures_map.races.CAT.corpse", kind_safe_fallback: "item_map._corpse_fallback" }, "resolveItemVisual corpse branch", "mapped"],
        ["Atlas", "The dead-state cell is cropped", "The sheet may be the same creature sheet as the living cat, but col/row is intentionally different.", { selected: "CAT.corpse.sheet/col/row" }, "creatures_map.json", "pixels"],
        ["Composite", "The pile reads as remains, not a live cat", "Container contents still may be legitimately hidden by the container/topmost item, matching native behavior.", { result: "cat corpse cell or bone-pile fallback" }, "drawItem / emitItem", "rendered"],
      ],
      layers: ["Terrain", "Contaminants", "Dead-state creature cell", "Container/top-item rules"],
      result: "A living-cat sprite is non-empty and species-correct—but state-wrong. That is exactly why wrong-art needs its own audit class.",
      ref: { catalog: "creatures", path: "races.CAT" },
    },
    {
      id: "dwarf-unit",
      title: "Dwarf unit",
      subtitle: "A five-tier live-composite fallback chain",
      steps: [
        ["DF world", "Unit identity plus render-produced composite", "A dwarf is layered and palette-conditioned. When DF has rendered that unit host-side, the exporter can copy its already-composited texpos pixels and hash them.", { unit_id: 5505, race_token: "DWARF", texpos_currently_in_use: "available only after host-side render" }, "src/unit_sprites.cpp + unit census", "known"],
        ["Wire", "Unit data travels in AUX", "Units are not part of terrain block signatures. AUX carries race token and optional ah/sw/sh/ax/ay describing the content-addressed composite and its anchor.", { rt: "DWARF", ah: "<16-hex hash, optional>", sw: 1, sh: 1, ax: 0, ay: 0 }, "src/world_stream.cpp UnitRec/AUX", "encoded"],
        ["Decode", "The unit remains separate from tile cache", "Moving dwarves do not dirty terrain chunks. The renderer receives a current unit list beside the cached window.", { units: [{ x: 101, y: 95, z: 157, rt: "DWARF", ah: "optional" }] }, "dwf-ws.js AUX handler", "decoded"],
        ["Resolve", "Tier chain prefers exact per-unit pixels", "Tier 1 is /unit-sprite/hash.png; tier 2 is fetch-in-flight; tier 3 is a usable race flat cell; tier 4 is a baked layered-race fallback; tier 5 is a small dot.", { tiers: ["live per-unit composite", "pending/404 fallthrough", "race flat cell", "baked dwarf.png", "dot"] }, "resolveUnitTier", "mapped"],
        ["Atlas", "Dynamic sheets use bounded retry and LRU", "A composite can 404 before the host camera has caused DF to create it. The client retries slowly while visible; dynamic atlas entries are content-addressed and evictable.", { url: "/unit-sprite/<hash>.png", retry_ms: 3000, allocation: "dynamic atlas span" }, "dwf-gl-atlas.js registerDynamicSheet", "pixels"],
        ["Composite", "Anchor places multi-cell art on the unit tile", "Large images emit one atlas instance per 32×32 cell. A missing composite degrades visibly but never blanks the map.", { result: "exact dwarf appearance when warm; explicit fallback while cold" }, "emitUnitSprite / canvas unit draw", "rendered"],
      ],
      layers: ["Terrain stack", "Buildings", "Unit composite", "Status icon", "Selection/presence"],
      result: "Independent cameras cannot force a unit composite from passive map data. The runtime hash is a cacheable result of DF’s own host-side draw.",
      ref: { catalog: "creatures", path: "races.DWARF" },
    },
    {
      id: "oak-tree",
      title: "Oak trunk / branch tile",
      subtitle: "Species identity plus structural tiletype plus adjacency",
      steps: [
        ["DF world", "Tree tiles contain two complementary identities", "The tiletype shape says which structural part is present; the plant object supplies species OAK. Neither alone selects the exact directional cell.", { ttname: "TreeTrunk…", shape: "WALL", material: "TREE", plant_id: "OAK", plant_part: "TRUNK" }, "map tile + df::plant_tree_info", "known"],
        ["Wire", "PLANT tail names species and part", "The fixed tile record still carries tiletype. The sparse PLANT tail carries OAK plus the part enum.", { record: { tt: "TreeTrunk ordinal" }, tail: { kind: "PLANT", id: "OAK", part: "TRUNK" } }, "make_plant_tail in src/wire_v1.cpp", "encoded"],
        ["Decode", "Tree identity is attached without losing ttname", "The tile object retains both values so the client can parse the structural suffix and select species art.", { ttname: "TreeTrunk…", mat: "TREE", plant: { id: "OAK", part: "TRUNK" } }, "dwf-cache.js", "decoded"],
        ["Resolve", "Tree map selects family and variant", "The client parses the tiletype into TREE_TRUNK/TREE_BRANCH/etc. and exact direction/connectivity key. OAK uses its authored table or the raws-defined generic tree fallback—not a stone wall cell.", { map: "tree_map.OAK", family: "TREE_TRUNK", variant: "<derived from ttname>", overlay: "TREE_OVERLEAVES when applicable" }, "drawTree/emitTree + shared adjacency helpers", "mapped"],
        ["Atlas", "Body and overleaves may be separate cells", "Canopy-level branches draw their structural cell and an authored leaf overlay. Both can come from the same species table.", { cells: ["TREE_TRUNK variant", "TREE_OVERLEAVES variant"] }, "tree_map.json", "pixels"],
        ["Composite", "Tree art must bypass generic wall joins", "Tree WALL-shaped tiles draw their own round trunk/cap. Applying the stone wall edge painter afterward turns them into grey rubble squares.", { result: "round wood slice / branch network with leaf overlay" }, "isTreeWallMat guard + emitTree/drawTree", "rendered"],
      ],
      layers: ["Grass backing", "Tree structural cell", "Overleaves", "Tree shadow", "Objects above"],
      result: "Shape-only rendering is dangerous: TREE trunks are WALL-shaped, but they are not stone walls.",
      ref: { catalog: "trees", path: "OAK" },
    },
    {
      id: "blood-spatter",
      title: "Blood spatter",
      subtitle: "Material hue, amount tier, and neighbor shape",
      steps: [
        ["DF world", "A block event supplies material and amount", "Spatter is not a terrain material. Several events can occupy one tile, so the encoder keeps the strongest bounded set rather than one generic red wash.", { event: "material_spatter", material: "creature blood", amount: 180, matter_state: "LIQUID" }, "block_square_event_material_spatterst", "known"],
        ["Wire", "SPATTER_MAT tail carries resolved color when possible", "The tail includes mat type/index, amount, state, and an optional solid-state RGB descriptor. flags2 says the sparse tail exists.", { kind: "0x03 SPATTER_MAT", mat_type: "creature material", mat_index: "blood", amount: 180, state: "liquid", rgb: [122, 20, 24] }, "make_spatter_tail", "encoded"],
        ["Decode", "Multiple decals remain an array", "The cache normalizes one or several spatter events into spatters[] so layering is explicit.", { spatters: [{ amount: 180, rgb: [122, 20, 24] }] }, "dwf-cache-worker.js + cache.js", "decoded"],
        ["Resolve", "Three decisions choose the cell", "Resolved hue chooses a blood family, amount chooses partial/full coverage, and an 8-neighbor mask chooses the joined edge shape. A stable variant handles fully surrounded cells.", { family: "nearest BLOOD_* family", coverage: "amount threshold", shape: "neighbor mask → FULL_N_S_W_E variant" }, "spatterFamilyFor + spatterTokenFor", "mapped"],
        ["Atlas", "Family sheet and shape cell resolve", "spatter_map provides the family’s sheet and named shape cells. Missing maps degrade to a translucent material-colored wash.", { lookup: "spatter_map.families[family].cells[shape]" }, "web/spatter_map.json", "pixels"],
        ["Composite", "Contaminant sits above terrain, below liquid", "On flooded tiles native draws bed contamination before the authored translucent liquid depth cell; draw order changes the apparent color.", { dry_order: ["terrain", "spatter"], flooded_order: ["terrain", "spatter", "liquid"] }, "drawSpatterDecals / emitSpatterDecals", "rendered"],
      ],
      layers: ["Terrain bed", "Spatter decal", "Liquid if flooded", "Items/plants", "Actors"],
      result: "Even with the right blood family, a wrong amount tier, adjacency shape, or layer order produces visibly wrong texture.",
      ref: { catalog: "spatter", path: "families.BLOOD_RED" },
    },
    {
      id: "workshop",
      title: "Carpenter’s workshop",
      subtitle: "AUX identity, multi-cell geometry, and component tint",
      steps: [
        ["DF world", "The building scan reads footprint and subtype", "Buildings are world objects, not one texture-bearing tile. Direction, construction stage, machine state, and component materials can all change visual selection.", { type: "Workshop", subtype: "Carpenters", footprint: "3×3", build_stage: "complete", components: "built materials" }, "src/world_stream.cpp BldRec", "known"],
        ["Wire", "Building record travels in AUX", "The record includes bounds, z, type/subtype, stage, optional direction/state, and component-derived tint data.", { type: "Workshop", subtype: "Carpenters", x1: 100, y1: 90, x2: 102, y2: 92, z: 157, crgb: "component color" }, "world_stream.cpp AUX building assembly", "encoded"],
        ["Decode", "Renderer receives geometry beside the tile view", "Buildings stay out of terrain block signatures, so moving units or machine animation does not force a full tile-cache rebuild.", { buildings: [{ key: "Workshop:Carpenters", w: 3, h: 3 }] }, "dwf-ws.js AUX", "decoded"],
        ["Resolve", "building_map supplies authored cell grid", "The type/subtype key chooses a sheet and a 2-D cell plan. Specialized helpers handle machines, bridges, farms, furniture, and states.", { lookup: "building_map['Workshop:Carpenters']", result: "sheet + w/h + cells[][]" }, "buildingEntry / buildingEntryGL", "mapped"],
        ["Atlas", "Each non-null subcell becomes one draw", "Art smaller than the footprint is centered; edge-clamping it would repeat a wagon or strip across empty footprint cells.", { geometry_rule: "authored art grid centered in footprint; no edge repeat" }, "emitBuilding / canvas building loop", "pixels"],
        ["Composite", "Building art draws after terrain", "Component material tint is masked to sprite alpha so transparent overhang pixels do not recolor the ground beneath.", { order: ["terrain and sparse tile occupants", "building subcells", "designations/presence", "units"] }, "multiplyTintedCell + building pass", "rendered"],
      ],
      layers: ["Terrain tiles", "Sparse ground objects", "3×3 building cells", "Masked component tint", "Units/overlays"],
      result: "A building texture bug may be lookup, state, geometry, material tint, or paint order—not just one bad PNG cell.",
      ref: { catalog: "buildings", path: "Workshop:Carpenters" },
    },
  ];

  const TRACE_SIMPLE = {
    "stone-floor": [
      "The game says this square is a stone floor and tells us which stone it is made from.",
      "The server replaces that long description with a few compact numbers. It does not choose a picture yet.",
      "The browser turns the numbers back into useful names like StoneFloor1 and STONE.",
      "The lookup selects one solid stone texture plus one mostly-transparent detail texture.",
      "Both texture names are converted into exact little rectangles inside floors.png.",
      "The solid stone goes down first. The little cracks and pebbles go on top. Using only the second layer would look almost blank.",
    ],
    "wood-construction": [
      "The square only says ‘constructed floor,’ so we also look up what the dwarves built it from: oak wood.",
      "The server preserves the built-from material instead of accidentally sending the natural rock under the building.",
      "The browser now knows both facts: this is a constructed floor, and its real material is oak wood.",
      "One rule chooses the wood-floor shape. A separate rule chooses oak’s color palette.",
      "The renderer makes a reusable oak-colored copy of the authored wood-floor picture.",
      "Both halves must be right: brown stone is still wrong, and gray wood is still wrong.",
    ],
    "steel-pick": [
      "The game says this is specifically a pick—not merely ‘some weapon’—and that it is made from steel.",
      "Because most squares have no item, the pick’s details travel as an optional item attachment.",
      "The browser attaches those item facts to the correct world square.",
      "The exact raw token ITEM_WEAPON_PICK wins before the generic WEAPON fallback.",
      "The pick-shaped cell is cropped and recolored with steel’s palette row.",
      "The result has the correct shape and material. Losing either fact creates a different bug.",
    ],
    "cat-corpse": [
      "The game says this item is a corpse, and the corpse belongs to the CAT species.",
      "The server sends both facts. ‘Cat’ alone would not tell us whether it is alive or dead.",
      "The browser keeps the dead-state and species together on the item.",
      "The resolver asks for CAT.corpse. If that is missing, it uses remains—not a living cat.",
      "The dead-cat cell can live on the same sheet as the live cat but at a different location.",
      "This demonstrates why a real, non-empty picture can still be wrong: a living cat is species-correct but state-wrong.",
    ],
    "dwarf-unit": [
      "A dwarf’s look is assembled from body, hair, clothes, equipment, profession, and conditions.",
      "Moving units travel separately from terrain. When available, the message includes a hash for DF’s finished per-unit composite.",
      "The browser keeps the dwarf in the unit list instead of pretending it is part of the ground tile.",
      "It tries the exact live composite first, then progressively simpler dwarf/race fallbacks, and finally a visible dot.",
      "The live composite is a dynamic image that may arrive after DF has rendered that dwarf on the host camera.",
      "A temporary fallback is not automatically a bad texture choice; first identify which fallback tier actually drew.",
    ],
    "oak-tree": [
      "A tree square needs both the species—oak—and its structural role—trunk, branch, leaves, and direction.",
      "The normal tile record carries structure; an optional plant attachment carries OAK and the part.",
      "The browser reunites the species with the structural tile name.",
      "The tree map chooses the exact oak family and directional variant, plus leaves where needed.",
      "The structural wood cell and leaf overlay can be two separate pictures.",
      "A trunk happens to be WALL-shaped in DF data, but it must not receive the generic stone-wall painter.",
    ],
    "blood-spatter": [
      "The game records what the contaminant is, how much is present, and its material color.",
      "Blood data travels only on affected squares, including an optional resolved RGB color.",
      "Several contaminants can survive as a list instead of being flattened into one generic red stain.",
      "Color chooses the stain family, amount chooses coverage, and neighboring stained squares choose its joined edge shape.",
      "That family and edge name point to a real cell on a spatter sheet.",
      "Blood sits above dry ground but below translucent water on a flooded square. Correct art in the wrong order still looks wrong.",
    ],
    workshop: [
      "A workshop is a multi-square object with a type, subtype, footprint, build stage, and component materials.",
      "Buildings travel beside the terrain because one building covers several squares and can animate or change state.",
      "The browser receives one workshop record with its whole footprint—not nine unrelated floor tiles.",
      "Workshop:Carpenters selects a 3×3 authored cell plan. Special buildings add direction or state rules.",
      "Each non-empty part of the plan is cropped from the building sheet and placed at the correct footprint offset.",
      "Material color is masked to the workshop pixels so transparent parts do not paint the ground underneath.",
    ],
  };

  const SCENARIO_VISUALS = {
    "stone-floor": { symbol: "▦", label: "stone floor", tokens: ["STONE_FLOOR_5", "STONE_FLOOR_1"], map: "tiletype_token_map", lookup: ["dense stone base", "sparse stone detail", "flat-color fallback"] },
    "wood-construction": { symbol: "≋", label: "oak floor", tokens: ["WOOD_FLOOR"], map: "construction material resolver", lookup: ["WOOD_FLOOR + oak palette", "FLOOR_STONE_BLOCK", "flat construction color"] },
    "steel-pick": { symbol: "⚒", label: "steel pick", catalog: "items", path: "bytoken.ITEM_WEAPON_PICK", map: "item_map.bytoken", lookup: ["ITEM_WEAPON_PICK", "generic WEAPON", "missing-item box"] },
    "cat-corpse": { symbol: "☠", label: "cat corpse", catalog: "creatures", path: "races.CAT.corpse", map: "creatures_map.races.CAT.corpse", lookup: ["CAT.corpse", "bone-pile fallback", "living CAT (wrong)"] },
    "dwarf-unit": { symbol: "☺", label: "dwarf", value: { baked: "dwarf.png" }, map: "resolveUnitTier", lookup: ["live unit composite", "baked dwarf fallback", "unit dot"] },
    "oak-tree": { symbol: "♣", label: "oak trunk", catalog: "trees", path: "OAK.TRUNK", map: "tree_map.OAK", lookup: ["OAK exact trunk variant", "raw-defined generic tree", "stone wall (wrong)"] },
    "blood-spatter": { symbol: "✹", label: "blood", catalog: "spatter", path: "families.BLOOD_RED", map: "spatter family + mask", lookup: ["red blood family + joined shape", "color wash fallback", "unrelated stain family"] },
    workshop: { symbol: "⌂", label: "carpenter workshop", catalog: "buildings", path: "Workshop:Carpenters", map: "building_map", lookup: ["Workshop:Carpenters 3×3 plan", "generic Workshop", "repeated edge cell (wrong)"] },
  };

  const CATALOGS = [
    { id: "tiletypes", title: "Terrain tiletype → graphics token", url: "/tiletype_token_map.json", description: "492 df::tiletype names mapped to premium base tokens, optional detail overlays, and tint policy.", generator: "tools/ws2/build_tiletype_token_map.py", consumer: "dwf-tiles.js resolveSprite / dwf-gl.js tokenCell", mode: "top" },
    { id: "items", title: "Item resolver map", url: "/item_map.json", description: "Raw item tokens, generic type cells, material variants, corpse fallbacks, gem shapes, and sheet geometry.", generator: "tools/ws2/build_item_map.py", consumer: "resolveItemVisual / resolveItemEntry in both renderers", mode: "visual" },
    { id: "creatures", title: "Creature and corpse map", url: "/creatures_map.json", description: "Race tokens mapped to flat, layered, baked, corpse, skeleton, and multi-cell creature art.", generator: "tools/ws2/build_creature_map.py", consumer: "resolveUnitTier + creature-derived item resolver", mode: "creatures" },
    { id: "buildings", title: "Building geometry map", url: "/building_map.json", description: "Building keys mapped to sheets and authored 2-D cell plans, including workshops, furniture, machines, and bridges.", generator: "tools/ws2/build_building_map.py", consumer: "buildingEntry / buildingEntryGL", mode: "top" },
    { id: "plants", title: "Plant species map", url: "/plant_map.json", description: "Plant tokens mapped to standing shrub, dead shrub, seed, picked growth, fruit, and related species art.", generator: "tools/ws2/build_plant_map.py", consumer: "drawPlant/emitPlant + plant-derived item resolver", mode: "visual" },
    { id: "trees", title: "Tree structural map", url: "/tree_map.json", description: "Species, structural families, and exact directional/connectivity variants, including overleaves and generic raw-defined fallback.", generator: "tools/ws2/build_tree_map.py", consumer: "drawTree / emitTree", mode: "visual" },
    { id: "materials", title: "Material → palette row", url: "/material_map.json", description: "Inorganics, plant materials, and creature-generic materials joined to DF’s 18-color palette rows and value/family metadata.", generator: "tools/ws2/build_material_map.py", consumer: "constructionMaterial/item palette resolver + atlas.resolvePalette", mode: "materials" },
    { id: "spatter", title: "Spatter family and adjacency map", url: "/spatter_map.json", description: "Blood/material families, amount thresholds, growth litter classes, and named joined-shape cells.", generator: "tools/ws2/build_spatter_map.py", consumer: "drawSpatter/emitSpatterDecals", mode: "visual" },
    { id: "flows", title: "Flow animation map", url: "/flow_map.json", description: "Flow type ordinals/names joined to animated graphics tokens and frame counts.", generator: "tools/ws2/build_flow_map.py", consumer: "cloud/flow resolver in both renderers", mode: "leaves" },
    { id: "overlays", title: "Stockpile, zone, and designation overlays", url: "/overlay_map.json", description: "Overlay categories and adjacency cells for gameplay UI drawn over the map.", generator: "tools/ws2/build_building_map.py", consumer: "overlay and designation passes", mode: "visual" },
    { id: "shadows", title: "Shadow mask → token", url: "/shadow_cell_map.json", description: "Measured 8-neighbor masks mapped to wall, ramp, and vision-shadow graphics tokens.", generator: "tools/spikes/fog/derive_shadow_table.py", consumer: "drawShadowDecals / GL shadow emission", mode: "leaves" },
    { id: "interface", title: "Interface sprite map", url: "/interface_map.json", description: "Interface token keys mapped to pixel rectangles in native UI sheets.", generator: "tools/ws2/build_interface_map.py", consumer: "HUD, panels, status icons, and map overlays", mode: "top" },
    { id: "raw-tokens", title: "Live environment/plant graphics tokens", url: "/sprites/map.json", description: "Parsed at plugin startup from DF’s installed graphics raws. Includes token aliases, sheet cells, and animation frame runs; available only through the dwf server.", generator: "src/sprite_map.cpp (runtime raw parser)", consumer: "resolveCell/tokenCell → /sprites/img/<sheet>", mode: "top", live: true },
  ];

  const FAILURE_PRESETS = [
    { id: "healthy", title: "Healthy end-to-end chain", state: { identity: true, mapping: true, correct: true, sheet: true, shared: true, fresh: true, fallback: "safe" } },
    { id: "identity", title: "Identity lost on the wire", state: { identity: false, mapping: true, correct: true, sheet: true, shared: true, fresh: true, fallback: "safe" } },
    { id: "generator", title: "Generator omitted the needed key", state: { identity: true, mapping: false, correct: true, sheet: true, shared: true, fresh: true, fallback: "cross" } },
    { id: "wrong-cell", title: "Existing key points at wrong cell", state: { identity: true, mapping: true, correct: false, sheet: true, shared: true, fresh: true, fallback: "safe" } },
    { id: "sheet", title: "Sheet fetch/atlas resolution failed", state: { identity: true, mapping: true, correct: true, sheet: false, shared: true, fresh: true, fallback: "safe" } },
    { id: "renderer", title: "Canvas2D/WebGL decision trees drifted", state: { identity: true, mapping: true, correct: true, sheet: true, shared: false, fresh: true, fallback: "safe" } },
    { id: "stale", title: "Open tab kept pre-fix JavaScript", state: { identity: true, mapping: true, correct: true, sheet: true, shared: true, fresh: false, fallback: "safe" } },
    { id: "plausible", title: "Cross-kind fallback hid a data gap", state: { identity: true, mapping: false, correct: true, sheet: true, shared: true, fresh: true, fallback: "cross" } },
  ];

  const REPAIR_ROUTES = [
    { id: "terrain", title: "Terrain, wall, floor, ramp, or liquid", summary: "First separate tile identity from topology and layer order. Walls and ramps need neighbors; floors can require dense-base + sparse-overlay; constructions need built-from material.", identity: "TileRecord + /tiletype_meta.json + base_mt/base_mi", map: "web/tiletype_token_map.json + /sprites/map.json + shadow_cell_map.json", client: "resolveSprite, resolveConstructionFloor, drawWallJoin, liquid/shadow helpers", check: "node tools/harness/renderer_wave_test.mjs (plus focused b*_test); native window parity for fog", ruleTitle: "Do not replace a layered floor with its sparse detail cell", ruleCopy: "STONE_FLOOR_1 is valid but nearly transparent. Trace whether the intended mechanism is base, overlay, adjacency, palette, or screen-space effect before changing a token." },
    { id: "item", title: "Ground item, corpse, gem, tool, or equipment", summary: "Confirm item_type, subtype/raw itemdef token, identity extension, material, gem shape, and state. Silhouette and palette color resolve independently.", identity: "ITEM tail + ITEMDEF_DICT + identKind/ident + material", map: "web/item_map.json + creatures_map.json + material_map.json", client: "resolveItemVisual / resolveItemEntry", check: "tools/ws2/tests/test_item_map.py + relevant Node item fixture + spritepick pins", ruleTitle: "A generic item box is safer than a confident wrong kind", ruleCopy: "Do not let plant identity turn WOOD into SEED, or creature identity turn CORPSE into a living animal. Fallbacks must stay inside the semantic class." },
    { id: "plant", title: "Plant, seed, fruit, shrub, or tree", summary: "Plant species is only half the key. Confirm part/state/growth for shrubs and items, or structural tiletype family/variant for full-grown trees.", identity: "PLANT/GRASS/ITEM tails + ttname structural part", map: "web/plant_map.json + tree_map.json", client: "drawPlant/emitPlant + drawTree/emitTree + plant-derived item branch", check: "texture_coverage_audit.py --selftest + tree/plant focused Node tests", ruleTitle: "Never fall from picked fruit to seed merely because seed exists", ruleCopy: "Nested GROWTH_PICKED tags and TREE_OVERLEAVES are separate authored classes. Missing one must not silently borrow another." },
    { id: "creature", title: "Live creature, layered unit, corpse, or skeleton", summary: "Determine whether you are testing runtime per-unit composite, flat race fallback, baked layered fallback, dead-state art, or last-resort dot/box.", identity: "AUX rt + optional ah/sw/sh/ax/ay; ITEM ident for corpses", map: "web/creatures_map.json + generated fallback atlases", client: "resolveUnitTier + creature item resolver", check: "creature_composite_map_test.py + portraits_test.mjs + live /unit-sprite evidence", ruleTitle: "A cold composite is not proof that the baker chose wrong pixels", ruleCopy: "A hash can 404 before DF has rendered that unit host-side. Identify which tier actually drew before diagnosing color or model." },
    { id: "building", title: "Building, workshop, furniture, bridge, or machine", summary: "Trace type/subtype/state/direction, footprint versus authored art dimensions, build stage, and component material tint. Buildings are multi-cell AUX objects.", identity: "AUX BldRec: type/subtype/bounds/stage/direction/state/components", map: "web/building_map.json + overlay_map.json", client: "buildingEntry/machineEntry/farmPlotEntry + building blit loop", check: "tools/ws2/tests/test_building_map.py + wc4/wb12/wc6 focused Node tests", ruleTitle: "Do not edge-clamp art to fill a footprint", ruleCopy: "A narrow wagon or overhang should be centered or anchored according to authored geometry. Repeating the nearest cell creates plausible but impossible structures." },
    { id: "material", title: "Right model, wrong color or material", summary: "First prove the selected silhouette cell is correct. Then inspect material identity, family, palette row, and exact palette remap. Multiplication is not equivalent to DF’s indexed palette swap.", identity: "base_mt/base_mi or ITEM material + stable inorganic/plant identity", map: "web/material_map.json + item/building source cell map", client: "constructionMaterial/item palette logic + resolvePalette", check: "material_map_test.py + t1_material_parity_test.mjs + native differential", ruleTitle: "Color cannot repair the wrong silhouette", ruleCopy: "The right palette row applied to a placeholder, wrong gem cut, or natural stone token remains wrong. Lock model selection before tuning color." },
    { id: "renderer", title: "Only Canvas2D or only WebGL is wrong", summary: "Assume duplicated client policy drift until evidence says otherwise. Compare the two resolver copies, atlas geometry, alpha mode, and instance painter order.", identity: "Same decoded view and maps feed both renderers", map: "Usually already correct; prove with the other renderer", client: "dwf-tiles.js versus dwf-gl.js / dwf-gl-atlas.js", check: "gl_core_test.mjs + renderer_wave_test.mjs + focused parity fixture", ruleTitle: "Do not patch the shared JSON to compensate for one renderer", ruleCopy: "If one renderer is correct with the same data, changing the map moves both. Fix the diverged resolver, geometry, atlas, shader, or paint order." },
  ];

  let pipelineStageIndex = 0;
  let guidedScenarioIndex = 0;
  let guidedStepIndex = 0;
  let guidedAutoplay = false;
  let guidedTimer = null;
  let guidedVisualRevision = 0;
  const guidedCompleted = new Set();
  const scenarioCellCache = new Map();
  let traceScenarioIndex = 0;
  let traceStepIndex = 0;
  let currentCatalog = null;
  let currentRows = [];
  let filteredRows = [];
  let currentEntryIndex = -1;
  let currentCells = [];
  let currentCellIndex = 0;
  let previewRequest = 0;
  let liveSpriteMap = null;
  const catalogCache = new Map();
  const TOKEN_CELL_OVERRIDES = {
    GRASS_1: { sheet: "grass.png", col: 0, row: 0 },
    GRASS_2: { sheet: "grass.png", col: 1, row: 0 },
    GRASS_3: { sheet: "grass.png", col: 2, row: 0 },
    GRASS_4: { sheet: "grass.png", col: 3, row: 0 },
  };

  function json(value) {
    return JSON.stringify(value, null, 2);
  }

  function pathValue(value, path) {
    if (!path) return value;
    return path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), value);
  }

  function setupTabs() {
    $$(".tab-button").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;
        $$(".tab-button").forEach((b) => {
          const active = b === button;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        $$(".lab-panel").forEach((panel) => {
          const active = panel.dataset.panel === tab;
          panel.hidden = !active;
          panel.classList.toggle("is-active", active);
        });
      });
    });
  }

  function renderPipeline() {
    const flow = $("#pipeline-flow");
    flow.textContent = "";
    PIPELINE_STAGES.forEach((stage, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pipeline-node" + (index === pipelineStageIndex ? " is-active" : "");
      button.setAttribute("aria-pressed", index === pipelineStageIndex ? "true" : "false");
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("strong");
      label.textContent = stage.short;
      button.append(number, label);
      button.addEventListener("click", () => {
        pipelineStageIndex = index;
        renderPipeline();
      });
      flow.appendChild(button);
    });

    const stage = PIPELINE_STAGES[pipelineStageIndex];
    $("#stage-number").textContent = "Stage " + (pipelineStageIndex + 1) + " of " + PIPELINE_STAGES.length;
    $("#stage-title").textContent = stage.title;
    $("#stage-summary").textContent = stage.summary;
    $("#stage-plain").textContent = PIPELINE_PLAIN[pipelineStageIndex];
    $("#stage-input").textContent = stage.input;
    $("#stage-output").textContent = stage.output;
    $("#stage-knows").textContent = stage.knows;
    $("#stage-unknown").textContent = stage.unknown;
    $("#stage-danger").textContent = stage.danger;
    $("#stage-source").textContent = stage.source;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function flattenScalars(value, prefix, output, limit) {
    if (output.length >= limit || value == null) return;
    if (typeof value !== "object") {
      output.push([prefix || "value", String(value)]);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, limit - output.length).forEach((child, index) => flattenScalars(child, prefix + "[" + index + "]", output, limit));
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      if (output.length < limit) flattenScalars(child, prefix ? prefix + "." + key : key, output, limit);
    });
  }

  function scenarioFields(scenario, sourceStep, limit) {
    const output = [];
    const step = scenario.steps[Math.max(0, Math.min(sourceStep, scenario.steps.length - 1))];
    flattenScalars(step && step[3], "", output, limit || 4);
    return output;
  }

  function worldGridMarkup(profile) {
    let cells = "";
    for (let index = 0; index < 25; index++)
      cells += `<span class="${index === 12 ? "is-target" : ""}">${index === 12 ? escapeHtml(profile.symbol) : ""}</span>`;
    return `<div class="pixel-grid" aria-hidden="true">${cells}</div>`;
  }

  function dataChipsMarkup(fields) {
    return `<div class="data-fields">${fields.map(([key, value]) =>
      `<span class="data-chip"><strong>${escapeHtml(key)}</strong>=${escapeHtml(value)}</span>`).join("")}</div>`;
  }

  function layerMarkup(scenario) {
    return scenario.layers.slice(0, 6).map((layer, index) =>
      `<div class="visual-layer"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(layer)}</strong></div>`).join("");
  }

  function visualMarkup(kind, scenario) {
    const profile = SCENARIO_VISUALS[scenario.id];
    const identityFields = scenarioFields(scenario, 0, 4);
    const decodedFields = scenarioFields(scenario, 2, 4);
    if (kind === "meet") {
      return `<div class="visual-flow">
        <div class="visual-node is-active"><span>the world square</span>${worldGridMarkup(profile)}<strong>${escapeHtml(profile.label)}</strong></div>
        <div class="visual-node"><span>question 1</span><div class="visual-glyph">?</div><strong>What is it?</strong></div>
        <div class="visual-node"><span>question 2</span><canvas class="actual-cell-canvas" width="144" height="144" aria-label="Actual sprite preview"></canvas><strong>What should it look like?</strong></div>
      </div>`;
    }
    if (kind === "read") {
      return `<div class="visual-flow">
        <div class="visual-node is-active"><span>DF world</span>${worldGridMarkup(profile)}<strong>${escapeHtml(profile.label)}</strong></div>
        <div class="visual-track"><div class="visual-packet">READ FACTS</div></div>
        <div class="visual-node"><span>DFHack record</span>${dataChipsMarkup(identityFields)}<strong>identity, not pixels</strong></div>
      </div>`;
    }
    if (kind === "wire") {
      const labels = ["tt/type", "material", "state bits", "desig", "flags", "optional tail"];
      return `<div class="byte-packet">${labels.map((label, index) =>
        `<div class="byte-segment"><strong>${escapeHtml(label)}</strong><span>${index === 5 ? "only if needed" : "compact bytes"}</span></div>`).join("")}</div>`;
    }
    if (kind === "decode") {
      return `<div class="visual-flow">
        <div class="visual-node"><span>binary packet</span><div class="visual-glyph">01</div><strong>small numbers</strong></div>
        <div class="visual-track"><div class="visual-packet">UNPACK</div></div>
        <div class="visual-node is-active"><span>named tile/object</span>${dataChipsMarkup(decodedFields)}<strong>meaning restored</strong></div>
      </div>`;
    }
    if (kind === "lookup") {
      return `<div class="lookup-tree">${profile.lookup.map((choice, index) =>
        `<div class="lookup-choice ${index === 0 ? "is-selected" : ""}"><span>${index === 0 ? "selected path" : index === 1 ? "fallback" : "unsafe/wrong"}</span><code>${escapeHtml(choice)}</code></div>`).join("")}</div>`;
    }
    if (kind === "build") {
      return `<div class="visual-composite">
        <div class="visual-atlas">
          <canvas class="actual-sheet-canvas" width="432" height="220" aria-label="Source sprite sheet with selected cell"></canvas>
          <div class="visual-atlas-arrow" aria-hidden="true">→</div>
          <div class="visual-crop-wrap"><canvas class="actual-cell-canvas" width="144" height="144" aria-label="Cropped sprite cell"></canvas><span>crop the chosen cell</span></div>
        </div>
        <div class="visual-layer-stack">${layerMarkup(scenario)}</div>
      </div>`;
    }
    return `<div class="visual-final">
      <canvas class="actual-cell-canvas" width="180" height="180" aria-label="Final sprite preview"></canvas>
      <div class="visual-checks"><div>✓ Exact identity survived</div><div>✓ Correct semantic art class</div><div>✓ Correct material/layers/order</div><div>✓ Compared with native evidence</div></div>
    </div>`;
  }

  async function loadScenarioCells(scenario) {
    if (scenarioCellCache.has(scenario.id)) return scenarioCellCache.get(scenario.id);
    const promise = (async () => {
      const profile = SCENARIO_VISUALS[scenario.id];
      if (profile.value) return extractCells(profile.value);
      if (profile.tokens) {
        const rawCatalog = CATALOGS.find((catalog) => catalog.id === "raw-tokens");
        const map = await fetchCatalog(rawCatalog);
        liveSpriteMap = map;
        return profile.tokens.flatMap((token) => extractCells(TOKEN_CELL_OVERRIDES[token] || map[token] || token));
      }
      const catalog = CATALOGS.find((item) => item.id === profile.catalog);
      const data = await fetchCatalog(catalog);
      return extractCells(pathValue(data, profile.path));
    })().catch(() => []);
    scenarioCellCache.set(scenario.id, promise);
    return promise;
  }

  function glyphCanvas(canvas, profile) {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    const styles = getComputedStyle(root);
    context.fillStyle = styles.getPropertyValue("--lab-panel-3").trim() || "#242e29";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = styles.getPropertyValue("--lab-gold").trim() || "#d6b96f";
    context.font = `600 ${Math.floor(canvas.height * 0.42)}px ${getComputedStyle(document.body).fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(profile.symbol, canvas.width / 2, canvas.height / 2);
  }

  async function hydrateScenarioVisual(container, scenario, revision) {
    const profile = SCENARIO_VISUALS[scenario.id];
    const cells = await loadScenarioCells(scenario);
    if (!container.isConnected || Number(container.dataset.visualRevision) !== revision) return;
    const cell = cells[0];
    const cellCanvases = Array.from(container.querySelectorAll(".actual-cell-canvas"));
    const sheetCanvases = Array.from(container.querySelectorAll(".actual-sheet-canvas"));
    if (!cell) {
      cellCanvases.forEach((canvas) => glyphCanvas(canvas, profile));
      sheetCanvases.forEach((canvas) => glyphCanvas(canvas, profile));
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (!container.isConnected || Number(container.dataset.visualRevision) !== revision) return;
      cellCanvases.forEach((canvas) => paintCellCanvas(canvas, image, cell));
      sheetCanvases.forEach((canvas) => paintSheetCanvas(canvas, image, cell));
    };
    image.onerror = () => {
      cellCanvases.forEach((canvas) => glyphCanvas(canvas, profile));
      sheetCanvases.forEach((canvas) => glyphCanvas(canvas, profile));
    };
    image.src = spriteUrl(cell.sheet);
  }

  function renderVisual(container, kind, scenario) {
    const revision = ++guidedVisualRevision;
    container.dataset.visualRevision = String(revision);
    container.setAttribute("aria-label", GUIDED_STAGES.find((stage) => stage.visual === kind)?.title || "Texture pipeline visual");
    container.innerHTML = visualMarkup(kind, scenario);
    hydrateScenarioVisual(container, scenario, revision);
  }

  function setupGuided() {
    const scenarioSelect = $("#guided-scenario");
    TRACE_SCENARIOS.forEach((scenario, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = scenario.title;
      scenarioSelect.appendChild(option);
    });
    scenarioSelect.addEventListener("change", () => {
      guidedScenarioIndex = Number(scenarioSelect.value) || 0;
      stopGuidedAutoplay();
      renderGuided();
    });
    $("#guided-prev").addEventListener("click", () => setGuidedStep(guidedStepIndex - 1));
    $("#guided-next").addEventListener("click", () => setGuidedStep(guidedStepIndex + 1));
    $("#guided-replay").addEventListener("click", () => renderGuidedVisual());
    $("#guided-autoplay").addEventListener("click", toggleGuidedAutoplay);
    setupGlossary();
    renderGuided();
  }

  function setGuidedStep(index, preserveAutoplay) {
    guidedStepIndex = Math.max(0, Math.min(GUIDED_STAGES.length - 1, index));
    if (!preserveAutoplay) stopGuidedAutoplay();
    renderGuided();
  }

  function renderGuided() {
    const stage = GUIDED_STAGES[guidedStepIndex];
    const scenario = TRACE_SCENARIOS[guidedScenarioIndex];
    const tabs = $("#guided-step-tabs");
    tabs.textContent = "";
    GUIDED_STAGES.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "guided-step-button" + (index === guidedStepIndex ? " is-active" : "") + (guidedCompleted.has(scenario.id + ":" + index) ? " is-complete" : "");
      button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(item.short)}</strong>`;
      button.addEventListener("click", () => setGuidedStep(index));
      tabs.appendChild(button);
    });
    $("#guided-progress-fill").style.width = (((guidedStepIndex + 1) / GUIDED_STAGES.length) * 100) + "%";
    $("#guided-progress-label").textContent = "Step " + (guidedStepIndex + 1) + " of " + GUIDED_STAGES.length;
    $("#guided-step-kicker").textContent = stage.short;
    $("#guided-step-title").textContent = stage.title;
    $("#guided-scenario-name").textContent = scenario.title;
    $("#guided-plain").textContent = stage.plain;
    $("#guided-technical").textContent = stage.technical;
    $("#guided-source").textContent = stage.source;
    $("#guided-question").textContent = stage.question;
    $("#guided-hint").textContent = stage.hint;
    $("#guided-feedback").textContent = "";
    $("#guided-feedback").className = "guided-feedback";
    $("#guided-prev").disabled = guidedStepIndex === 0;
    $("#guided-next").disabled = guidedStepIndex === GUIDED_STAGES.length - 1;
    $("#guided-next").textContent = guidedStepIndex === GUIDED_STAGES.length - 1 ? "Tour complete ✓" : "Next step →";
    renderGuidedAnswers(stage, scenario);
    renderGuidedVisual();
    scheduleGuidedAutoplay();
  }

  function renderGuidedVisual() {
    const stage = GUIDED_STAGES[guidedStepIndex];
    renderVisual($("#guided-visual"), stage.visual, TRACE_SCENARIOS[guidedScenarioIndex]);
  }

  function renderGuidedAnswers(stage, scenario) {
    const answers = $("#guided-answers");
    answers.textContent = "";
    stage.answers.forEach((answer, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = answer;
      button.addEventListener("click", () => {
        const correct = index === stage.correct;
        button.classList.add(correct ? "is-correct" : "is-wrong");
        const feedback = $("#guided-feedback");
        feedback.textContent = correct ? stage.success : stage.failure;
        feedback.className = "guided-feedback " + (correct ? "is-correct" : "is-wrong");
        if (correct) {
          guidedCompleted.add(scenario.id + ":" + guidedStepIndex);
          Array.from(answers.children).forEach((child, childIndex) => { child.disabled = true; if (childIndex === stage.correct) child.classList.add("is-correct"); });
        }
      });
      answers.appendChild(button);
    });
  }

  function toggleGuidedAutoplay() {
    guidedAutoplay = !guidedAutoplay;
    const button = $("#guided-autoplay");
    button.setAttribute("aria-pressed", guidedAutoplay ? "true" : "false");
    button.textContent = guidedAutoplay ? "❚❚ Pause tour" : "▶ Play the tour";
    if (guidedAutoplay && guidedStepIndex === GUIDED_STAGES.length - 1) guidedStepIndex = 0;
    renderGuided();
  }

  function stopGuidedAutoplay() {
    guidedAutoplay = false;
    if (guidedTimer) clearTimeout(guidedTimer);
    guidedTimer = null;
    const button = $("#guided-autoplay");
    if (button) {
      button.setAttribute("aria-pressed", "false");
      button.textContent = "▶ Play the tour";
    }
  }

  function scheduleGuidedAutoplay() {
    if (guidedTimer) clearTimeout(guidedTimer);
    guidedTimer = null;
    if (!guidedAutoplay) return;
    guidedTimer = setTimeout(() => {
      if (guidedStepIndex >= GUIDED_STAGES.length - 1) {
        stopGuidedAutoplay();
        return;
      }
      setGuidedStep(guidedStepIndex + 1, true);
    }, 6500);
  }

  function setupGlossary() {
    const buttons = $("#term-buttons");
    Object.keys(GLOSSARY).forEach((term, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = term;
      if (index === 0) button.classList.add("is-active");
      button.addEventListener("click", () => {
        Array.from(buttons.children).forEach((child) => child.classList.toggle("is-active", child === button));
        $("#term-title").textContent = term;
        $("#term-definition").textContent = GLOSSARY[term];
      });
      buttons.appendChild(button);
    });
  }

  function setupTrace() {
    const select = $("#trace-scenario");
    TRACE_SCENARIOS.forEach((scenario, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = scenario.title + " — " + scenario.subtitle;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      traceScenarioIndex = Number(select.value) || 0;
      traceStepIndex = 0;
      renderTrace();
    });
    $("#trace-prev").addEventListener("click", () => {
      traceStepIndex = Math.max(0, traceStepIndex - 1);
      renderTrace();
    });
    $("#trace-next").addEventListener("click", () => {
      const scenario = TRACE_SCENARIOS[traceScenarioIndex];
      traceStepIndex = Math.min(scenario.steps.length - 1, traceStepIndex + 1);
      renderTrace();
    });
    renderTrace();
  }

  function renderTrace() {
    const scenario = TRACE_SCENARIOS[traceScenarioIndex];
    const steps = $("#trace-steps");
    steps.textContent = "";
    scenario.steps.forEach((step, index) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trace-step-button" + (index === traceStepIndex ? " is-active" : "");
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("strong");
      label.textContent = step[1];
      button.append(number, label);
      button.addEventListener("click", () => {
        traceStepIndex = index;
        renderTrace();
      });
      li.appendChild(button);
      steps.appendChild(li);
    });

    const step = scenario.steps[traceStepIndex];
    $("#trace-stage-label").textContent = step[0];
    $("#trace-step-title").textContent = step[1];
    $("#trace-explanation").textContent = step[2];
    $("#trace-data").textContent = json(step[3]);
    $("#trace-source").textContent = step[4];
    $("#trace-status").textContent = step[5];
    $("#trace-plain").textContent = (TRACE_SIMPLE[scenario.id] || [])[traceStepIndex] || step[2];
    $("#trace-position").textContent = (traceStepIndex + 1) + " / " + scenario.steps.length;
    $("#trace-prev").disabled = traceStepIndex === 0;
    $("#trace-next").disabled = traceStepIndex === scenario.steps.length - 1;

    $("#layer-stack-title").textContent = scenario.title + " paint stack";
    const stack = $("#layer-stack");
    stack.textContent = "";
    scenario.layers.forEach((name, index) => {
      const chip = document.createElement("div");
      chip.className = "layer-chip";
      const order = document.createElement("span");
      order.textContent = "layer " + (index + 1);
      const label = document.createElement("strong");
      label.textContent = name;
      chip.append(order, label);
      stack.appendChild(chip);
    });
    $("#layer-result").textContent = scenario.result;
    const visualKinds = ["read", "wire", "decode", "lookup", "build", "prove"];
    renderVisual($("#trace-visual"), visualKinds[traceStepIndex] || "prove", scenario);
  }

  async function fetchCatalog(catalog) {
    if (catalogCache.has(catalog.id)) return catalogCache.get(catalog.id);
    const promise = fetch(catalog.url, { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
    catalogCache.set(catalog.id, promise);
    try {
      return await promise;
    } catch (error) {
      catalogCache.delete(catalog.id);
      throw error;
    }
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function isCell(value, inheritedSheet) {
    if (!isObject(value)) return false;
    return !!(value.sheet || inheritedSheet) && Number.isFinite(value.col) && Number.isFinite(value.row);
  }

  function scalarObject(value) {
    return isObject(value) && Object.values(value).every((v) => v == null || typeof v !== "object");
  }

  function makeRows(data, catalog) {
    const rows = [];
    const push = (path, value) => {
      if (!path || rows.length >= 12000) return;
      let search = path;
      try { search += " " + JSON.stringify(value); } catch (_) { /* cyclic data is impossible in JSON */ }
      rows.push({ path, value, search: search.toLowerCase() });
    };

    if (catalog.mode === "top") {
      Object.entries(data || {}).forEach(([key, value]) => push(key, value));
      return rows;
    }
    if (catalog.mode === "creatures") {
      Object.entries((data && data.races) || {}).forEach(([key, value]) => push("races." + key, value));
      return rows;
    }
    if (catalog.mode === "materials") {
      ((data && data.inorganic) || []).forEach((value, index) => push("inorganic." + index + "." + (value.id || "unknown"), value));
      Object.entries((data && data.plant) || {}).forEach(([key, value]) => push("plant." + key, value));
      Object.entries((data && data.creature_generic) || {}).forEach(([key, value]) => push("creature_generic." + key, { palette_row: value }));
      Object.entries((data && data.builtin) || {}).forEach(([key, value]) => push("builtin." + key, value));
      ((data && data.shape_tokens) || []).forEach((value, index) => push("shape_tokens." + index, value));
      push("palette", { rows: data && data.palette && data.palette.rows ? data.palette.rows.length : 0, colors_per_row: 18 });
      return rows;
    }

    const walk = (value, path, inheritedSheet, depth) => {
      if (rows.length >= 12000 || value == null) return;
      if (typeof value !== "object") {
        push(path, value);
        return;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return;
        value.forEach((child, index) => walk(child, path + "." + index, inheritedSheet, depth + 1));
        return;
      }
      const ownSheet = value.sheet || value.img || inheritedSheet || null;
      if (isCell(value, inheritedSheet) || value.baked || (ownSheet && value.cells)) {
        push(path, value);
        return;
      }
      if (scalarObject(value) || depth >= 6) {
        push(path, value);
        return;
      }
      Object.entries(value).forEach(([key, child]) => {
        if (key === "_note") return;
        walk(child, path ? path + "." + key : key, ownSheet, depth + 1);
      });
    };
    walk(data, "", null, 0);
    return rows;
  }

  function setupAtlas() {
    const select = $("#atlas-catalog");
    CATALOGS.forEach((catalog) => {
      const option = document.createElement("option");
      option.value = catalog.id;
      option.textContent = catalog.title + (catalog.live ? " (live)" : "");
      select.appendChild(option);
    });
    select.value = "tiletypes";
    select.addEventListener("change", () => selectCatalog(select.value));
    $("#atlas-search").addEventListener("input", () => {
      currentEntryIndex = -1;
      renderEntryList();
      if (filteredRows.length) selectEntry(0);
    });
    $("#cell-prev").addEventListener("click", () => {
      currentCellIndex = Math.max(0, currentCellIndex - 1);
      renderCurrentCell();
    });
    $("#cell-next").addEventListener("click", () => {
      currentCellIndex = Math.min(currentCells.length - 1, currentCellIndex + 1);
      renderCurrentCell();
    });
    selectCatalog("tiletypes");
  }

  async function selectCatalog(id) {
    const catalog = CATALOGS.find((c) => c.id === id) || CATALOGS[0];
    currentCatalog = catalog;
    currentRows = [];
    filteredRows = [];
    currentEntryIndex = -1;
    $("#catalog-title").textContent = catalog.title;
    $("#catalog-description").textContent = catalog.description;
    $("#catalog-count").textContent = "loading…";
    $("#entry-list").textContent = "";
    $("#entry-limit").textContent = "";
    $("#entry-key").textContent = "Loading " + catalog.url;
    $("#entry-json").textContent = "";
    clearPreviews("Loading catalog…");
    try {
      const data = await fetchCatalog(catalog);
      if (currentCatalog !== catalog) return;
      if (catalog.id === "raw-tokens") liveSpriteMap = data;
      currentRows = makeRows(data, catalog);
      $("#catalog-count").textContent = currentRows.length.toLocaleString() + " inspectable entries";
      renderEntryList();
      if (currentRows.length) selectEntry(0);
    } catch (error) {
      if (currentCatalog !== catalog) return;
      $("#catalog-count").textContent = "unavailable";
      $("#entry-key").textContent = catalog.live ? "Live token catalog unavailable" : "Catalog unavailable";
      $("#entry-json").textContent = catalog.live
        ? "Serve /texture-lab.html through the running dwf HTTP server to read /sprites/map.json and sprite sheets."
        : "The page could not fetch " + catalog.url + ". Serve the web directory over HTTP rather than opening this file directly.";
      clearPreviews("No data loaded");
    }
  }

  function renderEntryList() {
    const list = $("#entry-list");
    const query = $("#atlas-search").value.trim().toLowerCase();
    filteredRows = query ? currentRows.filter((row) => row.search.includes(query)) : currentRows.slice();
    list.textContent = "";
    const limit = 180;
    filteredRows.slice(0, limit).forEach((row, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-button" + (index === currentEntryIndex ? " is-active" : "");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", index === currentEntryIndex ? "true" : "false");
      button.textContent = row.path;
      button.addEventListener("click", () => selectEntry(index));
      list.appendChild(button);
    });
    $("#entry-limit").textContent = filteredRows.length > limit
      ? "Showing the first " + limit + " of " + filteredRows.length.toLocaleString() + ". Refine the search to reach the rest."
      : filteredRows.length.toLocaleString() + " matching entries";
    if (!filteredRows.length) {
      const empty = document.createElement("p");
      empty.className = "entry-limit";
      empty.textContent = "No key or value contains that search text.";
      list.appendChild(empty);
    }
  }

  function selectEntry(index) {
    const row = filteredRows[index];
    if (!row) return;
    currentEntryIndex = index;
    $$(".entry-button").forEach((button, i) => {
      button.classList.toggle("is-active", i === index);
      button.setAttribute("aria-selected", i === index ? "true" : "false");
    });
    $("#entry-key").textContent = row.path;
    $("#entry-json").textContent = json(row.value);
    $("#entry-generator").textContent = currentCatalog.generator;
    $("#entry-consumer").textContent = currentCatalog.consumer;
    currentCells = extractCells(row.value);
    currentCellIndex = 0;
    renderCurrentCell();
  }

  function extractCells(value) {
    const cells = [];
    const seen = new Set();
    const add = (cell) => {
      if (!cell.sheet || cells.length >= 128) return;
      const key = [cell.sheet, cell.sx, cell.sy, cell.sw, cell.sh, cell.path].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      cells.push(cell);
    };
    const walk = (node, path, inheritedSheet) => {
      if (node == null || cells.length >= 128) return;
      if (typeof node === "string") {
        const mapped = TOKEN_CELL_OVERRIDES[node] || (liveSpriteMap && liveSpriteMap[node]);
        if (mapped) walk(mapped, path + " → " + node, null);
        return;
      }
      if (typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, path + "[" + index + "]", inheritedSheet));
        return;
      }
      const sheet = node.sheet || node.img || inheritedSheet || null;
      if (sheet && Number.isFinite(node.col) && Number.isFinite(node.row)) {
        add({ sheet, sx: node.col * 32, sy: node.row * 32, sw: 32, sh: 32, path, label: sheet + " · cell " + node.col + "," + node.row });
      }
      if (node.img && Number.isFinite(node.cx) && Number.isFinite(node.cy)) {
        const sw = Number.isFinite(node.w) ? node.w : 32;
        const sh = Number.isFinite(node.h) ? node.h : 32;
        add({ sheet: node.img, sx: node.cx, sy: node.cy, sw, sh, path, label: node.img + " · px " + node.cx + "," + node.cy + " " + sw + "×" + sh });
      }
      if (node.baked && typeof node.baked === "string") {
        add({ sheet: node.baked, sx: 0, sy: 0, sw: 32, sh: 32, path: path + ".baked", label: node.baked + " · generated fallback" });
      }
      Object.entries(node).forEach(([key, child]) => {
        if (key === "sheet" || key === "img" || key === "baked") return;
        walk(child, path ? path + "." + key : key, sheet);
      });
    };
    walk(value, "entry", null);
    return cells;
  }

  function spriteUrl(sheet) {
    return "/sprites/img/" + String(sheet).split("/").map(encodeURIComponent).join("/");
  }

  function clearCanvas(canvas) {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function clearPreviews(message) {
    clearCanvas($("#sprite-preview"));
    clearCanvas($("#sheet-preview"));
    $("#sprite-caption").textContent = message;
    $("#sheet-caption").textContent = "No source sheet selected.";
    $("#cell-nav").hidden = true;
  }

  function renderCurrentCell() {
    if (!currentCells.length) {
      clearPreviews("This entry has no directly identifiable sprite cell.");
      return;
    }
    const cell = currentCells[currentCellIndex];
    const request = ++previewRequest;
    const nav = $("#cell-nav");
    nav.hidden = currentCells.length <= 1;
    $("#cell-position").textContent = (currentCellIndex + 1) + " / " + currentCells.length;
    $("#cell-prev").disabled = currentCellIndex === 0;
    $("#cell-next").disabled = currentCellIndex === currentCells.length - 1;
    $("#sprite-caption").textContent = "Loading " + cell.label;
    $("#sheet-caption").textContent = "Loading " + cell.sheet;
    clearCanvas($("#sprite-preview"));
    clearCanvas($("#sheet-preview"));

    const image = new Image();
    image.onload = () => {
      if (request !== previewRequest) return;
      drawCellPreview(image, cell);
      drawSheetPreview(image, cell);
      $("#sprite-caption").textContent = cell.label;
      $("#sheet-caption").textContent = cell.sheet + " · " + image.naturalWidth + "×" + image.naturalHeight + " px · highlighted source region";
    };
    image.onerror = () => {
      if (request !== previewRequest) return;
      clearPreviews("Could not load " + cell.sheet + " through /sprites/img/. Use the running dwf server for installed DF sheets.");
    };
    image.src = spriteUrl(cell.sheet);
  }

  function drawCellPreview(image, cell) {
    paintCellCanvas($("#sprite-preview"), image, cell);
  }

  function paintCellCanvas(canvas, image, cell) {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    const pad = 10;
    const scale = Math.min((canvas.width - pad * 2) / cell.sw, (canvas.height - pad * 2) / cell.sh);
    const dw = Math.max(1, Math.floor(cell.sw * scale));
    const dh = Math.max(1, Math.floor(cell.sh * scale));
    const dx = Math.floor((canvas.width - dw) / 2);
    const dy = Math.floor((canvas.height - dh) / 2);
    context.drawImage(image, cell.sx, cell.sy, cell.sw, cell.sh, dx, dy, dw, dh);
  }

  function drawSheetPreview(image, cell) {
    paintSheetCanvas($("#sheet-preview"), image, cell);
  }

  function paintSheetCanvas(canvas, image, cell) {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const dw = Math.max(1, Math.floor(image.naturalWidth * scale));
    const dh = Math.max(1, Math.floor(image.naturalHeight * scale));
    const dx = Math.floor((canvas.width - dw) / 2);
    const dy = Math.floor((canvas.height - dh) / 2);
    context.drawImage(image, dx, dy, dw, dh);
    const styles = getComputedStyle(root);
    context.strokeStyle = styles.getPropertyValue("--lab-gold").trim() || "#d6b96f";
    context.lineWidth = 2;
    const hx = dx + cell.sx * scale;
    const hy = dy + cell.sy * scale;
    const hw = Math.max(4, cell.sw * scale);
    const hh = Math.max(4, cell.sh * scale);
    context.strokeRect(Math.floor(hx) + 0.5, Math.floor(hy) + 0.5, Math.max(3, Math.floor(hw)), Math.max(3, Math.floor(hh)));
  }

  function setupFailureLab() {
    const preset = $("#failure-preset");
    FAILURE_PRESETS.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.title;
      preset.appendChild(option);
    });
    preset.addEventListener("change", () => {
      const item = FAILURE_PRESETS.find((p) => p.id === preset.value) || FAILURE_PRESETS[0];
      Object.entries(item.state).forEach(([key, value]) => {
        if (key === "fallback") $("#fallback-policy").value = value;
        else {
          const input = root.querySelector('[data-failure="' + key + '"]');
          if (input) input.checked = !!value;
        }
      });
      renderFailure();
    });
    $$("[data-failure]").forEach((input) => input.addEventListener("change", renderFailure));
    $("#fallback-policy").addEventListener("change", renderFailure);
    preset.value = "healthy";
    renderFailure();
  }

  function failureState() {
    const state = {};
    $$("[data-failure]").forEach((input) => { state[input.dataset.failure] = input.checked; });
    state.fallback = $("#fallback-policy").value;
    return state;
  }

  function renderFailure() {
    const state = failureState();
    const stages = [
      ["Wire identity", state.identity],
      ["Generated key", state.mapping],
      ["Correct cell", state.correct],
      ["Sheet / atlas", state.sheet],
      ["Renderer parity", state.shared],
      ["Fresh client", state.fresh],
    ];
    const chain = $("#failure-chain");
    chain.textContent = "";
    stages.forEach(([label, good], index) => {
      const node = document.createElement("div");
      node.className = "failure-node " + (good ? "is-good" : "is-broken");
      const stage = document.createElement("span");
      stage.textContent = "stage " + (index + 1);
      const result = document.createElement("strong");
      result.textContent = label + ": " + (good ? "intact" : "broken");
      node.append(stage, result);
      chain.appendChild(node);
    });

    let outcome;
    if (!state.fresh) {
      outcome = { title: "Stale result survives the fix", copy: "The open tab keeps its old resolver and maps in memory through server restarts. A correct web copy can appear ineffective until a hard refresh loads current JavaScript.", symbol: "↻", cls: "warning", layer: "Browser session / deploy verification", action: "Hard-refresh, confirm the cache-buster/current asset response, then reproduce before editing code again.", proof: "Versioned live reproduction", proofCopy: "Show that the tab loaded the new asset bytes and that the same exact subject still fails." };
    } else if (!state.identity) {
      outcome = { title: "Generic but information-limited art", copy: "The browser cannot infer an exact species, subtype, material, or state that never crossed the boundary. It falls to a coarse type cell or explicit placeholder.", symbol: "?", cls: "warning", layer: "DF read or wire encoding", action: "Add the missing stable identity at its DF source and transport it additively; do not encode a guessed sprite cell.", proof: "Wire fixture + live identity", proofCopy: "Golden-decode the field and show it matches the exact live object in DFHack." };
    } else if (!state.mapping && state.fallback === "cross") {
      outcome = { title: "Plausible but wrong sprite", copy: "The lookup gap is hidden by a fallback from another semantic class. The sprite exists and looks intentional, so missing-art checks incorrectly pass.", symbol: "≠", cls: "wrong", layer: "Map generator and fallback policy", action: "Teach the generator the missing class and restrict fallback to the same kind. Pin any ambiguous human-adjudicated choice.", proof: "Independent native/Steam oracle", proofCopy: "Compare exact pixels/state and run the audit’s seeded wrong-art case—not just a non-empty lookup." };
    } else if (!state.mapping) {
      outcome = { title: "Honest placeholder or flat fallback", copy: "Kind-safe fallback exposes the data gap instead of fabricating confidence. It looks less polished, but it points to the real missing generator rule.", symbol: "□", cls: "warning", layer: "Map generator", action: "Parse the authored raw tag and regenerate the derived JSON. Keep the safe fallback for genuinely absent native art.", proof: "Raw-to-map completeness", proofCopy: "Diff generator output against the raw class and seed a deleted-key selftest." };
    } else if (!state.correct) {
      outcome = { title: "Wrong art with a perfect data path", copy: "Every lookup succeeds, but the selected cell represents the wrong model, state, variant, or layer. This is the defect class most likely to be made worse by blind swapping.", symbol: "×", cls: "wrong", layer: "Generator classification or client resolver", action: "Use spritepick with banked references, identify whether the rule or one exception is wrong, then update the authority that owns it.", proof: "Human adjudication + regression pin", proofCopy: "Record the chosen sheet/cell with source evidence and verify it live in both renderers." };
    } else if (!state.sheet) {
      outcome = { title: "Correct selection, unavailable pixels", copy: "The resolver names the right cell, but image fetch, geometry validation, or atlas allocation fails. Canvas may show flat color while GL shows cell 0 or a fallback stamp.", symbol: "…", cls: "warning", layer: "Image route / atlas / retry path", action: "Verify /sprites/img routing, sheet dimensions, atlas capacity, and retry classification. Do not change the mapping key.", proof: "Network + atlas diagnostics", proofCopy: "Show the correct URL returns the expected bytes and the resolved cell fits the decoded sheet grid." };
    } else if (!state.shared) {
      outcome = { title: "Renderer-specific mismatch", copy: "The same identity and maps produce different pixels because Canvas2D and WebGL have hand-synced policy, geometry, alpha, or painter-order code.", symbol: "⇄", cls: "wrong", layer: "The diverged renderer only", action: "Port the known-correct decision or compositing rule and add a parity fixture. Do not distort shared JSON to compensate.", proof: "Same-input renderer parity", proofCopy: "Replay one decoded fixture through both paths and compare selected source cells plus final pixels." };
    } else {
      outcome = { title: "Native-intended sprite path", copy: "Exact identity reaches a complete map, the cell is independently verified, pixels load, both renderers agree, and the viewer is running current code.", symbol: "✓", cls: "correct", layer: "No repair needed", action: "If the visual still differs, inspect a missing dimension such as state, adjacency, material palette, layer order, or the oracle itself.", proof: "Keep the regression evidence", proofCopy: "Retain the pin/fixture so future regeneration and renderer changes cannot silently drift." };
    }
    const tile = $("#outcome-tile");
    tile.className = "outcome-tile is-" + outcome.cls;
    tile.querySelector("span").textContent = outcome.symbol;
    $("#outcome-title").textContent = outcome.title;
    $("#outcome-explanation").textContent = outcome.copy;
    $("#repair-layer").textContent = outcome.layer;
    $("#repair-action").textContent = outcome.action;
    $("#proof-title").textContent = outcome.proof;
    $("#proof-action").textContent = outcome.proofCopy;
  }

  function setupRepairRouter() {
    const select = $("#repair-kind");
    REPAIR_ROUTES.forEach((route) => {
      const option = document.createElement("option");
      option.value = route.id;
      option.textContent = route.title;
      select.appendChild(option);
    });
    select.addEventListener("change", renderRepairRouter);
    renderRepairRouter();
  }

  function renderRepairRouter() {
    const route = REPAIR_ROUTES.find((item) => item.id === $("#repair-kind").value) || REPAIR_ROUTES[0];
    $("#router-title").textContent = route.title;
    $("#router-summary").textContent = route.summary;
    $("#router-identity").textContent = route.identity;
    $("#router-map").textContent = route.map;
    $("#router-client").textContent = route.client;
    $("#router-check").textContent = route.check;
    $("#router-rule-title").textContent = route.ruleTitle;
    $("#router-rule-copy").textContent = route.ruleCopy;
  }

  async function checkConnection() {
    const dot = $("#connection-dot");
    if (window.location.protocol === "file:") {
      dot.classList.add("is-offline");
      $("#connection-title").textContent = "Direct-file mode: lessons are ready";
      $("#connection-detail").textContent = "For searchable catalogs and real sprite-sheet images, close this tab and double-click tools\\OPEN-TEXTURE-LAB.cmd.";
      return;
    }
    try {
      const rawCatalog = CATALOGS.find((catalog) => catalog.id === "raw-tokens");
      const data = await fetchCatalog(rawCatalog);
      liveSpriteMap = data;
      const count = Object.keys(data || {}).length;
      dot.classList.add("is-live");
      $("#connection-title").textContent = "Live DF graphics catalog connected";
      $("#connection-detail").textContent = count.toLocaleString() + " environment/plant tokens available from this DF install; static project maps are browsable too.";
      if (currentEntryIndex >= 0 && filteredRows[currentEntryIndex]) selectEntry(currentEntryIndex);
    } catch (_) {
      dot.classList.add("is-offline");
      $("#connection-title").textContent = "Static map mode";
      $("#connection-detail").textContent = "Project JSON catalogs are browsable. Serve this page through dwf to inspect /sprites/map.json and crop installed DF sheets.";
    }
  }

  setupTabs();
  renderPipeline();
  setupGuided();
  setupTrace();
  setupAtlas();
  setupFailureLab();
  setupRepairRouter();
  checkConnection();
})();
