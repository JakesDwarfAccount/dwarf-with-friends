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

// dwf-gl.js -- WB-9 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "GL core:
// instanced pipeline + scene-build + dense terrain"). The architectural keystone of Phase B:
// a WebGL2 instanced-quad renderer over the world cache, one drawArraysInstanced per frame,
// instance order = painter's order (no depth buffer), premultiplied-alpha blending, camera as
// two uniforms, a RenderParams UBO (§1.3), world-anchored instances with a chunk-padded build
// rectangle (R1), per-chunk terrain plus building/overlay CPU segments patched from cache dirt
// (R2/H1), and the context-loss/fallback state
// (§1.1). It consumes WB-8's atlas (dwf-gl-atlas.js) and WB-6's adjacency
// (dwf-adjacency.js) as-is, and reproduces the canvas2d terrain compositing
// (dwf-tiles.js drawTileComposite -- the pixel reference) as a stack of instances per
// tile: base-color fill, terrain sprite, liquids-over-bed, hidden-rock, grass recolor, wall
// joins and shadow decals, PLUS (WB-11) the sparse layers: spatter, item-spatter litter, items,
// plants, and tree geometry. Buildings, units and overlays are LATER items (WB-12..14) that
// emit more instances on top of this core. (WB-11's floor-edge "grass-creep" decal was DELETED
// by B71-r3 -- oracle-refuted false content; see the B71-r3 note above isOpenTileShapeMat.)
//
// SCOPE (WB-9): the dense terrain base pass, behind the ?renderer=gl seam flag; default stays
// canvas2d until WB-14. The seam (dwf-render.js) owns DOM wiring (the GL canvas, the rAF
// loop, the data source, context-loss -> canvas2d fallback); THIS file owns the GL pipeline
// and the pure cache->instance scene-build. The split keeps the scene-build testable with no
// DOM/GL at all (node harness: tools/harness/gl_core_test.mjs injects a mock atlas).
//
// WB-11 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "Sparse layers: spatter, items,
// plants, tree geometry, floor-edge decals"): every sparse-layer sprite is, same as the dense
// pass, exactly ONE 32x32 cell blitted at the tile's own grid position -- there is no sub-tile
// geometry to synthesize, so porting dwf-tiles.js's drawSpatter/drawItemSpatterLitter/
// drawItem/drawPlant/drawTree is mechanical once the resolution logic (family/shape/variant
// pick) is duplicated here (same no-cross-file-coupling convention as MAT_COLOR/hashXY/
// wallPrefix above -- this file keeps its own copy rather than reaching into
// dwf-tiles.js's private closures, which also means it needs its OWN item/plant/tree/
// spatter maps via setMaps -- see dwf-render.js's loadMaps()). Material TINT
// (dwf-tiles.js's drawItemTint, a `globalCompositeOperation="multiply"` fillRect on top
// of the item sprite) becomes the INSTANCE'S OWN tint instead of an extra instance: the shader
// already computes `sampledTexel * tint` for every sprite instance (FRAG_SRC), which is
// bit-for-bit the same operation as a canvas "multiply" blend over an OPAQUE destination
// (Porter-Duff multiply-with-alpha reduces to `Cb*((1-a)+a*Cs)` when the backdrop alpha is 1,
// i.e. exactly `texel*tint` when `tint = (1-a)+a*Cs`) -- see ITEM_TINT_RGB_BY_FAMILY below for
// the pre-composited factors. `resolveItemEntryGL` intentionally OMITS the (type,subtype) ->
// ITEMDEF_DICT -> bytoken step WC-3 added to the canvas2d path: that table (`itemDefTokens`)
// lives in dwf-tiles.js's private closure, and the spec explicitly scopes "subtype
// richness" to W-C for this item ("Items (coverage #2 render side): item instances via
// existing item_map.json; ... Subtype richness = W-C") -- this file does the matvariant/
// bytype/_missing chain only, a documented, in-scope simplification.
//
// RECONCILE-WC14 (tree geometry, sub-item #3): at the time this landed, WC-14 (full ttname ->
// species/family/variant tree-part derivation, docs/superpowers/specs/
// 2026-07-07-WC-coverage-spec.md chunk E) had NOT been committed to dwf-tiles.js (it was
// present only as an uncommitted working-tree draft, per this item's own coordination note --
// "if it hasn't landed when you get there, port trees against the spec + tree_map v2 directly").
// tree_map.json ITSELF is already v2 (species -> family -> variantKey, landed by WC-13), so the
// derivation below (`parseTreeTtname`/`resolveTreeCellGL`) reads the real committed table; the
// ttname-parsing grammar was cross-checked against the same uncommitted WC-14 draft as the best
// available reference at the time. RESOLVED: WC-14 landed in dwf-tiles.js, and
// tools/harness/wc14_tree_test.mjs now loads BOTH this file and dwf-tiles.js and asserts the
// two independently derived ttname parsers against the same fixtures -- the side-by-side
// reconciliation this banner used to ask for is pinned by that suite.
//
// WB-12 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "Buildings"): report-W8, ported
// from dwf-tiles.js's (8) BUILDINGS pass (buildingEntry Type:Subtype/bare-Type resolution,
// MISSING_BUILDING fallback (WC-4), Stockpile/Civzone exclusion, multi-tile `cells[][]`
// per-subcell blit, component-material palette substitution (legacy RGB-multiply fallback),
// wire:6 z-fade). Same no-cross-file-coupling
// convention as WB-11 above: this file keeps its own copy of WORKSHOP_SUBTYPE/FURNACE_SUBTYPE/
// MISSING_BUILDING/isOverlayOnlyBuildingType and its OWN buildingMap via setMaps (fetched by
// dwf-render.js's loadMaps from the SAME web/building_map.json the canvas2d path loads).
// A B273 palette-resolved building emits a pre-substituted atlas cell with neutral instance tint;
// only an old server or unknown modded palette token uses buildingTintRgb. That fallback is
// deliberately INEXACT: it multiplies every texel inside the sprite alpha mask, including fixed
// non-palette paint. It never colors outside the sprite, but it is graceful degradation rather
// than palette parity. The z-fade still folds
// into the emitted instance's OWN alpha (one instance per sub-cell replaces canvas2d's two draws).
// Furniture/bridge/well direction+state resolution and building.stage-driven cell selection are
// explicitly OUT of scope (spec: "Furniture/bridge map keys + direction/state wire fields =
// W-C"; verified building_map.json has no stage-keyed data at the flat-key level buildingEntry
// resolves against today, so this mirrors the canvas2d reference's actual behaviour rather than
// inventing an unbacked lookup) -- see emitBuilding's own banner comment for the full note.
//
// WB-13 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "Units + 60 fps interpolation"):
// report-W9, with the encoding question dissolved by spec §1.2's f32 x/y from day one (no u16
// re-encode step needed). Two independent pieces, both added here: (1) tier resolution, mirroring
// dwf-tiles.js's WE-4 resolveUnitTier() chain (per-unit appearance-hash composite -> flat
// race sheet cell -> layered/baked civ portrait -> fallback dot) but resolved through WB-8's
// atlas.registerDynamicSheet/resolve instead of an <img> onload -- both the composite (W-E baker,
// content-addressed /unit-sprite/<hash>.png) and the two baked civ portraits (dwarf.png/
// dwarf_female.png, verified 32x32 single-cell images) are dynamic sheets from the atlas's point
// of view, exactly the allocation path WB-8 built for this. LARGE_IMAGE coverage (spec §2.6) is a
// genuine improvement over canvas2d here: instead of one stretched drawImage, this emits ONE
// INSTANCE PER 32x32 CELL of the sw x sh composite, so a multi-tile creature renders its own real
// w x h cells. (2) 60fps interpolation: a pure, DOM-free lerp (createUnitInterpolator) between the
// last two ~30Hz unit-stream snapshots, on the SAME model as the smooth-cursor overlay
// (dwf-tiles.js's CURSOR_LERP_MS/ingestSmoothCursors) -- ticked every rAF frame from
// dwf-render.js's frame loop via tickUnits(), which re-emits ONLY the units instance tail
// past the scene-builder's `staticCount` checkpoint (buildScene's terrain/building bytes are
// never touched by a unit tick) and stages a small, independent bufferSubData for it -- never a
// full scene rebuild, never bumps sceneBuildCount. `?nolerp=1` (spec Rollback note) is a pure
// view-side kill-switch back to snap-to-latest. See createUnitInterpolator's own banner for why
// this ingests off a client-observed timestamp rather than threading an exact wire arrival time
// through dwf-ws.js (the spec's suggested touchpoint) -- a documented, deliberate scope
// trim that keeps this entire item inside dwf-gl.js/dwf-render.js with zero risk to
// W-A's ack/queue-policy code.
//
// DUAL-MODE FILE (same convention as dwf-adjacency.js / dwf-gl-atlas.js): a plain
// <script> in the browser (`window.DwfGL`), or loaded via vm.runInThisContext in a node
// unit test. The GL-specific entry points (`create(gl, opts)`) only touch WebGL when actually
// called in a browser; the scene-build core (`buildScene`) is pure and runs anywhere.
//
// Licensing (spec §1.5): no DF pixels here -- sprite sheets are fetched from the user's own
// install through WB-8's atlas at runtime and live only in GPU memory. This file is packing
// and compositing LOGIC plus committable colour/token constants mirrored from the canvas2d
// reference.
(function (root) {
  "use strict";

  // ---- atlas geometry mirror (must match dwf-gl-atlas.js exactly) -------------------
  var CELLS_PER_ROW = 60;
  var CELLS_PER_PAGE = 3600;
  var CELL_PITCH = 34;
  var CELL_SIZE = 32;
  var GUTTER = 1;
  var PAGE_SIZE = 2048;
  var SOLID_CELL = 0xFFFF;     // sentinel atlasCell: shader emits the tint as a flat colour
  var PENDING = 0;             // reserved transparent cell (== atlas PENDING)

  // instance record: 16 B interleaved (spec §1.2)
  //   f32 x,y (0)  | u16 atlasCell (8) | u16 attr (10) | u8 rgba (12..15)
  var INSTANCE_BYTES = 16;
  // attr bit layout: animFrames:4 | animRate:3 | ADDITIVE:1 | MARKER:1 | rsv:7
  var ATTR_ADDITIVE = 1 << 7;
  var ATTR_MARKER = 1 << 8;
  // WB-10: see-down descent depth, packed into 4 of the attr field's 7 reserved bits (9-12;
  // bits 13-15 stay genuinely reserved). 0 = camera plane / not descended; 1..10 = the number
  // of z-levels the scene-build walked down to find this instance's tile. Feeds the
  // RenderParams `seeDownTint` hook (§1.3 extension below) -- never touched by WB-15's
  // animFrames/animRate.
  var ATTR_SEEDOWN_SHIFT = 9;
  var ATTR_SEEDOWN_MASK = 0xF;
  var MAX_SEEDOWN_DEPTH = 10; // spec: "descend (max 10 z)"

  // WB-15 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "GL animation clock"):
  // animFrames occupies bits 0-3, animRate bits 4-6 (the spec's own attr layout comment above),
  // encoded so the shader can do `cell += frameIndex` with ZERO extra scene-build work -- the
  // instance's `cell` field always stays the ANIMATION'S FRAME-0 atlas index (WB-8's
  // resolveAnimated guarantees frame i == base+i, consecutive, for the life of the session), and
  // the vertex shader picks which of the run's frames to sample this DRAW using u_timeMs, never
  // touched by buildScene(). animFrames stores (frameCount-1): 0 means "1 frame" (i.e. not
  // animated -- the mod-frameCount math in the shader is then a no-op, so ordinary static
  // sprites need no branch to skip), and the 4-bit field's max value 15 represents 16 frames,
  // exactly covering the largest authored series in the vanilla raws (RIVER_BED_*/BROOK_BED_*,
  // 16 frames each, graphics_fluids.txt). animRate is an index into ANIM_RATE_HZ (3 bits = 8
  // slots; the spec's own enum only names 4 distinct rates, {2,4,8,15} Hz, so codes 4-7 alias
  // codes 0-3 -- headroom, not a separately assigned meaning today).
  var ATTR_ANIMFRAMES_MASK = 0xF;      // bits 0-3, pre-shift (shift 0)
  var ATTR_ANIMRATE_SHIFT = 4;
  var ATTR_ANIMRATE_MASK = 0x7;        // bits 4-6, pre-shift
  var ANIM_RATE_HZ = [2, 4, 8, 15, 2, 4, 8, 15];

  // Pack a frame count (1-16) + a rate-table index (0-7) into the attr bits above. frameCount<=1
  // correctly encodes to 0 (no animation -- see the banner above).
  function encodeAnimAttr(frameCount, rateCode) {
    var fc = Math.max(1, Math.min(16, frameCount | 0));
    if (fc <= 1) return 0; // no animation -- rate bits are meaningless, don't set them either
    var rc = Math.max(0, Math.min(7, rateCode | 0));
    return (((fc - 1) & ATTR_ANIMFRAMES_MASK)) | ((rc & ATTR_ANIMRATE_MASK) << ATTR_ANIMRATE_SHIFT);
  }

  // Per-token default animation rate (documented default, NOT an authored DF constant -- the
  // raws give us a frame COUNT, never a per-frame DURATION, which is an internal engine tick
  // this client has no access to). Fire/campfire tokens read faster than the brook/river bed
  // flow, matching the qualitative "fire flickers, water shimmers" distinction the spec's own
  // wording draws; both land inside the {2,4,8,15} Hz enum the spec requires. Tunable later
  // (RenderParams or a richer per-token table) without touching the wire or the atlas.
  function defaultAnimRateCodeForToken(token) {
    if (token && token.indexOf("CAMPFIRE") === 0) return 3; // 15 Hz
    return 1; // 4 Hz -- brook/river bed flow, magma glow, everything else with >1 frame
  }

  // Pure JS mirror of VERT_SRC's per-instance frame-select math (report §W11 / gl-atlas.js's
  // RECONCILE banner: `cell += (time/rate + hash) % animFrames`) -- test/documentation parity
  // only. The GLSL shader is the sole runtime authority (this is never called from the render
  // path); it exists so tools/harness/wb15_anim_test.mjs can assert the frame-selection formula
  // (cycling, wrap, per-tile phase, freeze/kill-switch) without a browser or GPU. `gx`/`gy` must
  // be the same non-negative integer grid coords the shader receives via i_grid -- exactly what
  // every animated emit in this file uses (terrain-layer sprites only; units/buildings never set
  // animFrames today).
  function hashGridPhase(gx, gy) {
    var gxu = gx >>> 0, gyu = gy >>> 0;
    var h = (Math.imul(gxu, 374761393) + Math.imul(gyu, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % 1009) / 1009;
  }
  function animFrameIndexForTest(timeMs, attr, gx, gy, globalEnabled) {
    var frameCount = (attr & ATTR_ANIMFRAMES_MASK) + 1;
    if (frameCount <= 1 || globalEnabled === false) return 0;
    var rateCode = (attr >> ATTR_ANIMRATE_SHIFT) & ATTR_ANIMRATE_MASK;
    var hz = ANIM_RATE_HZ[rateCode];
    var phase = hashGridPhase(gx, gy);
    var adv = (timeMs / 1000) * hz + phase * frameCount;
    var idx = Math.floor(adv) % frameCount;
    if (idx < 0) idx += frameCount;
    return idx;
  }

  // ---- colour tables (mirrored verbatim from dwf-tiles.js -- the pixel reference) ---
  var MAT_COLOR = {
    STONE: [130, 122, 110], SOIL: [120, 82, 48], MINERAL: [150, 130, 90],
    LAVA_STONE: [70, 60, 60], FROZEN_LIQUID: [170, 200, 230], CONSTRUCTION: [110, 110, 120],
    GRASS_LIGHT: [86, 140, 62], GRASS_DARK: [58, 104, 48], GRASS_DRY: [150, 150, 70],
    GRASS_DEAD: [110, 100, 70], PLANT: [70, 130, 70], TREE: [86, 66, 40], ROOT: [96, 74, 48],
    MUSHROOM: [150, 120, 130], DRIFTWOOD: [120, 100, 70], POOL: [60, 90, 150],
    BROOK: [70, 110, 170], RIVER: [55, 95, 165], ASHES: [90, 90, 90], MAGMA: [200, 70, 20],
    AIR: [24, 24, 28], NONE: [18, 18, 20],
  };
  var FALLBACK_MAT = [100, 100, 100];
  var BG = [14, 14, 16];
  var WALL_DARKEN = 0.45;
  var HIDDEN_COLOR = [6, 6, 8];
  // WB-4 calibrated summer grass recolour (see dwf-tiles.js TINT_COLORS derivation):
  // a source-over blend of (93,119,52) at alpha 0.25 over the sheet base -> measured (78,104,52).
  var TINT_COLORS = { grassSummer: [93, 119, 52, 0.25] };
  // Indoor/underground ambient wash: DELETED (fogparams.json `indoor.mode: "identity"`,
  // `washRgba` all-zero) -- 158 subterranean floor samples measured a rendered/sprite ratio
  // of ~1.0 and an A/B on an all-dug scene showed removing the rgba(8,10,34,0.17) wash
  // improved MAE 16.71->13.78 (docs/superpowers/specs/2026-07-06-fog-lighting-report.md).
  // DF applies no indoor darkening; the old INDOOR_WASH constant/emit below used to add one.

  function matRgb(mat) { return MAT_COLOR[mat] || FALLBACK_MAT; }
  function darken(rgb, f) { return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)]; }
  // B62 (canvas2d parity -- see dwf-tiles.js isTreeWallMat's banner): a ground-surface
  // tree trunk / mushroom cap is tiletype_material TREE/MUSHROOM + shape WALL, so it must be
  // EXEMPT from the stone wall-edge (wallJoinCell) and wall-darken (tileColor) passes -- emitTree
  // draws its own round trunk/cap cell, which the STONE_WALL rubble edge would otherwise overpaint
  // into a grey square (the B62 evidence pair).
  function isTreeWallMat(mat) { return mat === "TREE" || mat === "MUSHROOM"; }
  // B62-r2 (canvas2d parity -- see dwf-tiles.js derivedTreePart's banner): tree tiles
  // whose PLANT tail is missing (see-down substitution drops sparse tails; some live trunks'
  // wire plant lookup misses) previously drew NOTHING -- a bare brown box. Derive the part
  // from shape/mat exactly like the wire does; species falls to tree_map._default.
  function derivedTreePart(t) {
    var shape = t.shape || "", mat = t.mat || "";
    if (shape === "TWIG") return "LEAVES";
    if (shape === "BRANCH") return "BRANCH";
    if (shape === "TRUNK_BRANCH") return "TRUNK";
    if (mat === "TREE") return (shape === "WALL") ? "TRUNK" : "CANOPY";
    if (mat === "MUSHROOM") return "TRUNK";
    return null;
  }
  // B62-r2 grass-backing offsets (canvas2d parity -- see grassBackingCell's banner there):
  // Chebyshev ring 1 only, cardinal-closest first. B71/B107 ("green band spreading around
  // grass cells" / a playtester "mis-shaded grass square around tree trunks"): the old rings 1..3
  // reach let a trunk standing on NON-grass ground borrow grass from up to 3 tiles away, so a
  // treeline on dirt near a meadow painted a full grass square/band where native draws the
  // trunk's actual (dirt/mud) ground -- the reported band that "spreads around" the grass.
  // A trunk truly embedded in a grass field has grass at ring 1 (the B62-accepted "trunk shows
  // grass, not a brown box" case); a trunk 2-3 tiles out on dirt no longer invents grass.
  var GRASS_BACK_OFFSETS = (function () {
    var out = [];
    for (var r = 1; r <= 1; r++) {
      var ring = [];
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
        }
      }
      ring.sort(function (a, b) { return (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])); });
      out.push.apply(out, ring);
    }
    return out;
  })();
  // B71/B107 (canvas2d parity): backing sources are LIVE GRASS_LIGHT/GRASS_DARK ONLY -- the
  // B62-r2 original intent ("never dry/dead, never invented biome grass"). B107 (GROUNDART)
  // broadened this to dry/dead grass and any outside SoilFloor/*Pebbles with a trace grass
  // amount, which made nearly EVERY above-ground trunk paint a bright-summer-grass square even
  // over dirt/dry ground where native shows tan/brown -- the "green where native shows none"
  // band the owner + a playtester reported (re-review FAILed the broadening). Reverting also re-greens
  // the b62_trunk_walljoin_test gate that B107 silently broke. Grass-under compositing on the
  // FLOOR tiles themselves is a separate, server-tail-driven path (see tiles.js resolveSprite)
  // and is unaffected -- this predicate only governs what a solid tree tile borrows.
  function isGrassBackingSource(n) {
    if (!n || n.hidden) return false;
    return n.mat === "GRASS_LIGHT" || n.mat === "GRASS_DARK";
  }
  function waterRgb(depth) {
    var d = Math.max(1, Math.min(7, depth));
    var b = 90 + d * 18;
    return [30, 60 + d * 6, Math.min(255, b + 60)];
  }
  function magmaRgb(depth) {
    var d = Math.max(1, Math.min(7, depth));
    return [Math.min(255, 150 + d * 14), Math.max(30, 90 - d * 8), 10];
  }

  // Stable per-tile hash (dwf-tiles.js hashXY, verbatim) for grass/hidden variant pick.
  function hashXY(x, y) { return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0; }

  // ===========================================================================================
  // WB-14 (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md, "Overlays, final 2D split,
  // and the default-flip decision"): the OVERLAY LAYER's non-text pieces -- designation glyphs/
  // category washes/marker-mode alpha, and presence drag-rects/tile-outlines -- as instances.
  // TEXT (name pills, HUD, F3, "connecting...") is explicitly OUT of scope: it stays on
  // dwf-tiles.js's permanent 2D overlay canvas (the smooth-cursor overlay already IS that
  // canvas for the name pill -- see drawOneCursor/drawSmoothCursors there), unaffected by this
  // file, per the spec's "TEXT stays 2D forever" split. Both tables below are mirrored verbatim
  // from dwf-tiles.js (DESIG_CELL/DESIG_TRACK_CELL/DESIG_TINT/resolveDesig, playerColor) --
  // same no-cross-file-coupling convention as every other mirrored table in this file.
  // ===========================================================================================
  var DESIG_SHEET = "designations.png";
  var DESIG_CELL = {
    dig: [0, 1], channel: [0, 2], stairUp: [0, 3], stairDown: [0, 4],
    stairUpDown: [0, 5], ramp: [0, 6], removeConstruction: [0, 7], chop: [0, 8],
    gather: [0, 9], smooth: [0, 10], engrave: [0, 11], fortify: [0, 12],
    trafficLow: [0, 13], trafficHigh: [0, 14], trafficRes: [0, 15],
  };
  // B269 MINING INDICATORS. DF's own sheet, already in web/interface_map.json and already served
  // by /sprites/img (vanilla_interface/graphics/images/mining_indicators.png, 64x32 = 2 cells):
  //   (0,0) DAMP_STONE_WARNING -- the blue water drop, painted where a dig cancels on damp stone
  //   (1,0) WARM_STONE_WARNING -- orange heat waves, the magma analogue of the same mechanism
  // (vanilla_interface/graphics/graphics_interface.txt:3300-3301, tile_page_interface.txt:200.)
  // Each cell carries its own dashed tile border baked in (cyan for damp, red for warm) -- that is
  // why DF's damp tiles in the native oracle have a cyan outline and no designation wash: the icon
  // IS the whole overlay. Mirrored verbatim in dwf-tiles.js (same no-cross-file-coupling
  // convention as DESIG_CELL above); pinned equal by b269_mining_indicators_test.mjs.
  var MINING_SHEET = "mining_indicators.png";
  var MINING_CELL = { damp: [0, 0], warm: [1, 0] };
  // Mining designation mode ("m") -- DF shows these indicators only while the mining tool is up,
  // which is what keeps a fort beside a river from being permanently speckled with drops.
  // dwf-controls-placement.js pushes the flag in on every dig-tool selection change.
  var mineMode = false;
  function setMineMode(on) { mineMode = !!on; }
  // The whole decision, one place, so the two renderers cannot drift. Server-evaluated `damp`/
  // `warm` (src/wire_v1.cpp B269) + the two gates DF itself applies: only mineable terrain (a WALL
  // -- you cannot dig a floor, so DF never warns about one) and only REVEALED terrain (undiscovered
  // rock must not advertise the water behind it). Damp wins a both-flags tile: native paints ONE
  // 32x32 cell per tile, and water is the failure that floods the fort.
  function miningIndicatorCell(t, on) {
    if (!on || !t || t.hidden) return null;
    if ((t.shape || "") !== "WALL") return null;
    if (t.damp) return MINING_CELL.damp;
    if (t.warm) return MINING_CELL.warm;
    return null;
  }

  // carve-track adjacency mask (N=1 S=2 E=4 W=8) -> designations.png col-1 cell.
  var DESIG_TRACK_CELL = {
    1: [1, 0], 2: [1, 1], 8: [1, 2], 4: [1, 3], 3: [1, 4], 9: [1, 5], 5: [1, 6],
    10: [1, 7], 6: [1, 8], 12: [1, 9], 11: [1, 10], 7: [1, 11], 13: [1, 12],
    14: [1, 13], 15: [1, 14],
  };
  // Category tint (rgb 0-255 -- canvas2d's rgba(...) string prefixes re-expressed as triples;
  // alpha is baked into the instance separately, see emitDesignationOverlay below).
  var DESIG_TINT_RGB = {
    dig: [240, 150, 40], channel: [200, 105, 20], ramp: [240, 175, 60], stair: [240, 195, 75],
    chop: [215, 150, 45], gather: [120, 200, 90], smooth: [90, 150, 235], engrave: [80, 215, 225],
    traffic: [225, 205, 80], track: [185, 140, 90], fortify: [90, 150, 235],
    removeConstruction: [220, 110, 55],
  };
  var CHOP_PLANT_PART = { TRUNK: 1, BRANCH: 1, CANOPY: 1, LEAVES: 1, SAPLING: 1 };
  // Same wash alpha constants as dwf-tiles.js's drawDesignation (0.28 active / 0.13
  // marker) -- baked directly into the wash instance's own tint alpha at emit time, since the
  // active/marker ratio (0.28->0.13) differs from the glyph's own ratio below and JS already
  // knows the exact value per-instance. The GLYPH's marker alpha instead goes through the
  // shader's MARKER attr bit (FRAG_SRC's `base *= 0.6`) -- that bit was defined since WB-9/
  // §1.2 ("MARKER selects marker-mode alpha") but never consumed until this item; using it here
  // for the glyph (rather than also baking its alpha at emit time) exercises the mechanism the
  // spec actually named, and mirrors canvas2d's own TWO different alpha mechanisms exactly
  // (drawDesignation: fillStyle's literal alpha for the wash vs ctx.globalAlpha=0.6 for the
  // glyph blit -- two different constants, two different code paths, matched 1:1 here).
  var DESIG_WASH_ALPHA = 0.28, DESIG_WASH_ALPHA_MARKER = 0.5;

  // MARKER-COLOR (2026-07-13 live native probe, tools/orchestrator/attachments/MARKER-COLOR-{1,2}.png):
  // native marker(blueprint) mode recolours the ENTIRE designation cell toward blue -- NOT the
  // invented "fainter 0.13 wash + 0.6 glyph + dashed outline" we had. Fitting corresponding
  // normal-vs-marker pixel pairs (identical wall, adjacent tiles, 48px pitch, dy=0) established:
  //   * BLUE is preserved BYTE-EXACTLY: Bmarker - Bnormal == 0 for ALL 2304 sampled pairs.
  //   * per-channel multiply (R x0.43, G x0.68, B x1.00) fits the flat WASH region (rmse 8.2);
  //     validated anchor: native flat wash (76,73,78) -> (32,50,78) reproduced to +-1.
  //   * a global/3D-LUT transform CANNOT fit the whole cell (Rmarker 3D-LUT floor rmse 12.7):
  //     native recolours per SOURCE ELEMENT before compositing (bright silver pick head -> bright
  //     blue, orange handle -> dark teal), which no single post-composite op reproduces.
  // Because our category wash is SATURATED ORANGE (unlike native's near-neutral base), a literal
  // multiply of it yields olive, not blue -- so marker mode uses a FIXED blue palette (category-
  // independent, matching DF where marker is a MODE indicator, not a per-category colour): the
  // wash fills native's measured marker-wash colour, and the near-neutral glyph (designations.png
  // pick is ~mid-grey rgb 93,92,98) is recoloured by the fitted multiply tint == 255*MARKER_RECOLOR.
  var MARKER_RECOLOR = [0.43, 0.68, 1.0];   // fitted native per-channel multiply (blue exact)
  var MARKER_GLYPH_TINT = [110, 173, 255];  // round(255*MARKER_RECOLOR): glyph texel*tint multiply
  var MARKER_WASH_RGB = [32, 50, 78];       // native measured marker-wash colour (flat cell)

  // WC-19: designation-priority numerals + item-designation marks. Sheet cell layout is the
  // fixed vanilla one encoded in web/overlay_map.json (designation_priority.png: col 0, rows
  // 0-6 for priorities 1-7; designation_item.png: col 0, rows below) -- kept as literals here
  // for the same no-cross-file-coupling reason DESIG_CELL/DESIG_TRACK_CELL are (GL resolves
  // sheets through the atlas by name+col+row, needs no map document). The GL pipeline emits
  // full-tile quads (no sub-tile scaling), so unlike canvas2d's corner badge these render
  // full-tile over the designated tile / item -- functionally identical (same glyph on the
  // same tiles from the same wire), a documented placement residual, no parity-gate impact
  // (priority/mark glyphs only appear on actively designated/marked tiles, none in SCN-A).
  var DESIG_PRIORITY_SHEET = "designation_priority.png";
  var DESIG_ITEM_SHEET = "designation_item.png";
  var DESIG_ITEM_ROW = {
    DESIGNATION_ITEM_MELT: 0, DESIGNATION_ITEM_DUMP: 1, DESIGNATION_ITEM_FORBIDDEN: 2,
    DESIGNATION_ITEM_HIDDEN: 3, DESIGNATION_ITEM_FORBIDDEN_MELT: 4, DESIGNATION_ITEM_FORBIDDEN_DUMP: 5,
  };
  // Verbatim port of dwf-tiles.js's itemMarkToken (iflags bits web=0x01/forbid=0x02/
  // dump=0x04/melt=0x08/on_fire=0x10 -> DESIGNATION_ITEM_* token, or null).
  function itemMarkToken(iflags) {
    if (!iflags) return null;
    var forbid = iflags & 0x02, dump = iflags & 0x04, melt = iflags & 0x08;
    if (forbid && melt) return "DESIGNATION_ITEM_FORBIDDEN_MELT";
    if (forbid && dump) return "DESIGNATION_ITEM_FORBIDDEN_DUMP";
    if (forbid) return "DESIGNATION_ITEM_FORBIDDEN";
    if (melt) return "DESIGNATION_ITEM_MELT";
    if (dump) return "DESIGNATION_ITEM_DUMP";
    return null;
  }

  // Resolve a tile's desig wire object to {cell:[col,row], cat} or null -- verbatim port of
  // dwf-tiles.js's resolveDesig (dig=="Default" disambiguated by the tile's own mat/shape,
  // mirroring DF's own glyph pick).
  function resolveDesig(d, t) {
    if (!d) return null;
    var dig = d.dig;
    if (dig && dig !== "No") {
      switch (dig) {
        case "Channel": return { cell: DESIG_CELL.channel, cat: "channel" };
        case "Ramp": return { cell: DESIG_CELL.ramp, cat: "ramp" };
        case "UpStair": return { cell: DESIG_CELL.stairUp, cat: "stair" };
        case "DownStair": return { cell: DESIG_CELL.stairDown, cat: "stair" };
        case "UpDownStair": return { cell: DESIG_CELL.stairUpDown, cat: "stair" };
        default:
          var mat = t.mat || "", shape = t.shape || "";
          var plantPart = (t.plant && t.plant.part) || "";
          if (mat === "CONSTRUCTION")
            return { cell: DESIG_CELL.removeConstruction, cat: "removeConstruction" };
          if (mat === "TREE" || mat === "ROOT" || CHOP_PLANT_PART[plantPart] ||
            shape.indexOf("TRUNK") !== -1 || shape === "BRANCH" || shape === "TWIG" || shape === "SAPLING")
            return { cell: DESIG_CELL.chop, cat: "chop" };
          if (shape === "SHRUB" || mat === "PLANT" || plantPart === "SHRUB")
            return { cell: DESIG_CELL.gather, cat: "gather" };
          return { cell: DESIG_CELL.dig, cat: "dig" };
      }
    }
    if (d.smooth === 2) return { cell: DESIG_CELL.engrave, cat: "engrave" };
    if (d.smooth === 1) return { cell: DESIG_CELL.smooth, cat: "smooth" };
    if (d.track) { var c = DESIG_TRACK_CELL[d.track & 15]; if (c) return { cell: c, cat: "track" }; }
    if (d.traffic === 1) return { cell: DESIG_CELL.trafficLow, cat: "traffic" };
    if (d.traffic === 2) return { cell: DESIG_CELL.trafficHigh, cat: "traffic" };
    if (d.traffic === 3) return { cell: DESIG_CELL.trafficRes, cat: "traffic" };
    return null;
  }

  // B35: resolve a designation JOB kind (djobs wire array; bits cleared on job pickup) to the
  // same {cell, cat} shape resolveDesig returns -- verbatim port of dwf-tiles.js's
  // Kinds 1-6 are smooth/engrave/fortify/track/chop/gather; B54 adds the complete
  // mining family at 7-13 (dig, three stairs, ramp, channel, remove-construction).
  function resolveDjob(k, t) {
    switch (k) {
      case 1: return { cell: DESIG_CELL.smooth, cat: "smooth" };
      case 2: return { cell: DESIG_CELL.engrave, cat: "engrave" };
      case 3: return { cell: DESIG_CELL.fortify, cat: "fortify" };
      case 5: return { cell: DESIG_CELL.chop, cat: "chop" };
      case 6: return { cell: DESIG_CELL.gather, cat: "gather" };
      case 7: return { cell: DESIG_CELL.dig, cat: "dig" };
      case 8: return { cell: DESIG_CELL.stairUp, cat: "stair" };
      case 9: return { cell: DESIG_CELL.stairDown, cat: "stair" };
      case 10: return { cell: DESIG_CELL.stairUpDown, cat: "stair" };
      case 11: return { cell: DESIG_CELL.ramp, cat: "ramp" };
      case 12: return { cell: DESIG_CELL.channel, cat: "channel" };
      case 13: return { cell: DESIG_CELL.removeConstruction, cat: "removeConstruction" };
      case 4: {
        var m = (t && t.desig && t.desig.track) ? (t.desig.track & 15) : 15;
        return { cell: DESIG_TRACK_CELL[m] || DESIG_TRACK_CELL[15], cat: "track" };
      }
    }
    return null;
  }

  // dwf-tiles.js's playerColor FNV-1a hash -> hue, re-expressed as an RGB triple (the
  // instance tint field is 0-255 RGB, not a CSS hsl() string). Only the "fill" variant is
  // needed here -- the "dark" name-label background variant stays with the text-only 2D
  // cursor overlay (drawOneCursor), never ported to GL.
  function playerColorRgb(name) {
    var h = 2166136261 >>> 0;
    var s = String(name || "");
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    // WP-A color audit: was `(h >>> 0) % 360`, which diverged from tiles.js playerColor's
    // CSS-wrapped SIGNED hue for every name whose FNV hash has the sign bit set (2^32 % 360
    // == 256, a 104deg rotation -- 'guest' tinted green here vs his purple cursor label).
    // Now the same signed-wrap normalization as playerColor: identical hue, guaranteed.
    var hue = ((h % 360) + 360) % 360;
    return hslToRgb255(hue, 0.85, 0.58);
  }
  function hslToRgb255(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1) { r1 = c; g1 = x; b1 = 0; }
    else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
    else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
    else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    var m = l - c / 2;
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }

  // Own-session player id, mirroring dwf-tiles.js's ?player=/localStorage['dwf.
  // player'] resolution chain (no cross-file coupling -- this file keeps its own copy, same
  // convention as every mirrored table above). Reads the SAME localStorage key tiles.js WRITES
  // on boot; canvas2d always initializes before/under the GL seam (dwf-render.js's
  // canvas2d impl is the base layer GL stacks over), so by the time this is read the key already
  // holds the resolved id -- letting presence skip drawing our own cursor exactly like
  // drawPresence's own `p.name === player` guard. Returns null in any non-browser/sandboxed
  // context (node tests) -- callers then simply never match/skip (nothing to skip in a test
  // fixture anyway).
  function getOwnPlayerName() {
    try {
      if (typeof location !== "undefined" && location.search) {
        var q = new URLSearchParams(location.search).get("player");
        if (q) return q;
      }
      if (typeof localStorage !== "undefined") return localStorage.getItem("dwf.player");
    } catch (_) { /* non-browser/sandboxed context */ }
    return null;
  }

  // presenceBudget(players): worst-case instance count for buildScene's ensureCapacity pre-pass
  // (same convention as WB-12's buildingBudget pre-pass just below it) -- 1 tile-outline marker
  // per OTHER player, plus each in-progress drag rect's tile area, DEFENSIVELY CAPPED at 64x64
  // (4096 tiles) so a bugged/adversarial dx,dy never blows the scene-build budget (emit()'s own
  // capacity clamp already makes an uncapped budget merely a silent-drop risk rather than a
  // crash risk, but the cap keeps scene-build COST bounded too, matching this file's "size
  // generously, clamp on emit" convention everywhere else).
  var PRESENCE_DRAG_MAX_TILES = 4096;
  function presenceBudget(players) {
    var list = players || [];
    var budget = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      budget += 1; // tile-outline marker
      if (p.drag && typeof p.dx === "number" && typeof p.dy === "number" &&
          typeof p.x === "number" && typeof p.y === "number") {
        var w = Math.abs(p.dx - p.x) + 1, h = Math.abs(p.dy - p.y) + 1;
        budget += Math.min(PRESENCE_DRAG_MAX_TILES, w * h);
      }
    }
    return budget;
  }

  // Grass sprite override: /sprites/map.json mis-binds GRASS_n to floors.png; the real cells
  // are grass.png cols 0..3 row 0 (dwf-tiles.js TOKEN_CELL_OVERRIDE).
  var TOKEN_CELL_OVERRIDE = {
    GRASS_1: { sheet: "grass.png", col: 0, row: 0 },
    GRASS_2: { sheet: "grass.png", col: 1, row: 0 },
    GRASS_3: { sheet: "grass.png", col: 2, row: 0 },
    GRASS_4: { sheet: "grass.png", col: 3, row: 0 },
  };
  var GRASS_FLOOR_FALLBACK = { Shrub: 1, ShrubDead: 1, Sapling: 1, SaplingDead: 1 };
  function looksLikeGrassFloor(ttname) {
    return GRASS_FLOOR_FALLBACK[ttname] === 1 ||
      (ttname.indexOf("Grass") !== -1 && ttname.indexOf("Floor") !== -1);
  }

  // WC-17 GL parity (2026-07-07 ledger, "the owner BUG REPORT: blocky flat-color grass (canvas2d) +
  // GL grass no-op"): dwf-tiles.js's own grassTierIndex/grassSpeciesTint, verbatim port
  // (see that file's banner for the thresholds/derivation) -- GL previously ignored the wire's
  // real per-tile `t.grass` coverage entirely, always drawing a fixed position-hash GRASS_1..4
  // variant with a flat "grassSummer" tint (the pre-WC-17 canvas2d behaviour), which is why
  // the report described it as a renderer split rather than a shared bug: canvas2d already had
  // real tiers/species tint, GL had none.
  function grassTierIndex(amount) {
    if (amount <= 33) return 0;
    if (amount <= 66) return 1;
    if (amount <= 99) return 2;
    return 3;
  }
  // Per-species tint from grass_colors.json, keyed by the wire's resolved plant TOKEN. `colors`
  // is the fetched grass_colors.json document (ctx.grassColors inside createSceneBuilder,
  // fetched by the seam the SAME way it fetches every other optional map -- see
  // dwf-render.js's loadMaps), passed explicitly (not closed over) so this stays a pure,
  // fixture-testable function like every other WB-11-tier helper module-wide here. Returns an
  // [r,g,b,alpha(0..1)] tuple in the SAME shape as a TINT_COLORS entry (so callers can treat it
  // identically), or null if unresolved -- in which case the caller falls back to the flat
  // TINT_COLORS.grassSummer wash, same convention as dwf-tiles.js's own grassSpeciesTint.
  function grassSpeciesTintRGBA(colors, id, amount) {
    if (!colors || !colors.plants || !id) return null;
    var p = colors.plants[id];
    if (!p || !p.tiers) return null;
    var tier = p.tiers[grassTierIndex(amount)];
    if (!tier || !tier.rgb) return null;
    // Same alpha-blend convention as TINT_COLORS.grassSummer (0.25 source-over wash, not a
    // hard recolour, so the underlying grass.png texture detail still shows through).
    return [tier.rgb[0], tier.rgb[1], tier.rgb[2], 0.25];
  }

  function isStairOrRamp(shape) {
    return shape === "STAIR_UP" || shape === "STAIR_DOWN" || shape === "STAIR_UPDOWN" ||
      shape === "RAMP" || shape === "RAMP_TOP";
  }

  // ---- WB-11 sparse-layer tables (mirrored verbatim from dwf-tiles.js's WC-3/WC-11/
  // WC-12/WC-14 helpers -- see the WB-11 banner comment above for the no-cross-file-coupling
  // rationale). ---------------------------------------------------------------------------

  // Stable small integer hash (dwf-tiles.js's hashInt, verbatim): position/material ->
  // a repeatable 0..N-1 pick, used for spatter/web/floor-edge variant selection.
  function hashInt(a, b) {
    var h = (a | 0) * 2654435761 ^ (b | 0) * 2246822519;
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
  }

  // ---- items (WC-3, minus the itemDefTokens/bytoken step -- see banner) ------------------
  var ITEM_MATVARIANT_BASE = {
    DOOR: "Door", BED: "Bed", TABLE: "Table", CHAIR: "Chair", CABINET: "Cabinet",
    BOX: "Box", HATCH_COVER: "HatchCover", GRATE: "Grate",
  };
  function matFamilyFor(mat_type) {
    if (mat_type === 3 || mat_type === 4 || mat_type === 5) return "GLASS";
    if (mat_type >= 419) return "WOOD";
    if (mat_type === 0) return "STONE";
    return null;
  }
  // Closed-form multiply factor for dwf-tiles.js's ITEM_TINT_BY_FAMILY constants
  // (rgba(140,100,60,0.28) WOOD / rgba(180,220,220,0.20) GLASS): factor = 255*(1-a) + a*c per
  // channel (see the WB-11 banner's Porter-Duff derivation) -- applied as the item instance's
  // OWN tint rather than a second multiply-blend instance.
  var ITEM_TINT_RGB_BY_FAMILY = { WOOD: [223, 212, 200], GLASS: [240, 248, 248] };
  // TX6/TX6-SPECIES-TINT: prefer optional per-material RGB, with coarse family fallback.
  var ITEM_SPATTER_TINT_RGB_BY_FAMILY = { LEAVES: [82, 116, 48], FRUIT: [194, 120, 38], FRUIT_SMALL: [164, 57, 42], FRUIT_LARGE: [178, 72, 44] };
  function itemSpatterTintRgb(family, rgb) {
    if (!ITEM_SPATTER_TINT_RGB_BY_FAMILY[family]) return null;
    return rgb && rgb.length === 3 ? rgb : ITEM_SPATTER_TINT_RGB_BY_FAMILY[family];
  }
  // B138: native DF draws ONE litter decal per tile; drawing every overlapping ITEM_SPATTER
  // record stacked tint passes that multiply-compounded toward brown/black. Deterministic
  // winner among DRAWABLE records (family mapped, not OTHER): highest amount, ties broken by
  // lowest growth_class then item_type -- stable regardless of wire arrival order. Fully
  // equal records keep the first seen. MUST stay logic-identical to dwf-tiles.js's copy.
  function itemSpatterWins(a, b) {
    if ((a.amount | 0) !== (b.amount | 0)) return (a.amount | 0) > (b.amount | 0);
    if ((a.growth_class | 0) !== (b.growth_class | 0)) return (a.growth_class | 0) < (b.growth_class | 0);
    return (a.item_type | 0) < (b.item_type | 0);
  }
  function pickItemSpatterLitter(arr, map) {
    if (!arr || !arr.length || !map || !map.growth_class_family || !map.families) return null;
    var best = null;
    for (var i = 0; i < arr.length && i < 4; i++) {
      var isp = arr[i];
      if (!isp || !(isp.amount > 0)) continue;
      var fam = map.growth_class_family[String(isp.growth_class)];
      if (!fam || fam === "OTHER") continue;
      var famDef = map.families[fam];
      if (!famDef) continue;
      if (best && !itemSpatterWins(isp, best.isp)) continue;
      best = { isp: isp, fam: fam, famDef: famDef };
    }
    return best;
  }

  // ---- spatter (WC-11/WC-12) ---------------------------------------------------------------
  var SPATTER_BUILTIN_FAMILY = { 9: "DUST", 12: "MUD", 13: "VOMIT" };
  // B97: material-spatter amounts are DF's 0..255 byte field. The proprietary native
  // graphics cutoff is not derivable from DFHack sources, so 25 is the first existing
  // 25-wide size-class boundary; calibrate it against paired native captures.
  var SPATTER_VISIBLE_AMOUNT = 25;
  function spatterVisible(amount, threshold) {
    var min = threshold === undefined ? SPATTER_VISIBLE_AMOUNT : threshold;
    return Number.isFinite(amount) && amount >= min;
  }
  function firstVisibleSpatter(arr) {
    if (!arr) return null;
    for (var i = 0; i < arr.length && i < 4; i++) {
      if (arr[i] && spatterVisible(arr[i].amount)) return arr[i];
    }
    return null;
  }
  // Blood-family color extension (WC-22 gap) -- mirror of dwf-tiles.js's
  // bloodFamilyFromRgb (max-channel hue -> nearest BLOOD_* family). Kept byte-identical in
  // logic so the GL/canvas2d split can't diverge (the bug class the ledger paid for once).
  function bloodFamilyFromRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    var r = rgb[0], g = rgb[1], b = rgb[2];
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 36) return "BLOOD_GOO";
    if (r > g + 30 && b > g + 30) return "BLOOD_MAGENTA";
    if (b >= r && b >= g) return "BLOOD_CYAN";
    if (r >= g && r >= b) {
      if (g >= r * 0.6 && b < g) return "BLOOD_ICHOR";
      return "BLOOD_RED";
    }
    return "BLOOD_ICHOR";
  }
  function spatterFamilyForCtx(spatterMap, sp) {
    if (!spatterMap || !sp) return null;
    var mt = sp.mat_type;
    if (mt === 6) return (sp.state === 3) ? "SNOW" : "WATER_SPATTER";
    var hint = SPATTER_BUILTIN_FAMILY[mt];
    if (hint) return hint;
    if (mt >= 19 && mt < 419) {
      var byRgb = bloodFamilyFromRgb(sp.rgb);
      if (byRgb) return byRgb;
      var blood = spatterMap.blood_families;
      if (Array.isArray(blood) && blood.length) return blood[hashInt(mt, sp.mat_index) % blood.length];
    }
    return "MUD";
  }
  function spatterShapeForCtx(spatterMap, amount) {
    var thr = (spatterMap && spatterMap.amount_thresholds_default) || [];
    for (var i = 0; i < thr.length; i++) {
      var th = thr[i];
      if (th.max === null || amount <= th.max) return th.shape;
    }
    return "FULL";
  }
  function partialLetterKey(shape, gx, gy) {
    var letters = ["A", "B", "C", "D"];
    return shape + letters[hashInt(gx, gy) % letters.length];
  }

  // ---- tree geometry (WC-14 -- RECONCILE-WC14, see banner) ----------------------------------
  var TREE_FLAT_FALLBACK = {
    TREE_TRUNK: "TRUNK", TREE_TRUNK_THICK: "TRUNK", TREE_TRUNK_PILLAR: "TRUNK", TREE_BASE: "TRUNK",
    TREE_BRANCH: "BRANCH", TREE_HEAVY_BRANCH: "BRANCH",
    TREE_CAP: "CANOPY",
    TREE_TWIGS: "LEAVES", TREE_LEAFLESS_TWIGS: "LEAVES",
  };
  // DF's canonical direction-letter order is N,S,W,E, but the tiletype enum spells a few
  // runs in raws order (TreeTrunkEW/NEW/SEW, TreeBranchEW, ...) -- re-sort every captured
  // run so "TreeTrunkNEW" hits tree_map's real "NWE" key. B47: this canonicalisation (and
  // the TrunkInterior / CapWall-underscore fixes below) existed only in dwf-tiles.js;
  // this GL copy had drifted from an older WC-14 draft, so those tiles fell to flat
  // fallbacks in GL only. Kept byte-identical to dwf-tiles.js's parser from here on.
  var TREE_DIR_ORDER = "NSWE";
  function canonicalDirs(letters) {
    var out = "";
    for (var i = 0; i < TREE_DIR_ORDER.length; i++) {
      if (letters.indexOf(TREE_DIR_ORDER[i]) !== -1) out += TREE_DIR_ORDER[i];
    }
    return out;
  }
  // ttname (minus "Tree"/"Dead") -> {family, variant, altFamily?, adjacency?} | {skip:true} | null
  function parseTreeTtname(ttname) {
    if (!ttname || ttname.indexOf("Tree") !== 0) return null;
    var dead = ttname.indexOf("Dead") !== -1;
    var rest = ttname.slice(4);
    if (dead) rest = rest.replace("Dead", "");
    var m;
    if (rest === "TrunkInterior") return { family: "TREE_TRUNK_THICK", variant: "INTERIOR", dead: dead };
    if (rest === "CapInterior") return { family: "TREE_CAP", variant: "THICK_INTERIOR", dead: dead };
    if (rest === "TrunkPillar") return { family: "TREE_TRUNK_PILLAR", variant: "_", dead: dead };
    if (rest === "TrunkSloping") return { family: "TREE_TRUNK", variant: "SLOPE_TOP", dead: dead };
    if (rest === "RootSloping" || rest === "Roots") return { family: "TREE_BASE", variant: "TRUNK", dead: dead };
    if (rest === "CapRamp") return { skip: true };
    if (rest === "Twigs") {
      return { family: dead ? "TREE_LEAFLESS_TWIGS" : "TREE_TWIGS", variant: null, dead: dead, adjacency: true };
    }
    if (rest === "Branches" || rest === "BranchesSmooth") {
      return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "NSWE", dead: dead };
    }
    if (rest === "Branch") return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "_", dead: dead };
    if (rest === "CapPillar") return { family: "TREE_CAP", variant: "PILLAR", dead: dead };
    if ((m = /^CapPillar[NSEW]{1,4}$/.exec(rest))) return { family: "TREE_CAP", variant: "PILLAR", dead: dead };
    if ((m = /^TrunkBranch([NSEW])$/.exec(rest))) return { family: "TREE_BASE", variant: "TRUNK_" + m[1], dead: dead };
    if ((m = /^TrunkThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_TRUNK_THICK", variant: canonicalDirs(m[1]), dead: dead };
    if ((m = /^CapWallThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_THICK_" + canonicalDirs(m[1]), dead: dead };
    // Plain CAP_WALL raw tokens join their direction letters with underscores
    // (TREE_CAP_WALL_N_S_W_E) -- see the dwf-tiles.js parser's note.
    if ((m = /^CapWall([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_" + canonicalDirs(m[1]).split("").join("_"), dead: dead };
    if ((m = /^CapFloor([1-4])$/.exec(rest))) return { family: "TREE_CAP", variant: "FLOOR_" + m[1], dead: dead };
    if ((m = /^Trunk([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_TRUNK", variant: canonicalDirs(m[1]), dead: dead };
    if ((m = /^Branch([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: canonicalDirs(m[1]), dead: dead };
    return null;
  }
  // B47: TREE_OVERLEAVES overlay resolution -- shared shape with dwf-tiles.js's
  // resolveOverleaves (see its banner for the mechanism). Consumed by emitTree.
  var OVERLEAVES_PREFIX = {
    TREE_TRUNK: "TRUNK_",
    TREE_BRANCH: "HEAVY_BRANCH_",
    TREE_HEAVY_BRANCH: "HEAVY_BRANCH_",
  };
  function resolveOverleavesGL(treeMap, sel, id) {
    if (!sel || sel.dead || !treeMap) return null;
    var prefix = OVERLEAVES_PREFIX[sel.family];
    if (!prefix || !sel.variant || sel.variant === "_" || !/^[NSWE]+$/.test(sel.variant)) return null;
    var key = prefix + sel.variant;
    var sp = (id && treeMap[id]) || null;
    var own = sp && sp.TREE_OVERLEAVES && sp.TREE_OVERLEAVES[key];
    if (own) return own;
    var dflt = treeMap._default && treeMap._default.TREE_OVERLEAVES;
    return (dflt && dflt[key]) || null;
  }
  // Canopy-twig connectivity predicate (same shared 8-neighbor primitive drawWallJoin uses).
  function isCanopyNeighbor(nt) {
    if (!nt || nt.hidden) return false;
    var shape = nt.shape || "";
    if (shape !== "TWIG" && shape !== "BRANCH") return false;
    var mat = nt.mat || "";
    return mat === "TREE" || mat === "MUSHROOM";
  }

  // ---- floor-edge (grass-creep) decal: DELETED (B71-r3, the owner 07-14 escalation) ----------------
  // WB-11 #5 used to paint a grass.png cell OVER the finished terrain sprite of EVERY non-grass
  // tile bordering grass, at alpha min(140, 40 + 18*grassNeighbors)/255 -- up to 55% for a tile
  // embedded in a lawn. It was a client-invented heuristic (its own banner admitted the sprite
  // AND the alpha curve were made up; no oracle ever calibrated it), and the paired oracle
  // (tools/orchestrator/attachments/B71-oracle-native.png vs B71-broken-ours.png) refutes it
  // pixel-wise: native boulders/pebbles/dirt beside grass are FULLY OPAQUE (their edge fringe is
  // authored into the sprites themselves), while ours showed boulders at ~30% through a ~70%
  // grass wash (measured per-channel alpha 0.69/0.73/0.72 on the boulder's white highlight) and
  // whole pebble clusters as flat translucent green squares (dense-pebble cell + 0.549 grass
  // overlay reproduces the measured (89,104,78) to within sampling noise). canvas2d NEVER drew
  // this decal, so deleting it is also the renderer-parity fix. Same class of fix as the
  // see-above canopy and indoor-wash deletions: measured false content -> delete, don't tune.

  // WB-10 (report-W6 minus the fog report's deletions): ported VERBATIM from
  // dwf-tiles.js's isOpenTile (dwf-tiles.js:425-429) as a pure, cache-agnostic
  // predicate -- no `layers[]` transport assumption, no DOM. A tile lets the camera see
  // through it (down) when it is EMPTY/NONE/RAMP_TOP-shaped or AIR-matched. Plain RAMP
  // (not RAMP_TOP) is intentionally NOT open -- a ramp is a walkable solid surface, so a
  // camera column resting on one does not descend past it.
  function isOpenTileShapeMat(shape, mat) {
    return shape === "EMPTY" || shape === "NONE" || shape === "RAMP_TOP" || mat === "AIR";
  }

  // WB-10 public guard (the Rollback note's "cacheHasMultiZ() guard defaults false"): true
  // only when the cache holds a genuinely RAW (un-baked, post-W-A-WA-12) chunk at this world
  // column -- i.e. real z-below blocks exist to descend through. False today (WA-12 has not
  // landed; RECONCILE-WA §0: every chunk is still `baked` -- the legacy server's see-down
  // substitution, proven pixel-exact) and false whenever no cache reader is wired at all (node
  // tests, the offline atlas page). This is an UNCACHED convenience query for external
  // inspection/tests/handoff notes; the hot scene-build path below does its own memoized
  // equivalent check per buildScene call (see `getChunkCached` in createSceneBuilder).
  function cacheHasMultiZ(cacheReader, z, wx, wy) {
    if (!cacheReader || typeof cacheReader.getChunk !== "function" ||
      typeof cacheReader.chunkKeyFor !== "function") return false;
    var chunk = null;
    try { chunk = cacheReader.getChunk(z, cacheReader.chunkKeyFor(wx, wy)); } catch (_) { chunk = null; }
    return !!(chunk && chunk.baked === false);
  }

  function wallPrefix(mat, base_mt) {
    if (mat === "SOIL") return "SOIL_WALL";
    if (mat === "FROZEN_LIQUID") return "ICE_WALL";
    if (mat === "LAVA_STONE" || mat === "MAGMA") return "MAGMA_WALL";
    if (mat === "MINERAL") return "ORE_VEIN_WALL";
    // B47 / WALLSFIX (canvas2d parity): constructed walls use DF's dressed-block family recoloured
    // per material (wood -> WOODEN_WALL) -- see dwf-tiles.js wallPrefix's banner.
    if (mat === "CONSTRUCTION") return (typeof base_mt === "number" && base_mt >= 419) ? "WOODEN_WALL" : "ROCK_BLOCKS_WALL";
    return "STONE_WALL";
  }
  // B74 (GL parity -- byte-for-byte port of dwf-tiles.js wallDetailPrefix): a player-
  // smoothed / worn wall uses DF's dedicated detailed-wall art family, not the rough natural
  // wallPrefix() family. Detail state rides in the ttname (special=SMOOTH / WORN_1..3); direction
  // stays open-face adjacency. SMOOTHED_STONE_WALL_* / WORN{1,2,3}_STONE_WALL_* (stone family) and
  // SMOOTHED_ICE_WALL_* (frozen); no worn-ice art -> worn ice degrades to the smoothed-ice look.
  function wallDetailPrefix(t) {
    var nm = (t && t.ttname) || "";
    var isIce = ((t && t.mat) || "") === "FROZEN_LIQUID";
    if (/WallSmooth/.test(nm)) return isIce ? "SMOOTHED_ICE_WALL" : "SMOOTHED_STONE_WALL";
    var worn = /WallWorn([123])$/.exec(nm);
    if (worn) return isIce ? "SMOOTHED_ICE_WALL" : ("WORN" + worn[1] + "_STONE_WALL");
    return null;
  }

  // liquidCellFor: liquids.png depth cell (col 0 water / col 1 magma, row = 7 - depth).
  function liquidCellFor(liquid, flow) {
    if (liquid !== "water" && liquid !== "magma") return null;
    var d = Math.max(1, Math.min(7, flow || 0));
    return { sheet: "liquids.png", col: (liquid === "magma") ? 1 : 0, row: 7 - d };
  }

  function liquidEdgeTokens(t, gx, gy, lookupTile, Adj) {
    if (!Adj || !lookupTile) return [];
    var flow = t && (t.flow || 0), liquid = t && (t.liquid || "none");
    if (flow <= 0 || (liquid !== "water" && liquid !== "magma")) return [];
    var mask8 = Adj.computeMask8(lookupTile, gx, gy, function (nt) {
      if (!nt) return true;
      var nFlow = nt.flow || 0, nLiquid = nt.liquid || "none";
      return !(nFlow > 0 && (nLiquid === "water" || nLiquid === "magma"));
    });
    if (!mask8) return [];
    var prefix = (liquid === "magma") ? "UNDERMAGMA_EDGE_" : "UNDERWATER_EDGE_";
    var out = [];
    for (var i = 0; i < Adj.DIR_NAMES.length && out.length < 4; i++) {
      var name = Adj.DIR_NAMES[i];
      if (mask8 & Adj.BIT[name]) out.push(prefix + name);
    }
    return out;
  }

  // ---- buildings (WB-12, report-W8) -- tables mirrored VERBATIM from dwf-tiles.js's
  // (8) BUILDINGS pass (df::workshop_type/df::furnace_type subtype->name translation,
  // MISSING_BUILDING fallback, Stockpile/Civzone exclusion). Same no-cross-file-coupling
  // convention as every other table in this file: this file keeps its OWN copy of these tiny
  // constant tables rather than reaching into dwf-tiles.js's private closure. Furniture/
  // bridge/well direction+state resolution (building_map.json v2's nested `furniture`/
  // `bridges`/`wells`/`machines` sections) is explicitly OUT of scope here -- the spec scopes
  // "Furniture/bridge map keys + direction/state wire fields" to W-C; today's wire only carries
  // building.type (string enum)/building.subtype (int)/building.stage (int, unconsumed -- see
  // banner below), so this mirrors buildingEntry()'s EXACT flat-key resolution (Type:Subtype
  // alias -> Type:subtypeInt -> bare Type -> MISSING_BUILDING), the only resolution the
  // canvas2d reference itself performs today.
  var WORKSHOP_SUBTYPE = [
    "Carpenters", "Farmers", "Masons", "Craftsdwarfs", "Jewelers", "MetalsmithsForge",
    "MagmaForge", "Bowyers", "Mechanics", "Siege", "Butchers", "Leatherworks", "Tanners",
    "Clothiers", "Fishery", "Still", "Loom", "Quern", "Kennels", "Kitchen", "Ashery",
    "Dyers", "Millstone", "Custom", "Tool",
  ];
  var FURNACE_SUBTYPE = [
    "WoodFurnace", "Smelter", "GlassFurnace", "Kiln", "MagmaSmelter",
    "MagmaGlassFurnace", "MagmaKiln", "Custom",
  ];
  // TX17 (GL parity): planned/unbuilt CONSTRUCTION art. Byte-identical table to the canvas2d
  // CONSTRUCTION_PLANNED_TOKEN (dwf-tiles.js) -- indexed by construction_type ordinal
  // (df.building.xml), graphics token spellings (E-before-W: TrackEW -> _WE etc.), verified 1:1
  // against vanilla_buildings_graphics/graphics_planned_constructions.txt. See the canvas2d banner.
  var CONSTRUCTION_PLANNED_TOKEN = [
    "PLANNED_CONSTRUCTION_FORTIFICATION",   // 0  Fortification
    "PLANNED_CONSTRUCTION_WALL",            // 1  Wall
    "PLANNED_CONSTRUCTION_FLOOR",           // 2  Floor
    "PLANNED_CONSTRUCTION_STAIR_UP",        // 3  UpStair
    "PLANNED_CONSTRUCTION_STAIR_DOWN",      // 4  DownStair
    "PLANNED_CONSTRUCTION_STAIR_UPDOWN",    // 5  UpDownStair
    "PLANNED_CONSTRUCTION_RAMP",            // 6  Ramp
    "PLANNED_CONSTRUCTION_TRACK_N",         // 7  TrackN
    "PLANNED_CONSTRUCTION_TRACK_S",         // 8  TrackS
    "PLANNED_CONSTRUCTION_TRACK_E",         // 9  TrackE
    "PLANNED_CONSTRUCTION_TRACK_W",         // 10 TrackW
    "PLANNED_CONSTRUCTION_TRACK_NS",        // 11 TrackNS
    "PLANNED_CONSTRUCTION_TRACK_NE",        // 12 TrackNE
    "PLANNED_CONSTRUCTION_TRACK_NW",        // 13 TrackNW
    "PLANNED_CONSTRUCTION_TRACK_SE",        // 14 TrackSE
    "PLANNED_CONSTRUCTION_TRACK_SW",        // 15 TrackSW
    "PLANNED_CONSTRUCTION_TRACK_WE",        // 16 TrackEW  -> token _WE
    "PLANNED_CONSTRUCTION_TRACK_NSE",       // 17 TrackNSE
    "PLANNED_CONSTRUCTION_TRACK_NSW",       // 18 TrackNSW
    "PLANNED_CONSTRUCTION_TRACK_NWE",       // 19 TrackNEW -> token _NWE
    "PLANNED_CONSTRUCTION_TRACK_SWE",       // 20 TrackSEW -> token _SWE
    "PLANNED_CONSTRUCTION_TRACK_NSWE",      // 21 TrackNSEW-> token _NSWE
    "PLANNED_CONSTRUCTION_TRACK_RN",        // 22 TrackRampN
    "PLANNED_CONSTRUCTION_TRACK_RS",        // 23 TrackRampS
    "PLANNED_CONSTRUCTION_TRACK_RE",        // 24 TrackRampE
    "PLANNED_CONSTRUCTION_TRACK_RW",        // 25 TrackRampW
    "PLANNED_CONSTRUCTION_TRACK_RNS",       // 26 TrackRampNS
    "PLANNED_CONSTRUCTION_TRACK_RNE",       // 27 TrackRampNE
    "PLANNED_CONSTRUCTION_TRACK_RNW",       // 28 TrackRampNW
    "PLANNED_CONSTRUCTION_TRACK_RSE",       // 29 TrackRampSE
    "PLANNED_CONSTRUCTION_TRACK_RSW",       // 30 TrackRampSW
    "PLANNED_CONSTRUCTION_TRACK_RWE",       // 31 TrackRampEW  -> token _RWE
    "PLANNED_CONSTRUCTION_TRACK_RNSE",      // 32 TrackRampNSE
    "PLANNED_CONSTRUCTION_TRACK_RNSW",      // 33 TrackRampNSW
    "PLANNED_CONSTRUCTION_TRACK_RNWE",      // 34 TrackRampNEW -> token _RNWE
    "PLANNED_CONSTRUCTION_TRACK_RSWE",      // 35 TrackRampSEW -> token _RSWE
    "PLANNED_CONSTRUCTION_TRACK_RNSWE",     // 36 TrackRampNSEW-> token _RNSWE
    "PLANNED_CONSTRUCTION_REINFORCED_WALL", // 37 ReinforcedWall
  ];
  // WC-4's "unknown art" placeholder (defaults.png col 0 row 1) -- NEVER the old `_default`
  // workshops_1x1.png stamp (coverage §1.2#5). See dwf-tiles.js:1251-1257 for the same
  // constant + its licensing/provenance note.
  var MISSING_BUILDING = { sheet: "defaults.png", col: 0, row: 1 };
  function isOverlayOnlyBuildingType(type) { return type === "Stockpile" || type === "Civzone"; }

  // OVL1 (ex-B57): native DF paints buildings BACK-TO-FRONT -- up-screen (smaller y1, farther)
  // first, down-screen (larger y1, nearer) LAST -- so the nearer building's authored overhang
  // (B14, at y1-1) covers the up-screen building it sits in front of ("native paints
  // down-screen-over": bottom-over-top). The prior wave shipped this DESCENDING (by - ay), which
  // inverted it -- the up-screen building's bottom row wrongly won the collision. Ascending
  // (ay - by) restores native. Stable (source order breaks y1 ties) and non-mutating.
  function buildingsInPaintOrder(list) {
    if (!Array.isArray(list) || list.length < 2) return Array.isArray(list) ? list.slice() : [];
    return list.map(function (building, index) { return { building: building, index: index }; })
      .sort(function (a, b) {
        var ay = a.building && Number.isFinite(a.building.y1) ? a.building.y1 : -2147483648;
        var by = b.building && Number.isFinite(b.building.y1) ? b.building.y1 : -2147483648;
        return (ay - by) || (a.index - b.index);
      }).map(function (entry) { return entry.building; });
  }

  // Closed-form multiply factor for the building material tint. Same Porter-Duff derivation
  // WB-11 used for item tint (factor = 255*(1-a) + a*c per channel) -- computed at RUNTIME from
  // the wire's own continuously-varying component color (b.crgb) rather than picked from a small
  // fixed per-family table, since building material colour isn't a small enum. Becomes the
  // instance's OWN tint (shader already does texel*tint for every sprite instance). canvas2d
  // applies the SAME factor through its multiplyTintedCell compose (dwf-tiles.js
  // blitBldCell), masked to the sprite's own alpha exactly like texel*tint is -- the old
  // full-cell multiply fillRect painted tint on the GROUND wherever building art is transparent
  // (the workshoptint defect-B one-tile-above spill on the B14 overhang row).
  // B14 compatibility fallback: material-tint strength (lerp from white toward one descriptor
  // RGB). B273 uses exact 18-color palette substitution whenever cpal resolves, so this path is
  // limited to older servers and unknown modded palette tokens.
  // Recalibrated 0.7 -> 0.4 against a passive native capture of the jet (midnight-blue,
  // descriptor rgb 0,51,102) furnaces: at 0.7 a dark material crushed the neutral-grey sprite
  // to (~30,46,64) (over-blue, b/r 2.1, brick detail lost -- the "washed out weird blue"); at
  // 0.4 it reads (~60,71,84) (b/r 1.40), matching DF's own rendered stone (~67,68,96, b/r 1.43).
  // Near-white/grey materials are ~unchanged either way; the strength only matters for dark or
  // strongly-saturated materials, where DF's own tint is visibly this gentle.
  var BUILDING_TINT_ALPHA = 0.4;
  // Window #13 (building component-tint) -- CORRECTED 2026-07-09 (workshoptint): the tint source
  // is the component-derived RGB (`b.crgb`) ONLY. The header-material RGB (`b.rgb`) is NEVER a
  // tint source -- the old "fall back to header rgb" ladder was the root cause of the five blue-
  // workshop reports. NATIVE EVIDENCE (live differential, 2026-07-09 tintprobe): a component-less
  // microcline-HEADER workshop/furnace (range band z157, wire rgb=[0,255,255], no crgb) renders
  // GRAY in native DF (authored art, zero cyan) while the header-fallback browser tinted it cyan
  // (footprint cyan-frac .26-.56 vs native .00). The graphics raws agree: vanilla_buildings_graphics
  // carries ONLY [TILE_GRAPHICS...] rows onto authored sheets -- no color/material token exists, so
  // any material recolor native shows (the dark jet furnaces, B14; material-colored doors) comes
  // from the building's COMPONENT items (a door's component IS the door item -- its material just
  // happens to equal the header there, which is what made the header fallback look right on doors).
  // Rule: crgb when the server resolved a real component color, else NO tint (null) -- byte-parity
  // with canvas2d's pickBuildingTintRgb (dwf-tiles.js). Returns a validated [r,g,b] or null.
  function validRgbTriple(v) {
    return Array.isArray(v) && v.length === 3 &&
      Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
  }
  function pickBuildingTintRgb(b) {
    if (!b) return null;
    if (validRgbTriple(b.crgb)) return b.crgb;   // component-derived (native's true source)
    return null;   // header b.rgb NEVER tints: native draws a component-less building untinted
  }
  function pickBuildingPalRow(b, map) {
    if (!b || typeof b.cpal !== "string" || !map || !map.palette) return null;
    var r = map.palette.byname && map.palette.byname[b.cpal];
    return typeof r === "number" && map.palette.rows && map.palette.rows[r] ? r : null;
  }
  function buildingTintRgb(rgb) {
    return [
      Math.round(255 * (1 - BUILDING_TINT_ALPHA) + BUILDING_TINT_ALPHA * rgb[0]),
      Math.round(255 * (1 - BUILDING_TINT_ALPHA) + BUILDING_TINT_ALPHA * rgb[1]),
      Math.round(255 * (1 - BUILDING_TINT_ALPHA) + BUILDING_TINT_ALPHA * rgb[2]),
    ];
  }

  // MEASURED SEE-DOWN FOG (mirrors dwf-tiles.js's fogAlphaForDepth verbatim -- SAME
  // constants, docs/reference/fogparams.json `seeDown`, sweep #2). The terrain descent
  // itself is fogged via the shader's seeDownTint/seeDownCurve UBO hook (RenderParams,
  // WB-10); buildings/units are baked JS-side per-instance (they aren't atlas terrain
  // texels, and z-fade here happens at scene-build/tick time, not per-fragment), so this is
  // the same curve applied as a translucency proxy -- buildings/units weren't themselves
  // sampled by the fog fit (grass + stone rubble flats only), so this is a reasoned
  // EXTENSION of the measured terrain curve, not independently verified for sprites.
  var FOG_ALPHA_INTERCEPT = 0.2464;
  var FOG_ALPHA_RATE = 0.1057;
  // QA-only kill switch (mirrors dwf-tiles.js's FOG_DISABLED): set true by create()'s
  // opts.nofog (wired from `?nofog=1` in dwf-render.js) -- window-capture parity scoring
  // (tools/harness/gate_parity.py --oracle window) needs an A/B (fog on vs off) at the SAME
  // client/camera to prove the fog's parity CONTRIBUTION, not a product feature.
  var FOG_DISABLED = false;
  function fogAlphaForDepth(depth) {
    if (FOG_DISABLED) return 0;
    var d = (typeof depth === "number") ? depth : 0;
    if (d <= 0) return 0;
    return Math.max(0, Math.min(1, FOG_ALPHA_INTERCEPT + FOG_ALPHA_RATE * d));
  }
  // wire:6 z-fade (dwf-tiles.js, verbatim): buildings/units arrive across the whole
  // stacked z-range around the camera, not just the camera plane. BELOW camera: translucency
  // proxy for the measured see-down fog (fogAlphaForDepth above). ABOVE camera: no fade at
  // all (fogparams.json `seeAbove.mode: "delete"` -- DF draws no above-camera translucent
  // canopy; the old alphaAbove curve was approximating something that doesn't exist).
  function belowAlpha(d) { return Math.max(0, 1 - fogAlphaForDepth(d)); }

  // ---- (WB-13) units -- report-W9, dissolved by spec §1.2's f32 x/y from day one (no u16
  // re-encode). Two independent pieces: tier resolution (mirrors dwf-tiles.js's WE-4
  // resolveUnitTier chain) and view-side interpolation (mirrors the smooth-cursor overlay's
  // lerp model). Both are pure/DOM-free so they're directly node-testable.

  // Fallback dot tint (dwf-tiles.js's UNIT_COLOR "rgb(240,220,60)"): a flat SOLID_CELL
  // instance approximates canvas2d's filled circle -- unlike the stair/ramp X-strokes residual
  // elsewhere in this file, a coloured square IS instance-shaped, so this is a strict upgrade
  // over silently drawing nothing, not a "2D line work, deferred" case.
  var UNIT_FALLBACK_RGB = [240, 220, 60];
  // B98 ghost tint: shared with dwf-tiles.js's GHOST_TINT_RGB/GHOST_ALPHA (kept in sync
  // by the treegrass ghost fixture). Spectral-green multiply + DF's ghost translucency
  // (creature-compositing-system.md: the GHOST USE_PALETTE row carries alpha=163 ~ 0.64).
  var GHOST_TINT_RGB = [120, 235, 150];
  var GHOST_ALPHA = 163 / 255;
  var UNIT_STATUS_SHEET = "unit_status.png";
  var UNIT_STATUS_BLINK_MS = 800;
  var MACHINE_ANIM_MS = 500;
  var USTAT_SLEEPING = 0x01;
  var USTAT_UNCONSCIOUS = 0x02;
  var USTAT_STRESSED = 0x04;
  var USTAT_STRANGE_MOOD = 0x08;
  var USTAT_CAGED = 0x10;
  var USTAT_CHAINED = 0x20;
  // WT30 full status set (mirror of src/unit_status.h kUStat*; 0x200+). Byte-parity with
  // dwf-tiles.js (asserted by wt30_status_full_test.mjs). Bit->row map documented on the
  // resolver below; every bit is a graphics_interface.txt UNIT_STATUS row.
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
  // WT29: strange-mood SUBTYPE nibble (server world_stream.cpp kUStatMood*). 3-bit 1-based code in
  // bits 0x40..0x100; 0x08 STRANGE_MOOD is always co-set. Code 0 (old DLL / non-overhead mood) -> the
  // FEY_MOOD row-9 fallback, so a new client renders correctly against an old server. Mirrors
  // dwf-tiles.js byte-for-byte (same no-cross-file-coupling convention as every mirrored table).
  var USTAT_MOOD_SHIFT = 6;
  var USTAT_MOOD_MASK = 0x7 << USTAT_MOOD_SHIFT; // 0x1C0
  var MOOD_CELL = {
    1: { row: 9,  token: "UNIT_STATUS:FEY_MOOD" },
    2: { row: 10, token: "UNIT_STATUS:POSSESSED" },
    3: { row: 11, token: "UNIT_STATUS:SECRETIVE_MOOD" },
    4: { row: 12, token: "UNIT_STATUS:FELL_MOOD" },
    5: { row: 13, token: "UNIT_STATUS:MACABRE_MOOD" },
  };
  // WT31: the SECOND status word, shipped as the additive unit field `st2` (mirror of
  // src/unit_status.h kUStat2*). `st` ran out at bit 28 -- these `&` tests coerce to int32, so bit
  // 31 would go negative and anything above it would vanish. Hence a fresh word rather than a wider
  // one. An old server sends no st2 -> it reads 0 -> every WT30 bubble still resolves exactly as
  // before, so the two halves deploy in either order. Byte-parity with dwf-tiles.js.
  var USTAT2_MIGRANT = 0x00000001;
  var USTAT2_NO_JOB = 0x00000002;
  var USTAT2_NO_DESTINATION = 0x00000004;  // server reserves this; not set until probe P3 lands
  var USTAT2_DISTRACTED = 0x00000008;
  var USTAT2_TERRIFIED = 0x00000010;
  var USTAT2_WRESTLING = 0x00000020;
  var USTAT2_MINOR_INJURY = 0x00000040;
  var USTAT2_MAJOR_INJURY = 0x00000080;
  var USTAT2_MAKE_BELIEVE = 0x00000100;
  var USTAT2_TELLING_A_STORY = 0x00000200;
  var USTAT2_RECITING_POETRY = 0x00000400;
  var USTAT2_PERFORMING = 0x00000800;

  // Native premium status sheet: tile_page_interface.txt declares UNIT_STATUS as
  // images/unit_status.png, 32x32, one column. graphics_interface.txt maps the rows used here:
  // STRESSED=6, SLEEPING=8, FEY_MOOD:9 POSSESSED:10 SECRETIVE_MOOD:11 FELL_MOOD:12 MACABRE_MOOD:13,
  // UNCONSCIOUS=30. WT29: the wire now carries the mood SUBTYPE in the 0x1C0 nibble, so we pick the
  // exact mood cell; an absent/0 subtype (old DLL, or a mood with no overhead cell) falls back to
  // FEY_MOOD's row 9 -- the pre-WT29 behavior. Caged/chained have building/item icons but no native
  // UNIT_STATUS overhead cell, so they deliberately return null instead of inventing a badge.
  function usCell(row, name) {
    return { sheet: UNIT_STATUS_SHEET, col: 0, row: row, token: "UNIT_STATUS:" + name };
  }
  // NATIVE overhead priority ladder (v1 status bubbles). Source of authority: the decompiled
  // graphics-mode selector FUN_1402685d0, as distilled in a verified predicate table
  // (internal analysis notes, 2026-07-16, "NATIVE PRIORITY"; see tools/harness/sb_predicate_ref.mjs). DF
  // shows ONE bubble though the wire carries every active bit; the FIRST match wins. This resolver
  // is byte-identical (row MAP and ORDER) to dwf-tiles.js unitStatusIconForBits -- GL<->Canvas
  // resolution identity is a v1 acceptance criterion, so change both together or neither.
  //
  // This REPLACES the pre-v1 invented ladder, which (a) resolved HUNGRY before THIRSTY and (b)
  // ranked moods above the graded needs -- both proven wrong against the native selector. Ladder
  // (native step numbers in brackets; YIELDING[2]/32 excluded as an Adventure-mode v1 non-goal):
  //   [1]  SLEEPING(8)
  //   [3]  UNCONSCIOUS(30)
  //   [4]  PARALYZED(26)            server gates counters2.paralysis >= 100 (sel:78)
  //   [5]  activity walk: TELLING_A_STORY(34)/RECITING_POETRY(35)/PERFORMING(36)/MAKE_BELIEVE(33)
  //   [6]  WRESTLING(23)
  //   [7]  NAUSEA(28)
  //   [8]  STUNNED(27)              server folds the dizziness branch into the bit (sel:156)
  //   [9]  WINDED(29)
  //   [10] MAJOR_INJURY(25)
  //   [11] MINOR_INJURY(24)
  //   [12] FEVERED(31)
  //   [13] needs (sane citizen): THIRSTY(4) > HUNGRY(3) > DROWSY(5) > STRESSED(6) > DISTRACTED(7).
  //        THIRSTY precedes HUNGRY (PROVEN sel:173 vs 176). STRESSED/DISTRACTED self-gate on
  //        mood==-1 && soldier_mood==-1 SERVER-side (bit only set when eligible), so no client gate.
  //   [14] soldier moods: MARTIAL_TRANCE(21)/ENRAGED(20)/TANTRUM(14)/DEPRESSION(16)/OBLIVIOUS(15)
  //   [15] idle logic: NO_JOB(1) > NO_DESTINATION(2)   (server reserves NO_DESTINATION -> unset)
  //   [16] strange-mood switch: BERSERK(19)/MADNESS(17)/MELANCHOLY(18)/mood-nibble(9-13),
  //        DEFAULT -> TERRIFIED(22)  (TERRIFIED is the switch default, so it falls through last)
  //   [17] MIGRANT(0)               misc-trait type 7
  //   [18] physical fallback: PROJECTILE(37)/GROUNDED(38)/CLIMBING(40)/WEBBED(39). unitStatusIconForBits
  //        keeps these as the bottom fallback (ordinary tiers 1-17 outrank them); the native per-unit
  //        PHYSICAL sub-window is applied downstream by unitStatusIconNow (see nativeBubblePhase).
  // Caged/chained have building/item icons but no native UNIT_STATUS overhead cell -> null.
  function unitStatusIconForBits(st, st2) {
    st = st | 0;
    st2 = st2 | 0;   // absent (old DLL) -> 0 -> pre-WT31 behavior exactly
    // [1] sleep
    if (st & USTAT_SLEEPING) return usCell(8, "SLEEPING");
    // [3] unconscious / [4] paralyzed
    if (st & USTAT_UNCONSCIOUS) return usCell(30, "UNCONSCIOUS");
    if (st & USTAT_PARALYZED) return usCell(26, "PARALYZED");
    // [5] activity / performance walk
    if (st2 & USTAT2_TELLING_A_STORY) return usCell(34, "TELLING_A_STORY");
    if (st2 & USTAT2_RECITING_POETRY) return usCell(35, "RECITING_POETRY");
    if (st2 & USTAT2_PERFORMING) return usCell(36, "PERFORMING");
    if (st2 & USTAT2_MAKE_BELIEVE) return usCell(33, "PLAYING_MAKE_BELIEVE");
    // [6] wrestling
    if (st2 & USTAT2_WRESTLING) return usCell(23, "WRESTLING");
    // [7]-[9] acute physical (nausea / stunned+dizzy / winded)
    if (st & USTAT_NAUSEA) return usCell(28, "NAUSEA");
    if (st & USTAT_STUNNED) return usCell(27, "STUNNED");
    if (st & USTAT_WINDED) return usCell(29, "WINDED");
    // [10]-[11] injuries / [12] fever
    if (st2 & USTAT2_MAJOR_INJURY) return usCell(25, "MAJOR_INJURY");
    if (st2 & USTAT2_MINOR_INJURY) return usCell(24, "MINOR_INJURY");
    if (st & USTAT_FEVERED) return usCell(31, "FEVERED");
    // [13] graded needs: THIRSTY > HUNGRY > DROWSY > STRESSED > DISTRACTED
    if (st & USTAT_THIRSTY) return usCell(4, "THIRSTY");
    if (st & USTAT_HUNGRY) return usCell(3, "HUNGRY");
    if (st & USTAT_DROWSY) return usCell(5, "DROWSY");
    if (st & USTAT_STRESSED) return usCell(6, "STRESSED");
    if (st2 & USTAT2_DISTRACTED) return usCell(7, "DISTRACTED");
    // [14] soldier moods
    if (st & USTAT_MARTIAL_TRANCE) return usCell(21, "MARTIAL_TRANCE");
    if (st & USTAT_ENRAGED) return usCell(20, "ENRAGED");
    if (st & USTAT_TANTRUM) return usCell(14, "TANTRUM");
    if (st & USTAT_DEPRESSION) return usCell(16, "DEPRESSION");
    if (st & USTAT_OBLIVIOUS) return usCell(15, "OBLIVIOUS");
    // [15] idle logic (NO_DESTINATION is server-reserved -> currently never set)
    if (st2 & USTAT2_NO_JOB) return usCell(1, "NO_JOB");
    if (st2 & USTAT2_NO_DESTINATION) return usCell(2, "NO_DESTINATION");
    // [16] strange-mood switch, DEFAULT -> TERRIFIED
    if (st & USTAT_BERSERK) return usCell(19, "BERSERK");
    if (st & USTAT_MADNESS) return usCell(17, "MADNESS");
    if (st & USTAT_MELANCHOLY) return usCell(18, "MELANCHOLY");
    if (st & USTAT_STRANGE_MOOD) {
      var mc = MOOD_CELL[(st & USTAT_MOOD_MASK) >> USTAT_MOOD_SHIFT] || MOOD_CELL[1];
      return { sheet: UNIT_STATUS_SHEET, col: 0, row: mc.row, token: mc.token };
    }
    if (st2 & USTAT2_TERRIFIED) return usCell(22, "TERRIFIED");
    // [17] MIGRANT (misc-trait type 7)
    if (st2 & USTAT2_MIGRANT) return usCell(0, "MIGRANT");
    // [18] physical fallback -- the physical-marker GROUP (native shows it only in the <5001 phase
    // sub-window; see nativeBubblePhase/unitStatusIconNow). Kept last so ordinary tiers win selection.
    if (st & USTAT_PROJECTILE) return usCell(37, "PROJECTILE");
    if (st & USTAT_GROUNDED) return usCell(38, "GROUNDED");
    if (st & USTAT_CLIMBING) return usCell(40, "CLIMBING");
    if (st & USTAT_WEBBED) return usCell(39, "WEBBED");
    // caged/chained: no native overhead cell
    if (st & (USTAT_CAGED | USTAT_CHAINED)) return null;
    return null;
  }
  // ---------------------------------------------------------------------------------------------
  // NATIVE per-unit status-bubble blink cadence (decoded selector FUN_1402685d0, owner decision
  // 2026-07-16). Native staggers EVERY unit's bubble on its own phase -- there is NO fort-wide
  // synchronization (the invented global 800ms on/off clock is gone). Per-unit phase over a 7000ms
  // cycle (native uses GetTickCount(); the client uses a monotonic ms clock -- perf.now/Date.now):
  //     phase = (unit.id * 0x86e8 + now_ms) % 7000
  //   phase <  5001  -> ONLY the physical-marker group may show (PROJECTILE 37/WEBBED 39/GROUNDED 38/
  //                     CLIMBING 40); ordinary bubbles hidden.   (~5s window)
  //   phase >= 5001  -> the main ordinary ladder shows (needs/moods/sleep/injuries/soldier+strange
  //                     moods/...).   (~2s window)
  // Consequence: each unit's ordinary bubble is visible ~2s of every 7s, staggered per unit by
  // unit.id. A unit carrying BOTH an ordinary and a physical status shows the physical marker in the
  // other ~5s window. The bubble ROW itself (which status wins) is server-derived + unchanged; this
  // is pure client-side visibility cadence. unit.id is the REAL server unit id already carried in the
  // stream (used for player colors + WB-13 interpolation tracks -- keyed by u.id in tickUnits below).
  var NATIVE_BUBBLE_PERIOD_MS = 7000;    // full per-unit cycle
  var NATIVE_BUBBLE_ID_STRIDE = 0x86e8;  // native per-unit phase stride (34536)
  var NATIVE_BUBBLE_ORDINARY_MS = 5001;  // ordinary window is [5001, 7000); physical is [0, 5001)
  function nativeBubblePhase(unitId, nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    var id = (unitId >>> 0);   // real unit id; native ids are non-negative
    // reduce id*stride mod the period BEFORE adding time so the product stays exact for large ids
    var idPhase = ((id % NATIVE_BUBBLE_PERIOD_MS) * (NATIVE_BUBBLE_ID_STRIDE % NATIVE_BUBBLE_PERIOD_MS)) % NATIVE_BUBBLE_PERIOD_MS;
    var t = Math.floor(nowMs) % NATIVE_BUBBLE_PERIOD_MS;
    if (t < 0) t += NATIVE_BUBBLE_PERIOD_MS;
    return (idPhase + t) % NATIVE_BUBBLE_PERIOD_MS;
  }
  // the physical-marker group, resolved in the SAME intra-tier order as unitStatusIconForBits' tier 18.
  function physicalStatusIconForBits(st) {
    st = st | 0;
    if (st & USTAT_PROJECTILE) return usCell(37, "PROJECTILE");
    if (st & USTAT_GROUNDED) return usCell(38, "GROUNDED");
    if (st & USTAT_CLIMBING) return usCell(40, "CLIMBING");
    if (st & USTAT_WEBBED) return usCell(39, "WEBBED");
    return null;
  }
  // the ordinary ladder = the full selector MINUS the physical fallback. unitStatusIconForBits returns
  // a physical row ONLY when no ordinary tier matched (physical ranks last), so stripping rows 37-40
  // yields exactly the ordinary winner -- and a unit with both an ordinary and physical status keeps
  // its ordinary winner here while physicalStatusIconForBits independently reports the physical one.
  function ordinaryStatusIconForBits(st, st2) {
    var full = unitStatusIconForBits(st, st2);
    if (!full) return null;
    if (full.row === 37 || full.row === 38 || full.row === 39 || full.row === 40) return null;
    return full;
  }
  // the icon to actually DRAW for this unit at nowMs, applying the native per-unit phase window.
  function unitStatusIconNow(st, st2, unitId, nowMs) {
    return (nativeBubblePhase(unitId, nowMs) < NATIVE_BUBBLE_ORDINARY_MS)
      ? physicalStatusIconForBits(st)
      : ordinaryStatusIconForBits(st, st2);
  }
  // The 800ms on/off beat. NOTE: this does NOT gate overhead status bubbles -- that fort-wide
  // synchronized blink was an invented client clock (all units vanished together every 800ms) and is
  // gone; bubbles now use the NATIVE per-unit phase cadence (nativeBubblePhase) in unitStatusIconNow.
  // This function is RETAINED only for the unrelated animations that legitimately share the beat:
  // designation-job blinking (designationGlyphVisible) and flow-cloud breathing (flowOverlayForGL).
  // Those are byte-identical to before. Do not reintroduce a bubble gate here.
  function unitStatusBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / UNIT_STATUS_BLINK_MS) % 2) === 0;
  }
  // B135 three-state native cadence (live spec 07-10, corrects B108 and B135's first cut):
  // DF posts designation jobs that sit WORKERLESS in the job list (smoothing/chop queues
  // especially) -- native keeps those STEADY. The wire discriminator is the djob's additive
  // `w:1` (a UNIT_WORKER general ref is attached -- world_stream.cpp's DJobRec). State model:
  //   0  job exists, no worker         -> steady glyph, no blink
  //   1  worker assigned, en-route     -> pulse on the shared 800ms beat
  //   2  worker/unit ON the work tile  -> pulse on the 400ms half-beat (+ the tile alternates
  //      dwarf <-> glyph/object, see workedTileUnitVisible)
  // The half-beat divides the SAME clock (never a second timer), so both cadences stay
  // phase-locked forever. Kind range 1-13 = every djob kind. Idle t.desig marks stay steady.
  var DESIG_ACTIVE_BLINK_MS = UNIT_STATUS_BLINK_MS / 2;
  function isBlinkingDesignationJob(djobKind) {
    return djobKind >= 1 && djobKind <= 13;
  }
  function activeBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / DESIG_ACTIVE_BLINK_MS) % 2) === 0;
  }
  function designationBlinkState(djobKind, hasWorker, unitOnTile) {
    if (!isBlinkingDesignationJob(djobKind) || !hasWorker) return 0;
    return unitOnTile ? 2 : 1;
  }
  function designationGlyphVisible(djobKind, nowMs, hasWorker, unitOnTile) {
    var s = designationBlinkState(djobKind, hasWorker, unitOnTile);
    if (s === 2) return activeBlinkVisible(nowMs);
    if (s === 1) return unitStatusBlinkVisible(nowMs);
    return true;
  }
  // B135 worked-tile alternation: while a unit stands ON a worker-claimed designation tile,
  // native alternates the tile between the dwarf and the designation/object under it. The
  // glyph holds the activeBlinkVisible half of the 400ms half-beat (state 2 above), so the
  // unit takes the OTHER half -- exact anti-phase on one shared clock.
  function workedTileUnitVisible(nowMs) {
    return !activeBlinkVisible(nowMs);
  }
  function hasBlinkingDesignationJob(djobs) {
    if (!Array.isArray(djobs)) return false;
    for (var i = 0; i < djobs.length; i++)
      if (djobs[i] && djobs[i].w && isBlinkingDesignationJob(djobs[i].k)) return true;
    return false;
  }
  // B139: flow-cloud overlay policy (miasma/smoke/mist/...). EXACT twin of
  // dwf-tiles.js's FLOW_STYLES/flowOverlayFor (documented parity duplication, same
  // convention as the vehicle/projectile stamps): the per-tile densest-flow record has
  // ridden the block wire since WC-15 (t.cloud = {type,density}) but neither renderer
  // consumed it. One translucent cloud cell over the tile, opacity from density
  // (floor 0.2, saturating ~0.75 by density 64), breathing on the shared 800ms beat
  // (78% on the off half). Adding smoke/mist/dust later is ONE line in each table.
  // TX18: EXACT twin of dwf-tiles.js FLOW_STYLES -- each entry names DF's native
  // EVENT_FLOWS art token so the GL path samples the real FLOW_MIASMA sprite (4 frames) from
  // the atlas instead of a flat white radial stamp; rgb stays only as the procedural-haze
  // fallback tint for the no-sprite (mock-atlas / sheet-unloaded) path.
  var FLOW_STYLES_GL = {
    0: { token: "FLOW_MIASMA", rgb: [150, 64, 176] },   // Miasma: native EVENT_FLOWS art (TX18)
  };
  function flowOverlayForGL(cloud, nowMs) {
    if (!cloud || typeof cloud.type !== "number") return null;
    var style = FLOW_STYLES_GL[cloud.type];
    var d = typeof cloud.density === "number" ? cloud.density : 0;
    if (!style || d <= 0) return null;
    var a = 0.2 + 0.55 * Math.min(1, d / 64);   // fallback-haze alpha (unchanged)
    var sa = 0.9;                                // authored-sprite alpha: strong, not faint (TX18)
    if (!unitStatusBlinkVisible(nowMs)) { a *= 0.78; sa *= 0.85; }
    return { token: style.token || null, rgb: style.rgb, alpha: a, spriteAlpha: sa };
  }
  function markDesignationJobBlink(list, gx, gy, dj, unitOnTile) {
    if (!isBlinkingDesignationJob(dj.k)) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i].gx === gx && list[i].gy === gy) {
        list[i].djobKind = dj.k; list[i].djobWorker = !!dj.w; list[i].djobActive = !!unitOnTile;
        return;
      }
    }
  }
  // B135: camera-plane unit tiles ("x|y|z", raw wire integer coords) for the state-2
  // (worker ON the tile) decision at overlay-build time. view.units rides every AUX view
  // the render controller hands over; null when absent (tests/offline) -> state 1 fallback.
  function unitTileSet(view) {
    var us = (view && view.units) || null;
    if (!us || !us.length) return null;
    var set = new Set();
    for (var i = 0; i < us.length; i++) {
      var u = us[i];
      if (u && typeof u.x === "number" && typeof u.y === "number") set.add(u.x + "|" + u.y + "|" + u.z);
    }
    return set.size ? set : null;
  }
  function machineAnimPhase(nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    return Math.floor(nowMs / MACHINE_ANIM_MS);
  }
  function machineFrameParityGL(nowMs, freezeAnim) {
    return freezeAnim ? 0 : (machineAnimPhase(nowMs) % 2);
  }
  var MACHINE_TYPES_GL = { ScrewPump: 1, WaterWheel: 1, Windmill: 1, AxleHorizontal: 1, AxleVertical: 1, GearAssembly: 1 };
  function hasDrawableMachineGL(buildings) {
    if (!Array.isArray(buildings)) return false;
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      if (b && MACHINE_TYPES_GL[b.type] && (typeof b.bst === "number") && (b.bst & 1)) return true;
    }
    return false;
  }
  function machineCadenceStepGL(buildings, nowMs, lastPhase, freezeAnim) {
    if (freezeAnim || !hasDrawableMachineGL(buildings)) return { phase: -1, dirty: false };
    var phase = machineAnimPhase(nowMs);
    return { phase: phase, dirty: phase !== lastPhase };
  }

  // TX4 reopen #2: building AUX snapshots describe the current viewport, while the retained
  // GL scene (and its instance offsets) may use a larger padded cache rectangle. A building
  // beat must therefore take only the fresh AUX-owned building list from `latestView`; crops
  // remain block-owned and must be re-extracted from the exact tile/origin basis that built the
  // retained terrain. Mixing latestView.tiles with sceneView.origin shifts or drops crops after
  // a machine/AUX rebuild, most visibly immediately after an elevation change.
  function buildingRebuildViewGL(sceneView, latestView) {
    if (!sceneView || !sceneView.origin || !latestView || !latestView.origin ||
        sceneView.origin.z !== latestView.origin.z) return latestView;
    return Object.assign({}, sceneView, {
      buildings: Array.isArray(latestView.buildings) ? latestView.buildings : [],
      freezeAnim: latestView.freezeAnim,
      machineParity: latestView.machineParity,
    });
  }

  // Tier resolution, GL-shaped: mirrors dwf-tiles.js's resolveUnitTier() field-for-field
  // (same ah/sw/sh/ax/ay wire fields, same races lookup order: tier1 per-unit composite -> tier3
  // flat race sheet cell -> tier4 layered/baked civ portrait -> tier5 dot), but resolves
  // READINESS through the GL atlas's registerDynamicSheet/resolve instead of an <img> onload
  // callback. Both the per-unit composite (W-E baker, content-addressed /unit-sprite/<hash>.png)
  // and the two baked civ-race portraits (dwarf.png/dwarf_female.png -- verified 32x32 SINGLE-
  // CELL images, not a sprite grid) are content-addressed from the atlas's point of view, so both
  // tiers share the ONE registerDynamicSheet+resolve(key,col,row) path WB-8 built for exactly
  // this ("Unit composites ... get their OWN allocation path" -- WB-8's own banner). tier3 (a
  // flat per-race cell, e.g. AARDVARK -> creatures_surface.png) is an ordinary STATIC atlas
  // sheet, same resolve() path as every terrain/building sprite. Safe (and expected, per the
  // atlas's own contract) to call every frame for every currently-visible unit -- a hit just
  // refreshes the dynamic-sheet LRU touch.
  function resolveUnitTierGL(u, races, atlas) {
    if (!u || !atlas) return { tier: 5 };
    if (u.ah && typeof u.sw === "number" && typeof u.sh === "number") {
      var ready1 = atlas.registerDynamicSheet(u.ah, "/unit-sprite/" + u.ah + ".png");
      if (ready1) return { tier: 1 };
      // tier 2 (fetch in flight / evicted-forever-on-404, WE-2): fall through, same chain as
      // canvas2d's resolveUnitTier -- the fetch was already kicked off by the call above.
    }
    var rec = races && u.rt && races[u.rt];
    if (rec && rec.sheet && typeof rec.col === "number") return { tier: 3, rec: rec };
    if (rec && (rec.layered || rec.baked)) {
      var bname = (u.ct === "FEMALE") ? "dwarf_female.png" : (rec.baked || "dwarf.png");
      var ready4 = atlas.registerDynamicSheet(bname, "/" + bname);
      if (ready4) return { tier: 4, key: bname };
      return { tier: 5 }; // in-flight/failed: dot until it resolves, same as tier 1's fallthrough
    }
    return { tier: 5 };
  }

  // View-side lerp between the last two ~30Hz unit-stream snapshots -- same MODEL as the
  // smooth-cursor overlay (dwf-tiles.js's CURSOR_LERP_MS/ingestSmoothCursors): each
  // ingest() re-aims the lerp target at the new position, starting the glide from the CURRENTLY
  // INTERPOLATED position (not the stale raw target), so a new update mid-glide never pops.
  // Pure (no DOM/GL/atlas) -- testable with fabricated timestamps. `?nolerp=1` (spec Rollback
  // note: "a pure view-side lerp behind a flag; revert-safe") short-circuits to the newest raw
  // position every tick, i.e. the old snap-to-latest behaviour, for a zero-risk revert lever.
  //
  // Timestamp source (RECONCILE note): rather than threading an exact wire-arrival instant
  // through dwf-ws.js (the spec's suggested touchpoint), ingest() is driven by
  // Date.now() at the moment the rAF loop (dwf-render.js) notices `latest.units` changed
  // identity -- at most one rAF tick (~16ms) later than the true arrival, which is already
  // smaller than every other source of jitter in this pipeline (canvas2d itself only ever
  // *paints* a units update at its own next rAF tick too, via markMapUpdate/mapDirty) and far
  // smaller than UNIT_LERP_MS below. This keeps WB-13 entirely inside its own file, with zero
  // risk to W-A's ack/queue-policy code in dwf-ws.js.
  var UNIT_LERP_MS = 66; // ~2x the AUX stream's ~33ms metronome (dwf-ws.js's
                          // arrivalGapEwma/estBehindMsNow commentary) -- absorbs ordinary
                          // network jitter without ever visibly lagging the true position.
  function createUnitInterpolator(opts) {
    opts = opts || {};
    var lerpMs = (typeof opts.lerpMs === "number") ? opts.lerpMs : UNIT_LERP_MS;
    var nolerp = !!opts.nolerp;
    var tracks = new Map(); // unit id -> {fromX,fromY,toX,toY,tStart,raw}

    function currentXY(tr, nowMs) {
      if (nolerp || lerpMs <= 0) return { x: tr.toX, y: tr.toY };
      var a = (nowMs - tr.tStart) / lerpMs;
      if (a < 0) a = 0; else if (a > 1) a = 1;
      return { x: tr.fromX + (tr.toX - tr.fromX) * a, y: tr.fromY + (tr.toY - tr.fromY) * a };
    }

    // Fold a fresh units[] snapshot into the tracked set. A unit id missing from `units` is
    // dropped immediately -- matches canvas2d, which simply stops drawing a unit not present in
    // the current array (no lingering ghost / no fade-out animation).
    function ingest(units, nowMs) {
      var seen = new Map();
      var list = units || [];
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (!u || typeof u.id === "undefined" || typeof u.x !== "number" || typeof u.y !== "number") continue;
        seen.set(u.id, true);
        var tr = tracks.get(u.id);
        if (!tr) {
          tracks.set(u.id, { fromX: u.x, fromY: u.y, toX: u.x, toY: u.y, tStart: nowMs, raw: u });
          continue;
        }
        var cur = currentXY(tr, nowMs);
        tr.fromX = cur.x; tr.fromY = cur.y;
        tr.toX = u.x; tr.toY = u.y;
        tr.tStart = nowMs;
        tr.raw = u; // z/rt/ct/ah/sw/sh/ax/ay always reflect the newest wire state (never lerped)
      }
      var stale = [];
      tracks.forEach(function (_tr, id) { if (!seen.has(id)) stale.push(id); });
      for (var s = 0; s < stale.length; s++) tracks.delete(stale[s]);
    }

    // Current interpolated {x,y} per tracked unit PLUS every other (non-interpolated) field
    // from its most recent raw record. Returns a plain array; iteration order is whatever
    // Map.forEach gives (buildUnits() below doesn't depend on any particular order).
    function tick(nowMs) {
      var out = [];
      tracks.forEach(function (tr) {
        var cur = currentXY(tr, nowMs);
        var u = tr.raw;
        out.push({
          id: u.id, x: cur.x, y: cur.y, z: u.z, rt: u.rt, ct: u.ct,
          ah: u.ah, sw: u.sw, sh: u.sh, ax: u.ax, ay: u.ay,
          // B23 REGRESSION FIX (live report 07-09): this rebuild dropped the server's
          // see-down tag, so buildUnits' own-z gate discarded EVERY below-camera unit in GL
          // (c2d reads the raw record and was never affected). st rides for the same reason
          // (window #13 status icons would have been eaten by this wrapper).
          //
          // B277: st2 MUST ride too, and its absence is why NO overhead bubble rendered in the GL
          // path -- not even MIGRANT. Most statuses live in the SECOND status word; this wrapper
          // forwarded `st` and silently dropped `st2`, so the resolver and the draw call both ran
          // perfectly and received `undefined` for every second-word status. The whole feature was
          // dead while its fixtures stayed green, because the fixtures call the resolver BELOW this
          // interpolator and never see the drop. Anything added to the wire for units must be added
          // here as well, or it vanishes with no error.
          sd: u.sd, st: u.st, st2: u.st2,
        });
      });
      return out;
    }

    return { ingest: ingest, tick: tick, size: function () { return tracks.size; } };
  }

  // =========================================================================================
  // SCENE-BUILD CORE (pure -- no DOM/GL). Converts a decoded window view ({origin,width,height,
  // tiles:[...]}) into the interleaved instance buffer, mirroring dwf-tiles.js's
  // drawTileComposite draw order so instance order IS painter's order. Every sprite blit
  // becomes an instance with a resolved atlas cell; every fillRect (base colour, tint wash,
  // ambient) becomes a SOLID_CELL instance carrying the colour in its tint. `ctx` injects the
  // atlas + maps so this is testable with a mock atlas (node harness) and identical in-browser.
  // =========================================================================================

  // A SceneBuilder holds the growable instance buffer + its typed-array views, and the map/
  // atlas context. Reused across rebuilds (no per-rebuild allocation once warm).
  function createSceneBuilder(ctx) {
    ctx = ctx || {};
    var atlas = ctx.atlas || null;
    var spriteMap = ctx.spriteMap || null;
    var tokenMap = ctx.tokenMap || null;
    var shadowCellMap = ctx.shadowCellMap || null;
    var Adj = ctx.adjacency || (typeof root.DwfAdjacency !== "undefined" ? root.DwfAdjacency : null);
    // WB-10: {getChunk(z,key), chunkKeyFor(x,y)} -- the SAME public read API dwf-cache.js
    // (WA-6/7) already exposes on window.DwfCache. Read-only usage; no cache-file edits
    // needed for this item (per its own territory note). null in every context that doesn't
    // wire one (node tests, offline atlas page) -- descent is then unconditionally skipped.
    var cacheReader = ctx.cacheReader || null;
    // Map<tt(number), {ttname,shape,mat,special}>, fetched by the seam from GET
    // /tiletype_meta.json (WA-5) and handed in via setMaps -- THIS file keeps its own copy
    // rather than reaching into dwf-cache.js's private table, same dual-mode/no-cross-
    // file-coupling convention as MAT_COLOR/hashXY/wallPrefix above.
    var tiletypeMeta = ctx.tiletypeMeta || null;
    // WB-11 sparse-layer maps -- fetched by the seam (dwf-render.js's loadMaps) from the
    // SAME committed JSON files dwf-tiles.js already loads (item_map.json/plant_map.json/
    // tree_map.json/spatter_map.json); null in any context that doesn't wire one (node tests,
    // offline pages) simply disables that sparse layer, same "layer falls back, never throws"
    // convention as every other optional map here.
    var itemMap = ctx.itemMap || null;
    function applySheetGeometryFromItemMap() {
      if (atlas && itemMap && itemMap.sheet_geometry && typeof atlas.setSheetGeometry === "function") {
        atlas.setSheetGeometry(itemMap.sheet_geometry);
      }
    }
    applySheetGeometryFromItemMap();
    var plantMap = ctx.plantMap || null;
    var treeMap = ctx.treeMap || null;
    var spatterMap = ctx.spatterMap || null;
    // WB-12: the SAME committed web/building_map.json the canvas2d path loads (fetched by the
    // seam -- see dwf-render.js's loadMaps); null just means every building falls back to
    // MISSING_BUILDING (same "layer falls back, never throws" convention as every map above).
    var buildingMap = ctx.buildingMap || null;
    // WB-13: the SAME committed web/creatures_map.json dwf-tiles.js already loads
    // ({cell, races:{RACE:{sheet,col,row}|{layered,baked}}}) -- null just means every unit
    // resolves to tier 5 (the fallback dot), same "layer falls back, never throws" convention.
    var creaturesMap = ctx.creaturesMap || null;
    // WC-17 GL parity: the SAME committed web/grass_colors.json dwf-tiles.js already
    // loads (see loadGrassColors there) -- null just means grassSpeciesTintRGBA() always falls
    // back to the flat TINT_COLORS.grassSummer wash (same "layer falls back, never throws"
    // convention as every optional map above).
    var grassColors = ctx.grassColors || null;
    // T1a/T1c/T1d (asset-material-parity-spec 2026-07-08): material identity + palette-swap
    // table + the wire-driven (type,subtype)->ITEMDEF token map, both forwarded by the seam
    // (dwf-render.js). materialMap gives mat_type==0 items their exact inorganic identity
    // (EXACT family, palette row, per-material silhouette cells); itemDefTokens gives GL the
    // itemdef->bytoken resolution step it structurally lacked (the root of the minecart/tool/
    // toy/weapon PARITY-MISMATCH class). Both null-safe: absent => pre-T1 GL behavior exactly.
    var materialMap = ctx.materialMap || null;
    var itemDefTokens = ctx.itemDefTokens || null;
    // B256: numeric df::item_type -> "TYPE" (GET /item_type_meta.json), forwarded from
    // dwf-tiles.js by dwf-render.js exactly like itemDefTokens. Needed so the AUX
    // projectile wire's NUMERIC item_type can enter the item resolver. Null-safe: absent =>
    // projectiles keep the legacy marker, nothing else changes.
    var itemTypeNames = ctx.itemTypeNames || null;
    // Palette default-color lookup + a remap closure the atlas calls per swapped cell (built
    // once when materialMap lands; see buildPaletteRemap / paletteRemapFor below). Default entries
    // 0 and 9 share RGB 47,48,56; native DF uses FIRST-match precedence (B273's aligned native
    // AQUA Masons differential: 12 exact index-0 targets, zero index-9), so keep the first binding.
    var paletteLookup = null;
    function buildPaletteLookup() {
      paletteLookup = null;
      matInorganicByIdGL = null; // T2: id-join cache follows the materialMap instance
      var def = materialMap && (materialMap.default_row ||
        (materialMap.palette && materialMap.palette.rows && materialMap.palette.rows[0]));
      if (!def || !def.length) return;
      var m = new Map();
      for (var k = 0; k < def.length; k++) {
        var c = def[k];
        var key = c && c.length >= 3
          ? (((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255)) : null;
        if (key !== null && !m.has(key)) m.set(key, k);
      }
      paletteLookup = m;
    }
    buildPaletteLookup();
    // Returns a remap(cellData,w,h) fn that rewrites default-palette pixels to palette row
    // `palRow` in place (exact-match, non-palette pixels untouched -- engine semantics §1.2).
    function paletteRemapFor(palRow) {
      var rows = materialMap && materialMap.palette && materialMap.palette.rows;
      var target = rows && rows[palRow];
      if (!paletteLookup || !target || !target.length) return null;
      var look = paletteLookup;
      return function (d) {
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          var k = look.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          if (k !== undefined) { var t = target[k]; if (t) { d[i] = t[0]; d[i + 1] = t[1]; d[i + 2] = t[2]; } }
        }
      };
    }

    var cap = 0;               // instance capacity
    var buf = null, f32 = null, u16 = null, u8 = null;
    var k = 0;                 // current instance write cursor
    // R1: instance coordinates are world anchored. All existing emitters intentionally keep
    // their grid-relative math (including the adjacency grids); this single translation at the
    // write boundary preserves their painter order while making i_grid stable across pans.
    var emitOriginX = 0, emitOriginY = 0;

    function ensureCapacity(n) {
      if (n <= cap) return;
      var newCap = Math.max(n, (cap * 2) | 0, 4096);
      var newBuf = new ArrayBuffer(newCap * INSTANCE_BYTES);
      // WB-13: buildUnits() below writes ONLY the tail past `staticCount`, relying on the
      // static terrain/building prefix already in `buf` surviving a capacity grow triggered by
      // EITHER caller -- so a grow must copy forward, never start from a blank buffer (pre-
      // WB-13 this was safe to skip: the only caller, buildScene, always rewrote the whole
      // buffer from k=0 immediately after growing anyway).
      if (buf) new Uint8Array(newBuf).set(new Uint8Array(buf, 0, Math.min(buf.byteLength, newBuf.byteLength)));
      buf = newBuf; cap = newCap;
      f32 = new Float32Array(buf);
      u16 = new Uint16Array(buf);
      u8 = new Uint8Array(buf);
    }

    // Emit one instance. x,y are scene-grid coords and are translated to WORLD tile coords at
    // the buffer boundary. cell = atlas index or SOLID_CELL. tint rgba in 0..255 (a=255 =>
    // opaque). attr = attribute bits.
    function emit(x, y, cell, r, g, b, a, attr) {
      if (k >= cap) return; // capacity clamp (never overflow the buffer)
      var fo = k * 4;
      f32[fo] = x + emitOriginX; f32[fo + 1] = y + emitOriginY;
      var so = k * 8;
      u16[so + 4] = cell; u16[so + 5] = attr || 0;
      var bo = k * INSTANCE_BYTES;
      u8[bo + 12] = r; u8[bo + 13] = g; u8[bo + 14] = b; u8[bo + 15] = a;
      k++;
    }
    function emitSolid(x, y, rgb, alpha255, attr) { emit(x, y, SOLID_CELL, rgb[0], rgb[1], rgb[2], alpha255, attr); }
    function emitSprite(x, y, cell, attr) { emit(x, y, cell, 255, 255, 255, 255, attr || 0); }

    // token -> loaded atlas cell (>0), or 0 if the token has no sheet OR the sheet is not yet
    // packed. Mirrors dwf-tiles.js resolveCell returning null on "not loaded": callers
    // treat 0 as "no sprite, fall back to colour" exactly like the canvas2d path.
    function tokenCell(token) {
      var entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
      if (!entry || !entry.sheet || !atlas) return 0;
      // WB-15: a token with >1 authored frames (WC-10's /sprites/map.json `frames` array --
      // e.g. BROOK_BED_E/RIVER_BED_N at 16 frames, CAMPFIRE/CAMPFIRE_TOP at 4, both verified
      // against the real vanilla_environment raws) resolves through WB-8's resolveAnimated
      // instead of the plain grid resolve, landing on a CONSECUTIVE atlas run (frame i ==
      // base+i) the shader can walk with zero scene-build cost (see the ATTR_ANIMFRAMES banner
      // above). A token with 0-1 frames (the overwhelming majority) is unaffected -- same
      // resolve() call as before WB-15.
      var c = (entry.frames && entry.frames.length > 1 && atlas.resolveAnimated)
        ? atlas.resolveAnimated(token, entry.sheet, entry.frames)
        : atlas.resolve(entry.sheet, entry.col, entry.row);
      return (c > 0) ? c : 0;
    }

    // B241 boulder variants (canvas2d boulderVariant parity -- see dwf-tiles.js's
    // banner for the raws evidence): the 8 BOULDER cells live in a 4x2 grid at (0,0) on
    // terrain_boulders.png; sprite_map.cpp only publishes cell (0,0). Stable pick off WORLD
    // coords (t.x/t.y) so a boulder never reshapes on pan; vanilla-binding guard as in 2D.
    function boulderVariantGL(t, gx, gy, palRow) {
      var entry = spriteMap && spriteMap.BOULDER;
      if (!entry || entry.sheet !== "terrain_boulders.png" || entry.col !== 0 || entry.row !== 0 || !atlas) return 0;
      var wx = (t && typeof t.x === "number") ? t.x : gx;
      var wy = (t && typeof t.y === "number") ? t.y : gy;
      var h = hashXY(wx, wy);
      var col = h & 3, row = (h >> 2) & 1, c = 0;
      if (typeof palRow === "number" && atlas.resolvePalette) {
        var remap = paletteRemapFor(palRow);
        if (remap) c = atlas.resolvePalette(entry.sheet, col, row, palRow, remap);
      }
      if (!(c > 0)) c = atlas.resolve(entry.sheet, col, row);
      return (c > 0) ? c : 0;
    }

    // Resolve an ordinary terrain token through the material palette before it enters the
    // instance stream. The returned atlas cell is already recolored, so its instance tint stays
    // identity and no color layer can spill through transparent sprite pixels.
    function paletteTokenCellGL(token, palRow) {
      var entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
      if (typeof palRow === "number" && entry && entry.sheet && atlas && atlas.resolvePalette) {
        var remap = paletteRemapFor(palRow);
        var pc = remap ? atlas.resolvePalette(entry.sheet, entry.col, entry.row, palRow, remap) : 0;
        if (pc > 0) return pc;
      }
      return tokenCell(token);
    }

    // WB-15: the animFrames/animRate attr bits for `token`, or 0 if it has no (or one) frame --
    // a separate lookup from tokenCell (which only returns the resolved atlas index) so callers
    // that don't care about animation (resolveShadowCell/wallJoinCell -- no animated token
    // exists among wall-join/shadow decals in the shipped raws today) pay nothing extra, while
    // resolveSprite's base/overlay tokens (the ones actually meant to animate) can OR this into
    // the emitted instance's attr alongside seeDownAttr.
    function animAttrForToken(token) {
      var entry = spriteMap && spriteMap[token];
      var frames = entry && entry.frames;
      if (!frames || frames.length <= 1) return 0;
      return encodeAnimAttr(frames.length, defaultAnimRateCodeForToken(token));
    }

    // B47 material-family CONSTRUCTION FLOOR/TRACK art (canvas2d parity -- see
    // dwf-tiles.js's resolveConstructionFloor banner for the full rationale). The offline
    // token map is material-blind (every constructed floor -> grey FLOOR_STONE_BLOCK); DF draws
    // the built-from material's own floor sheet (wire base_mt/base_mi, wire_v1.cpp B47) recolored
    // by that material's palette row. Metal/stone/wood floor sheets are 100% default-palette
    // (verified) so atlas.resolvePalette reproduces the native color; glass floors are pre-colored
    // variants. Track variants overlay the built-rail cell (designations.png track family).
    var CONS_GLASS_FLOOR_TOKEN = { 3: "GLASS_GREEN_FLOOR", 4: "GLASS_CLEAR_FLOOR", 5: "GLASS_CRYSTAL_FLOOR" };
    function constructionTrackMask(ttname) {
      var m = /Track([NSEW]+)$/.exec(ttname || "");
      if (!m) return 0;
      var s = m[1];
      return (s.indexOf("N") >= 0 ? 1 : 0) | (s.indexOf("S") >= 0 ? 2 : 0) |
             (s.indexOf("E") >= 0 ? 4 : 0) | (s.indexOf("W") >= 0 ? 8 : 0);
    }
    // WALLSFIX (canvas2d parity: consMaterial) -> {family, palRow}|null for a construction material.
    function paletteRowRgbGL(palRow) {
      if (typeof palRow !== "number" || !materialMap || !materialMap.palette) return null;
      var row = materialMap.palette.rows && materialMap.palette.rows[palRow];
      var c = row && row[7];
      return (c && c.length >= 3) ? [c[0], c[1], c[2]] : null;
    }
    function plantWoodRowGL(base_mi) {
      var ids = materialMap && materialMap.plant_ids;
      var id = ids && ids[base_mi];
      var p = id && materialMap.plant && materialMap.plant[id];
      return p && typeof p.WOOD === "number" ? p.WOOD : null;
    }
    function consMaterialGL(base_mt, base_mi) {
      if (typeof base_mt !== "number" || base_mt < 0) return null;
      if (CONS_GLASS_FLOOR_TOKEN[base_mt]) {
        var prg = matPalRowForGL({ mat_type: base_mt });
        return { family: "GLASS", glassMt: base_mt, palRow: (typeof prg === "number") ? prg : null, tintRgb: paletteRowRgbGL(prg) };
      }
      if (base_mt >= 419) {
        var wr = plantWoodRowGL(base_mi);
        return { family: "WOOD", palRow: wr, woodRow: wr, tintRgb: paletteRowRgbGL(wr) || [150, 120, 84] };
      }
      if (base_mt === 0) {
        var ino = materialMap && materialMap.inorganic && materialMap.inorganic[base_mi];
        var fam = ino && ino.family;
        var pr = ino && typeof ino.row === "number" ? ino.row : null;
        var prOkG = (typeof pr === "number") && materialMap && materialMap.palette
          && materialMap.palette.rows && materialMap.palette.rows[pr];
        var row = prOkG ? pr : null;
        return { family: fam || "STONE", palRow: row, tintRgb: paletteRowRgbGL(row) };
      }
      return null;
    }
    // WALLSFIX (canvas2d parity: consMaterialRgb) -> representative material RGB for the wall fill.
    function consMaterialRgbGL(base_mt, base_mi) {
      var m = consMaterialGL(base_mt, base_mi);
      return m && m.tintRgb ? m.tintRgb : null;
    }
    // B273 (canvas2d parity): every palette-authored natural/construction wall class gets the
    // material row. Magma/ice/tree stay authored color.
    function wallMaterialGL(t) {
      if (!t) return null;
      var mat = t.mat || "";
      var m = consMaterialGL(t.base_mt, t.base_mi);
      if (!m) return null;
      if (mat === "CONSTRUCTION") return m;
      if (mat === "STONE" && m.family === "STONE") return m;
      if (mat === "SOIL" && m.family === "SOIL") return m;
      if (mat === "MINERAL" && (m.family === "STONE" || m.family === "GEM")) return m;
      return null;
    }
    function wallMaterialRgbGL(t) {
      var m = wallMaterialGL(t);
      return m && m.tintRgb ? m.tintRgb : null;
    }
    // B281 (canvas2d parity): natural material wall faces sit over DF's standard dark
    // hidden-rock texture. STATE_COLOR applies to the face sprite only, never this backing.
    function wallBackingTokenGL(t, gx, gy, openMask) {
      if (!t || (t.shape || "") !== "WALL" || (t.mat || "") === "CONSTRUCTION") return null;
      if (!wallMaterialGL(t)) return null;
      // B282 (canvas2d parity): mask 0 means fully buried, so wallJoinCell emits no face.
      // Without a face, an opaque hidden-rock cell becomes a visible full-tile box.
      if (!((openMask | 0) & 0xff)) return null;
      return "HIDDEN_ROCK_" + ((hashXY(gx, gy) % 5) + 1);
    }
    function wallJoinPalRowGL(t) {
      var m = wallMaterialGL(t);
      if (!m || typeof m.palRow !== "number") return null;
      return m.palRow;
    }
    // PURE decision (canvas2d parity: constructionFloorPlan) -> {token, palRow, mask} or null.
    // FLOOR+RAMP -> material floor art; STAIR -> PALETTE_STAIR_<kind>; FORTIFICATION -> FORTIFICATION
    // (wood -> FORTIFICATION_WOOD). All palette-swapped per material (see dwf-tiles.js banner).
    function fortificationOpenTokenGL(prefix, openMask) {
      // Adjacency bits N=1,S=2,W=4,E=8; suffix letters must equal the set bits (see the
      // canvas2d twin fortificationOpenToken's banner for the pixel-level derivation).
      var m = openMask & 15;
      var suffix = m === 15 ? "NSWE" : m === 11 ? "NSE" : m === 7 ? "NSW" :
        m === 13 ? "NWE" : m === 14 ? "SWE" : m === 3 ? "NS" : m === 12 ? "WE" :
        m === 9 ? "NE" : m === 5 ? "NW" : m === 10 ? "SE" : m === 6 ? "SW" : null;
      return suffix ? (prefix + "_OPEN_" + suffix) : prefix;
    }
    function constructionFloorPlanGL(ttname, base_mt, base_mi, openMask) {
      var nm = ttname || "";
      var isFloor = /^(?:Shoddy)?ConstructedFloor/.test(nm);
      var isRamp = /^(?:Shoddy)?ConstructedRamp/.test(nm);
      var stairM = /^ConstructedStair(UD|U|D)$/.exec(nm);
      var isFort = nm === "ConstructedFortification";
      if (!isFloor && !isRamp && !stairM && !isFort) return null;
      var m = consMaterialGL(base_mt, base_mi);
      if (!m) return null;
      var token = null, palRow = null, mask = 0, multiplyRgb = null;
      if (isFloor) {
        mask = constructionTrackMask(nm);
        if (m.family === "GLASS") token = CONS_GLASS_FLOOR_TOKEN[m.glassMt];
        else if (m.family === "WOOD") { token = "WOOD_FLOOR"; palRow = m.palRow; }
        else { token = (m.family === "METAL") ? "METAL_FLOOR" : "FLOOR_STONE_BLOCK"; palRow = m.palRow; }
      } else if (isRamp) {
        mask = constructionTrackMask(nm);
        token = "STONE_RAMP_OTHER";
        multiplyRgb = m.tintRgb;
      } else if (stairM) {
        var kind = (stairM[1] === "UD") ? "UPDOWN" : (stairM[1] === "U") ? "UP" : "DOWN";
        token = "PALETTE_STAIR_" + kind;
        palRow = m.palRow;
      } else {
        var prefix = (m.family === "WOOD") ? "FORTIFICATION_WOOD" : "FORTIFICATION";
        token = fortificationOpenTokenGL(prefix, typeof openMask === "number" ? openMask : 0);
        palRow = m.palRow;
      }
      if (!token) return null;
      return { token: token, palRow: palRow, mask: mask, multiplyRgb: multiplyRgb };
    }
    function resolveConstructionFloorGL(t, gx, gy, lookupTile) {
      var openMask = 0;
      // FORTFIX-r2: this referenced a bare `adjacency` -- undefined in the BROWSER scope (the module
      // symbol is `Adj`; only the Node test harness injects `adjacency`), so the first fortification
      // tile in view threw ReferenceError and blacked out the whole GL frame (confirm-sweep
      // 2026-07-09: every fortification card GL-blank, c2d fine). Mirror of tiles.js's `Adj` guard.
      if ((t.ttname || "") === "ConstructedFortification" && Adj && typeof gx === "number" && typeof gy === "number" && lookupTile) {
        openMask = Adj.computeMask8(lookupTile, gx, gy, Adj.isOpenNeighbor);
      }
      var plan = constructionFloorPlanGL(t.ttname || "", t.base_mt, t.base_mi, openMask);
      if (!plan || !atlas) return null;
      var token = plan.token, palRow = plan.palRow;
      var entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
      if (!entry || !entry.sheet) return null;
      var cell = 0;
      if (typeof palRow === "number") {
        var remap = paletteRemapFor(palRow);
        if (remap) cell = atlas.resolvePalette(entry.sheet, entry.col, entry.row, palRow, remap);
        if (cell <= 0) cell = atlas.resolve(entry.sheet, entry.col, entry.row);
      } else {
        cell = tokenCell(token);
      }
      if (!(cell > 0)) return null;
      var overlay = 0;
      var mask = plan.mask;
      if (mask) {
        var rc = DESIG_TRACK_CELL[mask];
        if (rc) { var oc = atlas.resolve(DESIG_SHEET, rc[0], rc[1]); if (oc > 0) overlay = oc; }
      }
      return { cell: cell, tintName: null, multiplyRgb: plan.multiplyRgb || null, overlay: overlay, animAttr: 0, overlayAnimAttr: 0 };
    }

    // B273 canvas2d parity: only natural sprite classes whose DF graphics flags carry a
    // material color index. Natural rough floor/stair/ramp sheets are pre-colored and absent.
    function terrainSpritePalRowGL(t, token) {
      if (!t || (token !== "BOULDER" && token !== "FORTIFICATION" &&
        !/^PEBBLES_FLOOR_/.test(token || ""))) return null;
      var mat = t.mat || "";
      if (mat !== "STONE" && mat !== "MINERAL") return null;
      var m = consMaterialGL(t.base_mt, t.base_mi);
      return m && typeof m.palRow === "number" ? m.palRow : null;
    }

    // Resolve a tile to { cell, tintName, overlayCell, animAttr, overlayAnimAttr } or null (fall
    // back to colour/grass). ttname -> token (tokenMap) -> cell (spriteMap), with the WB-3
    // base+overlay composite. WB-15: animAttr/overlayAnimAttr are the encodeAnimAttr() bits for
    // whichever of base/overlay actually carries >1 frames (see animAttrForToken) -- 0 for the
    // overwhelming majority of tokens, which costs the caller nothing (emitSprite ORs it in
    // unconditionally).
    // B119: SoilFloor<n> is material-blind; choose the authored sand-floor row from the
    // already-wired base material identity before the grass-under path runs.
    function sandFloorPlan(t, ttname) {
      if (!t || t.base_mt !== 0 || !/^SoilFloor[1-4]$/.test(ttname || "")) return null;
      var ino = materialMap && materialMap.inorganic && materialMap.inorganic[t.base_mi];
      var m = ino && /^SAND_(TAN|YELLOW|WHITE|BLACK|RED)$/.exec(ino.id || "");
      if (!m) return null;
      var prefix = m[1] === "TAN" ? "SAND" : "SAND_" + m[1];
      var vv = ((/([1-4])$/.exec(ttname) || [null, "1"])[1]);
      return { token: prefix + "_FLOOR_5", overlay: prefix + "_FLOOR_" + vv };
    }

    function resolveSprite(t, gx, gy, lookupTile) {
      if (t.hidden) return null;
      var ttname = t.ttname;
      if (!ttname) return null;
      // B36 (canvas2d parity): a WALL's terrain art is the darkened base fill + wallJoinCell's
      // adjacency-aware directional edge cell -- never the PHASE-1 full-block token. Returning
      // null here drops the flat block so only the dark interior + exposed rock edge render.
      // FORTIFICATION keeps its own full cell through the token map below.
      if ((t.shape || "") === "WALL") return null;
      var sandPlan = sandFloorPlan(t, ttname);
      if (sandPlan) {
        var sandCell = tokenCell(sandPlan.token);
        if (sandCell > 0) return { cell: sandCell, tintName: null, multiplyRgb: null, overlay: tokenCell(sandPlan.overlay), animAttr: 0, overlayAnimAttr: 0 };
      }
      // WC-17 wire grass, REDUCED to the worn-bare gate only (2026-07-07 grass-escalation,
      // the "multicolor patchwork" report -- see dwf-tiles.js's resolveSprite for the
      // full oracle evidence): the amount->tier cell pick + per-species grass_colors.json
      // tint that shipped here in the dgfix1 batch were verified WRONG against DF's own
      // render -- tier order inverted vs the raws' graze-STATE order (healthy lawn painted
      // the dead/brown color), thresholds assumed amount <= 100 while the live wire carries
      // 5..251, and (decisive) DF premium graphics don't tint grass by species at all
      // (GRASS_COLORS is ASCII-mode data; the native oracle shows uniform grass art across
      // 9 interleaved species). A grass-mat tile with coverage now falls THROUGH to the
      // ttname->token path below (GRASS_1..4 + the calibrated grassSummer wash -- identical
      // to canvas2d), keeping only DF's real "worn bare" signal from the wire tail.
      // grassTierIndex/grassSpeciesTintRGBA stay exported as pure helpers for a FUTURE
      // oracle-calibrated wear treatment, deliberately not applied to the live render.
      // B241 ("limestone pebbles don't render at all") -- canvas2d parity, see
      // dwf-tiles.js resolveSprite for the full story: the old B37 `bareExteriorPebble`
      // arm forced the grass + sparse-speckle composite onto every outside *Pebbles tile with
      // no grass tail, and the wire never ships grass tails for PEBBLES-shape tiles at all
      // (wire_v1.cpp gates on shape==FLOOR), so outside pebble floors rendered as plain lawn.
      // Deleted: tail-less pebbles fall through to the token map's DENSE pebble art
      // (PEBBLES_FLOOR_5/5B/5C/5D by VAR digit). Worn-bare (amount<=0) keeps its flat-color
      // meaning only for grass-material tiles.
      var isGrassMat = !!(t.mat && t.mat.indexOf("GRASS_") === 0);
      if (t.grass && t.grass.amount <= 0 && isGrassMat) return null; // worn bare grass -> flat
      // Grass-under compositing (grass-escalation stage 2, the "phantom stone" report) --
      // mirrors dwf-tiles.js's whitelist exactly (see its comment for the oracle
      // evidence + the B92 extension): DF draws grass coverage OVER outside non-grass floors;
      // the whole *Pebbles family (Stone/Mineral/Lava/Feature -- DF's one detailed-stone-rubble
      // floor, all mapping to PEBBLES_FLOOR_5 when bare) gets its SPARSE variant cell
      // (PEBBLES_FLOOR_1..4) on top of grass, SoilFloor* renders as plain grass. B92: the
      // pre-fix regex matched only StonePebbles, so dense grass on Mineral/Lava/Feature pebbles
      // (hovering as zoysia/satintail -- ordinary grasses) drew bare gray gravel. Any other
      // ttname carrying a tail keeps its normal art.
      if (t.grass && t.grass.amount > 0 && atlas && !isGrassMat) {
        var gu = /^(?:SoilFloor[1-4]|(?:Stone|Mineral|Lava|Feature)Pebbles([1-4]))$/.exec(ttname);
        if (gu) {
          var guCell = atlas.resolve("grass.png", hashXY(gx, gy) % 4, 0);
          if (guCell > 0) {
            var guOverlay = 0;
            if (gu[1]) {
              var pebbleToken = "PEBBLES_FLOOR_" + gu[1];
              guOverlay = paletteTokenCellGL(pebbleToken, terrainSpritePalRowGL(t, pebbleToken));
            }
            return {
              cell: guCell, tintName: "grassSummer",
              overlay: guOverlay,
              animAttr: 0, overlayAnimAttr: 0,
            };
          }
          // grass.png not resolved into the atlas yet -- fall through to the normal
          // ttname art for one rebuild (resolve() self-heals on the next rebuild).
        }
      }
      // B47: material-family construction floor/track art wins over the material-blind token map.
      var consCell = resolveConstructionFloorGL(t, gx, gy, lookupTile);
      if (consCell) return consCell;
      var map = spriteMap && tokenMap && tokenMap[ttname];
      if (map && map.token) {
        var baseCell = tokenCell(map.token);
        if (!baseCell) return null;   // token uncovered or sheet not loaded -> colour fallback
        var terrainPalRow = terrainSpritePalRowGL(t, map.token);
        // B241: BOULDER fans out to its 8 authored variant cells (canvas2d boulderVariant
        // parity -- same world-coord hashXY pick, same vanilla terrain_boulders.png guard).
        if (map.token === "BOULDER") {
          var bv = boulderVariantGL(t, gx, gy, terrainPalRow);
          if (bv > 0) baseCell = bv;
        } else if (typeof terrainPalRow === "number") {
          baseCell = paletteTokenCellGL(map.token, terrainPalRow);
        }
        var overlayCell = map.overlay ? tokenCell(map.overlay) : 0;
        return {
          cell: baseCell, tintName: map.tint || null, overlay: overlayCell,
          animAttr: animAttrForToken(map.token),
          overlayAnimAttr: map.overlay ? animAttrForToken(map.overlay) : 0,
        };
      }
      if (tokenMap && looksLikeGrassFloor(ttname)) {
        if (!atlas) return null;
        var gc = atlas.resolve("grass.png", hashXY(gx, gy) % 4, 0);
        if (!(gc > 0)) return null;
        return { cell: gc, tintName: null, overlay: 0, animAttr: 0, overlayAnimAttr: 0 };
      }
      return null;
    }

    function resolveHiddenCell(gx, gy) {
      var idx = (hashXY(gx, gy) % 5) + 1; // HIDDEN_ROCK_1..5
      var entry = spriteMap && spriteMap["HIDDEN_ROCK_" + idx];
      if (!entry || !entry.sheet || !atlas) return 0;
      var c = atlas.resolve(entry.sheet, entry.col, entry.row);
      return (c > 0) ? c : 0;
    }

    // WT25: canvas2d parity (dwf-tiles.js inMapBounds). Is the tile inside the world
    // footprint? `dims` is hello_ack's map.{w,h} (curMapDims, refreshed per buildScene from
    // ctx.mapDims or cacheReader.mapDims()). An in-bounds tt<0 tile is undiscovered rock -> hatch;
    // out-of-bounds tt<0 is the real map edge / sky column -> black.
    function inMapBoundsGL(t, dims) {
      if (!dims || !t) return false;
      var x = t.x, y = t.y;
      return typeof x === "number" && x >= 0 && x < dims.w &&
             typeof y === "number" && y >= 0 && y < dims.h;
    }

    // WT25 (canvas2d parity, dwf-tiles.js wantsHiddenHatch): does this tile paint DF's
    // unmined-rock hatch? A shipped-and-hidden tile (real tt + hidden bit) OR an in-bounds
    // undiscovered (tt<0) tile. Off-map tt<0 stays black. Single definition -- buildScene's
    // hatch decision AND the B235 overlay gate below both call it, so they cannot drift.
    function wantsHiddenHatchGL(t, dims) {
      if (!t) return false;
      var tt = (typeof t.tt === "number") ? t.tt : -1;
      if (t.hidden && tt >= 0) return true;
      return tt < 0 && inMapBoundsGL(t, dims);
    }

    // B235 (canvas2d parity, dwf-tiles.js overlaysAllowed -- see its banner for the full
    // story): may the per-tile overlay stack draw here? Only on DISCOVERED content (tt>=0, not
    // hidden), never on a hatched tile. The old gate was a bare `!t.hidden`, which let WT25's
    // in-bounds tt<0 tiles (hatched, but carrying no `hidden` flag) through; the ring of them
    // bordering the last known block then found shipped-hidden 8-neighbours and painted a
    // `visionShadow` fog-of-war decal, tracing a one-tile border along the loaded/unloaded
    // boundary -- the seam.
    function overlaysAllowedGL(t) {
      if (!t) return false;
      var tt = (typeof t.tt === "number") ? t.tt : -1;
      return tt >= 0 && !t.hidden;
    }

    // =======================================================================================
    // WB-11 sparse layers. Each `emit*` function is a direct port of its dwf-tiles.js
    // counterpart, one `emit`/`emitSprite` call per canvas `ctx.drawImage`/`fillRect`. All take
    // (t, gx, gy[, lookupTile]) and emit zero or more instances at (gx,gy) -- callers (buildTile)
    // gate them behind the same "drew && !hidden" guard the canvas2d overlay stack uses.
    // =======================================================================================

    // ---- (WB-11 #2) items --------------------------------------------------------------
    // Resolution order (WC-3 minus the bytoken step -- see the file banner): (1) furniture/
    // matvariant by material family; (2) bytype[type]; (3) MISSING_ITEM/_default.
    // Item identity extension (WIRE-TAILS): per-species/per-race art for harvested-plant items
    // (plant_map species cell) and corpse/vermin/pet items (creatures_map race cell), resolved
    // from the wire's resolved token. Mirrors dwf-tiles.js's resolveIdentityEntry.
    var ITEM_PLANT_PART_GL = { SEEDS: "SEED", PLANT: "PICKED", PLANT_GROWTH: "PICKED" };
    // GLOB (tallow) is DELIBERATELY excluded -- a rendered material, not a body part (see the
    // [gating] assertion in wc3_we4_wc12_apply_test.mjs). EGG (Phase-3 sweep fix, canvas2d parity):
    // an EGG item carried the LAYING creature's race and drew the live creature (or NOTHING for
    // giant races whose flat slot is blank); DF draws a single generic egg sprite per species
    // (tinted by shell material), so EGG is EXCLUDED and falls to item_map.bytype.EGG. MEAT stays
    // excluded because TX13 resolves its creature-material slot before identity. FISH stays IN --
    // prepared FISH ships item_fishst.race server-side. Mirrors dwf-tiles.js exactly.
    var ITEM_CREATURE_TYPES_GL = { CORPSE: 1, CORPSEPIECE: 1, REMAINS: 1, VERMIN: 1, PET: 1, FISH: 1, FISH_RAW: 1 };
    function creatureFoodItemCellGL(it) {
      if (!it || (it.type !== "MEAT" && it.type !== "GLOB") || it.identKind !== 2 || !it.ident)
        return null;
      var food = itemMap && itemMap.creature_food;
      var profile = food && food.by_creature && food.by_creature[it.ident];
      var layout = profile && food.profiles && food.profiles[profile];
      var kind = layout && layout[String(it.mat_type)];
      var entry = kind && food.cells && food.cells[kind];
      return entry && entry.sheet ? entry : null;
    }
    function resolveIdentityEntryGL(it) {
      if (!it || typeof it.identKind !== "number" || !it.ident) return null;
      if (it.identKind === 1 && plantMap) {
        // B31 FIX (GL parity, mirrors canvas2d resolveIdentityEntry): gate on ITEM TYPE.
        // WOOD/logs, DRINK, POWDER are plant-material items too but render a generic per-TYPE
        // cell, not a per-species plant cell. Only SEEDS/PLANT/PLANT_GROWTH use plant identity;
        // anything else returns null and falls through to the generic type/matvariant chain
        // (else the old unconditional pm.SEED fallback painted WOOD logs as seed sprites).
        var part = ITEM_PLANT_PART_GL[it.type];
        if (!part) return null;
        var pm = plantMap[it.ident];
        if (pm) return pm[part] || pm.PICKED || pm.SHRUB || pm.SEED || null;
      } else if (it.identKind === 2 && creaturesMap && creaturesMap.races) {
        if (ITEM_CREATURE_TYPES_GL[it.type]) {
          var cm = creaturesMap.races[it.ident];
          if (cm) {
            // B47 + CORPSETEX-B195 (canvas2d parity, CORPSETEX_B195_SKELETAL): which dead-art
            // cell depends on DF's own fresh->skeletal label (it.skeletal, wire iflags bit6).
            // skeletal -> .skeleton (bone) cell, else .corpse; fresh corpse (bit unset OR old
            // server) -> .corpse body art, else fall through to the flat living cell (NEVER the
            // skeleton). See dwf-tiles.js resolveIdentityEntry's banner for the mechanism.
            if (it.type === "CORPSE" || it.type === "CORPSEPIECE" || it.type === "REMAINS") {
              var corpseCell = (cm.corpse && cm.corpse.sheet) ? cm.corpse : null;
              var skelCell   = (cm.skeleton && cm.skeleton.sheet) ? cm.skeleton : null;
              if (it.skeletal) {
                var dead = skelCell || corpseCell;
                if (dead) return dead;
              } else {
                if (corpseCell) return corpseCell;
              }
            }
            if (cm.sheet) return cm;
          }
        }
      }
      return null;
    }
    // ---- T1a/T1d material identity (mirrors dwf-tiles.js matInorganic/matFamilyForItem/
    // matPalRowFor/materialItemCell EXACTLY -- the parity sweep G4 is the anti-drift guard).
    // T2 join (identKind 3 = server-resolved INORGANIC token, DLL window #9+): order-
    // independent ground truth, overrides the offline index join when present; unknown token
    // (modded world) => null, never a wrong-index guess. Graceful-dark pre-window-#9.
    var matInorganicByIdGL = null; // lazy {ID: entry}; reset in buildPaletteLookup on map swap
    function matInorganicGL(it) {
      if (!materialMap || !materialMap.inorganic || !it || it.mat_type !== 0) return null;
      if (it.identKind === 3 && it.ident) {
        if (!matInorganicByIdGL) {
          matInorganicByIdGL = Object.create(null);
          for (var j = 0; j < materialMap.inorganic.length; j++) {
            var e2 = materialMap.inorganic[j];
            if (e2 && e2.id) matInorganicByIdGL[e2.id] = e2;
          }
        }
        return matInorganicByIdGL[it.ident] || null;
      }
      var i = it.mat_index;
      if (typeof i !== "number" || i < 0 || i >= materialMap.inorganic.length) return null;
      return materialMap.inorganic[i] || null;
    }
    function matFamilyForItemGL(it) {
      var mt = it.mat_type;
      if (mt === 3 || mt === 4 || mt === 5) return "GLASS";
      if (mt === 0) {
        var e = matInorganicGL(it);
        if (e && e.family) return (e.family === "METAL") ? "METAL" : (e.family === "GLASS" ? "GLASS" : "STONE");
        return "STONE";
      }
      if (mt >= 419) return "WOOD";
      return null;
    }
    function matPalRowForGL(it) {
      if (!materialMap) return null;
      var mt = it.mat_type;
      if (mt === 0) { var e = matInorganicGL(it); return e && typeof e.row === "number" ? e.row : null; }
      if (mt === 3 || mt === 4 || mt === 5) {
        var b = materialMap.builtin && materialMap.builtin[String(mt)];
        return b && typeof b.row === "number" ? b.row : null;
      }
      if (mt >= 419 && it.identKind === 1 && it.ident && materialMap.plant) {
        var p = materialMap.plant[it.ident];
        if (p && typeof p.WOOD === "number") return p.WOOD;
      }
      return null;
    }
    var GLASS_ROUGH_KEY_GL = { 3: "GLASS_GREEN", 4: "GLASS_CLEAR", 5: "GLASS_CRYSTAL" };
    function pickRoughTierGL(value) {
      var tiers = itemMap && itemMap.rough_gem_tiers;
      if (!tiers || !tiers.length) return null;
      var chosen = tiers[0].cell;
      for (var i = 0; i < tiers.length; i++) if (value >= tiers[i].min_value) chosen = tiers[i].cell;
      return chosen || null;
    }
    function hatchCoverMaterialCellGL(it) {
      var map = itemMap && itemMap.hatch_cover_bymat;
      if (!map || !it) return null;
      if (it.mat_type === 0) {
        if (it.identKind === 3 && it.ident && map[it.ident]) return map[it.ident];
        var e = matInorganicGL(it);
        if (e && e.id && map[e.id]) return map[e.id];
      }
      if (it.mat_type >= 419 && it.identKind === 1 && it.ident) {
        return map["PLANT_MAT:" + it.ident + ":WOOD"] || null;
      }
      return null;
    }
    function materialItemCellGL(it, type) {
      if (!itemMap) return null;
      if (type === "HATCH_COVER") {
        var hc = hatchCoverMaterialCellGL(it);
        if (hc) return hc;
      }
      if (it.mat_type === 0) {
        var e = matInorganicGL(it);
        if (e) {
          if (type === "BOULDER" && itemMap.boulder_bymat && itemMap.boulder_bymat[e.id]) return itemMap.boulder_bymat[e.id];
          if (type === "ROUGH" && e.gem) { var c = pickRoughTierGL(e.value || 1); if (c) return c; }
          if ((type === "GEM" || type === "SMALLGEM") && e.gem) {
            // T2 join (wire gem `shape` i16, window #9+; mirrors dwf-tiles.js): shape ->
            // shape_tokens[shape] -> gem_shapes per-cut cell; -1/unknown -> the tier-1 default.
            if (typeof it.shape === "number" && it.shape >= 0 &&
                materialMap && materialMap.shape_tokens && itemMap.gem_shapes) {
              var stok = materialMap.shape_tokens[it.shape];
              var gsh = stok && itemMap.gem_shapes[stok];
              var cut = gsh && ((type === "GEM") ? gsh.large : gsh.small);
              if (cut) return cut;
            }
            var g = (type === "GEM") ? itemMap.gem_default : itemMap.smallgem_default;
            if (g) return g;
          }
        }
      }
      if (type === "ROUGH" && itemMap.rough_gem_glass) {
        var gk = GLASS_ROUGH_KEY_GL[it.mat_type];
        if (gk && itemMap.rough_gem_glass[gk]) return itemMap.rough_gem_glass[gk];
      }
      return null;
    }
    var PALETTIZABLE_SOURCE_GL = { itemdef: 1, material: 1, matvariant: 1, bytype: 1 };
    // Full resolution mirroring dwf-tiles.js resolveItemVisual, INCLUDING the itemdef->
    // bytoken step GL previously omitted (fixes the minecart/tool/toy/weapon PM class).
    function resolveItemVisualGL(it) {
      if (!itemMap) return null;
      var type = it.type;
      var food = creatureFoodItemCellGL(it);
      if (food) return { entry: food, source: "creaturefood" };
      var ident = resolveIdentityEntryGL(it);
      if (ident) return { entry: ident, source: "ident" };
      if (itemDefTokens && typeof it.subtype === "number" && it.subtype >= 0) {
        var tok = itemDefTokens.get(type + ":" + it.subtype);
        if (tok && itemMap.bytoken && itemMap.bytoken[tok]) return { entry: itemMap.bytoken[tok], source: "itemdef" };
      }
      var matCell = materialItemCellGL(it, type);
      if (matCell) return { entry: matCell, source: "material" };
      var base = ITEM_MATVARIANT_BASE[type];
      if (base && itemMap.matvariants && itemMap.matvariants[base]) {
        var fam = matFamilyForItemGL(it);
        var variants = itemMap.matvariants[base];
        if (fam && variants[fam]) return { entry: variants[fam], source: "matvariant" };
      }
      if (itemMap.bytype && itemMap.bytype[type]) return { entry: itemMap.bytype[type], source: "bytype" };
      if ((type === "CORPSE" || type === "CORPSEPIECE" || type === "REMAINS") && itemMap._corpse_fallback) {
        return { entry: itemMap._corpse_fallback, source: "corpse" };
      }
      var miss = itemMap._missing || itemMap[type] || itemMap._default || null;
      return miss ? { entry: miss, source: "missing" } : null;
    }
    // Thin cell-only wrapper (preserves the GL item test-hook contract).
    function resolveItemEntryGL(it) {
      var v = resolveItemVisualGL(it);
      return v ? v.entry : null;
    }

    // ---- TX1: barrel/bin contents-peek overlay (mirrors dwf-tiles.js's
    // containerPeekToken/containerPeekEntry EXACTLY -- see that file's banner for the
    // native mechanism: per-category ITEM_BARREL_TOP_*/ITEM_BIN_TOP_* overlay cells over
    // the container sprite, categories = df::item_bin_graphics_contents_type 1:1, wire
    // field = the CONTAINER_PEEK tail's representative contained item). Unmapped content
    // -> null -> plain container, never a guessed cell.
    var PEEK_CRAFT_TYPES_GL = { FIGURINE: 1, AMULET: 1, SCEPTER: 1, CROWN: 1, RING: 1, EARRING: 1, BRACELET: 1, TOTEM: 1, TOY: 1 };
    var PEEK_ARMOR_TYPES_GL = { ARMOR: 1, HELM: 1, GLOVES: 1, SHOES: 1, PANTS: 1 };
    function peekMatIsMetalGL(p) {
      if (!p || p.mat_type !== 0) return false;
      var e = matInorganicGL(p);
      return !!(e && e.family === "METAL");
    }
    function peekMatIsLeatherGL(p) {
      return !!p && p.mat_type >= 19 && p.mat_type <= 218;
    }
    function containerPeekTokenGL(it, peek) {
      if (!it || !peek || !peek.type) return null;
      var t = peek.type;
      if (it.type === "BARREL") {
        if (t === "MEAT") return "ITEM_BARREL_TOP_MEAT";
        if (t === "FISH" || t === "FISH_RAW") return "ITEM_BARREL_TOP_FISH";
        if (t === "CHEESE") return "ITEM_BARREL_TOP_CHEESE";
        if (t === "FOOD") return "ITEM_BARREL_TOP_MEAL";
        if (t === "PLANT" || t === "PLANT_GROWTH")
          return (peek.cflags & 0x01) ? "ITEM_BARREL_TOP_PLANT_SUBTERRANEAN" : "ITEM_BARREL_TOP_PLANT";
        if (t === "BOX") return "ITEM_BARREL_TOP_BAG";
        if (t === "DRINK" || t === "LIQUID_MISC")
          return (matFamilyForItemGL(it) === "METAL") ? "LIQUID_FOR_BARREL_METAL" : "LIQUID_FOR_BARREL_WOOD";
        return null;
      }
      if (it.type === "BIN") {
        if (t === "AMMO") return "ITEM_BIN_TOP_AMMO";
        if (t === "BAR") return (peek.mat_type === 7) ? "ITEM_BIN_TOP_COAL" : "ITEM_BIN_TOP_BARS";
        if (t === "BLOCKS") return "ITEM_BIN_TOP_BLOCKS";
        if (t === "POWDER_MISC") return "ITEM_BIN_TOP_POWDERS";
        if (t === "COIN") return "ITEM_BIN_TOP_COINS";
        if (t === "GEM" || t === "SMALLGEM" || t === "ROUGH") return "ITEM_BIN_TOP_GEMS";
        if (t === "TRAPPARTS") return "ITEM_BIN_TOP_MECHANISMS";
        if (t === "BOX") return "ITEM_BIN_TOP_BAGS";
        if (t === "BOOK") return "ITEM_BIN_TOP_BOOKS";
        if (t === "SHEET") return "ITEM_BIN_TOP_SHEETS";
        if (t === "CLOTH") return "ITEM_BIN_TOP_CLOTH";
        if (t === "SKIN_TANNED") return "ITEM_BIN_TOP_LEATHER";
        if (t === "WEAPON") return "ITEM_BIN_TOP_WEAPONS";
        if (t === "TRAPCOMP") return "ITEM_BIN_TOP_TRAP_COMPS";
        if (t === "CHAIN") return peekMatIsMetalGL(peek) ? "ITEM_BIN_TOP_CHAINS" : "ITEM_BIN_TOP_ROPES";
        if (PEEK_ARMOR_TYPES_GL[t])
          return peekMatIsMetalGL(peek) ? "ITEM_BIN_TOP_ARMOR_METAL"
            : (peekMatIsLeatherGL(peek) ? "ITEM_BIN_TOP_ARMOR_LEATHER" : "ITEM_BIN_TOP_CLOTHING");
        if (PEEK_CRAFT_TYPES_GL[t]) return "ITEM_BIN_TOP_CRAFTS";
        return null;
      }
      return null;
    }
    function containerPeekEntryGL(it, peek) {
      var tok = containerPeekTokenGL(it, peek);
      if (!tok || !itemMap || !itemMap.bytoken) return null;
      var e = itemMap.bytoken[tok];
      return (e && e.sheet) ? e : null;
    }

    function emitItem(t, gx, gy, attr) {
      var a = attr || 0;
      if (!itemMap || !t.item || !atlas) return;
      var it = t.item;
      // Spider web (WC-1 iflags bit0) priority, same as canvas2d -- variant pick uses (gx,gy)
      // here rather than canvas2d's screen-pixel (px,py): this file has no notion of screen
      // pixels in the scene-build core, and a GRID-coord hash is a strict improvement (stable
      // across zoom instead of flickering) -- documented deviation, not a parity bug.
      if (it.type === "THREAD" && (it.iflags & 0x01) && itemMap.web) {
        var variants = (itemMap.web.harmless && itemMap.web.harmless.length) ? itemMap.web.harmless : itemMap.web.thick;
        if (variants && variants.length) {
          var v = variants[hashInt(gx, gy) % variants.length];
          if (v && v.sheet) {
            var vc = atlas.resolve(v.sheet, v.col, v.row);
            if (vc > 0) { emitSprite(gx, gy, vc, a); return; }
          }
        }
      }
      var vis = resolveItemVisualGL(it);
      var e = vis && vis.entry;
      if (e && e.sheet) {
        // T1c/T1d: on a palettizable path, resolve a palette-swapped atlas cell (per material
        // row) so item art tints per material instead of collapsing to one grey sprite. The
        // swap supersedes the old WOOD/GLASS multiply tint; the fallback keeps the legacy tint.
        var palRow;
        if (materialMap && PALETTIZABLE_SOURCE_GL[vis.source]) {
          var pr = matPalRowForGL(it);
          if (typeof pr === "number") palRow = pr;
        }
        var c = -1;
        if (palRow !== undefined) {
          var remap = paletteRemapFor(palRow);
          if (remap) c = atlas.resolvePalette(e.sheet, e.col, e.row, palRow, remap);
        }
        // GRACEFUL FALLBACK (bug found via the 213412Z partial sweep): resolvePalette returns
        // PENDING (0) while the swap cell is being built AND stays 0 forever on a hard failure
        // (atlas full / bounds error). The original `c < 0` check never fired for 0, so the
        // item drew NOTHING -- a REGRESSION vs pre-T1, which always drew the plain cell (the
        // one-renderer-blank strip at y=173: item_scribe/nature/construction sheets). Any
        // c <= 0 from the palette path now falls back to the plain cell + legacy tint for this
        // frame; the atlas sheet-ready listener (dwf-render.js:131 lastKey reset) rebuilds
        // once the swap cell lands, so a transient shows the pre-T1 look instead of a blank.
        if (c <= 0) { c = atlas.resolve(e.sheet, e.col, e.row); palRow = undefined; }
        if (c > 0) {
          if (palRow !== undefined) {
            emitSprite(gx, gy, c, a);  // pixels already carry the material color
          } else {
            var fam = matFamilyFor(it.mat_type);
            var tint = fam && ITEM_TINT_RGB_BY_FAMILY[fam];
            if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], 255, a);
            else emitSprite(gx, gy, c, a);
          }
          // TX1: contents-peek overlay OVER the container sprite (only when the container
          // itself drew), emitted untinted -- the overlay cells are painted per-category
          // art. Mirrors dwf-tiles.js drawItem's peek composite.
          if (t.peek) {
            var pk = containerPeekEntryGL(it, t.peek);
            if (pk) {
              var pc = atlas.resolve(pk.sheet, pk.col, pk.row);
              if (pc > 0) emitSprite(gx, gy, pc, a);
            }
          }
        }
      }
      // WC-19: forbid/dump/melt mark over the item (full-tile in GL -- see the sheet-const
      // banner). Fires for the web-item branch's early return too? No: that path `return`s
      // above; webs are never forbid/dump-marked in practice, so this is an accepted omission.
      if (atlas) {
        var mtok = itemMarkToken(it.iflags);
        if (mtok) {
          var mr = DESIG_ITEM_ROW[mtok];
          if (typeof mr === "number") {
            var mc = atlas.resolve(DESIG_ITEM_SHEET, 0, mr);
            if (mc > 0) emitSprite(gx, gy, mc, a);
          }
        }
      }
    }

    // ---- WC-21: vermin / vermin-colony sprite (mirrors dwf-tiles.js drawVermin) -----
    // Resolves the server-provided creature token (WIRE-TAILS) to a creatures_map flat cell.
    function resolveVerminEntryGL(t) {
      var v = t.vermin;
      if (!v || !v.length || !creaturesMap || !creaturesMap.races) return null;
      var pick = null;
      for (var i = 0; i < v.length; i++) {
        var e = v[i];
        if (!e || !e.token) continue;
        var c = creaturesMap.races[e.token];
        if (!c || !c.sheet) continue;
        if (e.vflags & 0x01) return c;   // colony takes precedence
        if (!pick) pick = c;
      }
      return pick;
    }
    function emitVermin(t, gx, gy, attr) {
      if (!atlas) return;
      var e = resolveVerminEntryGL(t);
      if (e && e.sheet) {
        var c = atlas.resolve(e.sheet, e.col, e.row);
        if (c > 0) emitSprite(gx, gy, c, attr || 0);
      }
    }

    // ---- (WB-11 #1) spatter decals + item-spatter litter (WC-11/WC-12) -------------------
    function resolveSpatterFullKey(fam, gx, gy, lookupTile) {
      if (!Adj || !lookupTile) return "FULL_ISOLATED";
      var mask4 = 0;
      try {
        var mask8 = Adj.computeMask8(lookupTile, gx, gy, function (nt) {
          var nsp = nt && ((nt.spatters && nt.spatters[0]) || nt.spatter);
          return !!nt && spatterVisible(nsp && nsp.amount) && spatterFamilyForCtx(spatterMap, nsp) === fam;
        });
        mask4 = mask8 & Adj.CARDINAL_BITS;
      } catch (_) { mask4 = 0; }
      var suf = "";
      if (mask4 & Adj.BIT.N) suf += "N";
      if (mask4 & Adj.BIT.S) suf += "S";
      if (mask4 & Adj.BIT.W) suf += "W";
      if (mask4 & Adj.BIT.E) suf += "E";
      if (!suf) return "FULL_ISOLATED";
      if (suf === "NSWE") {
        var letters = ["A", "B", "C", "D", "E"];
        return "FULL_NSWE_" + letters[hashInt(gx, gy) % letters.length];
      }
      return "FULL_" + suf;
    }

    function emitSpatterFallbackWash(sp, gx, gy, attr) {
      if (!spatterVisible(sp && sp.amount)) return;
      var a = Math.min(0.4, 0.08 + sp.amount / 400);
      emitSolid(gx, gy, [140, 25, 20], Math.round(a * 255), attr || 0);
    }

    function emitSpatterDecals(t, gx, gy, lookupTile, attr) {
      var arr = t.spatters;
      if (!arr || !arr.length) return;
      if (!spatterMap || !atlas) { emitSpatterFallbackWash(firstVisibleSpatter(arr), gx, gy, attr); return; }
      var drewAny = false;
      for (var i = 0; i < arr.length && i < 4; i++) {
        var sp = arr[i];
        if (!sp || !spatterVisible(sp.amount)) continue;
        var fam = spatterFamilyForCtx(spatterMap, sp);
        var famDef = fam && spatterMap.families && spatterMap.families[fam];
        if (!famDef) continue;
        var shape = spatterShapeForCtx(spatterMap, sp.amount);
        var key = (shape === "FULL") ? resolveSpatterFullKey(fam, gx, gy, lookupTile) : partialLetterKey(shape, gx + i, gy + i);
        var cellDef = famDef.cells[key] || famDef.cells.FULL_ISOLATED;
        var c = cellDef ? atlas.resolve(famDef.sheet, cellDef.col, cellDef.row) : 0;
        if (c > 0) { emitSprite(gx, gy, c, attr || 0); drewAny = true; }
      }
      if (!drewAny) emitSpatterFallbackWash(firstVisibleSpatter(arr), gx, gy, attr);
    }

    // Fallen leaves/fruit litter -- always PARTIAL_n (never a FULL neighbor-joined sheet).
    function emitItemSpatterLitter(t, gx, gy, attr) {
      if (!atlas) return;
      // B138: ONE decal per tile (native parity) -- overlapping records used to each emit a
      // tinted instance, compounding darkness. pickItemSpatterLitter selects the single
      // deterministic winner; the loser records still ride the cache/hover, just not the draw.
      var best = pickItemSpatterLitter(t.itemSpatters, spatterMap);
      if (!best) return;
      var shape = spatterShapeForCtx(spatterMap, best.isp.amount);
      if (shape === "FULL") shape = "PARTIAL_4";
      var key = partialLetterKey(shape, gx, gy);
      var cellDef = best.famDef.cells[key];
      if (!cellDef) return;
      var c = atlas.resolve(best.famDef.sheet, cellDef.col, cellDef.row);
      if (c > 0) {
        var tint = itemSpatterTintRgb(best.fam, best.isp.rgb);
        if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], 255, attr || 0);
        else emitSprite(gx, gy, c, attr || 0);
      }
    }

    // ---- (WB-11 #4) plants/shrubs/saplings -----------------------------------------------
    function emitPlant(t, gx, gy, attr) {
      var p = t.plant;
      if (!p || !plantMap || !atlas) return;
      var part = p.part, id = p.id;
      if (part !== "SHRUB" && part !== "SAPLING") return;
      var e = id && plantMap[id] && plantMap[id][part];
      if (!e && part === "SAPLING" && treeMap && id && treeMap[id]) e = treeMap[id].SAPLING;
      if (!e) e = (part === "SHRUB") ? plantMap._default_shrub : plantMap._default_sapling;
      if (e && e.sheet) {
        var c = atlas.resolve(e.sheet, e.col, e.row);
        if (c > 0) emitSprite(gx, gy, c, attr || 0);
      }
    }

    // ---- (WB-11 #3) tree geometry (RECONCILE-WC14, see file banner) ----------------------
    function treeFamilyTable(entry, family) { return entry && entry[family]; }
    function resolveTreeCellGL(sel, id, gx, gy, lookupTile) {
      if (!treeMap || !sel || sel.skip) return null;
      var species = (id && treeMap[id]) || treeMap._default;
      if (!species) return null;
      var variant = sel.variant;
      if (variant === null && sel.adjacency) {
        variant = "_";
        if (Adj && lookupTile) {
          var mask = Adj.computeMask8(lookupTile, gx, gy, isCanopyNeighbor);
          var suffix = Adj.cardinalSuffix(mask).replace(/_/g, "");
          if (suffix) variant = suffix;
        }
      }
      function lookupFam(fam) {
        if (!fam) return null;
        var t1 = treeFamilyTable(species, fam);
        if (t1 && t1[variant]) return t1[variant];
        var t2 = treeFamilyTable(treeMap._default, fam);
        if (t2 && t2[variant]) return t2[variant];
        return null;
      }
      var cell = lookupFam(sel.family) || lookupFam(sel.altFamily);
      if (!cell && variant !== "_") {
        var saved = variant;
        variant = "_";
        cell = lookupFam(sel.family) || lookupFam(sel.altFamily);
        variant = saved;
      }
      if (!cell) {
        var flatKey = TREE_FLAT_FALLBACK[sel.family];
        if (flatKey) cell = species[flatKey] || (treeMap._default && treeMap._default[flatKey]);
      }
      return cell;
    }
    function emitTree(t, gx, gy, lookupTile, attr) {
      if (!treeMap || !atlas) return;
      var p = t.plant;
      // B62-r2: missing plant tail (see-down substitution / wire lookup miss) no longer
      // blanks the tile -- derive the part from shape/mat, species falls to _default
      // (canvas2d drawTree parity; see derivedTreePart's banner).
      var part = (p && p.part) || derivedTreePart(t);
      if (part !== "TRUNK" && part !== "BRANCH" && part !== "CANOPY" && part !== "LEAVES") return;
      var pid = (p && p.id) || null;
      var sel = parseTreeTtname(t.ttname || "");
      if (sel && sel.skip) return;
      var e = sel && resolveTreeCellGL(sel, pid, gx, gy, lookupTile);
      if (!e) {
        e = pid && treeMap[pid] && treeMap[pid][part];
        if (!e) e = treeMap._default && treeMap._default[part];
      }
      if (e && e.sheet) {
        var c = atlas.resolve(e.sheet, e.col, e.row);
        if (c > 0) {
          emitSprite(gx, gy, c, attr || 0);
          // B47: live directional trunk/branch cells composite the species' TREE_OVERLEAVES
          // leaf cell on top (canvas2d drawTree parity -- see resolveOverleavesGL banner).
          var over = resolveOverleavesGL(treeMap, sel, pid);
          if (over && over.sheet) {
            var oc = atlas.resolve(over.sheet, over.col, over.row);
            if (oc > 0) emitSprite(gx, gy, oc, attr || 0);
          }
        }
      }
    }

    // ---- (WB-12) buildings: multi-tile art, material tint, MISSING_BUILDING fallback --------
    // Mirrors dwf-tiles.js's (8) BUILDINGS pass (dwf-tiles.js ~2195-2269) field for
    // field: Type:Subtype alias -> Type:subtypeInt -> bare Type -> MISSING_BUILDING resolution;
    // per-subcell blit of a multi-tile `cells[][]` footprint (row/col CLAMPED to the map
    // entry's own grid, same as canvas2d -- a footprint bigger than its art repeats the last
    // row/col rather than going out of bounds); the single-cell `{sheet,col,row}` shape; the
    // wire:6 z-fade alpha. Runs as one pass over view.buildings, called from buildScene AFTER
    // the per-tile loop (buildTile) -- matching canvas2d's draw order (buildings drawn after
    // terrain/items/plants/trees, before creatures; WB-13 hasn't ported units into this file
    // yet, so nothing follows buildings in the GL dense pass today).
    //
    // Stage/state variants (report-W8's "stage/state variants as cell selection where the wire
    // carries them"): the wire DOES carry building.stage (tile_map_dump.cpp's getBuildStage),
    // but building_map.json has no stage-/state-keyed variant data at the flat-key level
    // buildingEntry() resolves against today (verified against the real committed map: zero
    // top-level entries carry a `states`/`stages` sub-object; the CONST_0..3/direction/firing
    // tokens that DO exist, e.g. BALLISTA_CONST_0/BALLISTA_N_FIRING, are keyed as raw TOKENs a
    // future direction/stage candidate-generation step would need to build from wire fields
    // that aren't read here -- squarely "direction/state wire fields = W-C" per this item's own
    // scope line). So this mirrors the canvas2d reference's ACTUAL behaviour (stage is not
    // consulted) rather than inventing a stage-keyed lookup with no map data behind it; b.stage
    // is intentionally unread here, same residual as the canvas2d path it mirrors.
    //
    // MISSING_BUILDING sheet-not-loaded-yet: canvas2d falls back to a stroked orange outline
    // (BLD_OUTLINE) in that transient case -- 2D line work, the SAME "not an instance-shaped
    // primitive" residual buildTile's stair/ramp X-strokes comment already documents for this
    // file. The GL dense pass simply omits the footprint for that one frame (atlas.resolve
    // returns 0 for every candidate cell -> nothing emitted) until defaults.png/the real sheet
    // finishes packing; self-heals via the seam's atlas.onSheetReady -> lastKey reset, same as
    // every other "sheet not loaded" case in this file.
    //
    // Material tint + z-fade COMBINED into one instance: canvas2d draws the sprite at
    // ctx.globalAlpha=bAlpha THEN a separate multiply-blend rect at alpha 0.7*bAlpha (nested
    // ctx.save/restore inherits the outer globalAlpha). This file has only ONE blend mode per
    // draw call (premultiplied alpha, spec §1.2), so both effects fold into the single
    // instance's own tint (buildingTintRgb, texel*tint) with alpha=round(bAlpha*255) -- exact
    // when bAlpha==1 (the overwhelmingly common camera-plane case), a documented approximation
    // only when a TINTED building is ALSO z-faded (dz!=0) simultaneously.
    // B63 (canvas2d customWorkshopEntry parity -- see its banner there): custom workshops'
    // def id is not on the wire; match footprint-driven against WORKSHOP_CUSTOM:* map keys
    // (vanilla: SOAP_MAKER 3x3, SCREW_PRESS 1x1 -- distinct sizes, exact pick).
    function customWorkshopEntryGL(b) {
      if (!buildingMap) return null;
      var w = Math.max(1, ((b.x2 | 0) - (b.x1 | 0)) + 1);
      var h = Math.max(1, ((b.y2 | 0) - (b.y1 | 0)) + 1);
      var keys = Object.keys(buildingMap);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("WORKSHOP_CUSTOM:") !== 0) continue;
        var e = buildingMap[keys[i]];
        if (e && e.w === w && e.h === h) return e;
      }
      return null;
    }

    // TX17 (GL parity): planned Construction -> DF planned-preview entry, else null. Mirrors
    // the canvas2d plannedConstructionEntry EXACTLY.
    function plannedConstructionEntryGL(b) {
      if (!buildingMap || !b || b.type !== "Construction") return null;
      var st = (typeof b.subtype === "number") ? b.subtype : -1;
      if (st < 0 || st >= CONSTRUCTION_PLANNED_TOKEN.length) return null;
      var tok = CONSTRUCTION_PLANNED_TOKEN[st];
      return (tok && buildingMap[tok]) ? buildingMap[tok] : null;
    }

    // B253 (GL parity -- the canvas2d statueEntry() banner in dwf-tiles.js carries the full
    // citation): a built statue is THREE cells, not one. Pedestal[material class][quality] +
    // the subject's BOTTOM cell on the statue's own tile; the subject's TOP cell ONE TILE ABOVE
    // (the B14 overhang row). All three are the same stone, so all three take the material tint
    // -- hence `overlayTint`. Creature statues (932 of them) live on their own sheets, hence
    // `overhangSheet`/`overlaySheet`. Same table copy convention as every other GL table here.
    var STATUE_OVERALL_CREATURE_GL = 2;   // item_statue_graphics_type_overall (df.itemdef.xml:2-9)
    var STATUE_OVERALL_EVENT_GL = 5;
    var STATUE_QUALITY_ARTIFACT_GL = 6;
    function statueSubjectGL(S, b) {
      if (!S.subjects) return S.default || null;
      var gt = (typeof b.sgt === "number") ? b.sgt : -1;
      if (gt === STATUE_OVERALL_CREATURE_GL && b.srt && S.creature) {
        var race = String(b.srt);
        var hit = S.creature[race] || S.creature[race.split(":")[0]];
        if (hit) return hit;
      } else if (gt === STATUE_OVERALL_EVENT_GL && S.event) {
        var etok = S.event[String(b.sgi)];
        if (etok && S.subjects[etok]) return S.subjects[etok];
      } else if (gt >= 0 && S.overall) {
        var otok = S.overall[String(gt)];
        if (otok && S.subjects[otok]) return S.subjects[otok];
      }
      return S.default || null;
    }
    function statueEntryGL(b) {
      if (!buildingMap || !b || b.type !== "Statue") return null;
      var S = buildingMap.statues;
      if (!S || !S.sheet || !S.pedestal) return null;
      // The statue's OWN stone (the item's, b.smt/b.smi), classified by the SAME item classifier
      // the canvas2d path uses; header material only as the pre-DLL fallback.
      var mat = (typeof b.smt === "number") ? { mat_type: b.smt, mat_index: b.smi } : b;
      var mc = matFamilyForItemGL(mat) || "STONE";
      var q = (typeof b.sq === "number") ? b.sq : 0;
      var ped = null;
      if (q >= STATUE_QUALITY_ARTIFACT_GL && Array.isArray(S.artifact) && S.artifact.length) {
        ped = S.artifact[Math.abs(b.id | 0) % S.artifact.length];
      } else {
        var row = S.pedestal[mc] || S.pedestal.STONE;
        if (row && row.length) ped = row[Math.min(Math.max(q, 0), row.length - 1)];
      }
      if (!ped) return null;
      var e = { sheet: S.sheet, w: 1, h: 1, cells: [[ped]] };
      var subj = statueSubjectGL(S, b);
      if (subj && subj.top && subj.bottom) {
        var ssheet = subj.sheet || S.sheet;
        e.overlaySheet = ssheet;
        e.overlay = [[subj.bottom]];
        e.overlayTint = true;
        e.overhangSheet = ssheet;
        e.overhang = [subj.top];
      }
      return e;
    }

    // B270 (GL parity): consume building_map.furniture's material/state cells and wrap the
    // selected cell as the same 1x1 building entry used by statueEntryGL. The canvas2d banner
    // carries the df-structures/raw citations; keep these deliberately duplicated lookup tables
    // in lockstep through b270_furniture_state_test.mjs.
    var FURNITURE_MAT_PREF_GL = ["WOOD", "STONE", "METAL", "GLASS", "GEM", "ROPE"];
    function furnitureMaterialKeyGL(variants, b) {
      var family = matFamilyForItemGL(b);
      if (family && variants[family]) return family;
      if (family === "WOOD" && variants.ROPE) return "ROPE";
      for (var i = 0; i < FURNITURE_MAT_PREF_GL.length; i++) {
        if (variants[FURNITURE_MAT_PREF_GL[i]]) return FURNITURE_MAT_PREF_GL[i];
      }
      return Object.keys(variants)[0] || null;
    }
    function furnitureStateKeyGL(b) {
      if (typeof b.bst !== "number") return null;
      switch (b.type) {
        case "Door": case "Floodgate": case "Hatch": return (b.bst & 1) ? "CLOSED" : "OPEN";
        case "GrateWall": case "GrateFloor": return (b.bst & 1) ? null : "OPEN";
        case "Cage": case "AnimalTrap": return (b.bst & 1) ? "OCCUPIED" : null;
        case "Weaponrack": case "Armorstand": return (b.bst & 1) ? "FULL" : null;
        case "TractionBench": return (b.bst & 1) ? "ROPE" : null;
        case "Hive": return ["EMPTY", "IN_USE", "PRODUCTS"][b.bst] || null;
        default: return null;
      }
    }
    function furnitureEntryGL(b) {
      if (!buildingMap || !buildingMap.furniture || !b) return null;
      var f = buildingMap.furniture[b.type];
      if (!f || !f.matvariants) return null;
      var variants = f.matvariants;
      var state = furnitureStateKeyGL(b);
      if (state && f.states && f.states[state]) {
        var sv = f.states[state];
        if (sv.sheet) return { sheet: sv.sheet, w: 1, h: 1, cells: [[sv]] };
        variants = sv;
      }
      var material = furnitureMaterialKeyGL(variants, b);
      var c = material && variants[material];
      return c ? { sheet: c.sheet, w: 1, h: 1, cells: [[c]] } : null;
    }

    function buildingEntryGL(b) {
      if (!buildingMap) return MISSING_BUILDING;
      var type = (b && b.type) || "";
      var st = (b && typeof b.subtype === "number") ? b.subtype : -1;
      // TX17: planned/in-progress constructions draw DF's authored preview art (see canvas2d banner).
      var pc = plannedConstructionEntryGL(b);
      if (pc) return pc;
      var furniture = furnitureEntryGL(b);
      if (furniture) return furniture;
      var cands = [];
      if (type === "Workshop" && st >= 0 && st < WORKSHOP_SUBTYPE.length) {
        var stName = WORKSHOP_SUBTYPE[st];
        if (stName === "Custom") {
          var ce = customWorkshopEntryGL(b);
          if (ce) return ce;
        }
        cands.push("Workshop:" + stName);
      }
      if (type === "Furnace" && st >= 0 && st < FURNACE_SUBTYPE.length) cands.push("Furnace:" + FURNACE_SUBTYPE[st]);
      if (type) { cands.push(type + ":" + st); cands.push(type); }
      for (var i = 0; i < cands.length; i++) {
        if (cands[i] && buildingMap[cands[i]]) return buildingMap[cands[i]];
      }
      return MISSING_BUILDING;
    }
    // WC-8 (GL parity): MACHINE buildings resolve their sprite from the WC-6 wire fields
    // (b.dir direction, b.bst state bit0=active) against building_map.json's `machines`
    // section (WC-5), synthesizing the SAME {sheet,w,h,cells} shape buildingEntryGL returns
    // so emitBuilding's multi-cell loop draws it unchanged. Mirrors the canvas2d
    // machineEntry() EXACTLY (identical family-key + frame-select tables) -- the two paths
    // are intentionally duplicated the same way buildingEntry/buildingEntryGL already are;
    // wb12_buildings_test.mjs cross-checks both against the same building_map.json to catch
    // divergence. Buildings live in the STATIC scene (rebuilt on data/camera change, plus the
    // wrapper's gated 500 ms machine cadence when an active machine is visible), so active
    // machines animate in idle scenes without a continuous rebuild loop for non-machine views.
    var WINDMILL_DIR8_GL = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    var SCREWPUMP_DIR4_GL = ["N", "E", "S", "W"];
    function machineFamilyKeyGL(b) {
      var dir = (typeof b.dir === "number") ? b.dir : 0;
      switch (b.type) {
        case "ScrewPump": return "SCREWPUMP_" + SCREWPUMP_DIR4_GL[dir & 3];
        case "WaterWheel": return dir ? "WATER_WHEEL_NS" : "WATER_WHEEL_WE";
        case "AxleHorizontal": return dir ? "AXLE_HORIZONTAL_NS" : "AXLE_HORIZONTAL_WE";
        case "AxleVertical": return "AXLE_VERTICAL";
        case "GearAssembly": return "GEAR_ASSEMBLY";
        case "Windmill": return "WINDMILL_" + WINDMILL_DIR8_GL[dir & 7];
        default: return null;
      }
    }
    // `sub` placement mirrors canvas2d machineEntry() EXACTLY: 2-element = explicit [dx,dy];
    // 1-element = linear sub-cell index laid out row-major within the building's own bbox
    // footprint (screw pumps -- axis follows the reported N/S 1x2 vs E/W 2x1 bbox); empty = 1x1.
    function machineEntryGL(b, map, frameParity) {
      if (!b || !map || !map.machines || !MACHINE_TYPES_GL[b.type]) return null;
      var key = machineFamilyKeyGL(b);
      var fam = key && map.machines[key];
      if (!fam || !Array.isArray(fam.frames) || fam.frames.length === 0) return null;
      var active = (typeof b.bst === "number") && (b.bst & 1);
      var fi = active ? ((((frameParity | 0) % fam.frames.length) + fam.frames.length) % fam.frames.length) : 0;
      var frame = fam.frames[fi] || fam.frames[0];
      if (!Array.isArray(frame) || frame.length === 0) return null;
      var fpw = Math.max(1, (b.x2 | 0) - (b.x1 | 0) + 1);
      var placed = [], gw = 1, gh = 1, i;
      for (i = 0; i < frame.length; i++) {
        var c = frame[i]; var s = c.sub || []; var dx, dy;
        if (s.length >= 2) { dx = (s[0] | 0); dy = (s[1] | 0); }
        else if (s.length === 1) { var idx = (s[0] | 0); dx = idx % fpw; dy = Math.floor(idx / fpw); }
        else { dx = 0; dy = 0; }
        if (dx + 1 > gw) gw = dx + 1; if (dy + 1 > gh) gh = dy + 1;
        placed.push({ dx: dx, dy: dy, col: c.col, row: c.row });
      }
      var cells = [];
      for (var y = 0; y < gh; y++) { var row = []; for (var x = 0; x < gw; x++) row.push(null); cells.push(row); }
      for (i = 0; i < placed.length; i++) { var p = placed[i]; cells[p.dy][p.dx] = { col: p.col, row: p.row }; }
      return { sheet: fam.sheet, w: gw, h: gh, cells: cells };
    }
    // B27a (GL parity): FARM PLOTS. Byte-identical to canvas2d farmPlotEntry -- furrowed-soil
    // bed (per-tile hashed FURROWED_SOIL_1..4 via the shared hashXY) when fallow, FARMPLOT_PLANTED
    // when a crop is set (b.bextra != 0xFFFF). Resolves the environment bed tokens through the
    // spriteMap (atlas.resolve lazy-loads the sheet, same path wallJoinCell uses). Emits the same
    // {sheet,w,h,cells} shape emitBuilding already blits; the null-cell texsweep FarmPlot entry
    // (invisible plots) is bypassed.
    var FARM_EMPTY = 0xFFFF;
    function farmCellRefGL(token) {
      var s = spriteMap && spriteMap[token];
      return (s && s.sheet) ? s : null;
    }
    function farmPlotEntryGL(b) {
      if (!b || b.type !== "FarmPlot" || !spriteMap) return null;
      var hasExtra = typeof b.bextra === "number";
      var planted = hasExtra && b.bextra !== FARM_EMPTY;
      if (planted) {
        var p = farmCellRefGL("FARMPLOT_PLANTED") || farmCellRefGL("FARMPLOT") || farmCellRefGL("FURROWED_SOIL_1");
        if (!p) return null;
        return { sheet: p.sheet, w: 1, h: 1, cells: [[{ col: p.col, row: p.row }]] };
      }
      var fur = [];
      for (var i = 1; i <= 4; i++) { var c = farmCellRefGL("FURROWED_SOIL_" + i); if (c) fur.push(c); }
      if (!fur.length) {
        var f = farmCellRefGL("FARMPLOT");
        if (!f) return null;
        return { sheet: f.sheet, w: 1, h: 1, cells: [[{ col: f.col, row: f.row }]] };
      }
      var x1 = b.x1 | 0, y1 = b.y1 | 0;
      var w = Math.max(1, (b.x2 | 0) - x1 + 1), h = Math.max(1, (b.y2 | 0) - y1 + 1);
      var cells = [];
      for (var y = 0; y < h; y++) {
        var row = [];
        for (var x = 0; x < w; x++) { var fc = fur[hashXY(x1 + x, y1 + y) % fur.length]; row.push({ col: fc.col, row: fc.row }); }
        cells.push(row);
      }
      return { sheet: fur[0].sheet, w: w, h: h, cells: cells };
    }
    function farmCropPlansGL(view) {
      var policy = (typeof DwfFarmCrops !== "undefined") ? DwfFarmCrops : null;
      return policy && typeof policy.collect === "function"
        ? policy.collect((view && view.tiles) || [], (view && view.width) | 0,
          (view && view.height) | 0, plantMap)
        : [];
    }
    function emitFarmCrops(view) {
      var plans = farmCropPlansGL(view);
      for (var i = 0; i < plans.length; i++) {
        var p = plans[i], c = p.cell, ac = atlas.resolve(c.sheet, c.col, c.row);
        if (ac) emit(p.gx, p.gy, ac, 255, 255, 255, 255, 0);
      }
    }
    function paintFarmLayers(paintBuildings, paintCrops) {
      var policy = (typeof DwfFarmCrops !== "undefined") ? DwfFarmCrops : null;
      if (policy && typeof policy.paintAboveBuildings === "function")
        policy.paintAboveBuildings(paintBuildings, paintCrops);
      else { paintBuildings(); paintCrops(); }
    }
    // Per-buildScene machine animation parity (set at the top of the buildings loop). ~2 Hz,
    // frozen to 0 under the freeze seam for deterministic parity captures.
    var machineParity = 0;
    function emitBuilding(b, ox, oy, camZ) {
      if (!b || isOverlayOnlyBuildingType(b.type) || !atlas) return;
      var x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
      if (typeof x1 !== "number" || typeof y1 !== "number" ||
        typeof x2 !== "number" || typeof y2 !== "number") return;
      var bdz = (typeof b.z === "number" && typeof camZ === "number") ? b.z - camZ : 0;
      // ZBELOW-BUILDINGS: B03 still drops stale off-z AUX ghosts, except when the server tags a
      // below-camera building as visible through an open column. Above-camera is always deleted.
      // Buildings are tile-composite content, so they use the raw terrain ladder (no unit floor).
      var seeDownB = !!b.sd && bdz < 0;
      if (bdz !== 0 && !seeDownB) return;
      var bAlpha = seeDownB ? belowAlpha(-bdz) : 1;
      var a255 = Math.max(0, Math.min(255, Math.round(bAlpha * 255)));
      var tint = null;
      // B273: exact component STATE_COLOR palette substitution first.
      // COMPATIBILITY LIMIT (INTENTIONALLY INEXACT): with an old DLL (no cpal) or an unknown
      // modded cpal, crgb multiplies the WHOLE sprite inside its alpha mask. It cannot spill onto
      // adjacent ground, but it DOES alter non-palette painted detail. This is graceful
      // degradation, never a claim of exact DF palette behavior.
      var bPalRow = pickBuildingPalRow(b, materialMap);
      var bTintRgb = pickBuildingTintRgb(b);
      if (typeof bPalRow !== "number" && bTintRgb) tint = buildingTintRgb(bTintRgb);
      var e = machineEntryGL(b, buildingMap, machineParity) || farmPlotEntryGL(b)
            || statueEntryGL(b) || buildingEntryGL(b);   // B253: statues are a 3-cell composite
      if (!e || !e.sheet) return;
      // B253: `sheet` defaults to the entry's own, but a statue's SUBJECT cells can sit on a
      // different sheet than its plinth (the 932 creature statues do), so callers may pass one.
      function put(bx, by, col, row, sheet) {
        var sh = sheet || e.sheet, c = 0;
        if (typeof bPalRow === "number" && atlas.resolvePalette) {
          var remap = paletteRemapFor(bPalRow);
          if (remap) c = atlas.resolvePalette(sh, col, row, bPalRow, remap);
        }
        if (!(c > 0)) c = atlas.resolve(sh, col, row);
        if (!c) return;
        var gx = bx - ox, gy = by - oy;
        if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], a255, 0);
        else emit(gx, gy, c, 255, 255, 255, a255, 0);
      }
      if (Array.isArray(e.cells)) {
        var gh2 = e.cells.length;
        var gw2 = e.w || (e.cells[0] ? e.cells[0].length : 1);
        // B47 (canvas2d parity, wagon 3x3): multi-cell art SMALLER than the footprint is
        // CENTERED, flanking tiles stay bare (the old edge clamp stamped the wagon's 1x3
        // strip on all 3 columns). 1x1 entries keep the pattern-stamp repeat (bridges).
        var bfw = x2 - x1 + 1, bfh = y2 - y1 + 1;
        var multiCell = (gw2 > 1 || gh2 > 1);
        var offX = (multiCell && gw2 < bfw) ? ((bfw - gw2) >> 1) : 0;
        var offY = (multiCell && gh2 < bfh) ? ((bfh - gh2) >> 1) : 0;
        for (var by = y1; by <= y2; by++) {
          var ry = by - y1 - offY;
          if (multiCell && gh2 < bfh && (ry < 0 || ry >= gh2)) continue;
          if (ry >= gh2) ry = gh2 - 1; if (ry < 0) ry = 0;
          var rowArr = e.cells[ry];
          if (!rowArr) continue;
          for (var bx = x1; bx <= x2; bx++) {
            var rx = bx - x1 - offX;
            if (multiCell && gw2 < bfw && (rx < 0 || rx >= gw2)) continue;
            if (rx >= gw2) rx = gw2 - 1; if (rx < 0) rx = 0;
            var cd = rowArr[rx] || rowArr[rowArr.length - 1];
            if (cd) {
              put(bx, by, cd.col, cd.row);
              // B20: tool/decoration OVERLAY layer, emitted UNTINTED on top of the
              // material-tinted base (same tile, after the base -> painter's-order on top).
              // B253: `overlayTint` opts the overlay INTO the material tint (canvas2d parity) --
              // a statue's subject is carved from the same stone as its plinth.
              if (e.overlay && e.overlaySheet) {
                var orow = e.overlay[ry];
                var ocd = orow && (orow[rx] || orow[orow.length - 1]);
                if (ocd) {
                  if (e.overlayTint) {
                    put(bx, by, ocd.col, ocd.row, e.overlaySheet);
                  } else {
                    var oc = atlas.resolve(e.overlaySheet, ocd.col, ocd.row);
                    if (oc) emit(bx - ox, by - oy, oc, 255, 255, 255, a255, 0);
                  }
                }
              }
            }
          }
        }
        // B14 (GL parity): the "sticking up above" overhang row (chimney/stack/roof), drawn one
        // tile ABOVE the top footprint row (y1 - 1), aligned to footprint columns, tinted like
        // the base via put() (+ its overlay row if present). Was clipped before -> tall building
        // art (furnaces) lost its height illusion.
        if (Array.isArray(e.overhang)) {
          var ow = e.overhang.length;
          // B47: align the overhang with the (possibly centered) art -- one row above the
          // ART's own top row, spanning only the art's columns (canvas2d parity).
          var ohy = y1 + offY - 1;
          for (var obx = x1; obx <= x2; obx++) {
            var orx = obx - x1 - offX;
            if (multiCell && ow < bfw && (orx < 0 || orx >= ow)) continue;
            if (orx >= ow) orx = ow - 1; if (orx < 0) orx = 0;
            var ocell = e.overhang[orx];
            if (!ocell) continue;
            // B253: `overhangSheet` (optional) -- a creature statue's TOP cell is on its own
            // creature-statue page, not on the entry's base sheet. Absent => the base sheet.
            put(obx, ohy, ocell.col, ocell.row, e.overhangSheet);
            if (Array.isArray(e.overlayOverhang) && e.overlaySheet) {
              var oov = e.overlayOverhang[orx];
              if (oov) {
                var ooc = atlas.resolve(e.overlaySheet, oov.col, oov.row);
                if (ooc) emit(obx - ox, ohy - oy, ooc, 255, 255, 255, a255, 0);
              }
            }
          }
        }
      } else if (typeof e.col === "number") {
        for (var by2 = y1; by2 <= y2; by2++) {
          for (var bx2 = x1; bx2 <= x2; bx2++) put(bx2, by2, e.col, e.row);
        }
      }
    }

    // (WB-11 #5's emitFloorEdgeDecal used to live here -- DELETED by B71-r3, see the
    //  "floor-edge (grass-creep) decal: DELETED" banner near isOpenTileShapeMat.)

    function resolveLiquidCell(t) {
      if (t.hidden) return 0;
      var flow = t.flow || 0;
      var liquid = t.liquid || "none";
      if (flow <= 0 || (liquid !== "water" && liquid !== "magma") || !atlas) return 0;
      var e = liquidCellFor(liquid, flow);
      if (!e) return 0;
      var c = atlas.resolve(e.sheet, e.col, e.row);
      return (c > 0) ? c : 0;
    }

    // ---- shore foam synthesis (WB-15, render-buffer verdict §B "shore/foam direction
    // markers") ------------------------------------------------------------------------------
    // DF's OWN render buffer carries isolated high bits in `liquid_flag` on water-adjacent
    // tiles (0x200/0x2000/0x20000/0x200000 -- verdict §B) marking shore/foam direction, and that
    // same verdict's §A found the foam SPRITES are NULL surfaces in the raws atlas walk -- DF
    // generates them at runtime. Both facts are oracle-only (captured via /tiledump, never sent
    // over this client's wire), so there is no flag to read and no sprite to copy even if there
    // were: this item's own note requires the client to SYNTHESIZE the decal instead.
    //
    // Direction comes from the SAME computeMask8 adjacency machinery every other directional
    // decal in this file already uses (wall-join/shadow decals) -- a "land" predicate (true for
    // any neighbor that is NOT itself flowing water/magma, including an undiscovered/
    // out-of-window neighbor: computeMask8's own documented 1-tile viewport-edge artifact,
    // favoring a visible decal over a silently missing one). Pixels come from the fluids sheet's
    // authored edge cells -- verified against the real vanilla_environment raws
    // (graphics_fluids.txt): UNDERWATER_EDGE_{N,S,W,E,NW,NE,SW,SE} / UNDERMAGMA_EDGE_{...} sit at
    // liquids.png cols 4-6, ONE bind each (no frame series exists for these 8 tokens in the
    // shipped raws) -- so this decal is a static synthesis, not itself clock-animated, and reuses
    // Adj.DIR_NAMES's exact N,S,W,E,NW,NE,SW,SE order as the token suffix (already spriteMap-
    // resolvable via the ordinary tokenCell path, same as every other token in this file).
    // Capped at 4 emitted directions (same defensive cap as emitSpatterDecals) -- a convex
    // shoreline realistically sets at most 2-3 bits.
    //
    // Draw-order residual (documented, not fixed here): the render-buffer verdict's own layer
    // list puts the animated water/foam class (`high_flow`) AFTER buildings/creatures, not
    // immediately over the water tile's own composite -- this file emits foam inside the SAME
    // per-tile stack as the liquid depth cell (buildTile), one pass before the cross-tile
    // buildings pass (WB-12) and units (WB-13) even start. In practice this only matters if a
    // building/unit overlaps a flowing-water tile's footprint, which the game rarely allows, so
    // it's the same class of residual as WB-12's stage-variant note above, not a correctness bug
    // for the shore-foam feature itself.
    function emitShoreFoam(t, gx, gy, lookupTile, attr) {
      if (!atlas) return;
      var tokens = liquidEdgeTokens(t, gx, gy, lookupTile, Adj);
      for (var i = 0; i < tokens.length; i++) {
        var c = tokenCell(tokens[i]);
        if (c) emitSprite(gx, gy, c, attr || 0);
      }
    }

    // tileColor (dwf-tiles.js verbatim): base fill colour or null (leave background).
    function tileColor(t, skipLiquidColor) {
      var tt = (typeof t.tt === "number") ? t.tt : -1;
      if (tt < 0) return null;
      if (t.hidden) return HIDDEN_COLOR;
      if (!skipLiquidColor) {
        var flow = t.flow || 0, liquid = t.liquid || "none";
        if (flow > 0 && liquid === "magma") return magmaRgb(flow);
        if (flow > 0 && liquid === "water") return waterRgb(flow);
      }
      var shape = t.shape || "NONE", mat = t.mat || "NONE";
      var base = matRgb(mat);
      // B62: TREE/MUSHROOM WALL is a trunk/cap, not stone -- keep its natural wood base.
      if (shape === "WALL" || shape === "FORTIFICATION") {
        if (isTreeWallMat(mat)) return base;
        // B281 (canvas2d parity): the natural wall's installed hidden-rock underlay owns
        // transparent face pixels. Keep the fallback dark if that texture is not ready.
        if (shape === "WALL" && mat !== "CONSTRUCTION" && wallMaterialGL(t)) return HIDDEN_COLOR;
        var cr = wallMaterialRgbGL(t);
        if (cr) return darken(cr, WALL_DARKEN);
        return darken(base, WALL_DARKEN);
      }
      // B118: RampTop/RAMPSPACE is open AIR, not a teal terrain cell.
      if (shape === "EMPTY" || shape === "NONE" || shape === "RAMP_TOP") return null;
      return base;
    }

    function resolveShadowCell(table, mask8) {
      if (!shadowCellMap || !spriteMap) return 0;
      var tbl = shadowCellMap[table];
      var tok = tbl && tbl[String(mask8)];
      if (!tok) return 0;
      return tokenCell(tok);
    }

    // 8-bit neighbour mask from a precomputed boolean grid, in dwf-adjacency.js's exact
    // DELTA/BIT order (N,S,W,E,NW,NE,SW,SE = bits 0..7). An out-of-window neighbour reads 0 --
    // the same 1-tile viewport-edge artifact DF itself shows (adjacency §computeMask8), so this
    // is bit-for-bit equal to Adj.computeMask8(lookup,...) but with no per-neighbour closure
    // call or predicate indirection (the scene-build hot path -- called up to 2x per tile).
    function maskFromGrid(grid, gx, gy, gw, gh) {
      var m = 0;
      var north = gy > 0, south = gy < gh - 1, west = gx > 0, east = gx < gw - 1;
      var row = gy * gw, rowN = row - gw, rowS = row + gw;
      if (north && grid[rowN + gx]) m |= 1;                  // N
      if (south && grid[rowS + gx]) m |= 2;                  // S
      if (west && grid[row + gx - 1]) m |= 4;                // W
      if (east && grid[row + gx + 1]) m |= 8;                // E
      if (north && west && grid[rowN + gx - 1]) m |= 16;     // NW
      if (north && east && grid[rowN + gx + 1]) m |= 32;     // NE
      if (south && west && grid[rowS + gx - 1]) m |= 64;     // SW
      if (south && east && grid[rowS + gx + 1]) m |= 128;    // SE
      return m;
    }

    // B36: directional wall cell for a WALL tile from its OPEN-face mask (byte-identical to
    // canvas2d's drawWallJoin -- same wallCellSuffix, same hashXY variant digit). Returns 0 for
    // a fully-buried wall (dark base fill only) or when no cell resolves.
    // B62-r2 (canvas2d grassBackingCell parity): borrowed-neighbor grass backing for
    // TREE/MUSHROOM tiles -- atlas cell index of GRASS_1..4 (hashXY variant) when a live
    // GRASS_LIGHT/GRASS_DARK tile exists within Chebyshev 1..3 of this tile, else 0.
    function grassBackingCellGL(t, gx, gy, lookupTile) {
      if (!lookupTile) return 0;
      var mat = t.mat || "";
      if (mat !== "TREE" && mat !== "MUSHROOM") return 0;
      var shape = t.shape || "";
      if (shape === "EMPTY" || shape === "NONE") return 0;
      for (var i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
        if (isGrassBackingSource(lookupTile(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
          return tokenCell("GRASS_" + ((hashXY(gx, gy) & 3) + 1));
        }
      }
      return 0;
    }

    // B241 GROUND BACKING (canvas2d groundBackingCell parity -- see dwf-tiles.js's
    // banner for the oracle + measurements): a BOULDER sprite is 50-65% opaque, and native
    // composites the tile's REAL ground beneath it, not a flat colour square. Backing
    // priority: own grass tail (true floor; DLL-gated -- the wire's grass gate excludes
    // BOULDER shapes today) > ring-1 borrowed live grass (the accepted B62-r2/B71-r2
    // trunk rule) > the rough stone floor of the tile's own material (STONE_FLOOR_5; every
    // Boulder tiletype is stone-family). Returns {cell, wash} or null (flat fill).
    // TREE/MUSHROOM tiles keep their existing borrowed-grass rule unchanged.
    function groundBackingCellGL(t, gx, gy, lookupTile) {
      var gb = grassBackingCellGL(t, gx, gy, lookupTile);
      if (gb) return { cell: gb, wash: true };
      if ((t.shape || "") !== "BOULDER") return null;
      var grassCell = function () {
        var c = tokenCell("GRASS_" + ((hashXY(gx, gy) & 3) + 1));
        return (c > 0) ? { cell: c, wash: true } : null;
      };
      if (t.grass && t.grass.amount > 0) return grassCell();        // (1) true floor: grass
      if (!t.grass && lookupTile) {                                 // (2) ring-1 borrow
        for (var i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
          if (isGrassBackingSource(lookupTile(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
            return grassCell();
          }
        }
      }
      var fc = tokenCell("STONE_FLOOR_5");                          // (3) rough stone floor
      return (fc > 0) ? { cell: fc, wash: false } : null;
    }

    function wallJoinCell(t, openMask, gx, gy) {
      if (!spriteMap || (t.shape || "") !== "WALL" || !Adj) return 0;
      if (isTreeWallMat(t.mat || "")) return 0; // B62: trunk/cap keeps its round emitTree cell, no stone edge
      var infix = Adj.wallCellSuffix(openMask);
      if (!infix) return 0;
      // B74: player-smoothed/worn walls use DF's detailed-wall family; rough walls keep the
      // natural wallPrefix() family. Direction (infix) + variant cascade identical either way.
      var base = (wallDetailPrefix(t) || wallPrefix(t.mat || "", t.base_mt)) + "_" + infix;
      // WALLSFIX/TX16/B273: constructed and natural stone/soil/mineral faces share the raw-derived row.
      var palRow = wallJoinPalRowGL(t);
      var v = (hashXY(gx, gy) & 3) + 1;
      var cands = [base + "_" + v, base + "_1", base];
      for (var i = 0; i < cands.length; i++) {
        var tok = cands[i];
        if (typeof palRow === "number" && atlas) {
          var entry = TOKEN_CELL_OVERRIDE[tok] || (spriteMap && spriteMap[tok]);
          if (entry && entry.sheet) {
            var remap = paletteRemapFor(palRow);
            var pc = remap ? atlas.resolvePalette(entry.sheet, entry.col, entry.row, palRow, remap) : 0;
            if (pc > 0) return pc;
            var fc = atlas.resolve(entry.sheet, entry.col, entry.row); // graceful transient (sheet decoding)
            if (fc > 0) return fc;
          }
        }
        var c = tokenCell(tok);
        if (c) return c;
      }
      return 0;
    }

    // WC-18 (GL parity): engraving decoration overlay -- the byte-for-byte port of
    // dwf-tiles.js's drawEngraving/engravingWallToken (the ENGRAVED_STONE_WALL_* +
    // FLOOR_STONE_ENGRAVED_* environment tokens already resolve through tokenCell/the atlas,
    // no map/generator work needed). Previously ONLY canvas2d rendered engravings -- exactly
    // the GL/canvas2d split the ledger (448380c/ee3f61f) paid for once; this closes it.
    // eflags: floor=0,W=1,E=2,N=3,S=4,hidden=5,NW=6,NE=7,SW=8,SE=9 (df::engraving_flags copied
    // verbatim onto the wire). Multi-record tiles OR-combine; cardinal bits win over a lone
    // diagonal (documented residual, same as canvas2d).
    var ENG_FLOOR = 0x0001, ENG_W = 0x0002, ENG_E = 0x0004, ENG_N = 0x0008, ENG_S = 0x0010,
        ENG_HIDDEN = 0x0020, ENG_NW = 0x0040, ENG_NE = 0x0080, ENG_SW = 0x0100, ENG_SE = 0x0200;
    function engravingWallTokenGL(mask) {
      var cardinal = mask & (ENG_N | ENG_S | ENG_W | ENG_E);
      if (cardinal) {
        var parts = [];
        if (cardinal & ENG_N) parts.push("N");
        if (cardinal & ENG_S) parts.push("S");
        if (cardinal & ENG_W) parts.push("W");
        if (cardinal & ENG_E) parts.push("E");
        return "ENGRAVED_STONE_WALL_" + parts.join("_");
      }
      if (mask & ENG_NW) return "ENGRAVED_STONE_WALL_NW";
      if (mask & ENG_NE) return "ENGRAVED_STONE_WALL_NE";
      if (mask & ENG_SW) return "ENGRAVED_STONE_WALL_SW";
      if (mask & ENG_SE) return "ENGRAVED_STONE_WALL_SE";
      return null;
    }
    function engravingWallPlanGL(t, mask) {
      var token = engravingWallTokenGL(mask);
      return token ? { token: token, palRow: wallJoinPalRowGL(t) } : null;
    }
    function engravingFloorPlanGL(t) {
      var m = wallMaterialGL(t);
      if (m && typeof m.palRow === "number") {
        return { token: "FLOOR_STONE_ENGRAVED_PALETTE", palRow: m.palRow };
      }
      return { token: "FLOOR_STONE_ENGRAVED_NON_PALETTE", palRow: null };
    }
    function emitEngraving(t, gx, gy, seeDownAttr) {
      var hits = t.engravings;
      if (!hits || !hits.length) return;
      var mask = 0;
      for (var i = 0; i < hits.length; i++) mask |= (hits[i].eflags & 0x03ff);
      if (mask & ENG_HIDDEN) return; // DF hides the decoration
      if (mask & ENG_FLOOR) {
        var fp = engravingFloorPlanGL(t), fc = 0;
        if (typeof fp.palRow === "number" && atlas) {
          var fe = TOKEN_CELL_OVERRIDE[fp.token] || (spriteMap && spriteMap[fp.token]);
          if (fe && fe.sheet) {
            var fremap = paletteRemapFor(fp.palRow);
            fc = fremap ? atlas.resolvePalette(fe.sheet, fe.col, fe.row, fp.palRow, fremap) : 0;
          }
        }
        if (!fc) fc = tokenCell(fp.token);
        if (fc) emitSprite(gx, gy, fc, seeDownAttr);
      }
      var plan = engravingWallPlanGL(t, mask);
      if (plan) {
        var wc = 0;
        if (typeof plan.palRow === "number" && atlas) {
          var entry = TOKEN_CELL_OVERRIDE[plan.token] || (spriteMap && spriteMap[plan.token]);
          if (entry && entry.sheet) {
            var remap = paletteRemapFor(plan.palRow);
            wc = remap ? atlas.resolvePalette(entry.sheet, entry.col, entry.row, plan.palRow, remap) : 0;
          }
        }
        if (!wc) wc = tokenCell(plan.token);
        if (wc) emitSprite(gx, gy, wc, seeDownAttr);
      }
    }

    // =======================================================================================
    // WB-10: multi-z see-down descent (transitional-mode aware, RECONCILE-WA §0).
    //
    // TRANSITIONAL MODE -- current reality, W-A's WA-12 hasn't landed: every cache chunk is
    // `baked` (the legacy server already substituted the see-down tile before it ever reached
    // the wire; the fog report proved this pixel-exact). The tile `buildTile` receives already
    // IS that substituted tile (it flows through dwf-render.js's getLatest() -> the WA-7
    // bridge's windowView()), so `descendSeeDown` below is a near-zero-cost no-op for every
    // tile today -- one memoized chunk lookup + a `baked` flag check, then bail. This is
    // exactly the spec's mandated transitional behaviour: "consume the baked see-down
    // substitution exactly as today... this item must land green in transitional mode alone."
    //
    // MULTI-Z MODE -- once W-A ships raw per-z records + z-below blocks (WA-12,
    // `chunk.baked=false`): this function performs its OWN bounded descent straight off the
    // cache's raw SoA arrays (RECONCILE-WA Part 3: "the descent function is written as a pure
    // cache query so [WB-10] can reuse it"), and additionally tracks the DEPTH descended --
    // which the WA-7 bridge's own windowView() descent does not expose -- to feed the
    // RenderParams `seeDownTint` hook (§1.3 extension, shader below). No fog curve is
    // hardcoded: depth is just a number until `setRenderParams({seeDownTint:...})` says
    // otherwise (default neutral, see `defaultRenderParams`).
    // reset per buildScene() call: Map<z, Map<chunkKey, chunk-or-null>> (memoized). Nested
    // integer-keyed Maps rather than a single string-concatenated key: the dominant scene-build
    // cost at 200x200 is THIS lookup running for every tile with a cache reader wired (the
    // common case is a bail after one lookup, per the banner above), so avoiding a per-tile
    // string allocation measurably matters (bench: tools/spikes/webgl/wb10-multiz-bench.html).
    var chunkCacheByZ = null;

    function getChunkCached(z, wx, wy) {
      if (!cacheReader) return null;
      var byKey = chunkCacheByZ.get(z);
      if (!byKey) { byKey = new Map(); chunkCacheByZ.set(z, byKey); }
      var key;
      try { key = cacheReader.chunkKeyFor(wx, wy); } catch (_) { return null; }
      if (byKey.has(key)) return byKey.get(key);
      var c = null;
      try { c = cacheReader.getChunk(z, key) || null; } catch (_) { c = null; }
      byKey.set(key, c);
      return c;
    }

    // Decode one raw SoA slot of an ALREADY-FETCHED chunk -> a legacy-shaped tile including
    // sparse tails, or {tt:-1} for a void record. Mirrors dwf-cache.js's decodeTile()
    // read-side shape closely enough that GL's private see-down descent no longer drops item/
    // plant/spatter tails that are already present in the browser world cache.
    function decodeRawAt(chunk, wx, wy) {
      var idx = (wy & 15) * 16 + (wx & 15);
      var tt = chunk.tt[idx];
      if (tt === 0xFFFF) return { tt: -1 };
      var m = chunk.mat[idx] | 0;
      var mt = m >> 16, mi = (m << 16) >> 16;
      var b = chunk.bits[idx];
      var liquidCode = b & 3, flow = (b >> 2) & 7, hidden = (b >> 5) & 1, outside = (b >> 6) & 1;
      var meta = tiletypeMeta && tiletypeMeta.get(tt);
      var out = {
        x: wx, y: wy, tt: tt, ttname: meta ? meta.ttname : "", shape: meta ? meta.shape : "", mat: meta ? meta.mat : "",
        flow: flow, liquid: flow > 0 ? (liquidCode === 2 ? "magma" : "water") : "none",
        hidden: !!hidden, outside: outside, base_mt: mt, base_mi: mi,
      };
      copySparseFields(out, chunk, idx);
      return out;
    }

    function copySparseFields(out, chunk, idx) {
      var sp = chunk && chunk.sparse && chunk.sparse.get && chunk.sparse.get(idx);
      if (!sp) return;
      // B24 see-down sparse seam: the cache-worker already ingests ITEM tails into the lower
      // chunk's sparse map, and dwf-cache.js already copies those tails when its own
      // decodeTile() descends. GL's private raw decoder was the only path still collapsing a
      // lower tile back to terrain-only fields, which made emitItem() a no-op for visible
      // below-camera items. Keep this field list in the same additive shape as cache.js.
      if (sp.item) out.item = sp.item;
      if (sp.plant) out.plant = sp.plant;
      if (sp.farmCrop) out.farmCrop = sp.farmCrop;
      if (sp.spatterMat) out.spatter = sp.spatterMat;
      if (sp.spatters && sp.spatters.length) out.spatters = sp.spatters;
      else if (sp.spatterMat) out.spatters = [sp.spatterMat];
      if (sp.itemSpatters && sp.itemSpatters.length) out.itemSpatters = sp.itemSpatters;
      if (sp.flow) out.cloud = sp.flow;
      if (sp.grass) out.grass = sp.grass;
      if (sp.engravings && sp.engravings.length) out.engravings = sp.engravings;
      if (sp.desigPriority) out.desigPriority = sp.desigPriority;
      if (sp.vermin && sp.vermin.length) out.vermin = sp.vermin;
      // TX1 (additive): container representative-content descriptor (contents-peek overlay).
      if (sp.peek) out.peek = sp.peek;
    }

    // Returns {depth, tile} for the first solid/liquid tile found descending from an open,
    // discovered camera column, or null (no cache reader / no meta table / baked chunk /
    // hidden camera tile / camera tile not open / nothing found within MAX_SEEDOWN_DEPTH --
    // in every null case the caller keeps rendering the tile it was already given, matching
    // WA-7's own "loop never breaks -> original fields survive" behaviour). `tile` is shaped
    // like any other scene-build input tile (x/y/tt/ttname/shape/mat/flow/liquid/hidden/
    // outside) -- buildTile renders it exactly like a normal cell, no special-casing needed.
    function descendSeeDown(z, wx, wy) {
      if (!cacheReader || !tiletypeMeta) return null;
      var chunk = getChunkCached(z, wx, wy);
      if (!chunk || chunk.baked !== false) return null; // transitional / unknown: bail, ~free
      var cam = decodeRawAt(chunk, wx, wy);
      if (cam.tt < 0 || cam.hidden || !isOpenTileShapeMat(cam.shape, cam.mat)) return null;
      for (var d = 1; d <= MAX_SEEDOWN_DEPTH; d++) {
        var lz = z - d;
        if (lz < 0) break;
        var lchunk = getChunkCached(lz, wx, wy);
        if (!lchunk) continue;                      // missing lower chunk: keep descending
        var lo = decodeRawAt(lchunk, wx, wy);
        if (lo.tt < 0) continue;                     // void record: keep descending
        if (isOpenTileShapeMat(lo.shape, lo.mat) && !(lo.flow > 0)) continue; // still open: deeper
        return {
          depth: d,
          tile: lo,
        };
      }
      return null;
    }

    // Emit the full instance stack for one tile at grid (gx,gy), mirroring drawTileComposite +
    // the (terrain-slice of the) overlay pass + the ambient wash. isWall/isHidden are the
    // precomputed neighbour grids for O(1) mask lookups. camZ is the view's camera z (used only
    // by the WB-10 descent above; absent/non-numeric input tiles without world x/y skip it
    // entirely -- e.g. synthetic test fixtures with no `.x`/`.y`).
    function buildTile(t, gx, gy, gw, gh, isWall, isHidden, camZ, lookupTile, isOpen) {
      if (!t) return;
      // WB-10: attempt the see-down descent BEFORE resolving anything else -- a substitution
      // makes every layer below (sprite/liquid/hidden/wall-join/shadow/ambient) render for
      // THAT tile instead, exactly mirroring how the WA-7 bridge substitutes it for canvas2d.
      var seeDownDepth = 0;
      if (cacheReader && typeof t.x === "number" && typeof t.y === "number" && typeof camZ === "number") {
        var desc = descendSeeDown(camZ, t.x, t.y);
        if (desc) { t = desc.tile; seeDownDepth = desc.depth; }
      }
      var seeDownAttr = seeDownDepth ? ((seeDownDepth & ATTR_SEEDOWN_MASK) << ATTR_SEEDOWN_SHIFT) : 0;

      var tt = (typeof t.tt === "number") ? t.tt : -1;

      var liquidCell = resolveLiquidCell(t);
      var hasLiquid = liquidCell > 0;
      var col = tileColor(t, hasLiquid);
      // WT25 (canvas2d parity, dwf-tiles.js wantsHiddenHatch): the hatch fires for a
      // shipped-and-hidden tile (real tt, hidden bit) OR an in-bounds undiscovered (tt<0) tile.
      // Off-map tt<0 stays black. curMapDims is null pre-hello -> only shipped-hidden hatches.
      var wantsHidden = wantsHiddenHatchGL(t, curMapDims);
      var hiddenCell = wantsHidden ? resolveHiddenCell(gx, gy) : 0;
      var sprite = resolveSprite(t, gx, gy, lookupTile);
      var wallOpenMask = ((t.shape || "") === "WALL" && isOpen)
        ? maskFromGrid(isOpen, gx, gy, gw, gh) : 0;

      var drew = false;
      // (1) base colour fill. B62-r2: tree/mushroom tiles swap the flat wood-tone fill for a
      // borrowed-neighbor GRASS backing (GRASS_1..4 + grassSummer wash) when real grass is
      // nearby -- canvas2d drawTileComposite parity; hidden/liquid tiles keep their own base.
      // B241: BOULDER tiles back their part-transparent sprite with the tile's TRUE floor
      // (groundBackingCellGL: own grass tail > ring-1 borrowed grass > rough stone floor);
      // the wash only rides the grass arms. Skipped when the BOULDER sprite itself did not
      // resolve -- a floor with no rock on it would be worse than the flat fill.
      if (col !== null) {
        var wallBackingCell = (!t.hidden && !hasLiquid && wallBackingTokenGL(t, gx, gy, wallOpenMask))
          ? resolveHiddenCell(gx, gy) : 0;
        var gbc = (!wallBackingCell && !t.hidden && !hasLiquid && ((t.shape || "") !== "BOULDER" || sprite))
          ? groundBackingCellGL(t, gx, gy, lookupTile) : null;
        if (wallBackingCell) {
          emitSprite(gx, gy, wallBackingCell, seeDownAttr);
        } else if (gbc) {
          emitSprite(gx, gy, gbc.cell, seeDownAttr);
          var gbt = gbc.wash ? TINT_COLORS.grassSummer : null;
          if (gbt) emitSolid(gx, gy, gbt, Math.round(gbt[3] * 255), seeDownAttr);
        } else {
          emitSolid(gx, gy, col, 255, seeDownAttr);
        }
        drew = true;
      } else if (hiddenCell) {
        // WT25 base-hatch backdrop: an in-bounds undiscovered (tt<0) tile has no tileColor, so
        // back the opaque hatch with HIDDEN_COLOR -- exactly the fill the shipped-and-hidden path
        // gets (col===HIDDEN_COLOR) -- so a transparent hatch texel never bleeds the black void.
        emitSolid(gx, gy, HIDDEN_COLOR, 255, seeDownAttr);
        drew = true;
      }

      // (2) terrain sprite stack (hidden > liquid-over-bed > sprite), matching canvas2d.
      // Every instance in this tile's stack carries `seeDownAttr` (0 unless this cell was
      // substituted by the WB-10 descent above) so the shader's per-depth tint hook applies
      // uniformly to the whole substituted stack, matching canvas2d rendering ONE composited
      // tile rather than tinting individual layers differently. WB-15: `sprite.animAttr`/
      // `overlayAnimAttr` OR straight into the same attr word -- animFrames/animRate (bits 0-6)
      // and seeDownAttr's depth (bits 9-12) never overlap, so this is a plain bitwise OR, no
      // extra branch. Zero for the overwhelming majority of tokens (see animAttrForToken).
      if (hiddenCell) {
        emitSprite(gx, gy, hiddenCell, seeDownAttr); drew = true;
      } else if (hasLiquid) {
        if (sprite) {
          emitSprite(gx, gy, sprite.cell, seeDownAttr | sprite.animAttr);
          // WC-17 GL parity: sprite.tintRGBA (a literal [r,g,b,alpha] tuple, e.g. per-species
          // grass_colors.json) wins over the named TINT_COLORS lookup -- mirrors
          // dwf-tiles.js's "literal CSS string vs TINT_COLORS key" duality, just as a
          // tuple instead of a string since this pipeline emits raw instance bytes, not CSS.
          var bt = sprite.tintRGBA || (sprite.tintName && TINT_COLORS[sprite.tintName]);
          if (bt) emitSolid(gx, gy, bt, Math.round(bt[3] * 255), seeDownAttr);
          if (sprite.overlay) emitSprite(gx, gy, sprite.overlay, seeDownAttr | sprite.overlayAnimAttr);
        }
        // TX2: native liquid is above bed contamination, not below it. Emit spatter before
        // the translucent liquid depth cell on flooded tiles, then skip it in the sparse tail.
        emitSpatterDecals(t, gx, gy, lookupTile, seeDownAttr);
        emitSprite(gx, gy, liquidCell, seeDownAttr); drew = true;
        // WB-15 shore foam: only meaningful on the liquid tile itself (the branch we're already
        // in), synthesized from water-adjacency -- see emitShoreFoam's own banner.
        emitShoreFoam(t, gx, gy, lookupTile, seeDownAttr);
      } else if (sprite) {
        if (sprite.multiplyRgb) emit(gx, gy, sprite.cell, sprite.multiplyRgb[0] | 0, sprite.multiplyRgb[1] | 0, sprite.multiplyRgb[2] | 0, 255, seeDownAttr | sprite.animAttr);
        else emitSprite(gx, gy, sprite.cell, seeDownAttr | sprite.animAttr);
        var tc = sprite.tintRGBA || (sprite.tintName && TINT_COLORS[sprite.tintName]);
        if (tc) emitSolid(gx, gy, tc, Math.round(tc[3] * 255), seeDownAttr);
        if (sprite.overlay) emitSprite(gx, gy, sprite.overlay, seeDownAttr | sprite.overlayAnimAttr);
        drew = true;
      }
      // (stair/ramp X-strokes on a bare-colour tile are 2D line work -- deferred to the 2D
      //  overlay per the report §B split; not an instance-shaped primitive.)

      // (3) terrain-slice overlays: shadow decals, WB-11 sparse layers
      //     (spatter/item-spatter litter/item/plant/tree), then wall joins -- same order as
      //     dwf-tiles.js's drawTileComposite (drawShadowDecals < drawSpatter <
      //     drawItemSpatterLitter < drawItem < drawPlant < drawTree < drawWallJoin). The WB-11
      //     floor-edge (grass-creep) decal that used to open this stack was DELETED by B71-r3
      //     (oracle-refuted false content painting translucent grass OVER boulder/pebble/floor
      //     sprites -- see the deletion banner near isOpenTileShapeMat). Skipped for
      //     undiscovered tiles, same guard as 2D. When WB-10 substituted a lower raw-cache tile,
      //     every sparse-layer instance carries the same seeDownAttr as the terrain instances;
      //     canvas2d draws the whole lower tile stack first and then applies one fog wash over it.
      // B235: "undiscovered" here means HATCHED -- a shipped-hidden tile OR a WT25 in-bounds tt<0
      // tile. The old `!t.hidden` gate only caught the first kind, so the tt<0 ring along the
      // known-block boundary drew a `visionShadow` decal and painted the seam. Same fix as 2D.
      if (drew && overlaysAllowedGL(t)) {
        var shape = t.shape || "";
        var isWallShape = shape === "WALL";
        var wallMask = (isWall || isWallShape) ? maskFromGrid(isWall, gx, gy, gw, gh) : 0;

        if (shadowCellMap) {
          if (!isWallShape && shape !== "FORTIFICATION" && shape !== "EMPTY" && shape !== "NONE" && wallMask) {
            var tbl = (shape === "RAMP" || shape === "RAMP_TOP") ? "rampShadowOnRamp" : "wallShadow";
            var sc = resolveShadowCell(tbl, wallMask);
            if (sc) emitSprite(gx, gy, sc, seeDownAttr);
          }
          if (isHidden) {
            var hiddenMask = maskFromGrid(isHidden, gx, gy, gw, gh);
            if (hiddenMask) {
              var vc = resolveShadowCell("visionShadow", hiddenMask);
              if (vc) emitSprite(gx, gy, vc, seeDownAttr);
            }
          }
        }

        if (!hasLiquid) emitSpatterDecals(t, gx, gy, lookupTile, seeDownAttr);
        emitItemSpatterLitter(t, gx, gy, seeDownAttr);
        emitItem(t, gx, gy, seeDownAttr);
        emitVermin(t, gx, gy, seeDownAttr);
        emitPlant(t, gx, gy, seeDownAttr);
        emitTree(t, gx, gy, lookupTile, seeDownAttr);

        if (isWallShape) {
          // B36: select from the OPEN-face mask (exposed edges), not the wall-connection mask.
          var wj = wallJoinCell(t, wallOpenMask, gx, gy);
          if (wj) emitSprite(gx, gy, wj, seeDownAttr);
        }

        // WC-18 (GL parity): engraving decoration LAST -- an overlay ON the resolved wall/
        // floor art, exactly the position drawEngraving holds in canvas2d's composite order.
        emitEngraving(t, gx, gy, seeDownAttr);
      }

      // (4) indoor/underground ambient wash: DELETED (see INDOOR_WASH's banner above).

      // (5) WB-10: designated-hidden additive lighten. Canvas2d parity (drawDesignation,
      // dwf-tiles.js:1204-1217/WB-5): a hidden tile carrying an active designation gets
      // an ADDITIVE (globalCompositeOperation="lighter") rgb(27,29,26) wash under its glyph, so
      // the RenderParams.designationLighten uniform (§1.3) has a real, on-screen instance to
      // drive with zero scene rebuild -- the full glyph/category-wash/marker-mode overlay is
      // WB-14 scope; this is the narrow additive-lighten slice WB-10's own approach text calls
      // out. A SOLID_CELL instance with a fully-transparent tint (0,0,0,0): the shader's
      // ADDITIVE branch adds `designationLighten.rgb` and zeroes alpha regardless of the
      // instance's own colour, so the tint value here is inert by construction.
      // NEVER fires on a descended (seeDownDepth>0) tile: this item's own descent doesn't
      // fetch sparse designation detail for the substituted tile (WB-11 sparse-layer scope) --
      // documented residual, matching how designations aren't expected at see-down depth.
      // B38 (bug list): the designation glyph is a ~35%-alpha mid-grey overlay that only
      // reads over a LIGHTENED backdrop. B36 (e5294e7) turned REVEALED wall interiors from a
      // full bright block into a dark fill, so a revealed designated wall adjacent to a mined
      // corridor lost this backdrop and its pick vanished, while the still-hidden rock behind
      // (which keeps the lighten) stayed visible -- exactly the reported symptom. Extend the
      // same additive lighten to revealed WALL designated tiles (canvas2d drawDesignation makes
      // the byte-identical extension). Non-wall revealed terrain draws bright already, so the
      // dark-backdrop lighten stays gated to hidden || WALL (native does not brighten floors).
      if ((t.hidden || (t.shape || "") === "WALL") && t.desig) {
        emitSolid(gx, gy, [0, 0, 0], 0, ATTR_ADDITIVE);
      }

      // (6) WB-14: collect this tile's designation glyph/wash for the batched OVERLAY pass
      // below (emitDesignationOverlay, called once per buildScene AFTER buildings) -- mirrors
      // dwf-tiles.js's own two-pass structure, where drawDesignation is invoked from a
      // SEPARATE loop over `tiles` at the very end of draw(), not inline in drawTileComposite.
      // Fires for hidden AND visible tiles alike (WB-5 parity: "hidden tiles are NO LONGER
      // skipped here"). Naturally skipped on a WB-10 descended/substituted tile since
      // decodeRawAt's synthetic record never carries a `.desig` field -- same documented
      // residual as the additive-lighten emit just above.
      if (t.desig) {
        var dv = resolveDesig(t.desig, t);
        if (dv) desigList.push({ gx: gx, gy: gy, cell: dv.cell, cat: dv.cat, marker: !!t.desig.marker,
                                 prio: (t.desigPriority && t.desigPriority.priority) | 0 });
      }
    }

    // buildScene(view): view = {origin:{x,y,z}, width, height, tiles:[...]} (row-major, y-outer
    // x-inner -- the same shape dwf-tiles.js's tileBuf/windowView use). Returns
    // {count, bytes, ms}. The typed buffer is on `builder.buffer` / `builder.byteLength`.
    //
    // WB-14 overlay emission (designations + presence, closure-scoped so they can call
    // emit()/emitSolid()/atlas.resolve() directly -- same convention as every other emit*
    // helper in this closure). `list` is the desigList this buildScene call's tile loop
    // (buildTile's step (6) above) just collected.
    function emitDesignationOverlay(list, nowMs) {
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        // MARKER-COLOR: marker mode swaps the category wash for the fixed native marker-blue and
        // recolours the glyph via its own instance tint (texel*tint == canvas2d multiplyTintedCell,
        // the same byte-parity mechanism ghost/fortification tints use) -- no ATTR_MARKER needed.
        var rgb = e.marker ? MARKER_WASH_RGB : (DESIG_TINT_RGB[e.cat] || DESIG_TINT_RGB.dig);
        var washA = Math.round((e.marker ? DESIG_WASH_ALPHA_MARKER : DESIG_WASH_ALPHA) * 255);
        emitSolid(e.gx, e.gy, rgb, washA, 0);
        if (!atlas || !designationGlyphVisible(e.djobKind, nowMs, e.djobWorker, e.djobActive)) continue;
        var gc = atlas.resolve(DESIG_SHEET, e.cell[0], e.cell[1]);
        if (gc > 0) {
          if (e.marker) emit(e.gx, e.gy, gc, MARKER_GLYPH_TINT[0], MARKER_GLYPH_TINT[1], MARKER_GLYPH_TINT[2], 255, 0);
          else emitSprite(e.gx, e.gy, gc, 0);
        }
        // WC-19: dig-priority numeral (designation_priority.png col 0, row level-1) over the
        // designated tile -- only when the tail carried a non-default priority (1..7).
        if (e.prio >= 1 && e.prio <= 7) {
          var pc = atlas.resolve(DESIG_PRIORITY_SHEET, 0, e.prio - 1);
          if (pc > 0) emitSprite(e.gx, e.gy, pc, 0);
        }
      }
    }

    // B269: the mining-indicator pass. Runs over the whole tile window (not a collected list --
    // an indicator is a property of the TERRAIN, not of a designation, which is exactly why it
    // survives DF clearing the dig designation on cancellation) and emits DF's damp/warm glyph
    // OVER the designation overlay, so a still-designated damp wall shows pick + drop.
    function emitMiningIndicators(tiles, gw, gh) {
      if (!mineMode || !atlas) return;
      var n = Math.min(tiles.length, gw * gh);
      for (var i = 0; i < n; i++) {
        var cell = miningIndicatorCell(tiles[i], mineMode);
        if (!cell) continue;
        var c = atlas.resolve(MINING_SHEET, cell[0], cell[1]);
        if (c > 0) emitSprite(i % gw, (i - (i % gw)) / gw, c, 0);
      }
    }

    // presence (B): drag-rects + tile-outlines ONLY, mirroring dwf-tiles.js's
    // drawPresence -- the name label + smooth-cursor arrow are TEXT and stay on the permanent
    // 2D overlay canvas (report §B), never ported here. Both pieces are approximated as
    // full-tile SOLID_CELL fills: the instance format (§1.2) is a fixed 32x32 quad with no
    // per-instance width/height, so a stroked rectangle border/hollow box isn't geometrically
    // representable without extending the 16-byte record -- a documented, in-scope
    // simplification (same class as WB-12/WB-15's own documented paint-order/geometry
    // residuals elsewhere in this file). `ox`/`oy`/`camZ` are the SAME window origin buildScene
    // just used for buildings above.
    function emitPresence(players, ox, oy, camZ, ownName) {
      var list = players || [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || p.name === ownName || typeof p.x !== "number" || typeof p.y !== "number") continue;
        var rgb = playerColorRgb(p.name);
        var sameZ = (typeof p.z !== "number") || p.z === camZ;
        if (p.drag && typeof p.dx === "number" && typeof p.dy === "number") {
          var gx0 = Math.min(p.x, p.dx) - ox, gy0 = Math.min(p.y, p.dy) - oy;
          var gx1 = Math.max(p.x, p.dx) - ox, gy1 = Math.max(p.y, p.dy) - oy;
          var fillA = Math.round((sameZ ? 0.16 : 0.08) * 255);
          var emitted = 0;
          drag:
          for (var ry = gy0; ry <= gy1; ry++) {
            for (var rx = gx0; rx <= gx1; rx++) {
              if (emitted >= PRESENCE_DRAG_MAX_TILES) break drag;
              emitSolid(rx, ry, rgb, fillA, 0);
              emitted++;
            }
          }
        }
        // tile-outline/marker approximation (see this function's own banner: no sub-tile
        // stroke geometry available) -- a stronger-alpha full-tile highlight stands in for
        // canvas2d's hollow stroked box + corner caret.
        var markA = Math.round((sameZ ? 0.55 : 0.28) * 255);
        emitSolid(p.x - ox, p.y - oy, rgb, markA, 0);
      }
    }

    var wallGrid = null, hiddenGrid = null, openGrid = null, gridN = 0;
    // WT25: the world footprint for this rebuild, resolved ONCE per buildScene/chunk-segment (not
    // per tile). ctx.mapDims is a fixture-test override (same convention as ctx.cacheReader);
    // otherwise the live footprint comes from the cache (hello_ack -> cacheReader.mapDims()).
    var curMapDims = null;
    function resolveMapDims() {
      if (ctx.mapDims !== undefined) return ctx.mapDims;
      if (cacheReader && typeof cacheReader.mapDims === "function") {
        try { return cacheReader.mapDims(); } catch (_) { return null; }
      }
      return null;
    }
    // WB-14: repopulated at the top of every buildScene() call (see there); consumed by
    // emitDesignationOverlay right after the buildings pass, below.
    var desigList = [];
    // WB-14: resolved ONCE (session-stable -- see getOwnPlayerName's own banner), not per
    // rebuild. `ctx.ownPlayerName` (explicit override, checked for `undefined` so an explicit
    // `null`/empty string still counts as "provided") lets a fixture test inject a name without
    // a DOM/localStorage -- same "ctx override, else a sensible default" convention as
    // cacheReader/adjacency above.
    var ownPlayerName = (ctx.ownPlayerName !== undefined) ? ctx.ownPlayerName : getOwnPlayerName();
    // H1/TX4: the static prefix has four ordered CPU segments. Their order is the painter
    // contract -- all row-major terrain stacks, then buildings, then planted crops, then overlays -- followed by
    // WB-13's dynamic units/projectiles tail. Segment boundaries let the machine beat rewrite
    // only buildings without executing buildTile for the terrain prefix.
    var terrainCount = 0, buildingStart = 0, buildingCount = 0;
    var cropStart = 0, cropCount = 0;
    var overlayStart = 0, overlayCount = 0, staticCount = 0;
    var lastBuildView = null;
    // B135: world-keyed ("x|y|z") tiles whose WORKER-claimed (w:1) designation job alternates
    // with a unit standing on them. Rebuilt by every djob walk (buildScene + rebuildOverlay)
    // and consulted by buildUnits each tick -- the unit yields its tile to the glyph on the
    // glyph half of the 400ms half-beat (see workedTileUnitVisible).
    var blinkDjobTiles = new Set();
    // R2: terrain is retained as independently replaceable 16x16 CPU segments. The flat
    // builder buffer remains the upload/draw shape; patchTerrainChunks compacts these bytes
    // ahead of the existing buildings/overlay/dynamic suffix after rebuilding only dirt.
    var terrainSegments = new Map(); // "z:bx:by" -> {bx,by,z,count,bytes,builds}
    var terrainOrder = [];
    function terrainSegmentId(bx, by, z) { return z + ":" + bx + ":" + by; }
    function rememberTerrainSegment(bx, by, z, start, end) {
      var id = terrainSegmentId(bx, by, z);
      var prev = terrainSegments.get(id);
      terrainSegments.set(id, {
        bx: bx, by: by, z: z, count: end - start,
        bytes: new Uint8Array(buf, start * INSTANCE_BYTES, (end - start) * INSTANCE_BYTES).slice(),
        builds: prev ? prev.builds + 1 : 1,
      });
      return id;
    }
    function buildScene(view) {
      var t0 = now();
      k = 0;
      chunkCacheByZ = new Map(); // WB-10: fresh per rebuild (§1.7 -- rebuild is already the
                                 // only place this runs; scene-build cadence, never per
                                 // rendered frame).
      curMapDims = resolveMapDims(); // WT25: once per rebuild, read by buildTile's base-hatch gate
      desigList = []; // WB-14: repopulated by this call's buildTile loop, consumed below.
      var gw = view.width | 0, gh = view.height | 0;
      var tiles = (view && view.tiles) || [];
      var total = gw * gh;
      var n = Math.min(tiles.length, total);
      var ox = (view && view.origin && typeof view.origin.x === "number") ? view.origin.x : 0;
      var oy = (view && view.origin && typeof view.origin.y === "number") ? view.origin.y : 0;
      emitOriginX = ox; emitOriginY = oy;
      var camZ = (view && view.origin && typeof view.origin.z === "number") ? view.origin.z : null;
      // WB-11: lookup(gx,gy) -> tile|null over THIS view's grid (dwf-tiles.js's tileAt,
      // mirrored) -- fed to Adj.computeMask8 for the sparse layers' own adjacency needs
      // (spatter same-family joins, tree canopy-twig connectivity, grass-creep neighbors). Built
      // once per buildScene call (stable for every tile in this rebuild), not per-tile, and only
      // ever invoked for tiles that actually carry a sparse layer -- negligible against the
      // dense pass's own per-tile cost (spec §1.7 budget).
      function lookupTile(x, y) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) return null;
        return tiles[y * gw + x] || null;
      }
      // worst case ~24 instances/tile (base + sprite + tint + overlay + liquid-bed + floor-edge
      // + 2 shadow + up to 4 layered spatter + up to 4 item-spatter litter + item + plant/tree +
      // walljoin + ambient + designation-lighten + WB-14's designation wash+glyph); size
      // generously, clamp on emit (WB-11 raised this from WB-9/10's ~10/tile once the sparse
      // layers below could stack on the same tile; WB-14 adds 2 more on top, multiplier bumped
      // 24->26 to keep the same 2-tile headroom margin).
      // WB-12: buildings are ADDITIVE on top of the per-tile budget above (one instance per
      // covered sub-cell -- material tint folds into that SAME instance, unlike canvas2d's two
      // draws per sub-cell, so this needs no *2). A cheap linear pre-pass over view.buildings
      // sums each footprint's tile-area (Stockpile/Civzone excluded, they emit nothing) so a
      // fort with many/large buildings never silently clamps -- same "size generously" approach
      // as the per-tile budget, just building-shaped instead of assumed-constant.
      var buildings = buildingsInPaintOrder((view && view.buildings) || []);
      var buildingBudget = 0;
      for (var bb = 0; bb < buildings.length; bb++) {
        var bB = buildings[bb];
        if (!bB || isOverlayOnlyBuildingType(bB.type)) continue;
        var bw = (typeof bB.x2 === "number" && typeof bB.x1 === "number") ? Math.max(1, bB.x2 - bB.x1 + 1) : 1;
        var bh = (typeof bB.y2 === "number" && typeof bB.y1 === "number") ? Math.max(1, bB.y2 - bB.y1 + 1) : 1;
        buildingBudget += bw * bh;
      }
      // WB-14: presence (drag-rect + tile-outline) budget, same pre-pass convention as
      // buildingBudget above -- see presenceBudget's own banner for the defensive drag-area cap.
      var players = (view && view.players) || [];
      var presBudget = presenceBudget(players);
      ensureCapacity(total * 26 + 32 + buildingBudget + presBudget);
      // Precompute the wall/hidden neighbour predicate grids ONCE (one linear pass), so each
      // tile's up-to-two 8-neighbour masks are O(1) array reads instead of closure+predicate
      // calls -- this is the dominant scene-build cost at 200x200 (spec §1.7 budget). Built from
      // the CAMERA-PLANE shapes as given (pre-WB-10-descent): a descended tile's own adjacency
      // to other descended tiles is a documented residual (a see-down tile normally sits alone
      // at the bottom of an open shaft, so this rarely matters visually) -- fixing it would mean
      // precomputing these grids from the descended geometry too, at extra scene-build cost that
      // buys nothing until W-A's raw multi-z actually ships real z-below data (WA-12).
      var haveHidden = false;
      if (!wallGrid || gridN < total) {
        wallGrid = new Uint8Array(total); hiddenGrid = new Uint8Array(total); openGrid = new Uint8Array(total); gridN = total;
      }
      for (var j = 0; j < n; j++) {
        var tj = tiles[j];
        wallGrid[j] = (tj && tj.shape === "WALL") ? 1 : 0;
        // B36/B282: share canvas2d's predicate, including tt<0 undiscovered placeholders.
        // B282: guard null Adj (unit-test contexts without the adjacency module) -- same predicate.
        openGrid[j] = (Adj ? Adj.isOpenNeighbor(tj) : (!!tj && !tj.hidden && tj.shape !== "WALL" && (typeof tj.tt !== "number" || tj.tt >= 0))) ? 1 : 0;
        if (tj && tj.hidden) { hiddenGrid[j] = 1; haveHidden = true; } else hiddenGrid[j] = 0;
        // (B71-r3: the WB-11 #5 grass-neighbour grid that fed emitFloorEdgeDecal is gone with
        //  the decal itself -- see the deletion banner near isOpenTileShapeMat.)
      }
      var hg = haveHidden ? hiddenGrid : null; // skip vision-shadow masks entirely with no hidden tiles
      terrainSegments = new Map();
      terrainOrder = [];
      // R2 painter legality: each tile stack is cell-local, so chunks may be row-major while
      // every stack within a chunk keeps the exact old y/x painter order.
      var bx0 = Math.floor(ox / 16), bx1 = Math.floor((ox + gw - 1) / 16);
      var by0 = Math.floor(oy / 16), by1 = Math.floor((oy + gh - 1) / 16);
      for (var by = by0; by <= by1; by++) {
        for (var bx = bx0; bx <= bx1; bx++) {
          var segmentStart = k;
          var gx0 = Math.max(0, bx * 16 - ox), gx1 = Math.min(gw, (bx + 1) * 16 - ox);
          var gy0 = Math.max(0, by * 16 - oy), gy1 = Math.min(gh, (by + 1) * 16 - oy);
          for (var gy = gy0; gy < gy1; gy++) {
            for (var gx = gx0; gx < gx1; gx++) {
              var i = gy * gw + gx;
              if (i >= n) continue;
              var t = tiles[i];
              if (!t) continue;
              try { buildTile(t, gx, gy, gw, gh, wallGrid, hg, camZ, lookupTile, openGrid); } catch (_e) { /* one bad tile never blanks the map */ }
            }
          }
          terrainOrder.push(rememberTerrainSegment(bx, by, camZ, segmentStart, k));
        }
      }
      terrainCount = k;
      buildingStart = terrainCount;
      // (WB-12) buildings: ONE pass over view.buildings, AFTER every tile instance above --
      // matches canvas2d's draw order (buildings drawn after terrain/items/plants/trees, before
      // creatures). `ox`/`oy` convert the wire's WORLD building coords to scene-grid coords;
      // emit() translates them back to WORLD at the instance-buffer boundary (R1).
      // WC-8: machine animation parity for this rebuild (respects the ?freezeAnim seam so
      // parity captures are deterministic; view.freezeAnim is set by the render controller).
      machineParity = (view && view.freezeAnim) ? 0 :
        (typeof view.machineParity === "number" ? view.machineParity :
          machineFrameParityGL(typeof Date !== "undefined" ? Date.now() : 0, false));
      paintFarmLayers(function () {
        for (var bi = 0; bi < buildings.length; bi++) {
          try { emitBuilding(buildings[bi], ox, oy, camZ); } catch (_e2) { /* one bad building never blanks the map */ }
        }
        buildingCount = k - buildingStart;
        cropStart = k;
      }, function () {
        emitFarmCrops(view);
        cropCount = k - cropStart;
      });
      overlayStart = k;
      // WB-14: designation glyphs/washes + presence drag-rects/tile-outlines, ON TOP of
      // terrain and buildings (report §B's OVERLAY LAYER, mirroring dwf-tiles.js's
      // drawDesignation/drawPresence -- the last pass in drawInner). Documented paint-order
      // residual: these render UNDER units (the WB-13 tail appended after the staticCount
      // checkpoint just below) rather than strictly topmost as canvas2d's true last-pass
      // ordering gives -- restructuring the units tick-chain to append a THIRD segment after
      // it was judged not worth the complexity for the rare case of a live unit standing on a
      // marked/cursor tile; same class of accepted draw-order residual as WB-12's tint+z-fade
      // note and WB-15's foam-vs-buildings note elsewhere in this file.
      // B35: append glyph entries for designation JOBS whose map bits were cleared on job
      // pickup (native keeps drawing from the live job). Same prefer-bits-then-job resolution
      // as canvas2d's drawDesignation: only add a djob entry where the desig-bit pass above
      // didn't already draw one for that tile.
      var djobs = (view && view.djobs) || [];
      blinkDjobTiles.clear();
      var unitTiles = unitTileSet(view);
      for (var dji = 0; dji < djobs.length; dji++) {
        var dj = djobs[dji];
        if (!dj) continue;
        // B135: only WORKER-claimed djobs blink/alternate (w:1 on the wire); workerless
        // posted jobs stay steady like native.
        if (dj.w && isBlinkingDesignationJob(dj.k)) blinkDjobTiles.add(dj.x + "|" + dj.y + "|" + dj.z);
        var djOnTile = !!(dj.w && unitTiles && unitTiles.has(dj.x + "|" + dj.y + "|" + dj.z));
        var dgx = dj.x - ox, dgy = dj.y - oy;
        if (dgx < 0 || dgy < 0 || dgx >= gw || dgy >= gh) continue;
        var dt = lookupTile(dgx, dgy);
        if (dt && dt.desig && resolveDesig(dt.desig, dt)) {
          markDesignationJobBlink(desigList, dgx, dgy, dj, djOnTile);
          continue; // bits still present -> already drawn
        }
        var djv = resolveDjob(dj.k, dt);
        if (djv) {
          // B127: claimed jobs are appended after buildTile's B38 designation-lighten pass.
          // Supply the same dark-backdrop treatment for a bits-cleared wall/hidden tile, and
          // preserve the priority tail that remains alongside the cleared dig bit.
          if (dt && (dt.hidden || (dt.shape || "") === "WALL"))
            emitSolid(dgx, dgy, [0, 0, 0], 0, ATTR_ADDITIVE);
          desigList.push({ gx: dgx, gy: dgy, cell: djv.cell, cat: djv.cat, marker: false,
            prio: (dt && dt.desigPriority && dt.desigPriority.priority) | 0,
            djobKind: dj.k, djobWorker: !!dj.w, djobActive: djOnTile });
        }
      }
      try { emitDesignationOverlay(desigList, (typeof view.designationNowMs === "number") ? view.designationNowMs : 0); } catch (_e3) { /* overlay guarded */ }
      try { emitMiningIndicators(tiles, gw, gh); } catch (_e3b) { /* overlay guarded */ }   // B269
      try { emitPresence(players, ox, oy, camZ, ownPlayerName); } catch (_e4) { /* overlay guarded */ }
      overlayCount = k - overlayStart;
      staticCount = k; // WB-13 checkpoint: units append/overwrite ONLY past this index
      lastBuildView = view;
      return { count: k, bytes: k * INSTANCE_BYTES, ms: now() - t0 };
    }

    function buildTerrainChunkSegment(patch) {
      var view = patch.view || {};
      var tiles = view.tiles || [];
      var gw = view.width | 0, gh = view.height | 0;
      var total = gw * gh, n = Math.min(tiles.length, total);
      var ox = view.origin && typeof view.origin.x === "number" ? view.origin.x : patch.bx * 16;
      var oy = view.origin && typeof view.origin.y === "number" ? view.origin.y : patch.by * 16;
      var camZ = view.origin && typeof view.origin.z === "number" ? view.origin.z : patch.z;
      function lookupTile(x, y) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) return null;
        return tiles[y * gw + x] || null;
      }
      ensureCapacity(total * 26 + 32);
      if (!wallGrid || gridN < total) {
        wallGrid = new Uint8Array(total); hiddenGrid = new Uint8Array(total);
        openGrid = new Uint8Array(total); gridN = total;
      }
      var haveHidden = false;
      for (var i = 0; i < n; i++) {
        var t = tiles[i];
        wallGrid[i] = (t && t.shape === "WALL") ? 1 : 0;
        openGrid[i] = (Adj ? Adj.isOpenNeighbor(t) : (!!t && !t.hidden && t.shape !== "WALL" && (typeof t.tt !== "number" || t.tt >= 0))) ? 1 : 0;
        hiddenGrid[i] = (t && t.hidden) ? 1 : 0; if (hiddenGrid[i]) haveHidden = true;
      }
      var gx0 = Math.max(0, patch.bx * 16 - ox), gx1 = Math.min(gw, (patch.bx + 1) * 16 - ox);
      var gy0 = Math.max(0, patch.by * 16 - oy), gy1 = Math.min(gh, (patch.by + 1) * 16 - oy);
      k = 0;
      emitOriginX = ox; emitOriginY = oy;
      chunkCacheByZ = new Map();
      curMapDims = resolveMapDims(); // WT25: once per chunk-segment rebuild (patch path)
      desigList = [];
      for (var gy = gy0; gy < gy1; gy++) {
        for (var gx = gx0; gx < gx1; gx++) {
          var idx = gy * gw + gx;
          if (idx >= n || !tiles[idx]) continue;
          try { buildTile(tiles[idx], gx, gy, gw, gh, wallGrid,
            haveHidden ? hiddenGrid : null,
            camZ, lookupTile, openGrid); } catch (_e) { /* one bad tile never blanks a chunk */ }
        }
      }
      return rememberTerrainSegment(patch.bx, patch.by, patch.z, 0, k);
    }

    // R2 patch/rect-shift core. `patches` contains only dirty or entering chunks, each decoded
    // with a one-tile neighbor border. `nextOrder` is optional; when present, overlapping
    // segments retain their byte arrays and only entering chunks are built.
    function patchTerrainChunks(patches, fullView, nextOrder) {
      var t0 = now();
      patches = patches || [];
      var oldSuffixCount = Math.max(0, k - buildingStart);
      var suffix = oldSuffixCount > 0
        ? new Uint8Array(buf, buildingStart * INSTANCE_BYTES, oldSuffixCount * INSTANCE_BYTES).slice()
        : null;
      var changed = new Set(), chunkMs = [];
      for (var i = 0; i < patches.length; i++) {
        var chunkT0 = now();
        changed.add(buildTerrainChunkSegment(patches[i]));
        chunkMs.push(now() - chunkT0);
      }
      if (Array.isArray(nextOrder)) {
        terrainOrder = nextOrder.slice();
        var keep = new Set(terrainOrder);
        for (var id of terrainSegments.keys()) if (!keep.has(id)) terrainSegments.delete(id);
      }
      var totalTerrain = 0, dirtyStart = -1;
      for (var oi = 0; oi < terrainOrder.length; oi++) {
        var seg0 = terrainSegments.get(terrainOrder[oi]);
        if (!seg0) continue;
        if (dirtyStart < 0 && changed.has(terrainOrder[oi])) dirtyStart = totalTerrain;
        totalTerrain += seg0.count;
      }
      // A rect shift can remove/reorder retained segments before the first entering chunk.
      // Their CPU byte arrays stay untouched, but their compacted GPU offsets move, so upload
      // the flat static prefix from zero (still no terrain re-emission for clean chunks).
      if (Array.isArray(nextOrder)) dirtyStart = 0;
      ensureCapacity(totalTerrain + oldSuffixCount + 32);
      k = 0;
      for (var oj = 0; oj < terrainOrder.length; oj++) {
        var seg = terrainSegments.get(terrainOrder[oj]);
        if (!seg) continue;
        new Uint8Array(buf, k * INSTANCE_BYTES, seg.bytes.byteLength).set(seg.bytes);
        k += seg.count;
      }
      terrainCount = k;
      buildingStart = terrainCount;
      if (suffix) new Uint8Array(buf, k * INSTANCE_BYTES, suffix.byteLength).set(suffix);
      cropStart = buildingStart + buildingCount;
      overlayStart = cropStart + cropCount;
      staticCount = overlayStart + overlayCount;
      k = staticCount + Math.max(0, oldSuffixCount - buildingCount - cropCount - overlayCount);
      emitOriginX = fullView && fullView.origin ? fullView.origin.x : emitOriginX;
      emitOriginY = fullView && fullView.origin ? fullView.origin.y : emitOriginY;
      lastBuildView = fullView || lastBuildView;
      return {
        count: staticCount, bytes: Math.max(0, staticCount - Math.max(0, dirtyStart)) * INSTANCE_BYTES,
        ms: now() - t0, dirtyStart: dirtyStart < 0 ? 0 : dirtyStart, dirtyEnd: staticCount,
        chunks: patches.length, chunkMs: chunkMs,
      };
    }

    // H1/TX4: atomically rewrite [buildingStart, overlayStart) as two painter-ordered segments
    // (buildings, then crops), then repack the already-built overlay and
    // dynamic suffix. On the normal two-frame machine beat the instance count is stable, so the
    // dirty GPU range is exactly the small building segment; the terrain prefix is neither
    // walked nor copied nor uploaded.
    function rebuildBuildings(view) {
      var t0 = now();
      view = view || lastBuildView || {};
      var oldBuildingCount = buildingCount;
      var oldCropCount = cropCount;
      var dynamicCount = Math.max(0, k - staticCount);
      var suffixCount = overlayCount + dynamicCount;
      var suffix = suffixCount > 0
        ? new Uint8Array(buf, overlayStart * INSTANCE_BYTES, suffixCount * INSTANCE_BYTES).slice()
        : null;
      var buildings = buildingsInPaintOrder(view.buildings || []);
      var budget = 0;
      for (var i = 0; i < buildings.length; i++) {
        var b = buildings[i];
        if (!b || isOverlayOnlyBuildingType(b.type)) continue;
        var bw = (typeof b.x2 === "number" && typeof b.x1 === "number") ? Math.max(1, b.x2 - b.x1 + 1) : 1;
        var bh = (typeof b.y2 === "number" && typeof b.y1 === "number") ? Math.max(1, b.y2 - b.y1 + 1) : 1;
        budget += bw * bh;
      }
      budget += farmCropPlansGL(view).length;
      ensureCapacity(buildingStart + budget + suffixCount + 32);
      k = buildingStart;
      machineParity = (view && view.freezeAnim) ? 0 :
        (typeof view.machineParity === "number" ? view.machineParity :
          machineFrameParityGL(typeof Date !== "undefined" ? Date.now() : 0, false));
      var camZ = (view.origin && typeof view.origin.z === "number") ? view.origin.z : null;
      paintFarmLayers(function () {
        for (var bi = 0; bi < buildings.length; bi++) {
          try { emitBuilding(buildings[bi], emitOriginX, emitOriginY, camZ); } catch (_e) { /* guarded */ }
        }
        buildingCount = k - buildingStart;
        cropStart = k;
      }, function () {
        emitFarmCrops(view);
        cropCount = k - cropStart;
      });
      overlayStart = k;
      if (suffix) new Uint8Array(buf, k * INSTANCE_BYTES, suffix.byteLength).set(suffix);
      staticCount = overlayStart + overlayCount;
      k = staticCount + dynamicCount;
      var countChanged = buildingCount !== oldBuildingCount || cropCount !== oldCropCount;
      return {
        count: staticCount, bytes: (buildingCount + cropCount) * INSTANCE_BYTES, ms: now() - t0,
        dirtyStart: buildingStart,
        dirtyEnd: countChanged ? staticCount : overlayStart,
      };
    }

    // The overlay segment is independently replaceable as the second H1 seam. Current R1 still
    // performs a full build for terrain contentVersion changes; this method is for presence/AUX
    // invalidations that do not touch terrain and for the R2 patch path that follows.
    function rebuildOverlay(view) {
      var t0 = now();
      view = view || lastBuildView || {};
      var dynamicCount = Math.max(0, k - staticCount);
      var dynamic = dynamicCount > 0
        ? new Uint8Array(buf, staticCount * INSTANCE_BYTES, dynamicCount * INSTANCE_BYTES).slice()
        : null;
      k = overlayStart;
      desigList = [];
      var gw = view.width | 0, gh = view.height | 0;
      var tiles = view.tiles || [];
      function lookupTile(x, y) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) return null;
        return tiles[y * gw + x] || null;
      }
      for (var i = 0; i < Math.min(tiles.length, gw * gh); i++) {
        var t = tiles[i];
        if (!t || !t.desig) continue;
        var dv = resolveDesig(t.desig, t);
        if (!dv) continue;
        var gx = i % gw, gy = (i - gx) / gw;
        desigList.push({ gx: gx, gy: gy, cell: dv.cell, cat: dv.cat, marker: !!t.desig.marker,
                         prio: (t.desigPriority && t.desigPriority.priority) | 0 });
      }
      var djobs = view.djobs || [];
      blinkDjobTiles.clear();
      var unitTiles = unitTileSet(view);
      for (var di = 0; di < djobs.length; di++) {
        var dj = djobs[di];
        if (!dj) continue;
        // B135: only WORKER-claimed djobs blink/alternate (w:1 on the wire).
        if (dj.w && isBlinkingDesignationJob(dj.k)) blinkDjobTiles.add(dj.x + "|" + dj.y + "|" + dj.z);
        var djOnTile = !!(dj.w && unitTiles && unitTiles.has(dj.x + "|" + dj.y + "|" + dj.z));
        var dgx = dj.x - emitOriginX, dgy = dj.y - emitOriginY;
        if (dgx < 0 || dgy < 0 || dgx >= gw || dgy >= gh) continue;
        var dt = lookupTile(dgx, dgy);
        if (dt && dt.desig && resolveDesig(dt.desig, dt)) {
          markDesignationJobBlink(desigList, dgx, dgy, dj, djOnTile);
          continue;
        }
        var djv = resolveDjob(dj.k, dt);
        if (djv) {
          // B127: claimed jobs are appended after buildTile's B38 designation-lighten pass.
          // Supply the same dark-backdrop treatment for a bits-cleared wall/hidden tile, and
          // preserve the priority tail that remains alongside the cleared dig bit.
          if (dt && (dt.hidden || (dt.shape || "") === "WALL"))
            emitSolid(dgx, dgy, [0, 0, 0], 0, ATTR_ADDITIVE);
          desigList.push({ gx: dgx, gy: dgy, cell: djv.cell, cat: djv.cat, marker: false,
            prio: (dt && dt.desigPriority && dt.desigPriority.priority) | 0,
            djobKind: dj.k, djobWorker: !!dj.w, djobActive: djOnTile });
        }
      }
      // B269: + gw*gh worst case (at most one mining indicator per tile in the window).
      ensureCapacity(overlayStart + desigList.length * 4 + (mineMode ? gw * gh : 0)
                     + presenceBudget(view.players || []) + dynamicCount + 16);
      try { emitDesignationOverlay(desigList, (typeof view.designationNowMs === "number") ? view.designationNowMs : 0); } catch (_e2) { /* guarded */ }
      try { emitMiningIndicators(tiles, gw, gh); } catch (_e2b) { /* guarded */ }   // B269
      var camZ = (view.origin && typeof view.origin.z === "number") ? view.origin.z : null;
      try { emitPresence(view.players || [], emitOriginX, emitOriginY, camZ, ownPlayerName); } catch (_e3) { /* guarded */ }
      overlayCount = k - overlayStart;
      staticCount = k;
      if (dynamic) new Uint8Array(buf, staticCount * INSTANCE_BYTES, dynamic.byteLength).set(dynamic);
      k = staticCount + dynamicCount;
      return { count: staticCount, bytes: overlayCount * INSTANCE_BYTES, ms: now() - t0,
               dirtyStart: overlayStart, dirtyEnd: staticCount };
    }

    // =======================================================================================
    // WB-13: units, called every rAF TICK (not gated by buildScene's data-change key) with the
    // caller's already-interpolated {id,x,y,z,rt,ct,ah,sw,sh,ax,ay} snapshot (see
    // createUnitInterpolator above / the GL controller's tickUnits in dwf-render.js).
    // Resets the write cursor to the `staticCount` checkpoint and re-emits ONLY the unit
    // instances -- the terrain/building bytes already staged/uploaded below `staticCount` are
    // never touched again this session except by a real buildScene() rebuild. R1 subtracts the
    // stable build origin at emit time and adds it at the buffer boundary, so units land at their
    // own world coordinates even while the camera pans; camZ still drives the z-fade shared with
    // emitBuilding (wire:6, mirrors dwf-tiles.js's fogAlphaForDepth).
    // =======================================================================================
    function resolveUnitTierForCtx(u) { return resolveUnitTierGL(u, creaturesMap && creaturesMap.races, atlas); }

    // LARGE_IMAGE coverage (spec §2.6): unlike canvas2d's single ctx.drawImage stretch of the
    // whole composite into one cell, this emits ONE INSTANCE PER 32x32 CELL of the sw x sh
    // composite -- exact multi-cell placement (a "multi-tile elephant" renders its own real
    // w x h cells), anchored per WE-2 §3 so the unit's own tile is the anchor's bottom cell
    // (top-left cell = x-ax, y-ay, matching dwf-tiles.js's tier-1 draw verbatim).
    // B98 ghost tint: a ghost unit (wire gh:1, world_stream.cpp) gets a spectral-green multiply
    // tint + DF's own ghost translucency (creature-compositing-system.md: the GHOST palette row
    // is alpha=163) applied UNIFORMLY across every sprite tier and the fallback dot, so ghosts
    // read the same whether they resolve to a layered composite, a flat race cell, the baked
    // dwarf, or the tier-5 dot. tr/tg/tb default to 255 (no tint) for living units.
    function emitUnitSprite(u, gx, gy, alpha255, tr, tg, tb) {
      if (typeof tr !== "number") { tr = 255; tg = 255; tb = 255; }
      var sel = resolveUnitTierForCtx(u);
      if (sel.tier === 1) {
        var sw = u.sw | 0, sh = u.sh | 0;
        if (sw <= 0 || sh <= 0) return false;
        var ax = (typeof u.ax === "number") ? u.ax : 0;
        var ay = (typeof u.ay === "number") ? u.ay : Math.max(0, sh - 1);
        var any = false;
        for (var ry = 0; ry < sh; ry++) {
          for (var rx = 0; rx < sw; rx++) {
            var c = atlas.resolve(u.ah, rx, ry);
            if (c > 0) { emit(gx - ax + rx, gy - ay + ry, c, tr, tg, tb, alpha255, 0); any = true; }
          }
        }
        return any;
      }
      if (sel.tier === 3) {
        // WE-6: span rw x sh cells for LARGE_IMAGE flat creatures (own-race sheet cell), one
        // atlas instance per cell -- same anchor rule as tier 1 above (center column, bottom
        // row is the unit's own tile). rw===rh===1 (most races) collapses to the original
        // single-instance emit at (gx,gy).
        var rw = sel.rec.w || 1, rh = sel.rec.h || 1;
        var rax = (rw === 1) ? 0 : 1;
        var ray = rh - 1;
        var any3 = false;
        for (var ry3 = 0; ry3 < rh; ry3++) {
          for (var rx3 = 0; rx3 < rw; rx3++) {
            var c3 = atlas.resolve(sel.rec.sheet, sel.rec.col + rx3, sel.rec.row + ry3);
            if (c3 > 0) { emit(gx - rax + rx3, gy - ray + ry3, c3, tr, tg, tb, alpha255, 0); any3 = true; }
          }
        }
        return any3;
      }
      if (sel.tier === 4) {
        var c4 = atlas.resolve(sel.key, 0, 0);
        if (c4 > 0) { emit(gx, gy, c4, tr, tg, tb, alpha255, 0); return true; }
        return false;
      }
      return false; // tier 5: caller draws the fallback dot
    }

    function buildUnits(units, ox, oy, camZ, nowMs) {
      k = staticCount;
      var list = units || [];
      // status bubbles: NATIVE per-unit blink cadence (nativeBubblePhase). No fort-wide sync -- each
      // unit's ordinary bubble shows ~2s of every 7s, staggered by unit.id; physical markers fill the
      // other ~5s window. The budget below sizes for the WINNING icon (unitStatusIconForBits) so a
      // cell is reserved whether or not this exact frame is inside the visible window (safe over-alloc).
      // Exact per-unit budget (same "size generously, no silent clamp" convention as WB-12's
      // buildingBudget pre-pass): a tier-1 composite needs up to sw*sh cells; a tier-3
      // LARGE_IMAGE flat race (WE-6, e.g. giant animals / sperm whale) needs up to its own
      // creatures_map w*h; everything else at most 1.
      var budget = 0;
      var raceMap = creaturesMap && creaturesMap.races;
      for (var bi = 0; bi < list.length; bi++) {
        var bu = list[bi];
        var span = 1;
        if (bu && typeof bu.sw === "number" && typeof bu.sh === "number") {
          span = Math.max(1, bu.sw * bu.sh);
        } else if (bu && bu.rt && raceMap) {
          var brec = raceMap[bu.rt];
          if (brec && brec.sheet && (brec.w || brec.h)) span = Math.max(1, (brec.w || 1) * (brec.h || 1));
        }
        if (bu && unitStatusIconForBits(bu.st, bu.st2)) span += 1;
        budget += span;
      }
      ensureCapacity(staticCount + budget + 8);
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (!u || typeof u.x !== "number" || typeof u.y !== "number") continue;
        // R1: emit() adds the scene origin, so subtract that stable build origin rather than
        // the caller's moving camera origin. The resulting instance stays at u.x/u.y in world.
        var gx = u.x - emitOriginX, gy = u.y - emitOriginY;
        // wire:6 z-fade (verbatim -- same curve as terrain descent/buildings): units arrive
        // across the whole stacked z-range around the camera, not just the camera plane.
        var udz = (typeof u.z === "number" && typeof camZ === "number") ? u.z - camZ : 0;
        // B03/B23 (GL parity, mirrors dwf-tiles.js): a unit renders on its own z-plane, OR
        // -- when the server tagged it see-down-visible (u.sd: an open column up to the camera
        // plane, DF's see-down rule) -- one or more levels BELOW the camera, fog-dimmed by depth.
        // Untagged off-z units are still dropped (the stale cross-z AUX ghosts B03 guards against);
        // above-camera units never render (see-above deleted -- sd is only set for below-camera).
        var seeDownU = !!u.sd && udz < 0;
        if (udz !== 0 && !seeDownU) continue;
        // B135 worked-tile alternation: a unit standing on a WORKER-claimed (w:1) designation
        // tile is drawn only on the unit half of the 400ms half-beat; the glyph (state 2:
        // visible on the activeBlinkVisible half, and painted UNDER the dynamic tail -- WB-14's
        // paint-order residual) owns the other half. Math.round maps the interpolated position
        // back to the logical tile; a working dwarf is stationary so this is exact.
        if (udz === 0 && blinkDjobTiles.size &&
            blinkDjobTiles.has(Math.round(u.x) + "|" + Math.round(u.y) + "|" + u.z) &&
            !workedTileUnitVisible(nowMs)) continue;
        // B23 depth-dim (mirrors dwf-tiles.js): floor a see-down unit's opacity so deep
        // ones stay READABLE (belowAlpha hits 0 by depth ~8 and would re-hide them); the
        // deepening blue comes from the fog-washed terrain drawn behind. Normal units stay opaque.
        var uAlpha = seeDownU ? Math.max(0.55, belowAlpha(-udz)) : 1;
        // B98 ghost tint: fold DF's ghost translucency into the unit's alpha and pass the
        // spectral-green multiply tint into every tier + the fallback dot below.
        var isGhost = (u.gh === 1);
        if (isGhost) uAlpha *= GHOST_ALPHA;
        var alpha255 = Math.max(0, Math.min(255, Math.round(uAlpha * 255)));
        var gtr = isGhost ? GHOST_TINT_RGB[0] : 255;
        var gtg = isGhost ? GHOST_TINT_RGB[1] : 255;
        var gtb = isGhost ? GHOST_TINT_RGB[2] : 255;
        try {
          if (!emitUnitSprite(u, gx, gy, alpha255, gtr, gtg, gtb)) {
            // T1 parity fix (same class as the WC-22 vehicle marker): the tier-5 fallback was
            // a FULL-TILE yellow emitSolid vs canvas2d's small centered dot (r=cell/3, yellow
            // fill + dark outline) -- a full-bleed uniform quad reads as fg=0 "blank" to the
            // sweep and buries the tile. Exposed at scale when the crash-recovered range world
            // broke unit composites for generated creatures (both renderers fell to tier 5:
            // 32 NIGHT_CREATURE/DEMON one-renderer-blank PMs). Stamp = c2d's exact geometry.
            var uc = (atlas && atlas.resolveStamp) ? atlas.resolveStamp("unit:dot", paintUnitDotStamp) : 0;
            if (uc > 0) emit(gx, gy, uc, gtr, gtg, gtb, alpha255, 0);
            else emitSolid(gx, gy, isGhost ? GHOST_TINT_RGB : UNIT_FALLBACK_RGB, alpha255, 0);  // legacy/mock-atlas fallback
          }
          // native per-unit blink cadence: physical marker in the <5001 window, ordinary bubble in
          // the >=5001 window, staggered per unit by unit.id (nativeBubblePhase). tickUnits re-emits
          // this tail every rAF, so the visibility is recomputed each frame with no dirty bookkeeping.
          var sic = unitStatusIconNow(u.st, u.st2, u.id, nowMs);
          if (sic) {
            var scell = atlas && atlas.resolve ? atlas.resolve(sic.sheet, sic.col, sic.row) : 0;
            if (scell > 0) emit(gx, gy - 1, scell, 255, 255, 255, alpha255, 0);
          }
        } catch (_e3) { /* one bad unit never blanks the map */ }
      }
      return { count: k - staticCount, bytes: (k - staticCount) * INSTANCE_BYTES };
    }

    // WC-22 (GL): the THIRD dynamic-instance region -- projectiles/vehicles in flight, the GL
    // parity for dwf-tiles.js's drawProjectiles marker (a bright bolt dot / a boxier cart
    // square). APPENDS to the dynamic tail AFTER buildUnits (does NOT reset k), so units + proj
    // share one contiguous [staticCount, k) region that uploadIfPending ships as a single tail;
    // re-emitted every rAF tick like units. Sub-tile placement uses the wire's fx/fy the SAME
    // way canvas2d's projCenterPx does: (fraw-128)/255 is a signed -0.5..+0.5 tile offset AROUND
    // the tile center (0/255 = half a tile either way, 128 = centered). No interpolation (latest
    // AUX snapshot each tick -- projectiles move too fast/briefly for a lerp to help; documented
    // parity with canvas2d's own latest-snapshot marker). Solid-color markers, not item art --
    // exact parity with the canvas2d marker (item-sprite resolution for projectiles is a shared
    // future refinement in BOTH renderers, not this pass).
    var PROJ_RGB = [250, 240, 200];   // bolt/stone/etc. (canvas2d rgba(250,240,200,0.95))
    var VEHICLE_RGB = [180, 150, 90]; // minecart/vehicle (canvas2d rgba(180,150,90,0.9))
    // T1 parity fix (root cause of the 8 "gl-blank" ITEM_TOOL_MINECART PARITY-MISMATCH cells,
    // spec §5 sub-class A): the old `emitSolid(..., 245, ...)` vehicle marker was a FULL-TILE
    // near-opaque khaki quad -- it completely occluded the tile's own minecart ITEM sprite
    // (canvas2d draws a HALF-cell square outline, cart art visible around it), and a full-bleed
    // uniform quad reads as fg=0 "blank" to the sweep's border-background metric. Both markers
    // are now painted ONCE into synthetic atlas stamp cells with canvas2d's EXACT geometry
    // (vehicle: centered cell*0.5 filled square, rgba(180,150,90,.9) + 1px rgba(40,30,10,.9)
    // outline; projectile: centered r=cell*0.16 dot, rgba(250,240,200,.95) + dark outline) and
    // emitted as normal sprites at the same sub-tile center. Mock atlases without resolveStamp
    // (older node fixtures) fall back to the legacy solid so no harness hard-breaks.
    function paintVehicleStamp(d, size) {
      var s = Math.max(3, Math.round(size * 0.5));     // canvas2d: Math.max(3, cell*0.5)
      var x0 = Math.round((size - s) / 2), y0 = Math.round((size - s) / 2);
      for (var y = y0; y < y0 + s; y++) {
        for (var x = x0; x < x0 + s; x++) {
          var i = (y * size + x) * 4;
          var edge = (x === x0 || x === x0 + s - 1 || y === y0 || y === y0 + s - 1);
          if (edge) { d[i] = 40; d[i + 1] = 30; d[i + 2] = 10; d[i + 3] = 230; }
          else { d[i] = VEHICLE_RGB[0]; d[i + 1] = VEHICLE_RGB[1]; d[i + 2] = VEHICLE_RGB[2]; d[i + 3] = 230; }
        }
      }
    }
    function paintProjStamp(d, size) {
      var cx = size / 2, cy = size / 2, r = Math.max(1.5, size * 0.16);
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r + 1) continue;
          var i = (y * size + x) * 4;
          if (dist <= r) { d[i] = PROJ_RGB[0]; d[i + 1] = PROJ_RGB[1]; d[i + 2] = PROJ_RGB[2]; d[i + 3] = 242; }
          else { d[i] = 30; d[i + 1] = 20; d[i + 2] = 10; d[i + 3] = 230; }
        }
      }
    }
    // Tier-5 unit fallback dot: canvas2d's exact geometry (drawUnits: centered circle
    // r=Math.max(2, floor(cell/3)), UNIT_COLOR yellow fill + UNIT_OUTLINE dark 1px stroke).
    function paintUnitDotStamp(d, size) {
      var cx = size / 2, cy = size / 2, r = Math.max(2, Math.floor(size / 3));
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r + 1) continue;
          var i = (y * size + x) * 4;
          if (dist <= r) { d[i] = UNIT_FALLBACK_RGB[0]; d[i + 1] = UNIT_FALLBACK_RGB[1]; d[i + 2] = UNIT_FALLBACK_RGB[2]; d[i + 3] = 255; }
          else { d[i] = 20; d[i + 1] = 20; d[i + 2] = 20; d[i + 3] = 235; }
        }
      }
    }
    // B256 (GL twin of dwf-tiles.js projItemVisual -- see that file's banner for DF's real
    // model: no projectile sheet, the AMMO ITEM's own graphics_items.txt cell IS the flying art).
    // Returns {entry,source} or null (unknown type / MISSING placeholder -> keep the marker).
    function projItemVisualGL(p) {
      if (!p || !itemMap || typeof p.item_type !== "number" || p.item_type < 0) return null;
      var type = itemTypeNames && itemTypeNames.get(p.item_type);
      if (!type) return null;
      var v = resolveItemVisualGL({
        type: type,
        subtype: typeof p.subtype === "number" ? p.subtype : -1,
        mat_type: typeof p.mat_type === "number" ? p.mat_type : -1,
        mat_index: typeof p.mat_index === "number" ? p.mat_index : -1,
        iflags: 0,
      });
      return (v && v.entry && v.entry.sheet && v.source !== "missing") ? v : null;
    }
    // The palette/tint emit rules are emitItem's, applied to a projectile's sub-tile position:
    // a copper bolt is copper. Returns true when a real sprite instance was emitted.
    function emitProjItem(p, gx, gy) {
      var vis = projItemVisualGL(p);
      var e = vis && vis.entry;
      if (!e || !atlas) return false;
      var palRow;
      if (materialMap && PALETTIZABLE_SOURCE_GL[vis.source]) {
        var pr = matPalRowForGL({ mat_type: p.mat_type, mat_index: p.mat_index });
        if (typeof pr === "number") palRow = pr;
      }
      var c = -1;
      if (palRow !== undefined && atlas.resolvePalette) {
        var remap = paletteRemapFor(palRow);
        if (remap) c = atlas.resolvePalette(e.sheet, e.col, e.row, palRow, remap);
      }
      if (c <= 0) { c = atlas.resolve(e.sheet, e.col, e.row); palRow = undefined; }
      if (!(c > 0)) return false;
      if (palRow !== undefined) { emitSprite(gx, gy, c, 0); return true; }
      var fam = matFamilyFor(p.mat_type);
      var tint = fam && ITEM_TINT_RGB_BY_FAMILY[fam];
      if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], 255, 0);
      else emitSprite(gx, gy, c, 0);
      return true;
    }
    function buildProjectiles(projs, ox, oy, camZ) {
      var list = projs || [];
      // capacity: keep the units tail already at [staticCount,k) and add one instance per proj.
      ensureCapacity(k + list.length + 4);
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
        // z-filter to the camera plane (server already window+z-filters; belt-and-suspenders,
        // mirrors canvas2d drawProjectiles' own `p.z !== oz` guard).
        if (typeof p.z === "number" && typeof camZ === "number" && p.z !== camZ) continue;
        var offx = ((typeof p.fx === "number" ? p.fx : 128) - 128) / 255;
        var offy = ((typeof p.fy === "number" ? p.fy : 128) - 128) / 255;
        var gx = (p.x - emitOriginX) + offx, gy = (p.y - emitOriginY) + offy;
        try {
          // B256: real item art first (bolts/arrows/darts/thrown weapons). Vehicles keep the
          // cart marker -- the minecart's own ITEM sprite is drawn by the tile layer underneath.
          if (!p.vehicle && emitProjItem(p, gx, gy)) continue;
          var sc = 0;
          if (atlas && atlas.resolveStamp) {
            sc = p.vehicle ? atlas.resolveStamp("proj:vehicle", paintVehicleStamp)
                           : atlas.resolveStamp("proj:bolt", paintProjStamp);
          }
          if (sc > 0) emitSprite(gx, gy, sc, 0);
          else emitSolid(gx, gy, p.vehicle ? VEHICLE_RGB : PROJ_RGB, 245, 0);  // legacy/mock-atlas fallback
        } catch (_ep) { /* one bad proj never blanks the map */ }
      }
      return { count: k - staticCount, bytes: (k - staticCount) * INSTANCE_BYTES };
    }

    // B139 (GL): the FOURTH dynamic-instance region -- flow clouds (miasma et al.), the GL
    // parity for dwf-tiles.js's drawFlows. APPENDS after buildProjectiles (no k reset)
    // so terrain/buildings/overlay stay untouched and the whole dynamic tail ships as one
    // partial upload; re-emitted every rAF tick, which is also what animates the shared-beat
    // opacity dip (alpha rides the per-instance tint, no shader change). The stamp is ONE
    // white soft radial falloff painted once into a synthetic atlas cell; per-instance tint
    // carries the flow color + density-mapped alpha (canvas2d's radial gradient bleeds
    // ~0.22 cell past the tile so neighbors merge; the GL stamp is clipped to its quad --
    // documented sub-cell parity residual, same class as the projectile markers).
    function paintFlowCloudStamp(d, size) {
      var cx = size / 2, cy = size / 2, rr = size * 0.5;
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          var dist = Math.sqrt(dx * dx + dy * dy) / rr;   // 0 center .. 1 quad edge
          if (dist >= 1) continue;
          // mirror the canvas gradient stops (1 @0, 0.6 @0.62, 0 @1), linear between.
          var a = dist < 0.62 ? 1 - 0.4 * (dist / 0.62) : 0.6 * (1 - dist) / 0.38;
          var i = (y * size + x) * 4;
          d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(255 * a);
        }
      }
    }
    function buildFlows(flows, nowMs) {
      var list = flows || [];
      ensureCapacity(k + list.length + 4);
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!f || typeof f.x !== "number" || typeof f.y !== "number") continue;
        try {
          var plan = flowOverlayForGL(f, nowMs);
          if (!plan) continue;
          var a = plan.alpha, sa = plan.spriteAlpha;
          // see-down substituted tile: same depth dim as canvas2d's drawFlows.
          if (typeof f.depth === "number" && f.depth > 0) {
            var fdim = Math.max(0.35, 1 - 0.12 * f.depth); a *= fdim; sa *= fdim;
          }
          var a255 = Math.max(0, Math.min(255, Math.round(a * 255)));
          var sa255 = Math.max(0, Math.min(255, Math.round(sa * 255)));
          var gx = f.x - emitOriginX, gy = f.y - emitOriginY;
          // TX18: DF's own authored flow art (EVENT_FLOWS FLOW_MIASMA, 4 frames) via the SAME
          // animated-atlas path every terrain sprite uses -- white tint preserves the sheet
          // colours, animAttr drives the 4-frame cycle in the shader (u_timeMs clock). Falls
          // back to the B139 white radial stamp + purple tint when the sheet/atlas isn't ready.
          var animCell = 0, animAttr = 0;
          var e = plan.token && spriteMap && spriteMap[plan.token];
          if (e && e.sheet && e.frames && e.frames.length && atlas && atlas.resolveAnimated) {
            animCell = atlas.resolveAnimated(plan.token, e.sheet, e.frames);
            if (animCell > 0 && e.frames.length > 1)
              animAttr = encodeAnimAttr(e.frames.length, defaultAnimRateCodeForToken(plan.token));
          }
          if (animCell > 0) { emit(gx, gy, animCell, 255, 255, 255, sa255, animAttr); continue; }
          var sc = (atlas && atlas.resolveStamp) ? atlas.resolveStamp("flow:cloud", paintFlowCloudStamp) : 0;
          if (sc > 0) emit(gx, gy, sc, plan.rgb[0], plan.rgb[1], plan.rgb[2], a255, 0);
          // legacy/mock-atlas fallback: a solid quad has no radial falloff, so halve the
          // alpha to keep the average coverage in the same class as the stamp.
          else emitSolid(gx, gy, plan.rgb, Math.round(a255 * 0.55), 0);
        } catch (_ef) { /* one bad flow never blanks the map */ }
      }
      return { count: k - staticCount, bytes: (k - staticCount) * INSTANCE_BYTES };
    }

    return {
      buildScene: buildScene,
      patchTerrainChunks: patchTerrainChunks,
      rebuildBuildings: rebuildBuildings,
      rebuildOverlay: rebuildOverlay,
      buildUnits: buildUnits,
      buildProjectiles: buildProjectiles,   // WC-22: third dynamic region, appends after units
      buildFlows: buildFlows,               // B139: fourth dynamic region, flow clouds (miasma)
      get buffer() { return buf; },
      get count() { return k; },
      get staticCount() { return staticCount; },
      get terrainCount() { return terrainCount; },
      get buildingCount() { return buildingCount; },
      get cropStart() { return cropStart; },
      get cropCount() { return cropCount; },
      get overlayCount() { return overlayCount; },
      hasTerrainSegment: function (bx, by, z) {
        return terrainSegments.has(terrainSegmentId(bx, by, z));
      },
      terrainSegmentId: terrainSegmentId,
      _getTerrainSegmentForTest: function (bx, by, z) {
        return terrainSegments.get(terrainSegmentId(bx, by, z)) || null;
      },
      setMaps: function (m) {
        if (m.atlas !== undefined) atlas = m.atlas;
        if (m.spriteMap !== undefined) spriteMap = m.spriteMap;
        if (m.tokenMap !== undefined) tokenMap = m.tokenMap;
        if (m.shadowCellMap !== undefined) shadowCellMap = m.shadowCellMap;
        if (m.adjacency !== undefined) Adj = m.adjacency;
        if (m.cacheReader !== undefined) cacheReader = m.cacheReader;
        if (m.tiletypeMeta !== undefined) tiletypeMeta = m.tiletypeMeta;
        // WB-11 sparse-layer maps.
        if (m.itemMap !== undefined) { itemMap = m.itemMap; applySheetGeometryFromItemMap(); }
        if (m.plantMap !== undefined) plantMap = m.plantMap;
        if (m.treeMap !== undefined) treeMap = m.treeMap;
        if (m.spatterMap !== undefined) spatterMap = m.spatterMap;
        // WB-12
        if (m.buildingMap !== undefined) buildingMap = m.buildingMap;
        // WB-13
        if (m.creaturesMap !== undefined) creaturesMap = m.creaturesMap;
        // WC-17 GL parity
        if (m.grassColors !== undefined) grassColors = m.grassColors;
        // T1a/T1c/T1d: material identity + palette table (rebuild the default-color lookup on
        // change) + the wire-driven itemdef token map forwarded from dwf-tiles.js.
        if (m.materialMap !== undefined) { materialMap = m.materialMap; buildPaletteLookup(); }
        if (m.itemDefTokens !== undefined) itemDefTokens = m.itemDefTokens;
        if (m.itemTypeNames !== undefined) itemTypeNames = m.itemTypeNames;   // B256
      },
      // test hooks
      _resolveSprite: resolveSprite,
      _tileColor: tileColor,
      _isTreeWallMatForTest: isTreeWallMat,           // B62 parity: TREE/MUSHROOM WALL-as-trunk predicate
      _wallJoinCellForTest: function (t, openMask, gx, gy) { return wallJoinCell(t, openMask, gx, gy); },
      _grassBackingCellForTest: grassBackingCellGL,
      _groundBackingCellForTest: groundBackingCellGL, // B241: (t,gx,gy,lookup) -> {cell,wash} | null
      _boulderVariantForTest: boulderVariantGL,       // B241: (t,gx,gy) -> atlas cell | 0 (8-cell fan-out)
      _inMapBoundsForTest: inMapBoundsGL,   // WT25: (t,dims) footprint test (canvas2d parity)
      _wantsHiddenHatchForTest: wantsHiddenHatchGL, // WT25: hatch decision (canvas2d parity)
      _overlaysAllowedForTest: overlaysAllowedGL,   // B235: only DISCOVERED tiles get the overlay stack
      _sandFloorPlanForTest: sandFloorPlan,   // B62-r2: (t,gx,gy,lookup) -> atlas cell | 0
      _emitTreeForTest: emitTree,                     // B62-r2: tail-less tree tiles still emit art
      _descendSeeDown: descendSeeDown,
      // WB-11 test hooks (same fixture-replay convention as dwf-tiles.js's
      // _resolveItemEntryForTest/_spatterFamilyForTest/_spatterShapeForTest/etc.).
      _resolveItemEntryForTest: resolveItemEntryGL,
      _resolveItemVisualForTest: resolveItemVisualGL,         // T1d: {entry,source} incl itemdef step
      _projItemVisualForTest: projItemVisualGL,               // B256: projectile record -> item art
      _containerPeekEntryForTest: containerPeekEntryGL,       // TX1: (containerItem, peek) -> overlay cell|null
      _matPalRowForTest: matPalRowForGL,                      // T1c: material -> palette row
      _matFamilyForItemForTest: matFamilyForItemGL,           // T1d: EXACT METAL/STONE family
      _constructionFloorPlanForTest: constructionFloorPlanGL, // B47: GL/canvas2d parity plan
      _constructionTrackMaskForTest: constructionTrackMask,   // B47: ttname -> track adjacency mask
      _fortificationOpenTokenForTest: fortificationOpenTokenGL,
      _consMaterialForTest: consMaterialGL,                   // WALLSFIX: base_mt/mi -> {family,palRow}|null
      _consMaterialRgbForTest: consMaterialRgbGL,             // WALLSFIX: base_mt/mi -> [r,g,b]|null
      _wallMaterialForTest: wallMaterialGL,                   // TX16: construction/natural-stone material policy
      _wallJoinPalRowForTest: wallJoinPalRowGL,               // TX16: wall-face palette row
      _wallBackingTokenForTest: wallBackingTokenGL,           // B281: natural wall dark hidden-rock underlay
      _terrainSpritePalRowForTest: terrainSpritePalRowGL,     // B273: palette-authored natural terrain
      _wallPrefixForTest: wallPrefix,                         // WALLSFIX: (mat,base_mt) -> family prefix
      _wallDetailPrefixForTest: wallDetailPrefix,             // B74: (t) -> smoothed/worn wall family | null
      _paletteRemapForTest: paletteRemapFor,                  // T1c: (palRow)->remap(cellData) | null
      _resolveIdentityEntryForTest: resolveIdentityEntryGL,   // B31 regression guard (GL half)
      _spatterFamilyForTest: function (sp) { return spatterFamilyForCtx(spatterMap, sp); },
      _bloodFamilyFromRgbForTest: bloodFamilyFromRgb,
      _engravingWallTokenForTest: engravingWallTokenGL,
      _engravingWallPlanForTest: engravingWallPlanGL,         // TX16: engraved wall token + material row
      _engravingFloorPlanForTest: engravingFloorPlanGL,       // B273: palette/non-palette floor art + row
      _itemMarkTokenForTest: itemMarkToken,
      _spatterShapeForTest: function (amount) { return spatterShapeForCtx(spatterMap, amount); },
      _spatterVisibleForTest: spatterVisible,
      _spatterVisibleAmountForTest: SPATTER_VISIBLE_AMOUNT,
      _parseTreeTtnameForTest: parseTreeTtname,
      _resolveTreeCellForTest: resolveTreeCellGL,
      // WB-12 test hooks (same fixture-replay convention as dwf-tiles.js's WC-4 hooks
      // _buildingEntryForTest/_isOverlayOnlyBuildingTypeForTest).
      _buildingEntryForTest: buildingEntryGL,
      _plannedConstructionEntryForTest: plannedConstructionEntryGL,  // TX17
      _constructionPlannedTokenForTest: CONSTRUCTION_PLANNED_TOKEN,  // TX17
      _machineEntryForTest: machineEntryGL,   // WC-8: (b, buildingMap, frameParity) -> synth entry|null
      _hasDrawableMachineForTest: hasDrawableMachineGL,
      _machineCadenceStepForTest: machineCadenceStepGL,
      _farmPlotEntryForTest: farmPlotEntryGL,  // B27a: (b) -> furrowed/planted bed entry|null
      _farmCropPlansForTest: farmCropPlansGL,  // TX4: shared per-stage crop overlay plans
      _emitBuildingForTest: emitBuilding,
      // WB-13 test hooks (same fixture-replay convention as every tier above).
      _resolveUnitTierForTest: resolveUnitTierForCtx,
      // WB-15 test hooks (same fixture-replay convention as every tier above).
      _tokenCellForTest: tokenCell, _animAttrForTokenForTest: animAttrForToken,
      _emitShoreFoamForTest: emitShoreFoam,
      _liquidEdgeTokensForTest: function (t, gx, gy, lookupTile) { return liquidEdgeTokens(t, gx, gy, lookupTile, Adj); },
    };
  }

  function now() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  // B206 PAUSE-ANIM: the pause-aware WORLD animation offset (dwf-animclock.js). Every
  // game-world animation clock here (u_timeMs sprite/flow/fire/water cycling, machine frames)
  // subtracts this so it FREEZES while the server-global game is paused and RESUMES without a
  // jump. UI clocks (designation blink -> now()/ts) deliberately do NOT subtract it. Absent
  // module -> 0, i.e. the pre-B206 raw-wall-clock behaviour, and never throws.
  function animOffset(wallMs) {
    try {
      var c = (typeof window !== "undefined") && window.DFAnimClock;
      if (c && typeof c.offset === "function") return c.offset(wallMs) || 0;
    } catch (_e) { /* inert-graceful */ }
    return 0;
  }
  // A wall-rate clock (perf.now or Date.now epoch) with paused spans removed.
  function worldNow(wallMs) {
    var b = (typeof wallMs === "number" && isFinite(wallMs)) ? wallMs : now();
    return b - animOffset(b);
  }
  // B206: machine frames on the pause-aware world clock. GL machines are stamped on the Date.now
  // epoch (WC-8, and every existing machine gate mocks Date.now) so this stays there; the offset
  // is a pure DURATION, so subtracting it still FREEZES the Date.now reader on pause and resumes
  // it continuously (before-pause and after-resume both track Date.now). The only edge effect is
  // that the single HELD frame is the perf-epoch parity rather than the last running one -- an
  // imperceptible <=1 of 2 machine frames, and never a moving animation. Miasma/flows/water/fire
  // (u_timeMs, the reported bug) are perf-epoch throughout, so they freeze with zero edge effect.
  function machineNow() {
    return worldNow(Date.now());
  }

  // =========================================================================================
  // GL PIPELINE (browser only). One program, one interleaved VBO (divisor-1 instancing), one
  // TEXTURE_2D_ARRAY atlas, one RenderParams UBO, one drawArraysInstanced. Camera = two
  // uniforms. Context-loss recreates GL objects; the seam decides fallback.
  // =========================================================================================

  var VERT_SRC =
    "#version 300 es\n" +
    "layout(location=0) in vec2 i_grid;\n" +          // grid (gx,gy)
    "layout(location=1) in uvec2 i_cellAttr;\n" +     // x=atlasCell, y=attr
    "layout(location=2) in vec4 i_tint;\n" +          // normalized rgba
    "uniform vec2 u_scroll;\n" +                       // fractional world offset (pan)
    "uniform vec3 u_view;\n" +                         // cellPx, canvasWpx, canvasHpx
    // WB-15: the animation clock, in ms, advanced by the seam every rAF frame (or pinned to 0
    // under ?freezeAnim=1 / the seam's own freeze flag -- spec: "REQUIRED by every parity gate
    // from here on"). Reading RenderParams here too (SAME uniform block/binding as the fragment
    // shader below -- GLSL links matching-layout interface blocks across stages into one) so the
    // vertex stage can honor reserved0.w as a GLOBAL kill switch (spec Rollback: "animRate=0
    // global kill-switch in RenderParams reserved0.w") without a second UBO or a JS round-trip.
    "uniform float u_timeMs;\n" +
    "layout(std140) uniform RenderParams {\n" +
    "  vec4 designationLighten;\n" +
    "  vec4 grassRecolor;\n" +
    "  vec4 reserved0;\n" +
    "  vec4 seeDownTint;\n" +
    "  vec4 seeDownCurve;\n" +
    "} u_rp;\n" +
    "out vec3 v_uvp;\n" +
    "out vec4 v_tint;\n" +
    "flat out uint v_attr;\n" +
    "flat out uint v_solid;\n" +
    "void main(){\n" +
    "  int vid = gl_VertexID;\n" +
    "  vec2 corner = vec2(float(vid==1||vid==4||vid==5), float(vid==2||vid==3||vid==5));\n" +
    "  vec2 tilePx = (i_grid - u_scroll + corner) * u_view.x;\n" +
    "  vec2 clip = vec2(tilePx.x / u_view.y * 2.0 - 1.0, 1.0 - tilePx.y / u_view.z * 2.0);\n" +
    "  gl_Position = vec4(clip, 0.0, 1.0);\n" +
    "  uint cell = i_cellAttr.x;\n" +
    "  v_attr = i_cellAttr.y;\n" +
    "  v_tint = i_tint;\n" +
    "  if (cell == 65535u) { v_solid = 1u; v_uvp = vec3(0.0); }\n" +
    "  else {\n" +
    "    v_solid = 0u;\n" +
    // WB-15 frame-select (report §W11 / gl-atlas.js RECONCILE banner: `cell += (time/rate +
    // hash) % animFrames`, spelled out exactly here): animFrames is stored as (frameCount-1) in
    // bits 0-3 (so this ALWAYS runs, even for a static sprite -- frameCount==1 makes the mod a
    // no-op, no branch needed to skip it); animRate (bits 4-6) indexes ANIM_RATE_HZ's {2,4,8,15}
    // Hz enum. A per-tile integer hash of the GRID position (never the world/camera scroll, so
    // the SAME world tile always gets the SAME phase regardless of pan) offsets each tile's
    // cycle so same-token neighbors don't animate in lockstep. reserved0.w is the global
    // kill-switch (0 = every animated instance freezes at its frame-0/base cell, matching a
    // fresh scene-build with no clock at all); u_timeMs itself is 0 under ?freezeAnim=1 (the
    // seam), which already yields frameIdx 0 * hz = phase-only, but the explicit `> 0.5` guard
    // below additionally SKIPS the hash/mod work entirely when either kill mechanism is active.
    "    uint frameCount = (v_attr & 0xFu) + 1u;\n" +
    "    if (frameCount > 1u && u_rp.reserved0.w > 0.5) {\n" +
    "      uint rateCode = (v_attr >> 4u) & 0x7u;\n" +
    "      float hzTable[8] = float[8](2.0, 4.0, 8.0, 15.0, 2.0, 4.0, 8.0, 15.0);\n" +
    "      float hz = hzTable[rateCode];\n" +
    "      uint gxu = uint(i_grid.x);\n" +
    "      uint gyu = uint(i_grid.y);\n" +
    "      uint h = gxu * 374761393u + gyu * 668265263u;\n" +
    "      h = (h ^ (h >> 13u)) * 1274126177u;\n" +
    "      h = h ^ (h >> 16u);\n" +
    "      float phase = float(h % 1009u) / 1009.0;\n" +
    "      float adv = (u_timeMs / 1000.0) * hz + phase * float(frameCount);\n" +
    "      uint frameIdx = uint(mod(floor(adv), float(frameCount)));\n" +
    "      cell = cell + frameIdx;\n" +
    "    }\n" +
    "    float idx = float(cell);\n" +
    "    float page = floor(idx / 3600.0);\n" +
    "    float local = idx - page * 3600.0;\n" +
    "    float ccol = mod(local, 60.0);\n" +
    "    float crow = floor(local / 60.0);\n" +
    "    vec2 originPx = vec2(ccol, crow) * 34.0 + 1.0;\n" +
    "    vec2 uv = (originPx + corner * 32.0) / 2048.0;\n" +
    "    v_uvp = vec3(uv, page);\n" +
    "  }\n" +
    "}\n";

  var FRAG_SRC =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "precision highp sampler2DArray;\n" +
    "uniform sampler2DArray u_atlas;\n" +
    "layout(std140) uniform RenderParams {\n" +
    "  vec4 designationLighten;\n" +
    "  vec4 grassRecolor;\n" +
    // WB-15 claims reserved0.w as the animation clock's global kill-switch (spec Rollback:
    // "animRate=0 global kill-switch in RenderParams reserved0.w") -- 1.0 (default) animates
    // normally, 0.0 freezes every animated instance at its base/frame-0 cell regardless of its
    // own animRate. x/y/z stay genuinely reserved (season/weather, unwired). Read only by the
    // VERTEX shader (frame-select happens there); unused in this fragment stage.
    "  vec4 reserved0;\n" +
    // WB-10, wired per sweep #2's fitted fog verdict (docs/reference/fogparams.json
    // `seeDown`, docs/superpowers/specs/2026-07-06-fog-lighting-report.md §7): rgb = the
    // measured blue-teal see-down fog color (88,138,158)/255; a = per-depth blend RATE
    // (the fitted curve's slope from depth 1..7, 0 => neutral regardless of instance depth --
    // still the documented kill switch). Appended as a 4th vec4 so existing offsets don't move.
    "  vec4 seeDownTint;\n" +
    // seeDownCurve.x = the fitted curve's INTERCEPT (see the shader math below) -- the
    // measured alpha-by-depth table is concave/saturating, NOT linear through the origin
    // (rate*depth alone undershoots depth 1-3 by ~0.15-0.2 alpha, per the fog report). A
    // plain intercept + rate*depth line fits the 7 measured non-clipped points (depth 1..7)
    // to within ~0.004 alpha -- this is a re-expression of the SAME fit, not a new curve.
    // y/z/w reserved (e.g. a future second-segment slope, unwired). Appended as a 5th vec4.
    "  vec4 seeDownCurve;\n" +
    "} u_rp;\n" +
    "in vec3 v_uvp;\n" +
    "in vec4 v_tint;\n" +
    "flat in uint v_attr;\n" +
    "flat in uint v_solid;\n" +
    "out vec4 o;\n" +
    "void main(){\n" +
    "  vec4 base;\n" +
    "  if (v_solid == 1u) { base = vec4(v_tint.rgb * v_tint.a, v_tint.a); }\n" +
    // WB-14 FIX (premultiplied-fade bug, present since WB-9 but only VISIBLE once WB-11's
    // translucent floor-edge decals landed): atlas texels are PREMULTIPLIED (upload sets
    // UNPACK_PREMULTIPLY_ALPHA_WEBGL; blend is ONE/ONE_MINUS_SRC_ALPHA), so fading a sprite
    // by its instance tint alpha must scale rgb by tint.a TOO. The old `base = s * v_tint`
    // cut only alpha and left rgb at full strength, making every alpha<255 sprite instance
    // effectively ADD (1-a)-weighted rgb over its backdrop -- measured live at S1: a
    // 94/255-alpha grass-creep decal over a stone floor drew (141,176,135) instead of the
    // correct ~(112,131,92) wash; this single line was the bulk of the GL-vs-canvas2d
    // parity gap (S1 GL 20.02 vs c2d 17.04). Solid fills (branch above) already scaled rgb
    // by a; this makes sprite instances consistent with them.
    "  else { vec4 s = texture(u_atlas, v_uvp); base = vec4(s.rgb * v_tint.rgb * v_tint.a, s.a * v_tint.a); }\n" +
    // MARKER-COLOR (2026-07-13): the marker-mode glyph recolour is NO LONGER a shader scalar.
    // The old `base *= 0.6` (a uniform dim) was an invented approximation; the live native probe
    // showed marker mode recolours the whole cell toward blue with a PER-CHANNEL transform, which
    // is carried by the glyph instance's own rgb tint (MARKER_GLYPH_TINT) through the ordinary
    // `texel * v_tint.rgb` path above -- byte-identical to canvas2d's multiplyTintedCell. ATTR_MARKER
    // (bit 8) is therefore no longer emitted or read here; the constant stays reserved (spec §1.2).
    // WB-10 see-down fog hook: bits 9-12 of v_attr carry the descended depth (0 = camera
    // plane / not descended). `amt` is clamp(intercept + depth * rate, 0, 1) -- the fitted
    // measured curve re-expressed as a line with a non-zero y-intercept (sweep #2's fog
    // verdict: the real curve is concave/saturating, NOT linear through the origin -- see
    // seeDownCurve.x's banner above). rate=0 (seeDownTint.a) is still the documented global
    // kill switch: it zeroes `amt` regardless of intercept, matching the pre-fog-verdict
    // neutral default's contract. Mixed in PREMULTIPLIED space (tint scaled by the
    // fragment's own alpha) so blending stays correct for partially-transparent texels.
    "  uint seeDownDepth = (v_attr >> 9u) & 0xFu;\n" +
    "  if (seeDownDepth > 0u && u_rp.seeDownTint.a > 0.0) {\n" +
    "    float amt = clamp(u_rp.seeDownCurve.x + float(seeDownDepth) * u_rp.seeDownTint.a, 0.0, 1.0);\n" +
    "    base.rgb = mix(base.rgb, u_rp.seeDownTint.rgb * base.a, amt);\n" +
    "  }\n" +
    "  if (((v_attr >> 7u) & 1u) == 1u) {\n" +      // ADDITIVE (spec §1.2): rgb carries the add, a=0
    "    base.rgb += u_rp.designationLighten.rgb;\n" +
    "    base.a = 0.0;\n" +
    "  }\n" +
    "  o = base;\n" +
    "}\n";

  function compileProgram(gl) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error("shader compile failed: " + log);
      }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, VERT_SRC);
    var fs = sh(gl.FRAGMENT_SHADER, FRAG_SRC);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log2 = gl.getProgramInfoLog(p);
      throw new Error("program link failed: " + log2);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    return p;
  }

  // Default RenderParams (spec §1.3, seeded from docs/reference/fogparams.json intent -- the
  // deleted fictional see-down/indoor/dayNight blocks are NOT here; only what survives).
  function defaultRenderParams() {
    return {
      designationLighten: [27 / 255, 29 / 255, 26 / 255, 0], // additive, a unused
      grassRecolor: [78 / 255, 104 / 255, 52 / 255, 1],       // measured summer target, a=blend enable
      // WB-15: reserved0.w defaults to 1 (animation ON) -- 0 is the documented global
      // kill-switch (spec Rollback), not the default state. x/y/z stay 0 (still unwired).
      reserved0: [0, 0, 0, 1],
      // MEASURED SEE-DOWN FOG (sweep #2 verdict, docs/reference/fogparams.json `seeDown`,
      // docs/superpowers/specs/2026-07-06-fog-lighting-report.md §7): rgb = the fitted
      // asymptotic fog color (88,138,158)/255; a = the fitted curve's RATE (slope of the
      // depth>=1 linear re-expression, ~0.1057/255-normalized-alpha-per-depth -- see
      // seeDownCurve below for the intercept half of the same fit). This is now the DEFAULT
      // (no longer neutral all-zero) -- the fog verdict landed and this is its wiring; the
      // rate component alone stays the documented kill switch (0 => no fog at any depth) for
      // anyone who wants the old neutral behavior.
      seeDownTint: [88 / 255, 138 / 255, 158 / 255, 0.1057],
      // x = the SAME fit's intercept (0.2464) -- least-squares line through the 7 measured
      // non-clipped points (depth 1..7 from fogparams.json `alphaByDepth`), mean abs residual
      // ~0.002 alpha. Needed because the measured curve is concave/saturating, not linear
      // through the origin (rate*depth alone undershoots low depths -- fogparams.json
      // `linearRateApprox` note). y/z/w reserved for a future second segment/material split.
      seeDownCurve: [0.2464, 0, 0, 0],
    };
  }

  // create(gl, opts): build the GL renderer. opts: {atlas, spriteMap, tokenMap, shadowCellMap,
  // adjacency, warn, cacheReader, tiletypeMeta}. The last two (WB-10) are optional -- absent
  // means the multi-z descent is unconditionally skipped (transitional mode, see
  // createSceneBuilder's banner comment); both flow straight through to createSceneBuilder.
  // Returns a renderer with buildScene/render/setCamera/setScroll/setRenderParams/getStats/
  // loseContext(handleLost/handleRestored)/dispose.
  function create(gl, opts) {
    opts = opts || {};
    var warn = opts.warn || (typeof console !== "undefined" ? function (m) { console.warn(m); } : function () {});
    var builder = createSceneBuilder(opts);

    var glResources = null;   // {program, vao, vbo, ubo, locs} -- recreated on context restore
    var vboCapacityBytes = 0;
    var instanceCount = 0;
    // Static (terrain/building) staging: set by buildScene(), consumed by the next
    // uploadIfPending(). WB-13: units append past this region every rAF tick (below) --
    // pendingStaticBuffer/-Count describe ONLY the prefix a real rebuild just rewrote.
    var pendingStaticBuffer = null;
    var pendingStaticCount = 0;
    var pendingStaticStart = 0;
    var pendingStaticEnd = 0;
    var staticBaseInstances = 0; // last-uploaded static count (== the units tail's GPU offset)
    // WB-13: units tail, restaged every tickUnits() call (i.e. every rAF frame), independent of
    // the data-change key buildScene() gates on.
    var pendingUnitsCount = 0;
    var unitInterp = createUnitInterpolator({ nolerp: !!opts.nolerp });
    var lastUnitsRef = null;    // identity of the last units[] array ingest()ed (dedupe re-ingest)
    var lastUnitXY = new Map(); // unit id -> {x,y} last TICK's rendered position (motion counter)
    var renderParams = defaultRenderParams();
    // QA-only kill switch (opts.nofog, wired from `?nofog=1` via dwf-render.js): zero
    // BOTH the terrain UBO fog fields (seeDownTint.a rate + seeDownCurve.x intercept -- the
    // documented kill switch per defaultRenderParams()'s own comment) and the module-level
    // FOG_DISABLED flag that gates the building/unit z-fade proxy (fogAlphaForDepth above),
    // so a `--oracle window` A/B sees a client with NO fog contribution anywhere.
    if (opts.nofog) {
      FOG_DISABLED = true;
      renderParams.seeDownTint = renderParams.seeDownTint.slice(0, 4);
      renderParams.seeDownTint[3] = 0;
      renderParams.seeDownCurve = renderParams.seeDownCurve.slice(0, 4);
      renderParams.seeDownCurve[0] = 0;
    }
    var camera = { cell: 16, canvasW: 0, canvasH: 0 };
    var scroll = { x: 0, y: 0 };
    var contextLost = false;
    // WB-15 Rollback note: `?freezeAnim=1` (the seam) pins the clock at t=0 for every draw --
    // REQUIRED by every parity gate from here on (a moving clock would make two captures of the
    // "same" frame differ). This is a view-side kill-switch independent of the RenderParams
    // reserved0.w global kill-switch above (freezeAnim always wins when set; reserved0.w is the
    // runtime-toggleable one via setRenderParams).
    var freezeAnim = !!opts.freezeAnim;
    var lastSceneView = null;
    var lastMachineAnimPhase = -1;
    var lastDesignationBlinkPhase = -1;
    // R1 rebuild hysteresis state. builtRect is world-space, half-open, and always aligned to
    // 16x16 cache chunks with one full chunk of margin on each side when windowView is present.
    var builtRect = null;
    var builtRectVersion = null;
    var builtZ = null, builtViewportW = 0, builtViewportH = 0;
    var lastCameraOrigin = null;
    var lastBuiltSceneView = null;
    var lastBuildingFingerprint = null, lastOverlayFingerprint = null;
    var sceneInvalidated = false;
    var chunkPatchingEnabled = true;
    var unsubscribeDirty = null;
    var patchSamples = [];

    var stats = {
      renderer: "gl", sceneBuildCount: 0, lastBuildMs: 0, lastBuildInstances: 0,
      drawCount: 0, uploadBytes: 0, contextLosses: 0, atlasPages: 0,
      panReuseCount: 0, buildingBuildCount: 0, lastBuildingBuildMs: 0,
      overlayBuildCount: 0, lastOverlayBuildMs: 0,
      chunkPatchCount: 0, chunkBuildCount: 0, lastPatchMs: 0,
      lastPatchBatchMs: 0, lastPatchChunks: 0,
      // WB-13
      unitTrackedCount: 0, unitInstances: 0, unitPositionSamples: 0,
    };

    if (opts.cacheReader && typeof opts.cacheReader.onDirty === "function") {
      unsubscribeDirty = opts.cacheReader.onDirty(handleCacheDirty);
    }

    function buildGLResources() {
      var program = compileProgram(gl);
      var vao = gl.createVertexArray();
      var vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      // location 0: vec2 grid (f32) @0
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INSTANCE_BYTES, 0);
      gl.vertexAttribDivisor(0, 1);
      // location 1: uvec2 cell/attr (u16) @8
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_SHORT, INSTANCE_BYTES, 8);
      gl.vertexAttribDivisor(1, 1);
      // location 2: vec4 tint (u8 normalized) @12
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, 12);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);

      var ubo = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, 80, gl.DYNAMIC_DRAW); // 5 vec4 std140 (WB-10: +seeDownTint/seeDownCurve)
      var blockIndex = gl.getUniformBlockIndex(program, "RenderParams");
      if (blockIndex !== 0xFFFFFFFF && blockIndex !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(program, blockIndex, 0);
      }
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);

      var locs = {
        u_scroll: gl.getUniformLocation(program, "u_scroll"),
        u_view: gl.getUniformLocation(program, "u_view"),
        u_atlas: gl.getUniformLocation(program, "u_atlas"),
        u_timeMs: gl.getUniformLocation(program, "u_timeMs"), // WB-15
      };
      glResources = { program: program, vao: vao, vbo: vbo, ubo: ubo, locs: locs };
      vboCapacityBytes = 0;
      uploadRenderParams();
    }

    function uploadRenderParams() {
      if (!glResources) return;
      var rp = renderParams;
      var arr = new Float32Array(20); // 5 vec4 (WB-10: +seeDownTint/seeDownCurve)
      arr.set(rp.designationLighten, 0);
      arr.set(rp.grassRecolor, 4);
      arr.set(rp.reserved0, 8);
      arr.set(rp.seeDownTint, 12);
      arr.set(rp.seeDownCurve, 16);
      gl.bindBuffer(gl.UNIFORM_BUFFER, glResources.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, arr);
    }

    function paddedRect(view) {
      var o = view.origin || { x: 0, y: 0 };
      var w = view.width | 0, h = view.height | 0;
      if (!(opts.cacheReader && typeof opts.cacheReader.windowView === "function")) {
        return { x0: o.x, y0: o.y, x1: o.x + w, y1: o.y + h };
      }
      var x0 = Math.floor(o.x / 16) * 16 - 16;
      var y0 = Math.floor(o.y / 16) * 16 - 16;
      var x1 = Math.ceil((o.x + w) / 16) * 16 + 16;
      var y1 = Math.ceil((o.y + h) / 16) * 16 + 16;
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    function rectContainsView(rect, view) {
      if (!rect || !view || !view.origin) return false;
      var o = view.origin;
      return o.x >= rect.x0 && o.y >= rect.y0 &&
        o.x + (view.width | 0) <= rect.x1 && o.y + (view.height | 0) <= rect.y1;
    }

    // Cheap dirty check over the already-built rectangle. world_seq is monotonic, so a changed
    // chunk becomes the new max; this preserves B29 without decoding the padded rectangle on
    // every pan step.
    function rectVersion(rect, z, fallback) {
      var cr = opts.cacheReader;
      if (!rect || !cr || typeof cr.getChunk !== "function") return fallback;
      var maxv = 0;
      var bx0 = Math.floor(rect.x0 / 16), bx1 = Math.ceil(rect.x1 / 16) - 1;
      var by0 = Math.floor(rect.y0 / 16), by1 = Math.ceil(rect.y1 / 16) - 1;
      var z0 = Math.max(0, (z | 0) - MAX_SEEDOWN_DEPTH);
      for (var zz = z0; zz <= (z | 0); zz++) {
        for (var bx = bx0; bx <= bx1; bx++) {
          for (var by = by0; by <= by1; by++) {
            var chunk = cr.getChunk(zz, bx * 4096 + by);
            if (chunk && chunk.ver > maxv) maxv = chunk.ver;
          }
        }
      }
      return maxv;
    }

    function viewForRect(view, rect) {
      var cr = opts.cacheReader;
      if (!cr || typeof cr.windowView !== "function") return view;
      var z = view.origin && view.origin.z;
      var decoded = cr.windowView(rect.x0, rect.y0, z, rect.x1 - rect.x0, rect.y1 - rect.y0);
      return Object.assign({}, view, decoded, {
        origin: { x: rect.x0, y: rect.y0, z: z },
        width: rect.x1 - rect.x0,
        height: rect.y1 - rect.y0,
      });
    }

    function terrainOrderForRect(rect, z) {
      var order = [];
      var bx0 = Math.floor(rect.x0 / 16), bx1 = Math.ceil(rect.x1 / 16) - 1;
      var by0 = Math.floor(rect.y0 / 16), by1 = Math.ceil(rect.y1 / 16) - 1;
      for (var by = by0; by <= by1; by++) {
        for (var bx = bx0; bx <= bx1; bx++) order.push(builder.terrainSegmentId(bx, by, z));
      }
      return order;
    }

    function chunkIntersectsRect(bx, by, rect) {
      return bx * 16 < rect.x1 && (bx + 1) * 16 > rect.x0 &&
        by * 16 < rect.y1 && (by + 1) * 16 > rect.y0;
    }

    function chunkPatchView(bx, by, z) {
      var cr = opts.cacheReader;
      if (!cr || typeof cr.windowView !== "function") return null;
      return cr.windowView(bx * 16 - 1, by * 16 - 1, z, 18, 18);
    }

    function overlayTileFold(t) {
      if (!t) return "";
      var d = t.desig || {}, p = t.desigPriority || {};
      return [t.tt, t.shape, t.mat, d.dig, d.smooth, d.traffic, d.track,
        d.marker ? 1 : 0, p.priority].join("|");
    }

    function foldChunkIntoBuiltView(patch) {
      var full = lastBuiltSceneView;
      if (!full || !full.origin || !patch || !patch.view) return false;
      var pv = patch.view, changed = false;
      for (var wy = patch.by * 16; wy < (patch.by + 1) * 16; wy++) {
        for (var wx = patch.bx * 16; wx < (patch.bx + 1) * 16; wx++) {
          var fgx = wx - full.origin.x, fgy = wy - full.origin.y;
          if (fgx < 0 || fgy < 0 || fgx >= full.width || fgy >= full.height) continue;
          var pgx = wx - pv.origin.x, pgy = wy - pv.origin.y;
          var fi = fgy * full.width + fgx, pi = pgy * pv.width + pgx;
          var next = pv.tiles[pi] || null, prev = full.tiles[fi] || null;
          if (overlayTileFold(prev) !== overlayTileFold(next)) changed = true;
          full.tiles[fi] = next;
        }
      }
      return changed;
    }

    function recordPatch(chunkMs, batchMs) {
      chunkMs = chunkMs || [];
      stats.chunkPatchCount += chunkMs.length;
      stats.chunkBuildCount += chunkMs.length;
      stats.lastPatchMs = chunkMs.length ? chunkMs[chunkMs.length - 1] : 0;
      stats.lastPatchBatchMs = batchMs;
      stats.lastPatchChunks = chunkMs.length;
      for (var i = 0; i < chunkMs.length; i++) patchSamples.push(chunkMs[i]);
      while (patchSamples.length > 120) patchSamples.shift();
    }

    function patchP95() {
      if (!patchSamples.length) return 0;
      var sorted = patchSamples.slice().sort(function (a, b) { return a - b; });
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    }

    // BLOCK_SET-driven R2 invalidation. A lower-z dirty block can change the camera-plane
    // see-down composite, so every dirty key in [z-10,z] patches its camera-plane chunk and
    // the full 8-neighbor ring used by joins/creep/foam/shadows.
    function handleCacheDirty(dirtyZ, keys) {
      if (!chunkPatchingEnabled || !builtRect || !lastBuiltSceneView || sceneInvalidated) return;
      if (dirtyZ > builtZ || dirtyZ < Math.max(0, builtZ - MAX_SEEDOWN_DEPTH)) return;
      keys = Array.isArray(keys) ? keys : [];
      var targets = new Map();
      for (var i = 0; i < keys.length; i++) {
        var key = Number(keys[i]);
        if (!isFinite(key)) continue;
        var bx = Math.floor(key / 4096), by = key - bx * 4096;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = bx + dx, ny = by + dy;
            if (!chunkIntersectsRect(nx, ny, builtRect) || !builder.hasTerrainSegment(nx, ny, builtZ)) continue;
            targets.set(nx + ":" + ny, { bx: nx, by: ny, z: builtZ });
          }
        }
      }
      if (!targets.size) return;
      var t0 = now(), patches = [], overlayChanged = false;
      for (var target of targets.values()) {
        var pv = chunkPatchView(target.bx, target.by, builtZ);
        if (!pv) continue;
        var patch = { bx: target.bx, by: target.by, z: builtZ, view: pv };
        overlayChanged = foldChunkIntoBuiltView(patch) || overlayChanged;
        patches.push(patch);
      }
      if (!patches.length) return;
      var r = builder.patchTerrainChunks(patches, lastBuiltSceneView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      if (overlayChanged && lastSceneView) rebuildOverlaySegment(lastSceneView, Date.now());
      builtRectVersion = rectVersion(builtRect, builtZ, builtRectVersion);
      recordPatch(r.chunkMs, now() - t0);
    }

    function hashText(h, value) {
      var s = value == null ? "" : String(value);
      for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      return h;
    }
    function hashNum(h, value) {
      var n = (typeof value === "number" && isFinite(value)) ? value : -2147483648;
      return Math.imul(h ^ (n | 0), 16777619) >>> 0;
    }
    function buildingFingerprint(list) {
      list = Array.isArray(list) ? list : [];
      var h = hashNum(2166136261, list.length);
      for (var i = 0; i < list.length; i++) {
        var b = list[i] || {};
        h = hashText(h, b.type); h = hashNum(h, b.id); h = hashNum(h, b.subtype);
        h = hashNum(h, b.x1); h = hashNum(h, b.y1); h = hashNum(h, b.x2); h = hashNum(h, b.y2);
        h = hashNum(h, b.z); h = hashNum(h, b.dir); h = hashNum(h, b.bst);
        h = hashNum(h, b.stage); h = hashNum(h, b.bextra);
        // Keep component tint and header material distinct: equal numeric triples do not mean
        // equal visuals because pickBuildingTintRgb intentionally ignores header-only b.rgb.
        var crgb = b.crgb || [], rgb = b.rgb || [];
        h = hashNum(h, Array.isArray(b.crgb) ? 1 : 0);
        h = hashNum(h, crgb[0]); h = hashNum(h, crgb[1]); h = hashNum(h, crgb[2]);
        h = hashNum(h, Array.isArray(b.rgb) ? 1 : 0);
        h = hashNum(h, rgb[0]); h = hashNum(h, rgb[1]); h = hashNum(h, rgb[2]);
      }
      return h;
    }
    function overlayFingerprint(players, djobs) {
      players = Array.isArray(players) ? players : [];
      djobs = Array.isArray(djobs) ? djobs : [];
      var h = hashNum(2166136261, players.length);
      for (var i = 0; i < players.length; i++) {
        var p = players[i] || {};
        h = hashText(h, p.name); h = hashNum(h, p.x); h = hashNum(h, p.y); h = hashNum(h, p.z);
        h = hashNum(h, p.drag ? 1 : 0); h = hashNum(h, p.dx); h = hashNum(h, p.dy);
      }
      h = hashNum(h, djobs.length);
      for (var j = 0; j < djobs.length; j++) {
        var d = djobs[j] || {};
        h = hashNum(h, d.x); h = hashNum(h, d.y); h = hashNum(h, d.z); h = hashText(h, d.k);
        // B135: fold the worker flag -- the blink->steady edge (worker unassigned, nothing
        // else moved) must rebuild the overlay here, because once no djob has w:1 the beat
        // rebuild stops and a glyph rebuilt in its hidden phase would stay hidden forever.
        h = hashNum(h, d.w ? 1 : 0);
      }
      return h;
    }

    function stageStaticRange(start, end) {
      if (pendingStaticBuffer === null) {
        pendingStaticStart = start;
        pendingStaticEnd = end;
      } else {
        pendingStaticStart = Math.min(pendingStaticStart, start);
        pendingStaticEnd = Math.max(pendingStaticEnd, end);
      }
      pendingStaticBuffer = builder.buffer;
      pendingStaticCount = builder.staticCount;
    }

    // buildScene is also the R1 invalidation seam. dwf-render.js may still call it when
    // its legacy key sees an origin change; calls inside the padded rect become uniform-scroll
    // updates and never enter the pure scene builder.
    function buildScene(view) {
      lastSceneView = view || null;
      if (!view || !view.origin) return { count: 0, bytes: 0, ms: 0 };
      var o = view.origin;
      scroll.x = o.x; scroll.y = o.y;
      var originChanged = !!lastCameraOrigin &&
        (o.x !== lastCameraOrigin.x || o.y !== lastCameraOrigin.y);
      lastCameraOrigin = { x: o.x, y: o.y, z: o.z };
      var canPatch = !!(opts.cacheReader && typeof opts.cacheReader.windowView === "function" &&
        typeof opts.cacheReader.getChunk === "function");
      var sameBasis = canPatch && !sceneInvalidated && !!builtRect && builtZ === o.z;
      var currentRectVersion = sameBasis
        ? rectVersion(builtRect, o.z, view.contentVersion)
        : null;
      if (sameBasis && rectContainsView(builtRect, view) && currentRectVersion === builtRectVersion) {
        if (originChanged) stats.panReuseCount++;
        updateSceneSegments(view);
        return { count: builder.staticCount, bytes: 0, ms: 0, reused: true };
      }
      var nextRect = (sameBasis && rectContainsView(builtRect, view)) ? builtRect : paddedRect(view);

      // R2 pan/resize reframe: retain every overlapping terrain segment, build only entering
      // chunks, compact once, and refresh the small overlay. This keeps sceneBuildCount flat
      // across chunk crossings; zoom alone never even changes nextRect.
      if (sameBasis && !rectContainsView(builtRect, view) && currentRectVersion === builtRectVersion) {
        var shiftedView = viewForRect(view, nextRect);
        var nextOrder = terrainOrderForRect(nextRect, o.z);
        var entering = [];
        var enteringSeeds = [];
        var bx0 = Math.floor(nextRect.x0 / 16), bx1 = Math.ceil(nextRect.x1 / 16) - 1;
        var by0 = Math.floor(nextRect.y0 / 16), by1 = Math.ceil(nextRect.y1 / 16) - 1;
        for (var by = by0; by <= by1; by++) {
          for (var bx = bx0; bx <= bx1; bx++) {
            if (!builder.hasTerrainSegment(bx, by, o.z)) enteringSeeds.push({ bx: bx, by: by });
          }
        }
        // An entering chunk changes border-neighbor inputs for retained chunks beside it.
        // Rebuild that ring too; all other overlapping segment objects remain untouched.
        var enteringTargets = new Map();
        for (var si = 0; si < enteringSeeds.length; si++) {
          var seed = enteringSeeds[si];
          for (var sy = -1; sy <= 1; sy++) {
            for (var sx = -1; sx <= 1; sx++) {
              var tx = seed.bx + sx, ty = seed.by + sy;
              if (tx < bx0 || tx > bx1 || ty < by0 || ty > by1) continue;
              enteringTargets.set(tx + ":" + ty, { bx: tx, by: ty });
            }
          }
        }
        for (var target of enteringTargets.values()) {
          var cv = chunkPatchView(target.bx, target.by, o.z);
          if (cv) entering.push({ bx: target.bx, by: target.by, z: o.z, view: cv });
        }
        var rr = builder.patchTerrainChunks(entering, shiftedView, nextOrder);
        stageStaticRange(rr.dirtyStart, rr.dirtyEnd);
        lastBuiltSceneView = shiftedView;
        builtRect = nextRect;
        builtRectVersion = (shiftedView && typeof shiftedView.version === "number")
          ? shiftedView.version : rectVersion(nextRect, o.z, view.contentVersion);
        builtViewportW = view.width | 0; builtViewportH = view.height | 0;
        stats.panReuseCount++;
        stats.chunkBuildCount += entering.length;
        var shiftedBfp = buildingFingerprint(view.buildings);
        if (shiftedBfp !== lastBuildingFingerprint) {
          rebuildBuildingSegment(view, machineNow(), freezeAnim || !!view.freezeAnim);
          lastBuildingFingerprint = shiftedBfp;
        }
        rebuildOverlaySegment(view, now()); // B135: perf-epoch designation clock (matches render/tickUnits)
        lastOverlayFingerprint = overlayFingerprint(view.players, view.djobs);
        return { count: builder.staticCount, bytes: rr.bytes, ms: rr.ms, reused: true, reframed: true };
      }
      var sceneView = viewForRect(view, nextRect);
      var nowMs = machineNow();   // B206: machine-frame clock (freezes on game pause)
      var viewFreezeAnim = freezeAnim || !!(view && view.freezeAnim);
      var buildView = sceneView;
      if (sceneView) {
        buildView = Object.assign({}, sceneView, {
          machineParity: (typeof sceneView.machineParity === "number")
            ? sceneView.machineParity : machineFrameParityGL(nowMs, viewFreezeAnim),
          // B135: the designation blink clock must be the SAME clock render()/tickUnits use
          // (the rAF timestamp = performance.now epoch). Stamping Date.now() here put full
          // scene rebuilds on a different epoch than the per-beat overlay rebuilds and the
          // unit alternation, which could show glyph+unit (or neither) for up to a beat.
          designationNowMs: now(),
        });
      }
      var r = builder.buildScene(buildView);
      pendingStaticBuffer = builder.buffer;
      pendingStaticCount = r.count;
      pendingStaticStart = 0;
      pendingStaticEnd = r.count;
      var mstep = machineCadenceStepGL(view && view.buildings, nowMs, lastMachineAnimPhase, viewFreezeAnim);
      lastMachineAnimPhase = mstep.phase;
      builtRect = nextRect;
      builtRectVersion = (sceneView && typeof sceneView.version === "number")
        ? sceneView.version : rectVersion(nextRect, o.z, view.contentVersion);
      builtZ = o.z; builtViewportW = view.width | 0; builtViewportH = view.height | 0;
      sceneInvalidated = false;
      lastBuiltSceneView = buildView;
      lastBuildingFingerprint = buildingFingerprint(view.buildings);
      lastOverlayFingerprint = overlayFingerprint(view.players, view.djobs);
      stats.sceneBuildCount++;
      stats.lastBuildMs = r.ms;
      stats.lastBuildInstances = r.count;
      return r;
    }

    function rebuildBuildingSegment(view, nowMs, viewFreezeAnim) {
      // Buildings arrive through AUX, but crops arrive through block tails. Keep crop extraction
      // on the retained padded scene basis and overlay only the fresh AUX building snapshot.
      var buildView = buildingRebuildViewGL(lastBuiltSceneView, view);
      if (buildView && typeof buildView.machineParity !== "number") {
        buildView = Object.assign({}, buildView, { machineParity: machineFrameParityGL(nowMs, viewFreezeAnim) });
      }
      var r = builder.rebuildBuildings(buildView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      stats.buildingBuildCount++;
      stats.lastBuildingBuildMs = r.ms;
      return r;
    }

    function rebuildOverlaySegment(view, nowMs) {
      var overlayView = lastBuiltSceneView
        ? Object.assign({}, lastBuiltSceneView, {
          // B135: units ride along so the state-2 (worker ON the tile) decision at each beat
          // rebuild sees current positions, not the ones from the last full scene build.
          players: view.players || [], djobs: view.djobs || [], units: view.units || [],
          designationNowMs: nowMs,
        })
        : Object.assign({}, view, { designationNowMs: nowMs });
      var r = builder.rebuildOverlay(overlayView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      stats.overlayBuildCount++;
      stats.lastOverlayBuildMs = r.ms;
      return r;
    }

    // H1 AUX invalidation seam. The render controller calls this for every fresh latest view;
    // cheap content folds prevent identity churn from rebuilding either segment.
    function updateSceneSegments(view) {
      if (!view) return;
      lastSceneView = view;
      if (view.origin) {
        lastCameraOrigin = { x: view.origin.x, y: view.origin.y, z: view.origin.z };
        scroll.x = view.origin.x; scroll.y = view.origin.y;
      }
      if (!builtRect) return;
      var bfp = buildingFingerprint(view.buildings);
      if (bfp !== lastBuildingFingerprint) {
        var nowMs = machineNow();   // B206: machine-frame clock (freezes on game pause)
        var frozen = freezeAnim || !!view.freezeAnim;
        rebuildBuildingSegment(view, nowMs, frozen);
        lastBuildingFingerprint = bfp;
        var mstep = machineCadenceStepGL(view.buildings, nowMs, lastMachineAnimPhase, frozen);
        lastMachineAnimPhase = mstep.phase;
      }
      var ofp = overlayFingerprint(view.players, view.djobs);
      if (ofp !== lastOverlayFingerprint) {
        rebuildOverlaySegment(view, now()); // B135: perf-epoch designation clock (matches render/tickUnits)
        lastOverlayFingerprint = ofp;
      }
    }

    // WB-13: ingest a fresh units[] snapshot (identity-deduped -- a no-op most calls, since AUX
    // only hands the render client a NEW units array reference ~30Hz while this may be invoked
    // at 60fps). `nowMs` defaults to `now()` -- see createUnitInterpolator's banner for why a
    // client-observed timestamp is used instead of threading an exact wire arrival time through
    // dwf-ws.js.
    function updateUnits(units, nowMs) {
      if (units === lastUnitsRef) return;
      lastUnitsRef = units;
      unitInterp.ingest(units, typeof nowMs === "number" ? nowMs : now());
    }

    // WC-22: latest projectile snapshot (AUX `proj` array). Stored raw (no interpolation) and
    // consumed by tickUnits, which appends the projectile instances after the units in the same
    // dynamic tail. Cheap identity-dedupe just avoids re-storing the same array reference.
    var lastProjRef = null, lastProj = [];
    function updateProjectiles(projs) {
      if (projs === lastProjRef) return;
      lastProjRef = projs;
      lastProj = Array.isArray(projs) ? projs : [];
    }

    // B139: flow clouds come from the TILE records (t.cloud, per-tile densest flow --
    // block wire, not AUX), so extraction walks latest.tiles. That walk is ~window-sized;
    // running it per rAF would re-introduce exactly the unit-churn cost F3 killed, so it
    // is keyed on the cache's real window CONTENT VERSION (+origin/dims -- flows re-sign
    // their block, so every flow change bumps it). The no-version poll/legacy path falls
    // back to `latest` identity (poll cadence is ~2s, cheap). tickUnits then re-emits the
    // extracted list every frame for the shared-beat alpha, like units/projectiles.
    var lastFlowsRef = null, lastFlowsKey = null, lastFlows = [];
    function extractFlows(latest) {
      var out = [];
      var tiles = latest && latest.tiles;
      var w = latest && latest.width;
      if (!Array.isArray(tiles) || !(w > 0)) return out;
      var o = latest.origin || { x: 0, y: 0, z: 0 };
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        if (!t || !t.cloud || t.hidden) continue;
        if (typeof t.cloud.type !== "number" || !(t.cloud.density > 0)) continue;
        out.push({ x: o.x + (i % w), y: o.y + ((i / w) | 0),
                   depth: (typeof t.depth === "number") ? t.depth : 0,
                   type: t.cloud.type, density: t.cloud.density });
      }
      return out;
    }
    function updateFlows(latest) {
      if (!latest) { lastFlowsRef = null; lastFlowsKey = null; lastFlows = []; return; }
      var o = latest.origin || { x: 0, y: 0, z: 0 };
      var key = (typeof latest.contentVersion === "number")
        ? "v" + latest.contentVersion + "|" + o.x + "," + o.y + "," + o.z + "|" + latest.width + "x" + latest.height
        : null;
      if (key !== null ? key === lastFlowsKey : latest === lastFlowsRef) return;
      lastFlowsRef = latest; lastFlowsKey = key;
      lastFlows = extractFlows(latest);
    }

    // WB-13: called every rAF tick (dwf-render.js's frame loop) -- recomputes every
    // tracked unit's interpolated position and re-emits ONLY the units instance tail (the
    // scene-builder's staticCount checkpoint keeps the terrain/building prefix untouched).
    // Stages that tail for a CHEAP partial upload (see uploadIfPending) -- never a full scene
    // rebuild, never bumps stats.sceneBuildCount. The legacy ox/oy arguments remain for caller
    // compatibility; world anchoring uses the builder's stable emitOrigin instead.
    function tickUnits(nowMs, ox, oy, camZ) {
      var t = typeof nowMs === "number" ? nowMs : now();
      var list = unitInterp.tick(t);
      var r = builder.buildUnits(list, ox || 0, oy || 0, camZ, t);
      // WC-22: append projectiles into the SAME dynamic tail (after units, no k reset). The
      // returned count is the TOTAL dynamic instance count (units + proj), which is exactly what
      // pendingUnitsCount must be for uploadIfPending's single-tail upload.
      var rp = builder.buildProjectiles(lastProj, ox || 0, oy || 0, camZ);
      stats.projInstances = rp.count - r.count;
      // B139: flow clouds append after projectiles in the same tail; re-emitting per rAF
      // is what animates the shared-beat opacity (alpha lives in the per-instance tint).
      var rf = builder.buildFlows(lastFlows, t);
      pendingUnitsCount = rf.count;
      stats.flowInstances = rf.count - rp.count;
      stats.unitTrackedCount = list.length;
      stats.unitInstances = r.count;
      // Gate evidence hook (spec: "assert >= 50 distinct rendered unit positions ... debug
      // counter in getStats"): a frame counts as "moved" whenever ANY tracked unit's rendered
      // (x,y) differs from the immediately preceding tick -- a real interpolation glide changes
      // this every rAF frame; a canvas2d-style snap-to-latest only changes it once per ~33ms AUX
      // arrival (the gate's own "~15 in 2s" canvas2d baseline vs ">=50" on gl).
      var moved = false;
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        var prev = lastUnitXY.get(u.id);
        if (!prev || prev.x !== u.x || prev.y !== u.y) { moved = true; lastUnitXY.set(u.id, { x: u.x, y: u.y }); }
      }
      if (moved) stats.unitPositionSamples++;
      return r;
    }

    // Upload the static (terrain/building) prefix when buildScene() just staged a fresh one,
    // and the units tail on EVERY call (tickUnits runs every rAF frame -- WB-13's whole point).
    // A VBO capacity GROW orphans the GPU buffer, so that case re-uploads the WHOLE region from
    // the CPU-side `builder.buffer`, which always holds both regions contiguously
    // (ensureCapacity's copy-forward, see its own banner); otherwise each region gets its own
    // small, independent bufferSubData -- the units one bounded by visible-unit count, not by
    // the (far larger, unchanged) terrain instance count.
    function uploadIfPending() {
      if (!glResources) return;
      var haveStatic = pendingStaticBuffer !== null;
      var curStaticCount = haveStatic ? pendingStaticCount : staticBaseInstances;
      var totalCount = curStaticCount + pendingUnitsCount;
      var totalBytes = totalCount * INSTANCE_BYTES;
      gl.bindBuffer(gl.ARRAY_BUFFER, glResources.vbo);
      var grew = false;
      if (totalBytes > vboCapacityBytes) {
        vboCapacityBytes = Math.max(totalBytes, (vboCapacityBytes * 2) | 0);
        gl.bufferData(gl.ARRAY_BUFFER, vboCapacityBytes, gl.DYNAMIC_DRAW);
        grew = true;
      }
      var uploadedBytes = 0;
      if (totalBytes > 0) {
        if (grew) {
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(builder.buffer, 0, totalBytes));
          uploadedBytes += totalBytes;
        } else {
          if (haveStatic && pendingStaticEnd > pendingStaticStart) {
            var staticOffset = pendingStaticStart * INSTANCE_BYTES;
            var staticBytes = (pendingStaticEnd - pendingStaticStart) * INSTANCE_BYTES;
            gl.bufferSubData(gl.ARRAY_BUFFER, staticOffset,
              new Uint8Array(builder.buffer, staticOffset, staticBytes));
            uploadedBytes += staticBytes;
          }
          if (pendingUnitsCount > 0) {
            var unitsBase = curStaticCount * INSTANCE_BYTES;
            gl.bufferSubData(gl.ARRAY_BUFFER, unitsBase, new Uint8Array(builder.buffer, unitsBase, pendingUnitsCount * INSTANCE_BYTES));
            uploadedBytes += pendingUnitsCount * INSTANCE_BYTES;
          }
        }
      }
      if (haveStatic) { staticBaseInstances = pendingStaticCount; pendingStaticBuffer = null; }
      instanceCount = totalCount;
      stats.uploadBytes = uploadedBytes;
    }

    function setCamera(c) {
      if (typeof c.cell === "number") camera.cell = c.cell;
      if (typeof c.canvasW === "number") camera.canvasW = c.canvasW;
      if (typeof c.canvasH === "number") camera.canvasH = c.canvasH;
    }
    // Compatibility for the existing benchpan caller: its values are fractional offsets. The
    // actual shader uniform remains world-space (camera origin + offset) under R1.
    function setScroll(x, y) {
      scroll.x = (lastCameraOrigin ? lastCameraOrigin.x : 0) + (x || 0);
      scroll.y = (lastCameraOrigin ? lastCameraOrigin.y : 0) + (y || 0);
    }

    function setRenderParams(p) {
      // zero scene rebuild (spec §1.3): only the UBO changes.
      if (!p) return;
      if (p.designationLighten) renderParams.designationLighten = p.designationLighten.slice(0, 4);
      if (p.grassRecolor) renderParams.grassRecolor = p.grassRecolor.slice(0, 4);
      if (p.reserved0) renderParams.reserved0 = p.reserved0.slice(0, 4);
      if (p.seeDownTint) renderParams.seeDownTint = p.seeDownTint.slice(0, 4);
      if (p.seeDownCurve) renderParams.seeDownCurve = p.seeDownCurve.slice(0, 4);
      uploadRenderParams();
    }

    // WB-15: `ts` is the caller's clock (the seam passes its rAF timestamp straight through --
    // dwf-render.js's frame(ts)); defaults to `now()` for any caller that doesn't pass one
    // (every existing test/bench call site). `freezeAnim` always pins it to 0 regardless of what
    // the caller passes -- the whole point of the kill-switch is that it can't be defeated by a
    // caller forgetting to check it. This uniform update is the ENTIRE per-frame animation cost:
    // no scene rebuild, no CPU-side re-emit, ever (§1.7's "shader-side frame select").
    function render(ts) {
      if (contextLost || !glResources) return false;
      // B206: machine frames ride the pause-aware world clock (frozen while the game is paused).
      var machineMs = machineNow();
      var mstep = machineCadenceStepGL(lastSceneView && lastSceneView.buildings, machineMs, lastMachineAnimPhase,
        freezeAnim || !!(lastSceneView && lastSceneView.freezeAnim));
      lastMachineAnimPhase = mstep.phase;
      if (mstep.dirty && lastSceneView) rebuildBuildingSegment(lastSceneView, machineMs,
        freezeAnim || !!lastSceneView.freezeAnim);
      var designationNowMs = (typeof ts === "number" && isFinite(ts)) ? ts : now();
      if (lastSceneView && hasBlinkingDesignationJob(lastSceneView.djobs)) {
        // B135: step at the 400ms half-beat -- the fastest cadence any glyph can need
        // (state 2). State-1 glyphs recompute to the same value at every second boundary
        // (800 = 2 x 400, phase-locked), so the extra rebuild is a cheap no-op visually,
        // and it doubles as the refresh that promotes/demotes state 2 as workers arrive.
        var designationPhase = Math.floor(designationNowMs / DESIG_ACTIVE_BLINK_MS);
        if (designationPhase !== lastDesignationBlinkPhase) {
          lastDesignationBlinkPhase = designationPhase;
          rebuildOverlaySegment(lastSceneView, designationNowMs);
        }
      } else {
        lastDesignationBlinkPhase = -1;
      }
      uploadIfPending();
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      gl.viewport(0, 0, w, h);
      gl.clearColor(BG[0] / 255, BG[1] / 255, BG[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (instanceCount <= 0) { stats.drawCount++; return true; }
      gl.useProgram(glResources.program);
      gl.bindVertexArray(glResources.vao);
      var atlasTex = opts.atlas && opts.atlas.getTexture && opts.atlas.getTexture();
      if (atlasTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlasTex);
        gl.uniform1i(glResources.locs.u_atlas, 0);
      }
      gl.uniform2f(glResources.locs.u_scroll, scroll.x, scroll.y);
      gl.uniform3f(glResources.locs.u_view, camera.cell, w, h);
      // B206: the sprite/flow/fire/water animation clock subtracts paused spans so every
      // game-world animation FREEZES while the server-global game is paused and RESUMES with no
      // jump. ?freezeAnim=1 still hard-pins to 0 (parity captures) and always wins.
      gl.uniform1f(glResources.locs.u_timeMs, freezeAnim ? 0 : worldNow(typeof ts === "number" ? ts : now()));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha (spec §1.2)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
      gl.bindVertexArray(null);
      stats.drawCount++;
      if (opts.atlas && opts.atlas.pageCount) stats.atlasPages = opts.atlas.pageCount();
      return true;
    }

    // Context-loss hooks. handleLost(): drop GL objects, stop drawing. handleRestored():
    // recreate them + force a re-upload of the last scene. The SEAM decides fallback policy
    // (loss twice -> canvas2d, spec §1.1); this just keeps GL state coherent.
    function handleLost() {
      contextLost = true;
      stats.contextLosses++;
      glResources = null;      // objects are invalid after loss
      vboCapacityBytes = 0;
      instanceCount = 0;
    }
    function handleRestored() {
      contextLost = false;
      buildGLResources();
      // re-stage the FULL last-known scene (static + units) so the next render() re-uploads it
      // whole -- context loss invalidated the GPU-side VBO entirely (vboCapacityBytes was reset
      // to 0 by handleLost(), which forces uploadIfPending's "grew" full-reupload branch here).
      staticBaseInstances = 0;
      pendingUnitsCount = 0;
      if (builder.buffer && builder.count > 0) {
        pendingStaticBuffer = builder.buffer;
        pendingStaticCount = builder.staticCount;
        pendingStaticStart = 0;
        pendingStaticEnd = builder.staticCount;
        pendingUnitsCount = builder.count - builder.staticCount;
      }
    }

    function setMaps(m) { builder.setMaps(m); sceneInvalidated = true; }
    function invalidateScene() { sceneInvalidated = true; }

    function getStats() {
      return {
        renderer: stats.renderer, sceneBuildCount: stats.sceneBuildCount,
        lastBuildMs: +stats.lastBuildMs.toFixed(3), lastBuildInstances: stats.lastBuildInstances,
        drawCount: stats.drawCount, uploadBytes: stats.uploadBytes,
        contextLosses: stats.contextLosses, atlasPages: stats.atlasPages,
        instanceCount: instanceCount,
        panReuseCount: stats.panReuseCount,
        buildingBuildCount: stats.buildingBuildCount,
        lastBuildingBuildMs: +stats.lastBuildingBuildMs.toFixed(3),
        overlayBuildCount: stats.overlayBuildCount,
        lastOverlayBuildMs: +stats.lastOverlayBuildMs.toFixed(3),
        chunkPatchCount: stats.chunkPatchCount,
        chunkBuildCount: stats.chunkBuildCount,
        lastPatchMs: +stats.lastPatchMs.toFixed(3),
        lastPatchBatchMs: +stats.lastPatchBatchMs.toFixed(3),
        patchP95Ms: +patchP95().toFixed(3),
        lastPatchChunks: stats.lastPatchChunks,
        terrainChunkCount: builtRect ? terrainOrderForRect(builtRect, builtZ).length : 0,
        terrainInstances: builder.terrainCount,
        buildingInstances: builder.buildingCount,
        cropInstances: builder.cropCount,
        overlayInstances: builder.overlayCount,
        buildRect: builtRect ? { x0: builtRect.x0, y0: builtRect.y0, x1: builtRect.x1, y1: builtRect.y1 } : null,
        scrollX: scroll.x, scrollY: scroll.y,
        // WB-13
        unitTrackedCount: stats.unitTrackedCount, unitInstances: stats.unitInstances,
        unitPositionSamples: stats.unitPositionSamples,
      };
    }

    function dispose() {
      if (unsubscribeDirty) { try { unsubscribeDirty(); } catch (_) {} unsubscribeDirty = null; }
      if (!glResources) return;
      try {
        gl.deleteBuffer(glResources.vbo);
        gl.deleteBuffer(glResources.ubo);
        gl.deleteVertexArray(glResources.vao);
        gl.deleteProgram(glResources.program);
      } catch (_) { /* context may already be gone */ }
      glResources = null;
    }

    // initial build
    buildGLResources();

    return {
      buildScene: buildScene, render: render, setCamera: setCamera, setScroll: setScroll,
      setRenderParams: setRenderParams, setMaps: setMaps, invalidateScene: invalidateScene, getStats: getStats,
      usesChunkPatching: !!unsubscribeDirty,
      handleLost: handleLost, handleRestored: handleRestored, dispose: dispose,
      // WB-13
      updateUnits: updateUnits, tickUnits: tickUnits,
      // H1: cheap AUX folds + buildings/overlay-only invalidation.
      updateSceneSegments: updateSceneSegments,
      // WC-22: third dynamic-instance region (projectiles/vehicles)
      updateProjectiles: updateProjectiles,
      // B139: fourth dynamic-instance region (flow clouds -- miasma et al.)
      updateFlows: updateFlows,
      _extractFlowsForTest: extractFlows,
      _setChunkPatchingEnabledForTest: function (enabled) { chunkPatchingEnabled = enabled !== false; },
      _builder: builder,
    };
  }

  var DwfGL = {
    create: create,
    createSceneBuilder: createSceneBuilder,
    // constants / helpers exposed for tests + the seam
    SOLID_CELL: SOLID_CELL, PENDING: PENDING, INSTANCE_BYTES: INSTANCE_BYTES,
    ATTR_ADDITIVE: ATTR_ADDITIVE, ATTR_MARKER: ATTR_MARKER,
    // WB-10: see-down descent depth encoding + the transitional-mode guard (Rollback note).
    ATTR_SEEDOWN_SHIFT: ATTR_SEEDOWN_SHIFT, ATTR_SEEDOWN_MASK: ATTR_SEEDOWN_MASK,
    MAX_SEEDOWN_DEPTH: MAX_SEEDOWN_DEPTH, cacheHasMultiZ: cacheHasMultiZ,
    isOpenTileShapeMat: isOpenTileShapeMat,
    defaultRenderParams: defaultRenderParams,
    hashXY: hashXY, wallPrefix: wallPrefix, wallDetailPrefix: wallDetailPrefix, isTreeWallMat: isTreeWallMat, tileColorTables: { MAT_COLOR: MAT_COLOR, BG: BG },
    liquidEdgeTokens: liquidEdgeTokens,
    derivedTreePart: derivedTreePart,             // B62-r2: tail-less tree part derivation (c2d parity)
    isGrassBackingSource: isGrassBackingSource,   // B62-r2: grass-backing neighbor predicate
    GRASS_BACK_OFFSETS: GRASS_BACK_OFFSETS,       // B62-r2: ring-ordered neighbor scan offsets
    VERT_SRC: VERT_SRC, FRAG_SRC: FRAG_SRC,
    // WC-17 GL parity: pure grass tier/tint helpers exposed module-wide (mirrors
    // dwf-tiles.js's own _grassTierIndexForTest/_grassSpeciesTintForTest convention).
    grassTierIndex: grassTierIndex, grassSpeciesTintRGBA: grassSpeciesTintRGBA,
    // WB-11: pure sparse-layer helpers exposed module-wide (no builder instance needed) for
    // fixture tests / the derive-table validation scripts.
    hashInt: hashInt, matFamilyFor: matFamilyFor, parseTreeTtname: parseTreeTtname,
    resolveOverleavesGL: resolveOverleavesGL,   // B47: canopy leaf-overlay resolution
    canonicalDirs: canonicalDirs,               // B47: parser parity with canvas2d
    ITEM_TINT_RGB_BY_FAMILY: ITEM_TINT_RGB_BY_FAMILY,
    ITEM_SPATTER_TINT_RGB_BY_FAMILY: ITEM_SPATTER_TINT_RGB_BY_FAMILY,
    itemSpatterTintRgb: itemSpatterTintRgb,
    itemSpatterWins: itemSpatterWins,                   // B138: overlap winner comparator
    pickItemSpatterLitter: pickItemSpatterLitter,       // B138: one-decal-per-tile winner pick
    // WB-12: pure building helpers exposed module-wide (no builder/buildingMap instance needed).
    isOverlayOnlyBuildingType: isOverlayOnlyBuildingType, buildingsInPaintOrder: buildingsInPaintOrder, buildingTintRgb: buildingTintRgb,
    pickBuildingTintRgb: pickBuildingTintRgb,   // window #13: component b.crgb only
    pickBuildingPalRow: pickBuildingPalRow,     // B273: component STATE_COLOR token -> exact palette row
    validRgbTriple: validRgbTriple,
    fogAlphaForDepth: fogAlphaForDepth, belowAlpha: belowAlpha, MISSING_BUILDING: MISSING_BUILDING,
    // WB-13: pure unit tier-resolution + interpolation helpers exposed module-wide (no builder/
    // GL instance needed) -- fixture tests exercise these directly.
    resolveUnitTierGL: resolveUnitTierGL, createUnitInterpolator: createUnitInterpolator,
    unitStatusIconForBits: unitStatusIconForBits, unitStatusBlinkVisible: unitStatusBlinkVisible,
    unitStatusIconNow: unitStatusIconNow, nativeBubblePhase: nativeBubblePhase,
    physicalStatusIconForBits: physicalStatusIconForBits, ordinaryStatusIconForBits: ordinaryStatusIconForBits,
    NATIVE_BUBBLE_PERIOD_MS: NATIVE_BUBBLE_PERIOD_MS, NATIVE_BUBBLE_ID_STRIDE: NATIVE_BUBBLE_ID_STRIDE,
    NATIVE_BUBBLE_ORDINARY_MS: NATIVE_BUBBLE_ORDINARY_MS,
    isBlinkingDesignationJob: isBlinkingDesignationJob, designationGlyphVisible: designationGlyphVisible,
    hasBlinkingDesignationJob: hasBlinkingDesignationJob, workedTileUnitVisible: workedTileUnitVisible,
    // B139: flow-cloud policy (miasma et al.) -- pure helpers, fixture tests hit these directly.
    FLOW_STYLES_GL: FLOW_STYLES_GL, flowOverlayForGL: flowOverlayForGL,
    designationBlinkState: designationBlinkState, activeBlinkVisible: activeBlinkVisible,
    DESIG_ACTIVE_BLINK_MS: DESIG_ACTIVE_BLINK_MS,
    UNIT_FALLBACK_RGB: UNIT_FALLBACK_RGB, UNIT_LERP_MS: UNIT_LERP_MS,
    GHOST_TINT_RGB: GHOST_TINT_RGB, GHOST_ALPHA: GHOST_ALPHA,   // B98 ghost tint (shared w/ canvas2d)
    UNIT_STATUS_BLINK_MS: UNIT_STATUS_BLINK_MS,
    MACHINE_ANIM_MS: MACHINE_ANIM_MS, machineAnimPhase: machineAnimPhase,
    machineFrameParityGL: machineFrameParityGL, machineCadenceStepGL: machineCadenceStepGL,
    _buildingRebuildViewForTest: buildingRebuildViewGL,
    // WB-15: animation-clock attr encoding + the pure JS mirror of the shader's frame-select
    // math (test/documentation parity only -- see animFrameIndexForTest's own banner).
    ATTR_ANIMFRAMES_MASK: ATTR_ANIMFRAMES_MASK, ATTR_ANIMRATE_SHIFT: ATTR_ANIMRATE_SHIFT,
    ATTR_ANIMRATE_MASK: ATTR_ANIMRATE_MASK, ANIM_RATE_HZ: ANIM_RATE_HZ,
    encodeAnimAttr: encodeAnimAttr, defaultAnimRateCodeForToken: defaultAnimRateCodeForToken,
    hashGridPhase: hashGridPhase, animFrameIndexForTest: animFrameIndexForTest,
    // B206 PAUSE-ANIM: the pause-aware world clock the renderer feeds u_timeMs / machine frames.
    _worldNowForTest: worldNow, _animOffsetForTest: animOffset,
    // WB-14: pure designation/presence helpers exposed module-wide (no builder/GL instance
    // needed) -- fixture tests exercise these directly, same convention as every tier above.
    DESIG_CELL: DESIG_CELL, DESIG_TRACK_CELL: DESIG_TRACK_CELL, DESIG_TINT_RGB: DESIG_TINT_RGB,
    DESIG_WASH_ALPHA: DESIG_WASH_ALPHA, DESIG_WASH_ALPHA_MARKER: DESIG_WASH_ALPHA_MARKER,
    MARKER_RECOLOR: MARKER_RECOLOR, MARKER_GLYPH_TINT: MARKER_GLYPH_TINT, MARKER_WASH_RGB: MARKER_WASH_RGB,
    resolveDesig: resolveDesig, resolveDjob: resolveDjob, playerColorRgb: playerColorRgb, hslToRgb255: hslToRgb255,
    presenceBudget: presenceBudget, PRESENCE_DRAG_MAX_TILES: PRESENCE_DRAG_MAX_TILES,
    // B269: mining indicators (damp/warm stone). setMineMode is the ONE input the overlay needs
    // from the placement UI -- dwf-controls-placement.js calls it (and DwfTiles's twin)
    // whenever the selected dig tool changes.
    setMineMode: setMineMode,
    MINING_SHEET: MINING_SHEET, MINING_CELL: MINING_CELL,
    _miningIndicatorCellForTest: miningIndicatorCell,
  };

  try { root.DwfGL = DwfGL; } catch (_) { /* non-browser context */ }
  if (typeof module === "object" && module && module.exports) module.exports = DwfGL;
})(typeof self !== "undefined" ? self : this);
