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

// dwf-tiles.js -- standalone Level-1.5 tile renderer client.
//
// Polls GET /mapdata?player=NAME (the "wire:1" tile-data endpoint) and draws the
// Dwarf Fortress map straight to a <canvas>, instead of decoding server-rendered
// JPEG frames (the retired product view; /frame.jpg remains a parity oracle). Coloring is
// ported from tools/ws2/render_mapdump.py's tile_color()
// so this view matches the offline reference renderer.
//
// This file is intentionally self-contained: it does not read or write any global
// used by the JPEG client, and it never throws out of its own event handlers.

(function () {
  "use strict";

  // ---- player identity (same convention as dwf-core.js) ------------------
  const params = new URLSearchParams(location.search);
  const stored = (function () {
    try { return localStorage.getItem("dwf.player"); } catch (_) { return null; }
  })();
  const fresh = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
    `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  // let (not const): an embedder (dwf-core.js) can hand us its own player id via init()
  // so the /mapdata poll and the core client's /designate etc. share one server-side camera.
  let player = params.get("player") || stored || fresh;
  // JOIN-GATE CONTRACT (see dwf-core.js + dwf-join.js): this module MUST NOT persist its
  // resolved player. This IIFE runs at load, BEFORE dwf-join.js's gate() reads
  // localStorage["dwf.player"] to decide whether to show the join card. Persisting the in-memory
  // `fresh` UUID fallback (or a shared-link ?player=) here poisoned that read into looking like a
  // returning player, so a passwordless first visit SILENTLY auto-joined under a generated
  // session-key name instead of prompting for a nickname. Persistence belongs to dwf-join.js,
  // which writes only a real name the player chose on the join card; the fallback stays in-memory.

  // B09(a): a stable per-TAB client id (sessionStorage: survives a page refresh, unique per new
  // tab). Sent in the WS hello so the server can tell a refresh's own lingering ghost connection
  // (same id -> keep the name) from a genuinely different browser on the same invite link
  // (different id -> gets renamed to name-2). Never leaves this browser except as an opaque token.
  const clientId = (function () {
    try {
      let id = sessionStorage.getItem("dwf.cid");
      if (!id) {
        id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
          `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
        sessionStorage.setItem("dwf.cid", id);
      }
      return id;
    } catch (_) {
      return `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    }
  })();

  // ---- WA-15: protocol v1 is the ONLY wire ----------------------------------------
  // The `?proto=0` opt-out (WA-14's rollback lever, back when the server still served
  // the legacy JSON wire alongside v1) is gone -- every connection negotiates v1.
  // `v1Active()` is kept as a named predicate (rather than inlining `true` at every call
  // site) purely so this file's many WA-12/13 v1-only call sites don't need editing.
  // WA-12's 5s hello_ack watchdog (dwf-ws.js) still exists as a belt-and-suspenders
  // safety net if a v1 handshake somehow never completes.
  function v1Active() { return true; }

  // ---- coloring, ported from tools/ws2/render_mapdump.py ------------------------
  // Material category -> base RGB (floors, and a fallback tint for anything unknown).
  const MAT_COLOR = {
    STONE: [128, 128, 128],
    SOIL: [120, 82, 48],
    MINERAL: [150, 130, 90],
    LAVA_STONE: [70, 60, 60],
    FROZEN_LIQUID: [170, 200, 230],
    CONSTRUCTION: [110, 110, 120],
    GRASS_LIGHT: [86, 140, 62],
    GRASS_DARK: [58, 104, 48],
    GRASS_DRY: [150, 150, 70],
    GRASS_DEAD: [110, 100, 70],
    PLANT: [70, 130, 70],
    TREE: [86, 66, 40],
    ROOT: [96, 74, 48],
    MUSHROOM: [150, 120, 130],
    DRIFTWOOD: [120, 100, 70],
    POOL: [60, 90, 150],
    BROOK: [70, 110, 170],
    RIVER: [55, 95, 165],
    ASHES: [90, 90, 90],
    MAGMA: [200, 70, 20],
    AIR: [24, 24, 28],
    NONE: [18, 18, 20],
  };
  const FALLBACK_MAT = [100, 100, 100];

  const BG = [14, 14, 16];
  const WALL_DARKEN = 0.45;
  const UNIT_COLOR = "rgb(240,220,60)";
  const UNIT_OUTLINE = "rgb(20,20,20)";
  // B98 ghost tint: a ghost unit (wire gh:1) gets a spectral-green multiply + DF's own ghost
  // translucency (creature-compositing-system.md: the GHOST USE_PALETTE row is alpha=163).
  // MUST stay byte-identical to dwf-gl.js's GHOST_TINT_RGB/GHOST_ALPHA so both renderers
  // tint ghosts the same -- the treegrass ghost fixture asserts the two are equal.
  const GHOST_TINT_RGB = [120, 235, 150];
  const GHOST_ALPHA = 163 / 255;
  const GHOST_TINT_CSS = "rgb(" + GHOST_TINT_RGB[0] + "," + GHOST_TINT_RGB[1] + "," + GHOST_TINT_RGB[2] + ")";
  const UNIT_STATUS_SHEET = "unit_status.png";
  const UNIT_STATUS_BLINK_MS = 800;
  const USTAT_SLEEPING = 0x01;
  const USTAT_UNCONSCIOUS = 0x02;
  const USTAT_STRESSED = 0x04;
  const USTAT_STRANGE_MOOD = 0x08;
  const USTAT_CAGED = 0x10;
  const USTAT_CHAINED = 0x20;
  // WT30 full status set (mirror of src/unit_status.h kUStat*; 0x200+). Byte-parity with
  // dwf-gl.js (asserted by wt30_status_full_test.mjs). Every bit is a graphics_interface.txt
  // UNIT_STATUS row; the resolver documents the bit->row map and the one-bubble priority order.
  const USTAT_WINDED = 0x00000200;
  const USTAT_STUNNED = 0x00000400;
  const USTAT_NAUSEA = 0x00000800;
  const USTAT_WEBBED = 0x00001000;
  const USTAT_PARALYZED = 0x00002000;
  const USTAT_FEVERED = 0x00004000;
  const USTAT_GROUNDED = 0x00008000;
  const USTAT_PROJECTILE = 0x00010000;
  const USTAT_CLIMBING = 0x00020000;
  const USTAT_MELANCHOLY = 0x00040000;
  const USTAT_MADNESS = 0x00080000;
  const USTAT_BERSERK = 0x00100000;
  const USTAT_MARTIAL_TRANCE = 0x00200000;
  const USTAT_ENRAGED = 0x00400000;
  const USTAT_TANTRUM = 0x00800000;
  const USTAT_DEPRESSION = 0x01000000;
  const USTAT_OBLIVIOUS = 0x02000000;
  const USTAT_HUNGRY = 0x04000000;
  const USTAT_THIRSTY = 0x08000000;
  const USTAT_DROWSY = 0x10000000;
  // WT29: strange-mood SUBTYPE nibble (server world_stream.cpp kUStatMood*). 3-bit 1-based code in
  // bits 0x40..0x100; 0x08 STRANGE_MOOD is always co-set. Code 0 (old DLL / non-overhead mood) -> the
  // FEY_MOOD row-9 fallback, so a new client renders correctly against an old server. MOOD_CELL is
  // keyed by that code; graphics_interface.txt row map FEY_MOOD:9 POSSESSED:10 SECRETIVE_MOOD:11
  // FELL_MOOD:12 MACABRE_MOOD:13. Kept module-scope + test-exported (same convention as the sheet map).
  const USTAT_MOOD_SHIFT = 6;
  const USTAT_MOOD_MASK = 0x7 << USTAT_MOOD_SHIFT; // 0x1C0
  const MOOD_CELL = {
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
  // before, so the two halves deploy in either order. Byte-parity with dwf-gl.js.
  const USTAT2_MIGRANT = 0x00000001;
  const USTAT2_NO_JOB = 0x00000002;
  const USTAT2_NO_DESTINATION = 0x00000004;  // server reserves this; not set until probe P3 lands
  const USTAT2_DISTRACTED = 0x00000008;
  const USTAT2_TERRIFIED = 0x00000010;
  const USTAT2_WRESTLING = 0x00000020;
  const USTAT2_MINOR_INJURY = 0x00000040;
  const USTAT2_MAJOR_INJURY = 0x00000080;
  const USTAT2_MAKE_BELIEVE = 0x00000100;
  const USTAT2_TELLING_A_STORY = 0x00000200;
  const USTAT2_RECITING_POETRY = 0x00000400;
  const USTAT2_PERFORMING = 0x00000800;
  const BLD_OUTLINE = "rgb(230,150,40)";
  // Not present in render_mapdump.py's tile_color() (its map.json predates the "hidden"
  // field) -- added per the wire:1 spec: hidden tiles should render black/very dark.
  const HIDDEN_COLOR = [6, 6, 8];

  function matRgb(mat) {
    return MAT_COLOR[mat] || FALLBACK_MAT;
  }

  function darken(rgb, f) {
    return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
  }

  function waterRgb(depth) {
    const d = Math.max(1, Math.min(7, depth));
    const b = 90 + d * 18;
    return [30, 60 + d * 6, Math.min(255, b + 60)];
  }

  function magmaRgb(depth) {
    const d = Math.max(1, Math.min(7, depth));
    return [Math.min(255, 150 + d * 14), Math.max(30, 90 - d * 8), 10];
  }

  function rgbStr(rgb) {
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // ---- real liquid sprites (replaces the flat waterRgb/magmaRgb placeholder) -----
  // liquids.png (served at /sprites/img/liquids.png) is a 7x7 grid of 32px cells,
  // per DF's tile_page_environment.txt ([TILE_PAGE:LIQUIDS] [PAGE_DIM_PIXELS:224:224])
  // and graphics_fluids.txt's [TILE_GRAPHICS:LIQUIDS:col:row:TOKEN] tokens:
  //   column 0, rows 0-6 = UNDERWATER_7 .. UNDERWATER_1 (row = 7 - depth)
  //   column 1, rows 0-6 = UNDERMAGMA_7 .. UNDERMAGMA_1 (row = 7 - depth)
  // Verified against the actual PNG: row 0 (depth 7) is fully opaque deep-teal
  // water / dark cracked-magma texture; row 6 (depth 1) is a lighter, ~70%-alpha
  // (partially translucent, so shallow liquid lets a bit of the tile show through)
  // texture -- exactly the "depth stage" progression DF's raws describe. Columns
  // 2-3 are numeral label overlays (unused) and columns 4-6 hold edge-adjacency
  // cells (unused here; every flooded/lava tile just gets its depth's full cell).
  const WATER_CELL = { sheet: "liquids.png", col: 0 };
  const MAGMA_CELL = { sheet: "liquids.png", col: 1 };

  function liquidCellFor(liquid, flow) {
    if (liquid !== "water" && liquid !== "magma") return null;
    const d = Math.max(1, Math.min(7, flow || 0));
    const base = (liquid === "magma") ? MAGMA_CELL : WATER_CELL;
    return { sheet: base.sheet, col: base.col, row: 7 - d };
  }

  function liquidEdgeTokens(t, gx, gy, lookupTile, Adj) {
    if (!Adj || !lookupTile) return [];
    const flow = t && (t.flow || 0), liquid = t && (t.liquid || "none");
    if (flow <= 0 || (liquid !== "water" && liquid !== "magma")) return [];
    const mask8 = Adj.computeMask8(lookupTile, gx, gy, (nt) => {
      if (!nt) return true;
      const nFlow = nt.flow || 0, nLiquid = nt.liquid || "none";
      return !(nFlow > 0 && (nLiquid === "water" || nLiquid === "magma"));
    });
    if (!mask8) return [];
    const prefix = (liquid === "magma") ? "UNDERMAGMA_EDGE_" : "UNDERWATER_EDGE_";
    const out = [];
    for (let i = 0; i < Adj.DIR_NAMES.length && out.length < 4; i++) {
      const name = Adj.DIR_NAMES[i];
      if (mask8 & Adj.BIT[name]) out.push(prefix + name);
    }
    return out;
  }

  // Resolve a flooded/lava tile to its loaded liquids.png cell, or null to keep
  // the existing waterRgb/magmaRgb flat-color fallback (sheet not loaded yet, or
  // tile isn't actually flowing liquid). Hidden tiles are excluded like resolveSprite.
  function resolveLiquidSprite(t) {
    if (t.hidden) return null;
    const flow = t.flow || 0;
    const liquid = t.liquid || "none";
    if (flow <= 0 || (liquid !== "water" && liquid !== "magma")) return null;
    const entry = liquidCellFor(liquid, flow);
    if (!entry) return null;
    const sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    return { img: sheet.img, col: entry.col, row: entry.row };
  }

  // Resolve a tile record to a fill color, or null to leave the background showing.
  // Mirrors tile_color() in render_mapdump.py, with a hidden-tile override layered on
  // top (see HIDDEN_COLOR above).
  //
  // WB-4 liquid fix (fog report §1/§4.6): a flooded tile's BASE FILL used to be the flat
  // waterRgb/magmaRgb wash unconditionally, even when the authored liquids.png depth cell
  // was going to be blitted right on top -- since that cell's own alpha is the whole point
  // (shallow depths let the bed show through), drawing the flat wash underneath bled a fake
  // teal tint through the authored translucency. Fix: when the caller already has a loaded
  // liquid sprite ready to draw (`skipLiquidColor` true), fall through to the tile's OWN
  // shape/mat color (the substituted bed the wire already carries) instead of the flow
  // color; the flat wash is now used ONLY as the pre-load fallback (sheet not fetched yet).
  // B62 ("surface tree trunks render as grey rock squares, not round tan slices").
  // A ground-surface tree trunk / mushroom-cap tile is tiletype_material TREE (or MUSHROOM)
  // with tiletype_shape WALL, so it flows through BOTH wall paths below: (1) tileColor's
  // WALL branch darkens it to a near-black stone-wall interior, and (2) drawWallJoin paints
  // the STONE_WALL adjacency edge cell over it (wallPrefix has no TREE/MUSHROOM case -> it
  // falls through to STONE_WALL). Since drawTree already draws the tile's OWN round trunk/cap
  // cell (tree_map TREE_TRUNK_PILLAR etc., a round slice with transparent corners) and runs
  // BEFORE drawWallJoin, the stone edge cell -- which for a lone open-surrounded trunk is the
  // near-full STONE_WALL_N_S_W_E rubble block -- overpaints the round slice into a grey square
  // (the evidence pair: native = round tan rings on grass, browser = grey rubble box). Trees
  // own their boundary art; they must be EXEMPT from the stone wall-edge + wall-darken passes.
  function isTreeWallMat(mat) { return mat === "TREE" || mat === "MUSHROOM"; }

  // B62-r2 (evidence pair 7.png/8.png: "trunks overdrawn by the brown box, can't see the
  // round slice at all"): tree tiles whose PLANT tail is missing drew NOTHING (drawTree's
  // `if (!p) return` guard), leaving only the flat brown base fill. The tail goes missing on
  // (a) see-down SUBSTITUTED tree tiles -- both the server's baked substitution and WB-10's
  // client descent carry tt/ttname/shape/mat but drop sparse tails (`a descended tile's
  // .item/.plant/.spatters are simply absent`, see descendSeeDown's banner) -- which is EVERY
  // tree tile viewed from a higher z (the canopy clusters), and (b) live-verified surface
  // pillars whose wire plant-pos lookup missed (5/15 at z161, outside=0). The tile's own
  // ttname/shape/mat fully determine the PART, so derive it exactly like the wire does
  // (src/wire_v1.cpp's shape/material -> part mapping) and let the species fall to
  // tree_map._default (species-perfect art for substituted tiles needs the tail on the wire
  // -- optional DLL-window item, documented residual).
  function derivedTreePart(t) {
    const shape = t.shape || "", mat = t.mat || "";
    if (shape === "TWIG") return "LEAVES";
    if (shape === "BRANCH") return "BRANCH";
    if (shape === "TRUNK_BRANCH") return "TRUNK";
    if (mat === "TREE") return (shape === "WALL") ? "TRUNK" : "CANOPY";
    if (mat === "MUSHROOM") return "TRUNK";
    return null; // SAPLING/SHRUB are PLANT-material -- drawPlant's domain, never derived here
  }

  // B62-r2 GRASS BACKING (design decision, same evidence pair): native DF draws tree
  // trunk/branch/canopy tiles OVER the ground below -- grass shows through every transparent
  // pixel -- while the client painted the flat MAT_COLOR.TREE fill ("brown box") behind all
  // tree art. There is no below-tile data for tree tiles on the wire (solid shapes: neither
  // WB-10 descent nor the server's baked substitution applies to THEM, only to the open tiles
  // around them). Client-only rule, accepted (the wire-side grass tail remains an optional
  // DLL-window "perfect" item): BORROW REAL NEIGHBORING GRASS. If any tile within Chebyshev
  // distance 1..3 (nearest ring first, cardinal-closest first) is a grass surface (B107 widened
  // this from GRASS_LIGHT/GRASS_DARK-only to any live grass mat incl. dry/dead + outside
  // grass-tail composites -- see isGrassBackingSource; still never invents biome grass), the backing is the
  // standard grass composite this client already draws for real grass floors: GRASS_1..4
  // variant by hashXY(gx,gy) + the calibrated grassSummer wash. No grass-mat neighbor
  // (desert/cavern-edge trees) -> keep the wood-tone fill. This never changes how a grass
  // tile ITSELF renders, so the grass-escalation oracle rules are untouched.
  // B71/B107 REACH FIX: Chebyshev ring 1 only (was rings 1..3). The owner "green band spreading around
  // grass cells" / a playtester "mis-shaded grass square around tree trunks": the 1..3 reach let a
  // trunk on NON-grass ground borrow grass from up to 3 tiles away, painting a full grass
  // square/band where native draws the trunk's real (dirt/mud) ground -- the band that "spreads
  // around" the grass. A trunk truly embedded in grass has grass at ring 1 (the B62-accepted
  // case); a trunk 2-3 tiles out on dirt no longer invents grass.
  const GRASS_BACK_OFFSETS = (() => {
    const out = [];
    for (let r = 1; r <= 1; r++) {
      const ring = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
        }
      }
      ring.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
      out.push.apply(out, ring);
    }
    return out;
  })();
  // B107: a trunk tile has no ground-layer grass event of its own. Borrow any real
  // grass surface around it, including dry/dead grass and the positive grass-tail composites
  // DF draws on outside SoilFloor/*Pebbles cells. This is client-only: wire_v1 emits GRASS
  // tails only for FLOOR tiles, never the solid trunk tile itself.
  // B71/B107 SOURCE FIX: backing sources are LIVE GRASS_LIGHT/GRASS_DARK ONLY -- the B62-r2
  // original intent ("never dry/dead, never invented biome grass"). B107 (GROUNDART) broadened
  // this to dry/dead grass and any outside SoilFloor/*Pebbles with a trace grass amount, which
  // made nearly EVERY above-ground trunk paint a bright-summer-grass square even over dirt/dry
  // ground where native shows tan/brown -- the "green where native shows none" band the owner + a playtester
  // reported (re-review FAILed that broadening). Reverting also re-greens the
  // b62_trunk_walljoin_test gate that B107 silently broke. Grass-under compositing on the FLOOR
  // tiles themselves is a separate, server-tail-driven path (see resolveSprite's grass-under arm)
  // and is unaffected -- this predicate only governs what a solid tree tile borrows.
  function isGrassBackingSource(n) {
    if (!n || n.hidden) return false;
    return n.mat === "GRASS_LIGHT" || n.mat === "GRASS_DARK";
  }
  // -> {sheet,col,row} grass cell, or null when this tile gets no grass backing.
  // `lookup` defaults to the live screen-window tileAt; tests inject a fixture lookup.
  function grassBackingCell(t, gx, gy, lookup) {
    const mat = t.mat || "";
    if (mat !== "TREE" && mat !== "MUSHROOM") return null;
    const shape = t.shape || "";
    if (shape === "EMPTY" || shape === "NONE") return null;
    if (typeof gx !== "number" || typeof gy !== "number") return null;
    const at = lookup || tileAt;
    for (let i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
      if (isGrassBackingSource(at(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
        return TOKEN_CELL_OVERRIDE["GRASS_" + ((hashXY(gx, gy) & 3) + 1)];
      }
    }
    return null;
  }

  // B241 GROUND BACKING (paired oracle B241-broken-ours.png vs B241-oracle-native.png):
  // a BOULDER tile's sprite is 50-65% opaque (terrain_boulders.png, measured 502-670/1024
  // opaque px per cell) and native composites the tile's REAL ground beneath it -- in the
  // oracle the rock sits directly on grass, while we filled the transparent fringe with the
  // flat MAT_COLOR.STONE grey (the "solid square box"; sampled ~(130,122,110) in the broken
  // capture vs grass (78,103,51) in the native one). The B71-r3-deleted grass-creep decal
  // was accidentally papering over this; the honest fix is the same backing slot tree trunks
  // use, generalized: back the sprite with the tile's TRUE floor.
  //   (1) the tile's OWN grass tail (amount>0) -> the standard grass composite. This is the
  //       real ground truth, but TODAY the wire never ships a grass tail for BOULDER-shape
  //       tiles (src/wire_v1.cpp gates grass_under_floor on shape==FLOOR; StoneBoulder is
  //       shape BOULDER) -- this arm goes live with the DLL-gated wire fix.
  //   (2) no tail on the wire: borrow ring-1 LIVE grass, the exact B62-r2/B71-r2 rule the owner
  //       accepted for tree trunks (never invents grass beyond an adjacent live-grass tile).
  //   (3) otherwise: the rough floor art of the tile's own stone-family material
  //       (STONE_FLOOR_5 -- every Boulder tiletype is stone-family, static.enums.inc;
  //       classify() maps all stone-family rough floors to this cell), textured where the
  //       flat grey fill was. A worn-bare tail (amount<=0, possible only post-DLL) means
  //       "grass is gone": straight to (3), no borrowing.
  // Returns {sheet, col, row, wash} (wash: apply the grassSummer wash, grass arms only) or
  // null (keep the flat fill). TREE/MUSHROOM tiles keep their existing borrowed-grass rule.
  function groundBackingCell(t, gx, gy, lookup) {
    const gb = grassBackingCell(t, gx, gy, lookup);
    if (gb) return { sheet: gb.sheet, col: gb.col, row: gb.row, wash: true };
    if ((t.shape || "") !== "BOULDER") return null;
    const grassBack = () => {
      const c = TOKEN_CELL_OVERRIDE["GRASS_" + ((hashXY(gx, gy) & 3) + 1)];
      return c ? { sheet: c.sheet, col: c.col, row: c.row, wash: true } : null;
    };
    if (t.grass && t.grass.amount > 0) return grassBack();          // (1) true floor: grass
    if (!t.grass && typeof gx === "number" && typeof gy === "number") {
      const at = lookup || tileAt;                                   // (2) ring-1 borrow
      for (let i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
        if (isGrassBackingSource(at(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
          return grassBack();
        }
      }
    }
    const entry = spriteMap && spriteMap.STONE_FLOOR_5;              // (3) rough stone floor
    if (!entry || !entry.sheet) return null;
    return { sheet: entry.sheet, col: entry.col, row: entry.row, wash: false };
  }

  function tileColor(t, skipLiquidColor) {
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    if (tt < 0) return null; // null / edge -> leave background
    if (t.hidden) return HIDDEN_COLOR;
    if (!skipLiquidColor) {
      const flow = t.flow || 0;
      const liquid = t.liquid || "none";
      if (flow > 0 && liquid === "magma") return magmaRgb(flow);
      if (flow > 0 && liquid === "water") return waterRgb(flow);
    }
    const shape = t.shape || "NONE";
    const mat = t.mat || "NONE";
    const base = matRgb(mat);
    // B62: a TREE/MUSHROOM WALL is a trunk/cap, not a stone wall -- keep its natural wood base
    // (the round trunk cell's transparent corners then show a wood tone, not a near-black box).
    if (shape === "WALL" || shape === "FORTIFICATION") {
      if (isTreeWallMat(mat)) return base;
      // B281: a palette-authored NATURAL wall face is composited over hidden_rock.png below.
      // Keep this fallback dark too: tinting the fill from STATE_COLOR made transparent face
      // pixels glow. Constructed walls and fortifications retain their built-from-material fill.
      if (shape === "WALL" && mat !== "CONSTRUCTION" && wallMaterial(t)) return HIDDEN_COLOR;
      const cr = wallMaterialRgb(t);
      if (cr) return darken(cr, WALL_DARKEN);
      return darken(base, WALL_DARKEN);
    }
    // RampTop is DF's AIR/RAMPSPACE tiletype (the "Downward Slope" hover): it is open,
    // not a cyan/teal terrain square. The multi-z compositor supplies the tile below.
    if (shape === "EMPTY" || shape === "NONE" || shape === "RAMP_TOP") return null;
    return base; // floors, ramps, stairs, boulders, pebbles, etc.
  }

  function isStairOrRamp(shape) {
    return shape === "STAIR_UP" || shape === "STAIR_DOWN" ||
      shape === "STAIR_UPDOWN" || shape === "RAMP" || shape === "RAMP_TOP";
  }

  // ---- premium terrain sprites ----------------------------------------------------
  // spriteMap: { "<TOKEN>": {sheet, col, row}, ... } fetched once from /sprites/map.json.
  // Its keys are graphics TOKENS (e.g. "GRASS_1", "STONE_WALL_N_S_W_E_1", "BOULDER"),
  // NOT df::tiletype enum keys. The wire gives us a tile's `ttname` (an enum key such as
  // "GrassLightFloor1"); DF's tiletype->token choice is hardcoded in the DF binary, so we
  // reconstruct it offline into tiletype_token_map.json and translate ttname->token here
  // BEFORE looking the sprite up. sheets: sheet filename -> { img, loaded, failed } cache;
  // each sheet is fetched once and reused. A missing map.json, a missing token map, a
  // missing sheet, an unmapped ttname, or an unmapped token all fall back to the existing
  // flat material color so the map is never blank.
  let spriteMap = null;
  let tiletypeTokenMap = null; // { "<ttname>": {token, tint}, ... } from /tiletype_token_map.json
  const sheets = Object.create(null);

  // WB-4 (fog report §1/§4.5): DF measured GrassLight === GrassDark, rendered IDENTICALLY
  // (same texpos, same color) -- the old 4-way light/dark/dry/dead multiply split was fog
  // debt, not signal. Replaced with ONE calibrated summer recolor computed (not eyeballed)
  // to hit the measured target RGB (78,104,52) from the measured grass.png sheet base
  // (73,99,52): a plain alpha-blend (source-over, NOT multiply -- multiply can only darken,
  // and the target is BRIGHTER than the base in every channel) of color C at alpha a solves
  // to final = base*(1-a) + C*a. Choosing a=0.25: C = (final - base*0.75)/0.25 =
  // (93,119,52) exactly (73*0.75+93*0.25=78.0, 99*0.75+119*0.25=104.0, 52*0.75+52*0.25=52.0
  // -- verified to the integer, zero rounding slack). Dry/dead grass keep their own ttnames
  // (a W-C seasonal-recolor concern) but share this same summer wash until then, per spec.
  const TINT_COLORS = {
    grassSummer: "rgba(93,119,52,0.25)",
  };

  // The /sprites/map.json parser mis-binds GRASS_n to floors.png (a token collision); the
  // REAL grass sprites are the 4 opaque textured cells of grass.png (graphics_grass.txt:
  // [GRASS_1:GRASS:0:0]..[GRASS_4:GRASS:3:0]). Override those tokens to the correct cells;
  // the 4 variants give DF's per-tile grass texture variation.
  const TOKEN_CELL_OVERRIDE = {
    GRASS_1: { sheet: "grass.png", col: 0, row: 0 },
    GRASS_2: { sheet: "grass.png", col: 1, row: 0 },
    GRASS_3: { sheet: "grass.png", col: 2, row: 0 },
    GRASS_4: { sheet: "grass.png", col: 3, row: 0 },
  };

  // GRASS CHECKERBOARD FIX: two independent gaps left some tiles with no
  // tiletype_token_map.json entry at all, so resolveSprite() gave up and
  // tileColor()'s flat color showed through as a hard-edged square amid the
  // textured grass.png field:
  //   1. df::tiletype's "Shrub"/"ShrubDead"/"Sapling"/"SaplingDead" entries are
  //      shape SHRUB/SAPLING with tiletype_material PLANT (confirmed against DF's
  //      own tiletype enum) -- build_tiletype_token_map.py's classify() only
  //      handles shape FLOOR/WALL/FORTIFICATION/RAMP/RAMP_TOP/STAIR_*/BOULDER/
  //      PEBBLES, so these four ttnames are never written to the JSON. A wild
  //      shrub/sapling standing on any biome's natural ground is overwhelmingly
  //      standing on grass, so tileColor() fell back to the flat PLANT-material
  //      color ([70,130,70]) under the small plant-tuft overlay drawPlant() draws
  //      -- a flat green square peeking out around every wild plant.
  //   2. Forward-compat: any future/modded grass FLOOR ttname not yet present in
  //      the generated token map should still get grass texture instead of flat
  //      color, per the same "GRASS_n" family.
  // Both fall back to one of the 4 real grass.png cells (same sheet/cells as the
  // TOKEN_CELL_OVERRIDE above), picked by a stable per-tile hash for variety
  // since these ttnames carry no DF variant digit to key off of.
  const GRASS_FLOOR_FALLBACK_TTNAMES = new Set(["Shrub", "ShrubDead", "Sapling", "SaplingDead"]);
  function looksLikeGrassFloor(ttname) {
    return GRASS_FLOOR_FALLBACK_TTNAMES.has(ttname) ||
      (ttname.indexOf("Grass") !== -1 && ttname.indexOf("Floor") !== -1);
  }

  // Cheap, stable per-tile hash (no crypto needed) so each (gx,gy) always picks
  // the same grass.png variant frame-to-frame instead of flickering.
  function hashXY(x, y) {
    return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0;
  }

  // B241 boulder variants: the raws bind EIGHT cells to the single BOULDER token
  // (TERRAIN_BOULDERS page, a 4x2 grid at cols 0-3 x rows 0-1 -- graphics_tiles.txt L5-12,
  // tile_page_environment.txt PAGE_DIM 4:2), but sprite_map.cpp is first-binding-wins so
  // /sprites/map.json only carries cell (0,0) and every boulder drew the same rock. There is
  // exactly ONE Boulder tiletype per material family (no VAR_ digit -- static.enums.inc), so
  // native's visible variety cannot be keyed off the tiletype; like the WB-5 hidden-rock
  // variants, it reads as a stable positional pick. Match it with the same hashXY convention
  // -- but keyed on WORLD coords (t.x/t.y, stamped on every tile by decodeTile), NOT the
  // viewport-relative gx/gy the 4-way grass variants use: the 8 boulder cells are visually
  // DISTINCT shapes, so a screen-space key would visibly reshuffle every boulder on pan.
  // Guarded to the vanilla terrain_boulders.png binding at (0,0): a modded raw that rebinds
  // BOULDER elsewhere keeps its single authored cell (we know nothing about its sheet layout).
  function boulderVariant(t, gx, gy) {
    const entry = spriteMap && spriteMap.BOULDER;
    if (!entry || entry.sheet !== "terrain_boulders.png" || entry.col !== 0 || entry.row !== 0) return null;
    const wx = (t && typeof t.x === "number") ? t.x : gx;
    const wy = (t && typeof t.y === "number") ? t.y : gy;
    const h = hashXY(wx, wy);
    return { col: h & 3, row: (h >> 2) & 1 };
  }

  // WB-5 (fog report §1/§4.2): undiscovered tiles render DF's opaque HIDDEN_ROCK hatch
  // sprite (5 variants, hidden_rock.png cols 0-4 row 0 -- already in /sprites/map.json per
  // §1.5), not a flat color. DF's own variant pick reads as noise (the oracle matched any
  // of the 5 as exact -- median (49,44,52) held across all of them), so we just need a
  // STABLE per-tile choice (no flicker), same hashXY convention as the grass fallback above.
  function resolveHiddenSprite(gx, gy) {
    const idx = (hashXY(gx, gy) % 5) + 1; // HIDDEN_ROCK_1..5
    const entry = spriteMap && spriteMap["HIDDEN_ROCK_" + idx];
    if (!entry || !entry.sheet) return null;
    const sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    return { img: sheet.img, col: entry.col, row: entry.row };
  }

  // WT25: is a tile inside the world footprint [0,W)x[0,H)? `dims` is hello_ack's map.{w,h}
  // (v1MapDims). Uses the tile's own world (t.x,t.y) -- decodeTile stamps these on every tile,
  // void ones included. z is not checked: the composite never renders above the camera plane
  // (see-above is deleted) and see-down is z>=0 clamped, so any rendered tile's z is in-bounds.
  function inMapBounds(t, dims) {
    if (!dims || !t) return false;
    const x = t.x, y = t.y;
    return typeof x === "number" && x >= 0 && x < dims.w &&
           typeof y === "number" && y >= 0 && y < dims.h;
  }

  // WT25: should this tile paint DF's uniform unmined-rock hatch? Two cases, both DF-faithful:
  //   (1) a shipped-and-hidden tile (real tt, hidden bit) -- the pre-WT25 behavior; and
  //   (2) NEW: an in-bounds tile the cache cannot resolve (tt<0) -- undiscovered rock the server
  //       withholds for fog-of-war. Painting the same hatch (not black) is the base state; the
  //       already-streamed discovered blocks overlay it as deltas. A truly off-map tt<0 tile
  //       (outside the footprint) is NOT in-bounds -> stays black (real map edge / sky column).
  function wantsHiddenHatch(t, dims) {
    if (!t) return false;
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    if (t.hidden && tt >= 0) return true;
    return tt < 0 && inMapBounds(t, dims);
  }

  // B235 ("faint border around the edge of the unloaded chunk"): may the per-tile OVERLAY stack
  // (shadow decals < spatter < item < plant < tree < wall-join < engraving) draw on this tile?
  // Only on a tile that shows real, DISCOVERED content -- never on one painting the unmined hatch.
  //
  // Why this is not just `!t.hidden`: WT25 introduced a SECOND class of hatched tile -- in-bounds
  // tt<0 "undiscovered" tiles the server never shipped. Those carry NO `hidden` flag (the server
  // sent no tile at all), so `!t.hidden` waves them through. Pre-WT25 that was harmless because an
  // in-bounds tt<0 tile painted nothing -- `drew` stayed false and the `drew && !t.hidden` gate
  // never opened. WT25 made them paint the hatch, which flipped `drew` TRUE and let the whole
  // overlay stack run on undiscovered rock for the first time.
  //
  // The visible consequence is drawShadowDecals' (b) `visionShadow` decal: its 8-neighbour mask is
  // keyed on `isHiddenTile` (=== !!t.hidden), which matches the shipped-and-hidden tiles filling
  // the last KNOWN block. So the ring of tt<0 tiles hugging the known-block boundary each found a
  // hidden neighbour and painted a fog-of-war edge shadow -- a one-tile-wide gradient tracing the
  // loaded/unloaded boundary. That is exactly the seam (VISION_SHADOW_S along the horizontal run,
  // _E along the vertical). Same gate also kills the (a) wallShadow leak onto hatch tiles.
  //
  // The predicate is just "does this tile have DISCOVERED CONTENT?" -- a real, resolved tiletype
  // (tt>=0) that the player has seen (not hidden). Everything the overlay stack draws (spatter,
  // items, plants, trees, wall joins, engravings, shadows) is content that only a discovered tile
  // can have, so nothing is lost. Deliberately NOT expressed as `!wantsHiddenHatch(...)`: that
  // would depend on v1MapDims, and a null footprint (pre-hello) would quietly re-open the gate on
  // tt<0 tiles. tt>=0 needs no footprint and cannot regress that way.
  //
  // Strictly a SUBSET of the old `!t.hidden` gate: it can only ever REMOVE overlays, and only from
  // tiles with no content to overlay. The genuine fog-of-war shadow ringing the carved-out fort is
  // untouched -- those are discovered, non-hidden tiles (tt>=0), and they keep it.
  function overlaysAllowed(t) {
    if (!t) return false;
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    return tt >= 0 && !t.hidden;
  }

  function grassFallbackCell(gx, gy) {
    const sheet = getSheet("grass.png");
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    const col = hashXY(gx, gy) % 4;
    return { img: sheet.img, col, row: 0, tint: null };
  }

  // WC-17 pure helpers, NOT applied to the live render since the 2026-07-07
  // grass-escalation (see resolveSprite's grass comment for the oracle evidence): the
  // tier thresholds assumed amount <= 100 (live wire carries 5..251) and indexed
  // grass_colors.json tiers backwards vs the raws' graze-state order. Kept exported for
  // the test hooks and for a FUTURE oracle-calibrated wear treatment.
  function grassTierIndex(amount) {
    if (amount <= 33) return 0;
    if (amount <= 66) return 1;
    if (amount <= 99) return 2;
    return 3;
  }
  function grassTierCell(amount) {
    const sheet = getSheet("grass.png");
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    return { img: sheet.img, col: grassTierIndex(amount), row: 0 };
  }
  // Per-species tint from grass_colors.json, keyed by the wire's resolved plant TOKEN
  // (not a numeric id -- see src/wire_v1.cpp::make_grass_tail's doc for why). The raw
  // [GRASS_COLORS:...] token carries 4 fg:bg:bright triples; this indexes the SAME
  // coverage tier the cell pick above used, so light/thin coverage and dense coverage
  // can (and in vanilla often do) resolve to different shades of the same species.
  // Returns a literal rgba() string (not a TINT_COLORS key) or null if unresolved, in
  // which case the caller falls back to the flat TINT_COLORS.grassSummer wash.
  function grassSpeciesTint(id, amount) {
    if (!grassColors || !grassColors.plants || !id) return null;
    const p = grassColors.plants[id];
    if (!p || !p.tiers) return null;
    const tier = p.tiers[grassTierIndex(amount)];
    if (!tier || !tier.rgb) return null;
    // Same alpha-blend convention as TINT_COLORS.grassSummer (a source-over wash at low
    // alpha, not a hard recolor, so the underlying grass.png texture detail still shows).
    return "rgba(" + tier.rgb[0] + "," + tier.rgb[1] + "," + tier.rgb[2] + ",0.25)";
  }

  // 2026-07-07 ledger ("the owner BUG REPORT: blocky flat-color grass"): a sheet's <img> element
  // used to stick at `failed:true` FOREVER on a single dropped/errored load (e.g. one hiccup
  // over a flaky cloudflare tunnel) -- every tile referencing it (grass.png, in the report)
  // then permanently fell back to its flat material-colour fill (tileColor()'s plain
  // GRASS_LIGHT/DARK/DRY/DEAD rgb, no texture, no wash) for the REST of the browser session,
  // recoverable only by a full page reload. Same bug class/fix as dwf-gl-atlas.js's
  // ensureSheet() (this session's other GL fix): bounded backoff retry instead of a permanent
  // failure state.
  const SHEET_RETRY_DELAY_MS = 2000;

  function getSheet(name) {
    let s = sheets[name];
    if (s && s.failed && (Date.now() - s.failedAt) >= SHEET_RETRY_DELAY_MS) {
      s = null; // backoff elapsed -- retry as if seen for the first time
    }
    if (!s) {
      s = sheets[name] = { img: new Image(), loaded: false, failed: false, failedAt: 0 };
      s.img.onload = () => {
        s.loaded = true;
        draw();
      };
      s.img.onerror = () => {
        s.failed = true;
        s.failedAt = Date.now();
      };
      // Never throw synchronously on a bad filename -- onerror handles load failure.
      s.img.src = "/sprites/img/" + name;
    }
    return s;
  }

  async function loadSpriteMap() {
    try {
      const resp = await fetch("/sprites/map.json", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || typeof data !== "object") return;
      spriteMap = data;
      const seen = new Set();
      for (const key in spriteMap) {
        const entry = spriteMap[key];
        if (entry && entry.sheet && !seen.has(entry.sheet)) {
          seen.add(entry.sheet);
          getSheet(entry.sheet);
        }
      }
    } catch (_) {
      // No sprite map available (older server, network hiccup, bad JSON) -- the
      // renderer just keeps drawing flat colors for every tile.
      spriteMap = null;
    }
  }

  async function loadTokenMap() {
    try {
      const resp = await fetch("/tiletype_token_map.json", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || typeof data !== "object") return;
      tiletypeTokenMap = data;
      draw(); // some tiles may now resolve to sprites
    } catch (_) {
      // No token map available -> resolveSprite() returns null and the renderer
      // keeps drawing flat colors for every tile.
      tiletypeTokenMap = null;
    }
  }

  // WC-17: grass_colors.json (tools/ws2/build_grass_colors.py) -- { plants: { "<raw
  // token>": { tiers: [{fg,bg,bright,rgb:[r,g,b]}, x4] }, ... } }. Missing/failed fetch
  // just leaves grassSpeciesTint() falling back to the existing flat summer wash --
  // never blocks terrain drawing (same convention as every other optional map fetch).
  let grassColors = null;
  async function loadGrassColors() {
    try {
      const resp = await fetch("/grass_colors.json", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || typeof data !== "object") return;
      grassColors = data;
      draw();
    } catch (_) {
      grassColors = null;
    }
  }

  // WB-7: shadow_cell_map.json -- { wallShadow, visionShadow, rampShadowOnRamp,
  // rampShadowOnFloor } each mapping a string mask8 ("0".."255") to a spriteMap TOKEN name
  // (tools/spikes/fog/derive_shadow_table.py). Fetched once at boot like the other maps;
  // missing/failed fetch just leaves the decal pass a no-op (never blocks terrain drawing).
  let shadowCellMap = null;
  async function loadShadowCellMap() {
    try {
      const resp = await fetch("/shadow_cell_map.json", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || typeof data !== "object") return;
      shadowCellMap = data;
      draw();
    } catch (_) {
      shadowCellMap = null;
    }
  }

  // Resolve one token-map cell reference ({sheet,col,row} via TOKEN_CELL_OVERRIDE or
  // spriteMap) to a loaded sheet image, or null if unresolved/not loaded yet.
  function resolveCell(token) {
    const entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
    if (!entry || !entry.sheet) return null;
    const sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    return { img: sheet.img, col: entry.col, row: entry.row };
  }

  // ---- B47 material-family CONSTRUCTION FLOOR/TRACK art (full-range native cons:floor/track) ---
  // The tiletype_token_map is material-BLIND (its enum `material` attr is just "CONSTRUCTION"), so
  // every constructed floor/track routes to the single grey FLOOR_STONE_BLOCK. DF actually draws
  // the BUILT-FROM material's own floor sheet -- wood parquet (WOOD_FLOOR), metal diamond-plate
  // (METAL_FLOOR), glass (GLASS_{GREEN,CLEAR,CRYSTAL}_FLOOR), dressed stone (FLOOR_STONE_BLOCK) --
  // recolored by that material's palette row. The material rides the wire per-tile as
  // base_mt/base_mi (src/wire_v1.cpp B47, resolved via Constructions::findAtTile), so the override
  // lives HERE where the wire material is in hand, not in the offline token map. The metal/stone/
  // wood floor sheets are drawn 100% in the default palette (verified pixel-exact vs material_map's
  // default_row), so paletteSwappedCell reproduces the exact native per-material color; glass
  // floors are pre-colored variant cells (mat 3/4/5 = builtin GLASS_GREEN/CLEAR/CRYSTAL, no swap).
  // base_mt<0 (older DLL with no construction material on the wire, or an unresolved construction)
  // falls through to the token-map stone-block default -- graceful, never a regression. Track
  // variants (ConstructedFloorTrack<dirs>) additionally overlay the built-rail cell (designations.
  // png track family, the same rail sprite DF reuses for a built track), direction from the ttname.
  const CONS_GLASS_FLOOR_TOKEN = { 3: "GLASS_GREEN_FLOOR", 4: "GLASS_CLEAR_FLOOR", 5: "GLASS_CRYSTAL_FLOOR" };
  function constructionTrackMask(ttname) {
    const m = /Track([NSEW]+)$/.exec(ttname || "");
    if (!m) return 0;
    const s = m[1];
    return (s.indexOf("N") >= 0 ? 1 : 0) | (s.indexOf("S") >= 0 ? 2 : 0) |
           (s.indexOf("E") >= 0 ? 4 : 0) | (s.indexOf("W") >= 0 ? 8 : 0);
  }
  // WALLSFIX ("constructed walls/ramps/stairs/fortifications render as one generic grey sprite"):
  // resolve a construction's built-from wire material (base_mt/base_mi, live since the window-#11
  // wire guard) to {family, palRow}. family in GLASS/WOOD/METAL/STONE; palRow = the per-material
  // palette-swap row (null => a pre-colored sheet used as-is, OR an unresolved material that
  // gracefully degrades to the default stone/grey art -- e.g. the range world's DIVINE_* and other
  // inorganics whose index exceeds material_map.inorganic; "don't invent" a colour we can't read).
  function paletteRowRgb(palRow) {
    if (typeof palRow !== "number" || !materialMap || !materialMap.palette) return null;
    const row = materialMap.palette.rows && materialMap.palette.rows[palRow];
    const c = row && row[7];
    return (c && c.length >= 3) ? [c[0], c[1], c[2]] : null;
  }
  function plantWoodRow(base_mi) {
    const ids = materialMap && materialMap.plant_ids;
    const id = ids && ids[base_mi];
    const p = id && materialMap.plant && materialMap.plant[id];
    return p && typeof p.WOOD === "number" ? p.WOOD : null;
  }
  function consMaterial(base_mt, base_mi) {
    if (typeof base_mt !== "number" || base_mt < 0) return null;
    if (CONS_GLASS_FLOOR_TOKEN[base_mt]) {
      const pr = matPalRowFor({ mat_type: base_mt });
      return { family: "GLASS", glassMt: base_mt, palRow: (typeof pr === "number") ? pr : null, tintRgb: paletteRowRgb(pr) };
    }
    if (base_mt >= 419) {
      const wr = plantWoodRow(base_mi);
      return { family: "WOOD", palRow: wr, woodRow: wr, tintRgb: paletteRowRgb(wr) || [150, 120, 84] };
    }
    if (base_mt === 0) {
      const ino = materialMap && materialMap.inorganic && materialMap.inorganic[base_mi];
      const fam = ino && ino.family;
      const pr = ino && typeof ino.row === "number" ? ino.row : null;
      const prOk = (typeof pr === "number") && materialMap && materialMap.palette
        && materialMap.palette.rows && materialMap.palette.rows[pr];
      const row = prOk ? pr : null;
      return { family: fam || "STONE", palRow: row, tintRgb: paletteRowRgb(row) };
    }
    return null;
  }
  function consMaterialRgb(base_mt, base_mi) {
    const m = consMaterial(base_mt, base_mi);
    return m && m.tintRgb ? m.tintRgb : null;
  }
  // B273: one material policy for every palette-authored wall face. baseMaterialAt() carries
  // the actual inorganic for layer stone, soil, and mineral veins; constructions carry their
  // component override. Magma/ice/tree art remains authored color and is deliberately excluded.
  function wallMaterial(t) {
    if (!t) return null;
    const mat = t.mat || "";
    const m = consMaterial(t.base_mt, t.base_mi);
    if (!m) return null;
    if (mat === "CONSTRUCTION") return m;
    if (mat === "STONE" && m.family === "STONE") return m;
    if (mat === "SOIL" && m.family === "SOIL") return m;
    if (mat === "MINERAL" && (m.family === "STONE" || m.family === "GEM")) return m;
    return null;
  }
  function wallMaterialRgb(t) {
    const m = wallMaterial(t);
    return m && m.tintRgb ? m.tintRgb : null;
  }
  // B281: natural rock/soil/mineral wall art is alpha-composited over DF's standard opaque,
  // dark undiscovered-rock texture. Only the palette-authored FACE receives STATE_COLOR.
  // Construction walls are deliberately excluded: they retain the built-material backing
  // established by WALLSFIX. Return the token rather than pixels so both renderers use the
  // installed HIDDEN_ROCK_1..5 cells and share the existing stable variant grammar.
  function wallBackingToken(t, gx, gy, openMask) {
    if (!t || (t.shape || "") !== "WALL" || (t.mat || "") === "CONSTRUCTION") return null;
    if (!wallMaterial(t)) return null;
    // B282: fully buried walls have no exposed-face sprite (wallJoinBaseToken returns null).
    // A full opaque hatch there is not an underlay at all -- it is the whole visible tile,
    // which stamped the reported dark rectangle across the interiors of thick wall clusters.
    if (!((openMask | 0) & 0xff)) return null;
    return "HIDDEN_ROCK_" + ((hashXY(gx, gy) % 5) + 1);
  }
  // PURE decision (no sheet/Image dependency, unit-testable): ttname+wire-material ->
  // {token, palRow, mask} or null. Covers the NON-WALL constructed shapes (walls own drawWallJoin):
  //   FLOOR + RAMP  -> the built-from material's FLOOR art (native oracle cons:ramp draws the
  //                    material diamond-plate/parquet/dressed-stone floor, NOT the blue-grey
  //                    STONE_RAMP sprite -- 0% palettizable, so DF can't recolor it; it uses the
  //                    floor art instead), palette-swapped per material; track dirs from ttname.
  //   STAIR U/D/UD  -> PALETTE_STAIR_<kind> (stairs.png row 8, ~97-100% default-palette) + swap.
  //   FORTIFICATION -> FORTIFICATION (~92% default-palette) + swap; WOOD -> FORTIFICATION_WOOD.
  // All measured this session (tools/harness/wallsfix_construction_test.mjs asserts the matrix).
  function fortificationOpenToken(prefix, openMask) {
    // Adjacency bit values (dwf-adjacency.js DIR order): N=1, S=2, W=4, E=8. The raws'
    // _OPEN_<letters> variants carve their openings on exactly the named edges (verified
    // pixel-wise against fortification.png edge bands), so the suffix letters must equal the
    // set bits -- an E/W-mirrored table here renders end-of-run/corner fortifications flipped.
    const m = openMask & 15;
    const suffix = m === 15 ? "NSWE" : m === 11 ? "NSE" : m === 7 ? "NSW" :
      m === 13 ? "NWE" : m === 14 ? "SWE" : m === 3 ? "NS" : m === 12 ? "WE" :
      m === 9 ? "NE" : m === 5 ? "NW" : m === 10 ? "SE" : m === 6 ? "SW" : null;
    return suffix ? (prefix + "_OPEN_" + suffix) : prefix;
  }
  function constructionFloorPlan(ttname, base_mt, base_mi, openMask) {
    const nm = ttname || "";
    const isFloor = /^(?:Shoddy)?ConstructedFloor/.test(nm);
    const isRamp = /^(?:Shoddy)?ConstructedRamp/.test(nm);
    const stairM = /^ConstructedStair(UD|U|D)$/.exec(nm);
    const isFort = nm === "ConstructedFortification";
    if (!isFloor && !isRamp && !stairM && !isFort) return null;
    const m = consMaterial(base_mt, base_mi);
    if (!m) return null;
    let token = null, palRow = null, mask = 0, multiplyRgb = null;
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
      const kind = (stairM[1] === "UD") ? "UPDOWN" : (stairM[1] === "U") ? "UP" : "DOWN";
      token = "PALETTE_STAIR_" + kind;
      palRow = m.palRow;
    } else {
      const prefix = (m.family === "WOOD") ? "FORTIFICATION_WOOD" : "FORTIFICATION";
      token = fortificationOpenToken(prefix, typeof openMask === "number" ? openMask : 0);
      palRow = m.palRow;
    }
    if (!token) return null;
    return { token: token, palRow: palRow, mask: mask, multiplyRgb: multiplyRgb };
  }
  function resolveConstructionFloor(t, gx, gy) {
    let openMask = 0;
    if ((t.ttname || "") === "ConstructedFortification") {
      const Adj = window.DwfAdjacency;
      if (Adj && typeof gx === "number" && typeof gy === "number") openMask = Adj.computeMask8(tileAt, gx, gy, Adj.isOpenNeighbor);
    }
    const plan = constructionFloorPlan(t.ttname || "", t.base_mt, t.base_mi, openMask);
    if (!plan) return null;
    const token = plan.token, palRow = plan.palRow;
    const entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
    if (!entry || !entry.sheet) return null;
    const sh = getSheet(entry.sheet);
    if (!sh || !sh.loaded || sh.failed) return null;
    const base = { img: sh.img, col: entry.col, row: entry.row, tint: null, overlay: null, multiplyRgb: plan.multiplyRgb || null, multiplySheet: entry.sheet };
    if (typeof palRow === "number") { base.palRow = palRow; base.paletteSheet = entry.sheet; }
    const mask = plan.mask;
    if (mask) {
      const rc = DESIG_TRACK_CELL[mask];
      const rs = rc && getSheet(DESIG_SHEET);
      if (rc && rs && rs.loaded && !rs.failed) base.overlay = { img: rs.img, col: rc[0], row: rc[1] };
    }
    return base;
  }

  // B273 natural terrain classes whose DF graphics flags carry a material color index. Natural
  // rough floors/stairs/ramps are intentionally absent: their installed sheets contain zero
  // default-palette pixels and are authored as-is. Boulder, pebble, and carved-fortification art
  // is 72-100% palette pixels, so exact substitution recolors the material while retaining fixed
  // painted highlights.
  function terrainSpritePalRow(t, token) {
    if (!t || (token !== "BOULDER" && token !== "FORTIFICATION" &&
      !/^PEBBLES_FLOOR_/.test(token || ""))) return null;
    const mat = t.mat || "";
    if (mat !== "STONE" && mat !== "MINERAL") return null;
    const m = consMaterial(t.base_mt, t.base_mi);
    return m && typeof m.palRow === "number" ? m.palRow : null;
  }

  // Resolve a tile to a loaded sprite cell (+ optional tint, + optional overlay), or null
  // to fall back to tileColor(). Translation is ttname -> token (tiletypeTokenMap) -> cell
  // (spriteMap). Hidden tiles are deliberately excluded so they keep the existing dark/
  // undiscovered treatment instead of showing the real terrain sprite underneath. gx/gy
  // (grid position) are only used by the grass fallback below, for a stable variant hash.
  //
  // WB-3 base+overlay composite: stone/soil floor variant digits (ttname "SoilFloor2" etc)
  // map to a DENSE, opaque base cell (e.g. STONE_FLOOR_5/DIRT_FLOOR_5) plus an `overlay`
  // token naming DF's real per-variant detail cell (e.g. STONE_FLOOR_2). That overlay cell
  // is genuinely near-transparent art (floors.png measured mean alpha ~5-20/255 on _1..4 vs
  // 255 on _5) -- a DIRECT swap to the bare variant cell was tried and regressed U2 parity
  // ~32->37 MAE (floors went nearly blank); DF itself composites the dense base THEN the
  // sparse per-tile detail on top, which is what drawTileComposite's caller now reproduces.
  // B119: all natural soil/sand floors have SoilFloor<n> tiletypes, so the offline
  // tiletype map cannot distinguish them. base_mt/base_mi is already on every tile; join its
  // inorganic id against material_map and select DF's authored sand_floor.png row before the
  // grass-under fallback can turn sand into lawn.
  function sandFloorPlan(t, ttname) {
    if (!t || t.base_mt !== 0 || !/^SoilFloor[1-4]$/.test(ttname || "")) return null;
    const ino = materialMap && materialMap.inorganic && materialMap.inorganic[t.base_mi];
    const m = ino && /^SAND_(TAN|YELLOW|WHITE|BLACK|RED)$/.exec(ino.id || "");
    if (!m) return null;
    const prefix = m[1] === "TAN" ? "SAND" : "SAND_" + m[1];
    const v = ((/([1-4])$/.exec(ttname) || [null, "1"])[1]);
    return { token: prefix + "_FLOOR_5", overlay: prefix + "_FLOOR_" + v };
  }

  function resolveSprite(t, gx, gy) {
    if (t.hidden) return null;
    const ttname = t.ttname;
    if (!ttname) return null;
    // B36: a WALL's terrain art is owned ENTIRELY by the darkened base-color fill (DF's dark
    // wall interior) plus drawWallJoin's adjacency-aware directional edge cell. Never stamp
    // the PHASE-1 full-block token (SOIL_WALL_N_S_W_E_1 for every wall) underneath -- that flat
    // block on every tile is exactly the "evenly-tiled solid blocks" B36 reports. FORTIFICATION
    // is a distinct shape and keeps its own full cell via the token map below.
    if ((t.shape || "") === "WALL") return null;
    const sandPlan = sandFloorPlan(t, ttname);
    if (sandPlan) {
      const base = resolveCell(sandPlan.token);
      if (base) { base.overlay = resolveCell(sandPlan.overlay); return base; }
    }
    // WC-17 wire grass, REDUCED to the worn-bare gate only (2026-07-07 grass-escalation,
    // the "multicolor patchwork" report): the amount->tier cell pick + per-species
    // grass_colors.json tint that used to live here were verified WRONG against DF's own
    // render (raw-oracle ground truth at a live grassy camera):
    //   (a) tint tier order INVERTED -- grass_colors.json tiers mirror the raw
    //       [GRASS_COLORS:...] triple order, which is DF's graze-STATE order
    //       (state 0 = lush LGREEN ... state 3 = depleted BROWN), while grassTierIndex()
    //       maps HIGH amount -> index 3, so a healthy lawn (live amounts: 93% >= 100)
    //       painted the dead/brown color and worn paths painted neon LGREEN;
    //   (b) thresholds assumed amount <= 100 but live wire amounts run 5..251;
    //   (c) decisive: DF PREMIUM GRAPHICS DON'T TINT GRASS BY SPECIES AT ALL --
    //       GRASS_COLORS is ASCII/console-mode data; the native render at the same camera
    //       shows uniform grass.png-family art for 9 interleaved species at amounts
    //       25..251 (all 41 vanilla species share the same 4 grass.png cells, and the
    //       oracle crops show no per-tile species/state color variation whatsoever).
    // So a grass-mat tile with coverage falls THROUGH to the ttname->token path below
    // (GRASS_1..4 variant + the oracle-calibrated grassSummer wash -- the parity-proven
    // pre-WC-17 look). Only DF's real "worn bare" signal is kept from the wire tail.
    // grassTierIndex/grassSpeciesTint remain exported as pure helpers for a FUTURE
    // oracle-calibrated wear treatment (see the grass-escalation ledger entry), but are
    // deliberately not applied to the live render until calibrated against the oracle.
    // B241 ("limestone pebbles don't render at all"): the old B37 arm here
    // (`bareExteriorPebble`) forced the grass + SPARSE-speckle composite onto EVERY outside
    // *Pebbles tile that carried no grass tail -- and the wire NEVER ships a grass tail for
    // pebble tiles at all (src/wire_v1.cpp gates grass_under_floor on shape==FLOOR;
    // StonePebbles* is shape PEBBLES, static.enums.inc), so every outside pebble floor
    // rendered as plain lawn with 6-140 opaque px of speckle: invisible. Deleted. A pebble
    // tile with no (positive) grass tail now falls through to the token map's DENSE pebble
    // art (PEBBLES_FLOOR_5/5B/5C/5D by the tiletype's own VAR digit -- all four fully
    // opaque, measured 1024/1024). The grass-covered arm below is unchanged (B92-verified);
    // it starts firing for pebbles once the DLL-gated wire fix ships grass tails for
    // PEBBLES/BOULDER shapes. Worn-bare (amount<=0) keeps its flat-color meaning ONLY for
    // grass-material tiles -- on any other tile a zero tail just means "no grass here",
    // never "suppress the tile's own floor art".
    const isGrassMat = !!(t.mat && t.mat.indexOf("GRASS_") === 0);
    if (t.grass && t.grass.amount <= 0 && isGrassMat) return null; // worn bare grass -> flat
    // Grass-under compositing (grass-escalation stage 2, the "phantom stone" report):
    // the same oracle ground truth showed DF drawing grass coverage OVER non-grass
    // surface floors -- StonePebbles* renders as its SPARSE pebble variant cell
    // (PEBBLES_FLOOR_1..4, 6-140 opaque px of 1024) on top of grass, and SoilFloor*
    // renders as plain grass -- while the client drew bare dense gravel
    // (PEBBLES_FLOOR_5, fully opaque) / bare dirt there. The server now sends the GRASS
    // tail for EVERY outside non-grass FLOOR with a positive-amount event (wire_v1.cpp's
    // widened gate: grass_amt>0 && shape==FLOOR && outside -- NOT limited to any tiletype).
    // B92 ("dense zoysia/satintail render as pebbles"): the original whitelist matched only
    // StonePebbles, so grass growing over the THREE mechanically-identical sibling detailed-
    // stone floors -- MineralPebbles / LavaPebbles / FeaturePebbles (all four are DF's single
    // "detailed stone rubble floor" family; tiletype_token_map maps every one to PEBBLES_FLOOR_5
    // when bare) -- fell through to that bare opaque gravel cell. The reported tiles hover as a
    // grass species (zoysia/satintail are ordinary vanilla grasses, plant_grasses.txt, that
    // render on the standard grass.png cells) yet drew gray pebbles. Extend the pebble arm to
    // the whole *Pebbles family with the SAME proven sparse-pebble-over-grass composite; SoilFloor
    // stays plain grass. Anything outside the family (boulders/ramps/rough StoneFloor/etc) still
    // keeps its normal art -- never blank a tile we don't know how to composite.
    if (t.grass && t.grass.amount > 0 && !isGrassMat) {
      const under = /^(?:SoilFloor[1-4]|(?:Stone|Mineral|Lava|Feature)Pebbles([1-4]))$/.exec(ttname);
      if (under) {
        const cell = grassFallbackCell(gx, gy);
        if (cell) {
          cell.tint = "grassSummer";
          if (under[1]) {
            const pebbleToken = "PEBBLES_FLOOR_" + under[1];
            cell.overlay = resolveCell(pebbleToken);
            const pebbleRow = terrainSpritePalRow(t, pebbleToken);
            if (cell.overlay && typeof pebbleRow === "number") {
              cell.overlay.palRow = pebbleRow;
              const pe = TOKEN_CELL_OVERRIDE[pebbleToken] || (spriteMap && spriteMap[pebbleToken]);
              cell.overlay.paletteSheet = pe && pe.sheet;
            }
          }
          return cell;
        }
        // grass.png not loaded yet -- fall through to the normal ttname art for one frame.
      }
    }
    // B47: a constructed floor/track carries its built-from material on the wire -> DF's
    // material floor art + per-material palette color (the offline token map is material-blind
    // and would draw grey FLOOR_STONE_BLOCK for every material). Checked before the token-map
    // path so the material sheet wins; null (no wire material) falls through to the stone default.
    const consCell = resolveConstructionFloor(t, gx, gy);
    if (consCell) return consCell;
    const map = spriteMap && tiletypeTokenMap && tiletypeTokenMap[ttname];
    if (map && map.token) {
      // Override wins over the (sometimes mis-bound) server sprite map; getSheet loads
      // any referenced sheet on demand (grass.png isn't in map.json, so preload never
      // saw it).
      const base = resolveCell(map.token);
      if (!base) return null;
      // B241: BOULDER fans out to its 8 authored variant cells (see boulderVariant).
      if (map.token === "BOULDER") {
        const bv = boulderVariant(t, gx, gy);
        if (bv) { base.col = bv.col; base.row = bv.row; }
      }
      const terrainPalRow = terrainSpritePalRow(t, map.token);
      if (typeof terrainPalRow === "number") {
        base.palRow = terrainPalRow;
        const paletteEntry = TOKEN_CELL_OVERRIDE[map.token] || spriteMap[map.token];
        base.paletteSheet = paletteEntry && paletteEntry.sheet;
      }
      const overlay = map.overlay ? resolveCell(map.overlay) : null;
      base.tint = map.tint || null;
      base.overlay = overlay;   // null when absent/unloaded -- caller checks before blitting
      return base;
    }
    // No usable token-map entry: only decide "this ttname is legitimately
    // uncovered" once tiletypeTokenMap has actually loaded (so we don't flash
    // the fallback for every tile during the brief window before the fetch
    // resolves -- same load-order guard the original code had via the
    // `!tiletypeTokenMap` bailout above).
    if (tiletypeTokenMap && looksLikeGrassFloor(ttname)) return grassFallbackCell(gx, gy);
    return null;
  }

  // Draw a resolved terrain layer with the same pre-composite palette semantics as the base
  // sprite. Used by sparse pebble-over-grass so material color changes the pebble pixels
  // themselves; it never adds a color layer above transparent sprite pixels.
  function drawResolvedTerrainCell(resolved, px, py, cell) {
    if (!resolved) return false;
    if (typeof resolved.palRow === "number" && resolved.paletteSheet) {
      const swapped = paletteSwappedCell(resolved.paletteSheet, resolved.col, resolved.row, resolved.palRow);
      if (swapped) {
        const sm = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(swapped, 0, 0, 32, 32, px, py, cell, cell);
        ctx.imageSmoothingEnabled = sm;
        return true;
      }
    }
    ctx.drawImage(resolved.img, resolved.col * 32, resolved.row * 32, 32, 32, px, py, cell, cell);
    return true;
  }

  // ============================================================================
  // MEASURED SEE-DOWN FOG (docs/reference/fogparams.json `seeDown`, sweep #2,
  // 2026-07-07). The owner reported real bluish depth haze looking down into a valley that
  // BOTH capture oracles (/frame.jpg and /tiledump) miss entirely -- DF applies this tint
  // in its screen-space present pass, downstream of where either oracle reads. Fitted
  // live against the real DF window (PrintWindow captures, camera (53,75), window_z
  // swept 161..170): two materials with very different base colors (grass, stone rubble)
  // converge to the SAME asymptotic color regardless of base -- a material-independent
  // screen-space alpha overlay, confirmed non-per-sprite. This supersedes the OLD
  // "identity/delete" verdict (fogparams.json `seeDown.supersededVerdict`): that verdict's
  // OWN evidence (both capture paths substitute see-down tiles at full brightness) is
  // still true and unrelated -- it just doesn't describe what the real window shows.
  //
  // fogColorRgb (88,138,158) is the fitted asymptotic color. The measured alpha-by-depth
  // table (fogparams.json `alphaByDepth`) is concave/saturating, NOT linear through the
  // origin -- but depths 1..7 fit a plain line (y = FOG_ALPHA_INTERCEPT + d*FOG_ALPHA_RATE)
  // to within ~0.004 alpha (least squares on the 7 measured points; verified in
  // tools/harness/gl_core_test.mjs and this file's own fog test hook), clipping to 1.0 at
  // depth>=8 same as the measured table. This is a re-expression of the SAME fit, not a
  // new curve -- kept here as the canvas2d reference implementation the GL shader mirrors.
  const FOG_COLOR = [88, 138, 158];
  const FOG_ALPHA_INTERCEPT = 0.2464;
  const FOG_ALPHA_RATE = 0.1057;
  // QA-only kill switch (window-capture parity scoring, M1 closure): `?nofog=1` forces the
  // see-down wash off so tools/harness/gate_parity.py --oracle window can A/B the fog's
  // CONTRIBUTION to parity (score with fog vs score with fog disabled, same client/camera).
  // Not a product feature -- default is fog ON (params absent -> false).
  const FOG_DISABLED = params.get("nofog") === "1";
  function buildingAlphaForZ(b, cameraZ) {
    const dz = (b && typeof b.z === "number" && typeof cameraZ === "number") ? b.z - cameraZ : 0;
    const seeDown = !!(b && b.sd) && dz < 0;
    if (dz !== 0 && !seeDown) return null;
    return seeDown ? Math.max(0, 1 - fogAlphaForDepth(-dz)) : 1;
  }

  function fogAlphaForDepth(depth) {
    if (FOG_DISABLED) return 0;
    const d = typeof depth === "number" ? depth : 0;
    if (d <= 0) return 0;
    return Math.max(0, Math.min(1, FOG_ALPHA_INTERCEPT + FOG_ALPHA_RATE * d));
  }

  // ============================================================================
  // wire:6 MULTI-Z COMPOSITE. The server sends layers[] (a flat tile plane per z from
  // z_above above the camera down to z_below below). The client composites the stack for
  // the viewer's z: see-below tiles get the measured fog wash above, the camera plane
  // draws at full/no fog. See-above (canopy fog) is DELETED below (fogparams.json
  // `seeAbove.mode: "delete"` -- 24 captures across elevated/forest cameras show DF draws
  // NO above-camera translucent canopy at all; the old alphaAbove/brightnessAbove pass
  // was adding false content, not approximating a real one). Missing layers (culled by
  // the server as empty) are treated as transparent air, so we keep descending.
  // ============================================================================

  // Does this tile let you see THROUGH it (down or up)? EMPTY/NONE/RAMP_TOP shapes and
  // AIR material are open. Used to decide whether the camera column reveals a tile below.
  function isOpenTile(t) {
    if (!t) return true;
    const s = t.shape || "", m = t.mat || "";
    return s === "EMPTY" || s === "NONE" || s === "RAMP_TOP" || m === "AIR";
  }

  // Does a tile ABOVE the camera block the view of the sky (a rock ceiling)? Solid,
  // non-tree terrain blocks; trees/mushrooms/plants and open air never block. This is the
  // "stop at first opaque tile" rule that keeps see-above from revealing indoor tiles.
  function isSkyBlocker(t) {
    if (!t) return false;
    const m = t.mat || "", s = t.shape || "";
    if (m === "TREE" || m === "MUSHROOM") return false;   // canopy: see through
    if (t.plant) return false;
    if (s === "EMPTY" || s === "NONE" || s === "RAMP_TOP" || m === "AIR") return false;
    return true;                                          // solid rock floor/wall: ceiling
  }

  // Should a tile ABOVE the camera be drawn as faded canopy? Tree/mushroom/plant tiles
  // (branch/twig/leaf slices at higher z) are the "you see trees above you" case.
  function isCanopyTile(t) {
    if (!t) return false;
    const m = t.mat || "";
    return m === "TREE" || m === "MUSHROOM" || !!t.plant;
  }

  // Draw ONE tile's full sprite stack (base color + terrain/liquid sprite + spatter/item/
  // plant/tree/wall-join overlays) at (px,py), optionally overlaid with the measured
  // see-down fog wash (`depth` > 0 => blue-teal blend by depth, see fogAlphaForDepth) and/or
  // made translucent by `alpha` (<1; see-above no longer uses this -- kept generic for any
  // future translucent-draw caller). Returns whether anything was drawn. This is the shared
  // per-tile draw used by BOTH the legacy single-plane path and the multi-z composite, so
  // every existing sprite layer keeps working per layer. Never throws (callers guarded).
  function drawTileComposite(t, px, py, cell, gx, gy, depth, alpha) {
    if (!t) return false;
    const a = (typeof alpha === "number") ? alpha : 1;
    const d = (typeof depth === "number") ? depth : 0;
    let saved = false;
    if (a < 1) { ctx.save(); ctx.globalAlpha = a; saved = true; }
    // DF composites each tile as a material-color BASE with the sprite ON TOP (grass/plant
    // tufts are transparent over the colored base). So fill the base color first, then blit.
    // WB-5: undiscovered tiles (true void excepted, tt<0) get the opaque hidden-rock hatch
    // sprite instead of/over the flat HIDDEN_COLOR fallback fill.
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    // WT25: the hatch now also fills in-bounds undiscovered (tt<0) tiles, not just shipped-hidden
    // ones -- see wantsHiddenHatch. v1MapDims is hello_ack's footprint (null pre-hello -> only
    // shipped-hidden hatches, i.e. pre-WT25 behavior). Off-map tt<0 tiles stay black.
    const hiddenSprite = wantsHiddenHatch(t, v1MapDims) ? resolveHiddenSprite(gx, gy) : null;
    const sprite = resolveSprite(t, gx, gy);
    const liquidSprite = resolveLiquidSprite(t);
    const Adj = window.DwfAdjacency;
    const wallOpenMask = (Adj && (t.shape || "") === "WALL" && typeof gx === "number" && typeof gy === "number")
      ? Adj.computeMask8(tileAt, gx, gy, Adj.isOpenNeighbor) : 0;
    // WB-4: when a liquid sprite is actually going to draw, skip tileColor's flat flow-color
    // shortcut so `col` becomes the tile's OWN bed color instead of the fake wash (see
    // tileColor's banner comment).
    const col = tileColor(t, !!liquidSprite);
    let drew = false;
    // B62-r2: tree/mushroom tiles get a borrowed-neighbor GRASS backing instead of the flat
    // wood-tone fill when real grass is adjacent (see grassBackingCell's banner). B241
    // generalizes the slot: BOULDER tiles back their 50-65%-opaque sprite with the tile's
    // TRUE floor (own grass tail > ring-1 borrowed grass > rough stone floor -- see
    // groundBackingCell). Skipped for hidden/liquid tiles -- their base is owned by the
    // hidden hatch / flow color paths -- and, for boulders, when the BOULDER sprite itself
    // did not resolve (a floor with no rock on it would be worse than the flat fill).
    let grassBacked = false;
    if (col !== null && !t.hidden && !hiddenSprite && !liquidSprite) {
      const wallBackToken = wallBackingToken(t, gx, gy, wallOpenMask);
      const wallBack = wallBackToken && spriteMap && spriteMap[wallBackToken];
      if (wallBack && wallBack.sheet && blitCell(wallBack.sheet, wallBack.col, wallBack.row, px, py, cell)) {
        grassBacked = true;
        drew = true;
      }
      const gb = !grassBacked && ((t.shape || "") !== "BOULDER" || sprite)
        ? groundBackingCell(t, gx, gy) : null;
      if (!grassBacked && gb && blitCell(gb.sheet, gb.col, gb.row, px, py, cell)) {
        if (gb.wash) {
          ctx.fillStyle = TINT_COLORS.grassSummer;
          ctx.fillRect(px, py, cell, cell);
        }
        grassBacked = true;
        drew = true;
      }
    }
    if (col !== null && !grassBacked) {
      ctx.fillStyle = rgbStr(col);
      ctx.fillRect(px, py, cell, cell);
      drew = true;
    } else if (hiddenSprite && col === null && !grassBacked) {
      // WT25 base-hatch backdrop: an in-bounds undiscovered (tt<0) tile has no tileColor, so back
      // the opaque hatch with HIDDEN_COLOR -- exactly the fill the shipped-and-hidden path gets
      // (col===HIDDEN_COLOR) -- so a transparent hatch pixel never bleeds the black void through.
      ctx.fillStyle = rgbStr(HIDDEN_COLOR);
      ctx.fillRect(px, py, cell, cell);
      drew = true;
    }
    if (hiddenSprite) {
      ctx.drawImage(hiddenSprite.img, hiddenSprite.col * 32, hiddenSprite.row * 32, 32, 32, px, py, cell, cell);
      drew = true;
    } else if (liquidSprite) {
      // WB-4 liquid fix (fog report §1/§4.6): draw the tile's OWN terrain sprite first (DF
      // composites the authored depth cell OVER the substituted bed tile, per WB-9's own
      // "liquids: authored depth cells over the bed tile" description) -- no extra tint on
      // top; the depth cell's own authored alpha is the whole "shallow water shows the bed
      // through" effect (fog report: a d7 pond renders as the raw cell, nothing more).
      if (sprite) {
        ctx.drawImage(sprite.img, sprite.col * 32, sprite.row * 32, 32, 32, px, py, cell, cell);
        // sprite.tint is normally a TINT_COLORS KEY (e.g. "grassSummer"); WC-17 also
        // allows a literal CSS color string (per-species grass_colors.json rgba) --
        // resolve the key first, fall back to the value itself if it isn't one.
        const bedTint = sprite.tint && (TINT_COLORS[sprite.tint] || sprite.tint);
        if (bedTint) {
          ctx.fillStyle = bedTint;
          ctx.fillRect(px, py, cell, cell);
        }
        if (sprite.overlay) drawResolvedTerrainCell(sprite.overlay, px, py, cell);
      }
      // TX2: native composites water/magma over contaminants on the bed. Material spatter
      // therefore belongs below the authored translucent liquid depth cell on flooded tiles.
      drawSpatter(t, px, py, cell, gx, gy);
      ctx.drawImage(liquidSprite.img, liquidSprite.col * 32, liquidSprite.row * 32, 32, 32, px, py, cell, cell);
      if (drawLiquidEdges(t, px, py, cell, gx, gy)) drew = true;
      drew = true;
    } else if (sprite) {
      // B47: a construction floor/track cell carries palRow+paletteSheet -> the per-material
      // palette swap (native recolors DF's default-palette floor sheet by the material's row).
      // The swap is exact (these sheets are 100% default-palette); a transient miss (sheet still
      // decoding) draws the un-swapped cell for one frame, never blank.
      let cdrew = false;
      if (typeof sprite.palRow === "number" && sprite.paletteSheet) {
        const sw = paletteSwappedCell(sprite.paletteSheet, sprite.col, sprite.row, sprite.palRow);
        if (sw) {
          const sm = ctx.imageSmoothingEnabled;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sw, 0, 0, 32, 32, px, py, cell, cell);
          ctx.imageSmoothingEnabled = sm;
          cdrew = true;
        }
      }
      if (!cdrew && sprite.multiplyRgb && sprite.multiplySheet) {

        const mtc = multiplyTintedCell(sprite.multiplySheet, sprite.col, sprite.row, sprite.multiplyRgb);

        if (mtc) {

          const sm = ctx.imageSmoothingEnabled;

          ctx.imageSmoothingEnabled = false;

          ctx.drawImage(mtc, 0, 0, 32, 32, px, py, cell, cell);

          ctx.imageSmoothingEnabled = sm;

          cdrew = true;

        }

      }

      if (!cdrew) ctx.drawImage(sprite.img, sprite.col * 32, sprite.row * 32, 32, 32, px, py, cell, cell);
      // sprite.tint is normally a TINT_COLORS KEY; WC-17's per-species grass tint is a
      // literal CSS rgba() string instead (see grassSpeciesTint) -- resolve the key
      // first, fall back to the value itself if it isn't a known key.
      const tintColor = sprite.tint && (TINT_COLORS[sprite.tint] || sprite.tint);
      if (tintColor) {
        // WB-4: plain alpha blend (canvas default source-over), NOT "multiply" -- the
        // calibrated summer wash BRIGHTENS toward the measured target vs the sheet base,
        // which a multiply blend can never do (see TINT_COLORS comment for the derivation).
        ctx.fillStyle = tintColor;
        ctx.fillRect(px, py, cell, cell);
      }
      // WB-3 base+overlay composite: blit the per-variant detail cell (near-transparent
      // art -- floors.png's _1..4 measured mean alpha ~5-20/255) ON TOP of the dense base
      // just drawn, reproducing DF's own per-tile variant texture without ever losing the
      // opaque fill (a bare swap to the sparse cell alone regressed parity -- see the
      // resolveSprite comment).
      if (sprite.overlay) drawResolvedTerrainCell(sprite.overlay, px, py, cell);
      drew = true;
    } else if (col !== null) {
      const shape = t.shape || "";
      if (isStairOrRamp(shape) && cell >= 3) {
        ctx.strokeStyle = "rgb(220,220,220)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 0.5, py + 0.5);
        ctx.lineTo(px + cell - 0.5, py + cell - 0.5);
        ctx.moveTo(px + cell - 0.5, py + 0.5);
        ctx.lineTo(px + 0.5, py + cell - 0.5);
        ctx.stroke();
      }
    }
    // Per-tile overlay stack (shadow-decal < spatter < item < plant < tree < wall-join),
    // skipped for undiscovered tiles -- same order/guards as before, now per composited
    // layer. WB-7: the shadow decal goes FIRST (right after terrain, before spatter) -- the
    // layer slot DF's own render uses (fog report §1/§4.3).
    if (drew && overlaysAllowed(t)) {
      drawShadowDecals(t, px, py, cell, gx, gy);
      if (!liquidSprite) drawSpatter(t, px, py, cell, gx, gy);
      drawItemSpatterLitter(t, px, py, cell, gx, gy);
      drawItem(t, px, py, cell);
      drawItemMark(t, px, py, cell);   // WC-19: forbid/dump/melt glyph over a marked ground item
      drawVermin(t, px, py, cell, gx, gy);  // WC-21: vermin/colony sprite (creatures_map race cell)
      drawPlant(t, px, py, cell);
      drawTree(t, px, py, cell, gx, gy);
      drawWallJoin(t, px, py, cell, gx, gy, wallOpenMask);
      // WC-18: engraving decoration is drawn LAST -- it's an overlay ON the resolved
      // wall/floor art (DF composites the engraving decoration over the finished wall
      // join / floor cell, not under it).
      drawEngraving(t, px, py, cell, gx, gy);
    }
    // MEASURED SEE-DOWN FOG: a see-below tile (d>0) gets DF's real screen-space blue-teal
    // haze blended on top, per fogAlphaForDepth (fogparams.json `seeDown`). Replaces the old
    // fictional flat-black "brightness" wash -- the real thing is a COLOR overlay, not a
    // multiply-darken (fitted jointly across two very different base materials that both
    // converged to the same asymptotic color, proof it's not a per-sprite recolor).
    // INDOOR/UNDERGROUND AMBIENT WASH: DELETED (fogparams.json `indoor.mode: "identity"`,
    // `washRgba` all-zero) -- 158 subterranean floor samples measured a rendered/sprite ratio
    // of ~1.0 and an A/B on an all-dug scene showed removing the rgba(8,10,34,0.17) wash
    // improved MAE 16.71->13.78. DF applies no indoor darkening; this branch used to add one.
    if (drew && d > 0) {
      const fa = fogAlphaForDepth(d);
      if (fa > 0) {
        ctx.fillStyle = `rgba(${FOG_COLOR[0]},${FOG_COLOR[1]},${FOG_COLOR[2]},${fa})`;
        ctx.fillRect(px, py, cell, cell);
      }
    }
    if (saved) ctx.restore();
    return drew;
  }

  // Composite the multi-z stack for one viewport, cell by cell (analysis C.2). byDz maps a
  // dz offset -> that layer's tiles[]; cam is the camera plane (dz 0 / top-level tiles).
  // `maxUp` is accepted (still computed by the caller from layers[]) but no longer used here
  // -- see-above is a deletion, not a fade (below).
  function renderComposite(byDz, maxUp, maxDown, cam, gw, gh, cell, n, iStart, iEnd) {
    // F1 keep-warm may bound the loop to a row band [iStart, iEnd); a full paint passes 0..n.
    const _s = (iStart | 0), _e = (iEnd == null ? n : (iEnd | 0));
    for (let i = _s; i < _e; i++) {
      const gx = i % gw, gy = (i - gx) / gw;
      const px = gx * cell, py = gy * cell;
      try {
        const ct = cam[i];
        // (1) SEE-BELOW: if the camera tile is open (and discovered), descend to the first
        // solid/liquid tile below and draw it with the MEASURED see-down fog wash for its
        // depth (fogAlphaForDepth -- see the banner above isOpenTile). Drawn BEFORE the
        // camera plane so a solid camera tile (drawn next) correctly occludes it.
        if (ct && !ct.hidden && isOpenTile(ct)) {
          for (let d = 1; d <= maxDown; d++) {
            const arr = byDz[-d];
            if (!arr) continue;               // culled/empty layer: keep descending
            const bt = arr[i];
            if (!bt) continue;
            if (isOpenTile(bt) && !(bt.flow > 0)) continue;   // still open air: go deeper
            drawTileComposite(bt, px, py, cell, gx, gy, d, 1);
            break;                            // stop at the first solid/liquid we can see
          }
        }
        // (2) CAMERA PLANE at full brightness, no fog (depth 0). An open camera tile draws
        // nothing (its color is null), letting the see-below tile show; a solid one covers
        // the below tile.
        if (ct) drawTileComposite(ct, px, py, cell, gx, gy, 0, 1);
        // (3) SEE-ABOVE: DELETED (fogparams.json `seeAbove.mode: "delete"` -- top_shadow,
        // signpost, tree_plus_one, shadow_tree layers all measured ZERO in every scene
        // incl. forest and elevated cameras; canopy renders only as camera-plane slices).
        // DF draws no above-camera translucent canopy; the old alphaAbove/brightnessAbove
        // pass was adding false content that isn't in the real render at all -- not
        // approximating a real-but-differently-shaped one, so there is no curve to fit
        // here (unlike see-below). isSkyBlocker/isCanopyTile are kept (unused here now) --
        // WB-10's GL descent reuses them as cache-query predicates.
      } catch (_) { /* per-cell guarded: one bad cell never blanks the map */ }
    }
  }

  // ---- wire:3 extra layer maps (items/plants/trees/buildings/creatures) ----------
  // Each is fetched once at boot; a missing/failed fetch just leaves the map null and
  // that whole layer silently falls back (never blank, never throws). Sprite SHEETS
  // referenced by these maps load on demand through the existing getSheet() (which
  // hits /sprites/img/<file>); the baked civ PNGs load via getBaked() from web root.
  let itemMap = null;       // v2: { bytype:{TYPE:{sheet,col,row}}, bytoken:{TOKEN:{...}},
                            //       matvariants:{Base:{WOOD|STONE|METAL|GLASS:{...}}},
                            //       web:{harmless:[4 cells],thick:[4 cells]}, _missing, _v:2 }
  let plantMap = null;      // { id: {SHRUB|SAPLING:{...}}, _default_shrub, _default_sapling }
  let treeMap = null;       // { species: {PART:{...}}, _default:{PART:{...}} }
  let buildingMap = null;   // { "Type:Subtype"|TOKEN : {sheet,w,h,cells}|{sheet,col,row}, _default }
  let creaturesMap = null;  // { cell, races: { RACE: {sheet,col,row}|{layered,baked} } }
  // T1a/T1c (asset-material-parity-spec 2026-07-08): material identity + palette-swap table.
  //   { _v, palette:{rows:[[r,g,b]x18]x137, byname:{}}, default_row:[[r,g,b]x18],
  //     inorganic:[{id,row,family,value,gem} x265], builtin:{"3":{row,family},...},
  //     plant:{TOKEN:{WOOD:row,...}}, creature_generic:{BONE:row,...} }
  // Absent/failed fetch => every item resolves EXACTLY as before (strictly additive layer).
  let materialMap = null;
  let spatterMap = null;    // WC-12: { families:{FAM:{sheet,cells:{SHAPE:{col,row}}}},
                            //          amount_thresholds_default:[{max,shape}], blood_families:[...],
                            //          growth_class_family:{"0".."4":FAM}, builtin_material_hints:{...} }
  let overlayMap = null;    // WC-19: { designation_priority:{"1".."7":{sheet,col,row}},
                            //          designation_item:{DESIGNATION_ITEM_*:{sheet,col,row}}, ... }

  // WC-1/WC-3: (item_type STRING, subtype) -> raw itemdef token (e.g. "ITEM_WEAPON_PICK"),
  // fed once per connection by the v1 ITEMDEF_DICT message (dwf-ws.js's onItemDefDict).
  // Legacy JSON sessions and any v1 session before the dict arrives simply have this stay
  // null -- item resolution then skips straight to the bytype/matvariants/missing chain
  // below (never blocks, never throws).
  let itemDefTokens = null; // Map<"TYPE:subtype", token>
  // B256: numeric df::item_type ordinal -> its STRING key ("AMMO", "WEAPON", ...), from the
  // server's GET /item_type_meta.json (http_server.cpp build_item_type_meta_json, WA-5). The
  // client has fetched this table since WA-12 but only ever handed it to the CACHE WORKER (which
  // needs it to give v1-ingested tile items the string-keyed shape itemMap expects) -- the
  // RENDERER never kept a copy. That is the missing hop behind B256: the AUX projectile wire
  // ships a NUMERIC item_type (world_stream.cpp:1967) and drawProjectiles could not turn it into
  // the "AMMO" key resolveItemVisual needs, so it drew a placeholder dot instead of the bolt.
  let itemTypeNames = null; // Map<number, "TYPE">
  function applyItemTypeMeta(list) {
    try {
      const m = new Map();
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (Array.isArray(r) && r.length >= 2 && typeof r[0] === "number" && r[1]) m.set(r[0], r[1]);
        }
      }
      itemTypeNames = m;
      // The cache/worker ingest still needs the same table (WA-12); one fetch, both consumers.
      if (window.DwfCache && typeof DwfCache.setItemTypeMeta === "function") {
        DwfCache.setItemTypeMeta(list);
      }
      draw();
    } catch (_) { /* table stays whatever it was -- projectiles just keep the marker */ }
  }
  // subcat index -> df::item_type enum key, EXACT order of DFHack's Items.cpp ITEMDEF_VECTORS
  // macro (src/wire_v1.h's own table, mirrored here since the wire only carries the numeric
  // subcat index): 0 WEAPON 1 TRAPCOMP 2 TOY 3 TOOL 4 INSTRUMENT 5 ARMOR 6 AMMO 7 SIEGEAMMO
  // 8 GLOVES 9 SHOES 10 SHIELD 11 HELM 12 PANTS 13 FOOD.
  const ITEMDEF_SUBCAT_TYPE = ["WEAPON", "TRAPCOMP", "TOY", "TOOL", "INSTRUMENT", "ARMOR", "AMMO",
    "SIEGEAMMO", "GLOVES", "SHOES", "SHIELD", "HELM", "PANTS", "FOOD"];
  function handleItemDefDictV1(subcats) {
    try {
      const m = new Map();
      if (Array.isArray(subcats)) {
        for (let i = 0; i < subcats.length; i++) {
          const sc = subcats[i];
          const typeName = ITEMDEF_SUBCAT_TYPE[sc.subcat];
          if (!typeName || !Array.isArray(sc.entries)) continue;
          for (let j = 0; j < sc.entries.length; j++) {
            const e = sc.entries[j];
            if (e && typeof e.id === "number" && e.token) m.set(typeName + ":" + e.id, e.token);
          }
        }
      }
      itemDefTokens = m;
      draw();
    } catch (_) { /* dict stays whatever it was -- resolution just skips the bytoken step */ }
  }

  // ---- WE-4: per-unit baked composite sprite (appearance-hash -> PNG), fallback chain ----
  // Content-addressed at /unit-sprite/<hash>.png (immutable, WE-2's Cache-Control: max-age=1y
  // -- fetch once per hash, ever). Fed by the AUX wire's "ah"/"sw"/"sh"/"ax"/"ay" fields
  // (WE-3, emitted identically by the legacy JSON aux/units array and the v1 AUX message --
  // both share world_stream.cpp/tile_map_dump.cpp's emit_units body), so this needs no
  // protocol branching. A changed appearance always mints a different hash (WE-2: "refetch once
  // per NEW hash"); a SAME-hash 404 is transient, not permanent -- see the heal note next.
  // AH-DEFECT client heal (live report 07-09): a hash 404s when the server has NOT baked the
  // composite yet -- DF only fills texpos_currently_in_use once the unit RENDERS host-side, so a
  // unit first seen before it is drawn has no composite, and the window #10 worker re-enqueues the
  // bake seconds-to-minutes later. This map USED to stamp `failed=true` and keep the entry FOREVER,
  // so a portrait first referenced pre-bake showed the yellow-dot fallback until a full page reload
  // dropped the cache -- exactly the reported symptom. Now a failed entry records `failedAt` and,
  // on the next reference past UNIT_SPRITE_RETRY_MS, is dropped so a fresh Image re-requests (the
  // bake may have landed since). `onload -> draw()` is the repaint hook that fills the portrait in
  // the instant a retry succeeds -- no reload. A genuinely-permanent 404 just re-requests once every
  // few seconds WHILE the unit is on screen, which is cheap and stops when it scrolls off.
  const UNIT_SPRITE_RETRY_MS = 3000;
  const unitSpriteImgs = Object.create(null); // hash -> {img, loaded, failed, failedAt}
  let unitSpriteRetryTimer = null;
  function scheduleUnitSpriteRetry() {
    // Idle guard (perfhitch rule): keep at most ONE armed timer. It fires a single draw() after the
    // backoff; that draw re-references every on-screen unit via getUnitSprite(), re-requesting any
    // whose backoff has elapsed. A still-missing one re-arms through its own onerror; once every
    // visible portrait has resolved (or none reference a missing hash) nothing re-arms -- zero
    // further wakeups.
    if (unitSpriteRetryTimer !== null) return;
    unitSpriteRetryTimer = setTimeout(() => { unitSpriteRetryTimer = null; draw(); }, UNIT_SPRITE_RETRY_MS);
  }
  function getUnitSprite(hash) {
    let e = unitSpriteImgs[hash];
    if (e && e.failed && (Date.now() - e.failedAt) >= UNIT_SPRITE_RETRY_MS) {
      delete unitSpriteImgs[hash]; // drop the negatively-cached miss; the old Image is abandoned
      e = null;
    }
    if (!e) {
      e = unitSpriteImgs[hash] = { img: new Image(), loaded: false, failed: false, failedAt: 0 };
      e.img.onload = () => { e.loaded = true; draw(); };
      e.img.onerror = () => { e.failed = true; e.failedAt = Date.now(); scheduleUnitSpriteRetry(); };
      e.img.src = "/unit-sprite/" + hash + ".png";
    }
    return e;
  }
  // Pure tier-selection (WE-4's fallback chain), separated from the actual drawImage calls so
  // it's independently testable (same convention as `resolveItemEntry`/`buildingEntry`):
  // returns {tier:1, sprite} | {tier:3, rec} | {tier:4, rec} | {tier:5} -- never throws, never
  // touches the canvas. `races` is creaturesMap.races (passed in so the caller's existing
  // per-frame lookup isn't duplicated).
  function resolveUnitTier(u, races) {
    if (u.ah && typeof u.sw === "number" && typeof u.sh === "number") {
      const usp = getUnitSprite(u.ah);
      if (usp.loaded && !usp.failed) return { tier: 1, sprite: usp };
      // tier 2 (fetch in flight / 404): fall through, but the fetch was already kicked off.
    }
    const rec = races && u.rt && races[u.rt];
    if (rec && rec.sheet && typeof rec.col === "number") return { tier: 3, rec: rec };
    if (rec && (rec.layered || rec.baked)) return { tier: 4, rec: rec };
    return { tier: 5 };
  }

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
  // V1 status-bubble ladder -- reordered to the NATIVE graphics-mode overhead selector's own code
  // order (FUN_1402685d0; predicate-table PRIORITY section, sel:35-284). Native shows ONE bubble
  // though the wire carries every active bit, and the ORDER of the code's checks IS the priority
  // (top wins). The bit->row map below is byte-identical to dwf-gl.js -- only the check order
  // changed. Native tiers, top-down:
  //   1  SLEEPING(8)
  //   (2 YIELDING(32) -- v1 non-goal, server never sets it, no bit here)
  //   3  UNCONSCIOUS(30)
  //   4  PARALYZED>=100(26)
  //   5  performance walk: TELLING_A_STORY(34) RECITING_POETRY(35) PERFORMING(36) MAKE_BELIEVE(33)
  //   6  WRESTLING(23)
  //   7  NAUSEA(28)
  //   8  STUNNED|dizzy(27)
  //   9  WINDED(29)
  //   10 MAJOR_INJURY(25)
  //   11 MINOR_INJURY(24)
  //   12 FEVERED(31)
  //   13 sane-citizen needs: THIRSTY(4) > HUNGRY(3) > DROWSY(5) > STRESSED(6) > DISTRACTED(7)
  //   14 soldier-mood switch: MARTIAL_TRANCE(21) ENRAGED(20) TANTRUM(14) DEPRESSION(16) OBLIVIOUS(15)
  //   15 sane-citizen idle: NO_JOB(1) NO_DESTINATION(2)
  //   16 strange-mood switch: BERSERK(19) MADNESS(17) MELANCHOLY(18) STRANGE_MOOD(9-13),
  //      default -> TERRIFIED(22)
  //   17 MIGRANT(0)
  //   18 physical fallback: PROJECTILE(37) > GROUNDED(38) > CLIMBING(40) > WEBBED(39) (GL-matched)
  // Key changes vs the old client ladder (all evidence-backed corrections from the predicate table):
  //   * THIRSTY now precedes HUNGRY (native counters2 order; old client inverted it).
  //   * The needs band (thirst/hunger/drowsy/stress) precedes DISTRACTED, and DISTRACTED is last of
  //     the needs band -- the mass-yellow-DISTRACTED symptom is fixed here AND server-side (the
  //     server now sets the bit from native focus%, not has_unmet_needs; that field fix lives in
  //     unit_status.h, not this file).
  //   * Soldier moods rank ABOVE idle; strange moods + TERRIFIED rank BELOW idle (native splits the
  //     two mood switches around the idle tier). TERRIFIED dropped out of the danger band.
  //   * Injuries/wrestling/nausea/stunned/winded/fever now sit in native code order, not the old
  //     hand-tuned danger band.
  // Caged/chained have no native UNIT_STATUS overhead cell -> null (unchanged). Server-side mood
  // self-gating (STRESSED/DISTRACTED require mood==-1 && soldier_mood==-1) is applied by the server
  // predicate, so the client only orders whatever bits arrive.
  function unitStatusIconForBits(st, st2) {
    st = st | 0;
    st2 = st2 | 0;   // absent (old DLL) -> 0 -> pre-WT31 behavior exactly
    // -- native tier 1: sleep. Most specific state DF gives us (job_type == Sleep/Rest). A dwarf
    // asleep in a bed also carries the byproducts (on_ground/unconscious/sleepiness), each of which
    // ranks below here so the Zz still wins. --------------------------------------------------------
    if (st & USTAT_SLEEPING) return usCell(8, "SLEEPING");
    // -- native tiers 3-4: incapacitation ----------------------------------------------------------
    if (st & USTAT_UNCONSCIOUS) return usCell(30, "UNCONSCIOUS");
    if (st & USTAT_PARALYZED) return usCell(26, "PARALYZED");
    // -- native tier 5: performance walk (roles 0/1/2-3/make-believe; PREACHER role 6 -> 34) --------
    if (st2 & USTAT2_TELLING_A_STORY) return usCell(34, "TELLING_A_STORY");
    if (st2 & USTAT2_RECITING_POETRY) return usCell(35, "RECITING_POETRY");
    if (st2 & USTAT2_PERFORMING) return usCell(36, "PERFORMING");
    if (st2 & USTAT2_MAKE_BELIEVE) return usCell(33, "PLAYING_MAKE_BELIEVE");
    // -- native tiers 6-12: combat / physical distress, in native code order -----------------------
    if (st2 & USTAT2_WRESTLING) return usCell(23, "WRESTLING");
    if (st & USTAT_NAUSEA) return usCell(28, "NAUSEA");
    if (st & USTAT_STUNNED) return usCell(27, "STUNNED");
    if (st & USTAT_WINDED) return usCell(29, "WINDED");
    if (st2 & USTAT2_MAJOR_INJURY) return usCell(25, "MAJOR_INJURY");
    if (st2 & USTAT2_MINOR_INJURY) return usCell(24, "MINOR_INJURY");
    if (st & USTAT_FEVERED) return usCell(31, "FEVERED");
    // -- native tier 13: sane-citizen needs -- THIRSTY before HUNGRY (native counters2 order) -------
    if (st & USTAT_THIRSTY) return usCell(4, "THIRSTY");
    if (st & USTAT_HUNGRY) return usCell(3, "HUNGRY");
    if (st & USTAT_DROWSY) return usCell(5, "DROWSY");
    if (st & USTAT_STRESSED) return usCell(6, "STRESSED");
    if (st2 & USTAT2_DISTRACTED) return usCell(7, "DISTRACTED");
    // -- native tier 14: soldier-mood switch (soldier_mood 0..4) ------------------------------------
    if (st & USTAT_MARTIAL_TRANCE) return usCell(21, "MARTIAL_TRANCE");
    if (st & USTAT_ENRAGED) return usCell(20, "ENRAGED");
    if (st & USTAT_TANTRUM) return usCell(14, "TANTRUM");
    if (st & USTAT_DEPRESSION) return usCell(16, "DEPRESSION");
    if (st & USTAT_OBLIVIOUS) return usCell(15, "OBLIVIOUS");
    // -- native tier 15: sane-citizen idle (MIGRANT-as-idle handled by tier 17; NO_DESTINATION is
    //    server-reserved and currently never set) ---------------------------------------------------
    if (st2 & USTAT2_NO_JOB) return usCell(1, "NO_JOB");
    if (st2 & USTAT2_NO_DESTINATION) return usCell(2, "NO_DESTINATION");
    // -- native tier 16: strange-mood switch, default case -> TERRIFIED -----------------------------
    if (st & USTAT_BERSERK) return usCell(19, "BERSERK");
    if (st & USTAT_MADNESS) return usCell(17, "MADNESS");
    if (st & USTAT_MELANCHOLY) return usCell(18, "MELANCHOLY");
    if (st & USTAT_STRANGE_MOOD) {
      const mc = MOOD_CELL[(st & USTAT_MOOD_MASK) >> USTAT_MOOD_SHIFT] || MOOD_CELL[1];
      return { sheet: UNIT_STATUS_SHEET, col: 0, row: mc.row, token: mc.token };
    }
    if (st2 & USTAT2_TERRIFIED) return usCell(22, "TERRIFIED");
    // -- native tier 17: MIGRANT (misc-trait type 7) -----------------------------------------------
    if (st2 & USTAT2_MIGRANT) return usCell(0, "MIGRANT");
    // -- native tier 18: physical fallback = the physical-marker GROUP. Intra-tier order matches
    //    dwf-gl.js EXACTLY (GL-worker coordination 2026-07-16): PROJECTILE > GROUNDED > CLIMBING >
    //    WEBBED, so a unit with several physical bits resolves to the same row in both renderers
    //    (acceptance #7). Native only shows these in the <5001 phase sub-window; that per-unit
    //    windowing is applied downstream by unitStatusIconNow (see nativeBubblePhase). -----------------
    if (st & USTAT_PROJECTILE) return usCell(37, "PROJECTILE");
    if (st & USTAT_GROUNDED) return usCell(38, "GROUNDED");
    if (st & USTAT_CLIMBING) return usCell(40, "CLIMBING");
    if (st & USTAT_WEBBED) return usCell(39, "WEBBED");
    if (st & (USTAT_CAGED | USTAT_CHAINED)) return null;
    return null;
  }
  // ---------------------------------------------------------------------------------------------
  // NATIVE per-unit status-bubble blink cadence (decoded selector FUN_1402685d0, owner decision
  // 2026-07-16). Byte-equivalent to dwf-gl.js: native staggers EVERY unit's bubble on its own phase
  // -- NO fort-wide synchronization (the invented global 800ms on/off clock is gone). Per-unit phase
  // over a 7000ms cycle (native uses GetTickCount(); the client uses a monotonic ms clock):
  //     phase = (unit.id * 0x86e8 + now_ms) % 7000
  //   phase <  5001  -> ONLY the physical-marker group may show (PROJECTILE 37/WEBBED 39/GROUNDED 38/
  //                     CLIMBING 40); ordinary bubbles hidden.   (~5s window)
  //   phase >= 5001  -> the main ordinary ladder shows (needs/moods/sleep/injuries/...).   (~2s window)
  // Each unit's ordinary bubble is visible ~2s of every 7s, staggered by unit.id; a unit with BOTH an
  // ordinary and a physical status shows the physical marker in the other ~5s window. The bubble ROW
  // (which status wins) is server-derived + unchanged -- this is pure client-side visibility cadence.
  // unit.id is the REAL server unit id already carried in the stream (keyed by rec.id on ingest).
  const NATIVE_BUBBLE_PERIOD_MS = 7000;    // full per-unit cycle
  const NATIVE_BUBBLE_ID_STRIDE = 0x86e8;  // native per-unit phase stride (34536)
  const NATIVE_BUBBLE_ORDINARY_MS = 5001;  // ordinary window is [5001, 7000); physical is [0, 5001)
  function nativeBubblePhase(unitId, nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    const id = (unitId >>> 0);   // real unit id; native ids are non-negative
    // reduce id*stride mod the period BEFORE adding time so the product stays exact for large ids
    const idPhase = ((id % NATIVE_BUBBLE_PERIOD_MS) * (NATIVE_BUBBLE_ID_STRIDE % NATIVE_BUBBLE_PERIOD_MS)) % NATIVE_BUBBLE_PERIOD_MS;
    let t = Math.floor(nowMs) % NATIVE_BUBBLE_PERIOD_MS;
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
  // the ordinary ladder = the full selector MINUS the physical fallback (rows 37-40, which the selector
  // returns ONLY when no ordinary tier matched). Keeps a unit's ordinary winner intact even when a
  // physical bit is also set (physicalStatusIconForBits reports that one independently).
  function ordinaryStatusIconForBits(st, st2) {
    const full = unitStatusIconForBits(st, st2);
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
  // Repaint trigger for the persistent draw loop: a rolling hash over (id, visible row) of every unit
  // currently showing a bubble. It changes EXACTLY when some unit crosses its per-unit phase edge
  // (or a status flips window), so the canvas2d loop marks mapDirty only on a real transition rather
  // than every frame. Cheap O(n) arithmetic, no draw. (The GL path needs no analogue -- tickUnits
  // re-emits its unit tail every rAF unconditionally.)
  function unitStatusVisibilitySignature(units, nowMs) {
    if (!Array.isArray(units)) return 0;
    let h = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u) continue;
      const icon = unitStatusIconNow(u.st, u.st2, u.id, nowMs);
      if (icon) h = (Math.imul(h, 33) + (((u.id | 0) * 41 + icon.row + 1) | 0)) | 0;
    }
    return h;
  }
  // Cadence: this 800ms half/half beat does NOT gate unit-status bubbles -- those use the NATIVE
  // per-unit phase cadence (nativeBubblePhase) in unitStatusIconNow. The invented fort-wide on/off
  // clock that made every bubble vanish together every 800ms is gone. The function survives only
  // as the SHARED designation/flow beat: the designation "worker en-route" pulse (state 1 in
  // designationGlyphVisible) and the flow-cloud roil (flowOverlayFor) still ride it, and those
  // animations are explicitly out of scope for the status-bubble work and left byte-identical.
  // Retained under its historical name (renaming would perturb those untouched call sites); it is
  // no longer a "status bubble" clock. The _unitStatusBlinkVisibleForTest export mirrors that: it
  // pins the designation/flow beat, not any bubble visibility.
  function unitStatusBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / UNIT_STATUS_BLINK_MS) % 2) === 0;
  }
  // B135 three-state native cadence (live spec 07-10; byte-parity with dwf-gl.js):
  // DF posts designation jobs that sit WORKERLESS in the job list (smoothing/chop queues
  // especially) -- native keeps those STEADY. The wire discriminator is the djob's additive
  // `w:1` (a UNIT_WORKER general ref is attached -- world_stream.cpp's DJobRec). State model:
  //   0  job exists, no worker         -> steady glyph, no blink
  //   1  worker assigned, en-route     -> pulse on the shared 800ms beat
  //   2  worker/unit ON the work tile  -> pulse on the 400ms half-beat (+ the tile alternates
  //      dwarf <-> glyph/object, see workedTileUnitVisible)
  // The half-beat divides the SAME clock (never a second timer), so both cadences stay
  // phase-locked forever. Kind range 1-13 = every djob kind. Idle t.desig marks stay steady.
  const DESIG_ACTIVE_BLINK_MS = UNIT_STATUS_BLINK_MS / 2;
  function isBlinkingDesignationJob(djobKind) {
    return djobKind >= 1 && djobKind <= 13;
  }
  function activeBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / DESIG_ACTIVE_BLINK_MS) % 2) === 0;
  }
  function designationBlinkState(djobKind, hasWorker, unitOnTile) {
    if (!isBlinkingDesignationJob(djobKind) || !hasWorker) return 0;
    return unitOnTile ? 2 : 1;
  }
  function designationGlyphVisible(djobKind, nowMs, hasWorker, unitOnTile) {
    const s = designationBlinkState(djobKind, hasWorker, unitOnTile);
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
    for (let i = 0; i < djobs.length; i++)
      if (djobs[i] && djobs[i].w && isBlinkingDesignationJob(djobs[i].k)) return true;
    return false;
  }
  function hasDrawableUnitStatus(units) {
    if (!Array.isArray(units)) return false;
    for (let i = 0; i < units.length; i++) if (units[i] && unitStatusIconForBits(units[i].st, units[i].st2)) return true;
    return false;
  }
  function unitStatusDrawPlan(u, ox, oy, cell, nowMs, alpha) {
    // NATIVE per-unit blink cadence: physical marker in the <5001 phase window, ordinary bubble in
    // the >=5001 window, staggered per unit by unit.id (nativeBubblePhase). Returns null when this
    // unit's icon is outside its current window -- the caller skips the draw for this frame.
    const icon = unitStatusIconNow(u && u.st, u && u.st2, u && u.id, nowMs);
    if (!icon) return null;
    return {
      sheet: icon.sheet, col: icon.col, row: icon.row, token: icon.token,
      dx: (u.x - ox) * cell, dy: (u.y - oy - 1) * cell, dw: cell, dh: cell,
      alpha: (typeof alpha === "number") ? alpha : 1,
    };
  }

  // Baked civ-race sprites are served at the web ROOT (/dwarf.png), NOT via
  // /sprites/img -- so they get their own tiny Image cache, mirroring getSheet().
  const bakedImgs = Object.create(null);
  function getBaked(name) {
    let b = bakedImgs[name];
    if (!b) {
      b = bakedImgs[name] = { img: new Image(), loaded: false, failed: false };
      b.img.onload = () => { b.loaded = true; draw(); };
      b.img.onerror = () => { b.failed = true; };
      b.img.src = "/" + name;
    }
    return b;
  }

  // Generic tolerant JSON loader for the boot-time map fetches. On success it assigns
  // and repaints; on any failure it leaves the target map null (layer falls back).
  async function loadJsonMap(url, assign) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && typeof data === "object") { assign(data); draw(); }
    } catch (_) { /* map stays null -> this layer just falls back */ }
  }

  // df::workshop_type / df::furnace_type enum order (wire gives building.subtype as an
  // int; building.type arrives as a STRING enum key e.g. "Workshop"/"Furnace"/
  // "TradeDepot"). building_map.json is keyed by DFHack-style "Type:Subtype" aliases
  // (e.g. "Workshop:Masons") plus raw TOKENs, so we translate the subtype int -> name.
  const WORKSHOP_SUBTYPE = [
    "Carpenters", "Farmers", "Masons", "Craftsdwarfs", "Jewelers", "MetalsmithsForge",
    "MagmaForge", "Bowyers", "Mechanics", "Siege", "Butchers", "Leatherworks", "Tanners",
    "Clothiers", "Fishery", "Still", "Loom", "Quern", "Kennels", "Kitchen", "Ashery",
    "Dyers", "Millstone", "Custom", "Tool",
  ];
  const FURNACE_SUBTYPE = [
    "WoodFurnace", "Smelter", "GlassFurnace", "Kiln", "MagmaSmelter",
    "MagmaGlassFurnace", "MagmaKiln", "Custom",
  ];

  // TX17 -- planned/unbuilt CONSTRUCTIONS. A df::building of type "Construction" in
  // world->buildings.all is ALWAYS a not-yet-complete (planned or in-progress) construction:
  // DF removes the building and lays a real construction TILE the moment it finishes, so this
  // building record never represents a finished wall. DF draws these with dedicated planned-
  // preview art (data/vanilla vanilla_buildings_graphics/graphics_planned_constructions.txt ->
  // the PLANNED_CONSTRUCTION_* tokens on planned_constructions.png), keyed by the construction's
  // construction_type. That type rides the wire as building.subtype (world_stream.cpp BldRec.subtype
  // = b->getSubtype()), so no wire change is needed. This array indexes by the AUTHORITATIVE
  // construction_type enum ordinal (df-structures df.building.xml): 0 Fortification, 1 Wall,
  // 2 Floor, 3 UpStair, 4 DownStair, 5 UpDownStair, 6 Ramp, 7..21 Track{N..NSEW}, 22..36
  // TrackRamp{N..NSEW}, 37 ReinforcedWall. NOTE the graphics tokens reorder E-before-W relative
  // to the enum names (enum TrackEW -> token _WE, TrackNEW -> _NWE, TrackSEW -> _SWE, TrackNSEW ->
  // _NSWE, and likewise the TrackRamp* row) -- the strings below are the GRAPHICS token spellings,
  // verified 1:1 against graphics_planned_constructions.txt. Before TX17 a Construction building
  // matched no building_map key ("Construction:<st>"/"Construction" don't exist) and fell to
  // MISSING_BUILDING -- the blue "b" glyph on defaults.png a playtester reported.
  const CONSTRUCTION_PLANNED_TOKEN = [
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

  // ---- T1c PALETTE SWAP (asset-material-parity-spec §1.2) ---------------------------------
  // Native v50 recolors item art by remapping every sprite pixel whose RGB EXACTLY equals
  // default-palette entry k (palettes.png row 0, the 18 colors the sheet is drawn in) to
  // palettes.png[palRow][k]; non-palette pixels pass through untouched (that is how painted
  // detail survives -- safe on every sheet, no per-sheet gating). We reproduce that remap ONCE
  // per (sheet,col,row,palRow) on an offscreen 32x32 canvas and cache the result.
  //   paletteLookup: Map<packedRGB, k> for the 18 default colors (rebuilt when materialMap lands).
  //   paletteCellCache: Map<"sheet:col:row:palRow", HTMLCanvasElement|null>  (null = miss retried).
  // B273 review: default entries 0 and 9 are both RGB 47,48,56. Native DF uses FIRST-match
  // precedence: an aligned AQUA Masons workshop in TINT-fort2-NATIVE has 12 exact index-0 targets
  // at unobscured duplicate-source pixels and zero index-9 targets. Keep the first Map binding.
  let paletteLookup = null;
  const paletteCellCache = new Map();
  const multiplyCellCache = new Map();
  function buildPaletteLookup() {
    paletteLookup = null;
    paletteCellCache.clear();
    matInorganicById = null; // T2: id-join cache follows the materialMap instance
    const def = materialMap && (materialMap.default_row ||
      (materialMap.palette && materialMap.palette.rows && materialMap.palette.rows[0]));
    if (!def || !def.length) return;
    const m = new Map();
    for (let k = 0; k < def.length; k++) {
      const c = def[k];
      const key = c && c.length >= 3
        ? (((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255)) : null;
      if (key !== null && !m.has(key)) m.set(key, k);
    }
    paletteLookup = m;
    multiplyCellCache.clear();
  }
  function sheetCellGeometry(sheetName) {
    const g = itemMap && itemMap.sheet_geometry && itemMap.sheet_geometry[sheetName];
    return {
      cellW: Math.max(1, Math.floor((g && (g.cell_w || g.cellW)) || 32)),
      cellH: Math.max(1, Math.floor((g && (g.cell_h || g.cellH)) || 32)),
    };
  }

  // Returns a cached 32x32 offscreen canvas holding the palette-swapped cell, or null if the
  // source sheet isn't decodable yet / palette data is missing (caller then blits untinted).
  function paletteSwappedCell(sheetName, col, row, palRow) {
    if (!paletteLookup || !materialMap || !materialMap.palette || !materialMap.palette.rows) return null;
    const target = materialMap.palette.rows[palRow];
    if (!target || !target.length) return null;
    const key = sheetName + ":" + col + ":" + row + ":" + palRow;
    if (paletteCellCache.has(key)) return paletteCellCache.get(key);
    const s = getSheet(sheetName);
    if (!s || !s.loaded || s.failed) return null; // not cached: retried next frame once loaded
    let out = null;
    try {
      const oc = document.createElement("canvas");
      oc.width = 32; oc.height = 32;
      const octx = oc.getContext("2d");
      octx.imageSmoothingEnabled = false;
      const geom = sheetCellGeometry(sheetName);
      octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, 0, 0, 32, 32);
      const id = octx.getImageData(0, 0, 32, 32);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const k = paletteLookup.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        if (k !== undefined) {
          const t = target[k];
          if (t) { d[i] = t[0]; d[i + 1] = t[1]; d[i + 2] = t[2]; }
        }
      }
      octx.putImageData(id, 0, 0);
      out = oc;
    } catch (_) { out = null; } // tainted canvas / decode race -> fall back to untinted blit
    paletteCellCache.set(key, out);
    return out;
  }

  function multiplyTintedCell(sheetName, col, row, rgb) {


    if (!Array.isArray(rgb) || rgb.length < 3) return null;


    const key = sheetName + ":" + col + ":" + row + ":" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0);


    if (multiplyCellCache.has(key)) return multiplyCellCache.get(key);


    const s = getSheet(sheetName);


    if (!s || !s.loaded || s.failed) return null;


    let out = null;


    try {


      const oc = document.createElement("canvas");


      oc.width = 32; oc.height = 32;


      const octx = oc.getContext("2d");


      octx.imageSmoothingEnabled = false;


      const geom = sheetCellGeometry(sheetName);


      octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, 0, 0, 32, 32);


      octx.globalCompositeOperation = "multiply";


      octx.fillStyle = "rgb(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + ")";


      octx.fillRect(0, 0, 32, 32);


      octx.globalCompositeOperation = "destination-in";


      octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, 0, 0, 32, 32);


      out = oc;


    } catch (_) { out = null; }


    multiplyCellCache.set(key, out);


    return out;


  }

  // B98 ghost tint (canvas2d). A living unit returns null (drawn normally); a ghost (u.gh===1)
  // returns the shared green multiply + translucency plan. Pure -- the treegrass ghost fixture
  // asserts it against dwf-gl.js's buildUnits tint (both renderers, same numbers).
  function unitGhostPlan(u) {
    if (!u || u.gh !== 1) return null;
    return { rgb: GHOST_TINT_RGB, alpha: GHOST_ALPHA, css: GHOST_TINT_CSS };
  }

  // Draw one unit sprite region with the green ghost multiply, re-clipped to the sprite's own
  // alpha (same draw->multiply->destination-in technique as multiplyTintedCell, but for an
  // arbitrary source rect so it serves every unit tier). Honors ctx.globalAlpha (already folded
  // with GHOST_ALPHA by the caller) on the final blit. Falls back to a plain draw on any error
  // so a ghost is never lost.
  let ghostBuf = null, ghostBufCtx = null;
  function blitGhostTinted(img, sx, sy, sSW, sSH, dx, dy, dw, dh) {
    const w = Math.max(1, Math.round(dw)), h = Math.max(1, Math.round(dh));
    try {
      if (!ghostBuf) { ghostBuf = document.createElement("canvas"); ghostBufCtx = ghostBuf.getContext("2d"); }
      if (ghostBuf.width !== w || ghostBuf.height !== h) { ghostBuf.width = w; ghostBuf.height = h; }
      const octx = ghostBufCtx;
      octx.imageSmoothingEnabled = false;
      octx.globalCompositeOperation = "source-over";
      octx.clearRect(0, 0, w, h);
      octx.drawImage(img, sx, sy, sSW, sSH, 0, 0, w, h);   // 1) unit sprite
      octx.globalCompositeOperation = "multiply";
      octx.fillStyle = GHOST_TINT_CSS;
      octx.fillRect(0, 0, w, h);                            // 2) green multiply (also paints transparent)
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(img, sx, sy, sSW, sSH, 0, 0, w, h);   // 3) re-clip to the sprite's alpha
      octx.globalCompositeOperation = "source-over";
      ctx.drawImage(ghostBuf, 0, 0, w, h, dx, dy, dw, dh); // 4) blit (honors ctx.globalAlpha)
    } catch (_) {
      ctx.drawImage(img, sx, sy, sSW, sSH, dx, dy, dw, dh);
    }
  }



  // Blit one 32x32 sheet cell (col,row) scaled into a tile. Returns false (no draw)
  // if the sheet isn't loaded yet, so callers can decide whether to fall back.
  // T1c: optional palRow triggers the per-material palette swap (item paths only pass it).
  // T1e: item blits (nearest=true) use NEAREST sampling at the UNROUNDED destination so the
  // canvas2d sprite point-samples exactly like GL's NEAREST atlas draw at the same fractional
  // position (the sub-pixel halo PARITY-MISMATCH sub-class B: c2d's default bilinear smoothing
  // put a 1px soft rim around small sprites that GL's hard edges don't have; rounding the
  // destination was tried first and just traded the rim for a 0..0.5px offset). Non-item
  // callers keep the legacy smoothed draw.
  function blitCell(sheetName, col, row, px, py, cell, palRow, nearest) {
    if (!sheetName || typeof col !== "number" || typeof row !== "number") return false;
    if (typeof palRow === "number") {
      const swapped = paletteSwappedCell(sheetName, col, row, palRow);
      if (swapped) {
        const sm = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(swapped, 0, 0, 32, 32, px, py, cell, cell);
        ctx.imageSmoothingEnabled = sm;
        return true;
      }
      // swap not ready/available -> fall through to a plain blit (still NEAREST for items).
    }
    const s = getSheet(sheetName);
    if (!s || !s.loaded || s.failed) return false;
    if (nearest || typeof palRow === "number") {
      const sm2 = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      const geom = sheetCellGeometry(sheetName);
      ctx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, px, py, cell, cell);
      ctx.imageSmoothingEnabled = sm2;
      return true;
    }
    const geom = sheetCellGeometry(sheetName);
    ctx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, px, py, cell, cell);
    return true;
  }

  // ---- small stable integer hash (position/material -> a repeatable 0..N-1 pick) ----------
  // Used wherever a variant needs to be "always the same for this tile/material" without
  // storing extra state -- the same convention `drawWallJoin`'s neighbor-mask lookups and the
  // WEB item variant pick already lean on informally; centralized here so WC-3/WC-11/WC-12
  // share one implementation.
  function hashInt(a, b) {
    let h = (a | 0) * 2654435761 ^ (b | 0) * 2246822519;
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
  }

  // ---- WC-3: item sprite resolution (token -> cell, matvariant, tint, fallback) ----------
  // Furniture-as-item bases (WC-2's item_map.json `matvariants`) keyed by their PascalCase
  // generator name -- the wire's item.type is the plain df::item_type enum key (all-caps).
  const ITEM_MATVARIANT_BASE = {
    DOOR: "Door", BED: "Bed", TABLE: "Table", CHAIR: "Chair", CABINET: "Cabinet",
    BOX: "Box", HATCH_COVER: "HatchCover", GRATE: "Grate",
  };
  // Best-effort client-side material-family classifier (WC-3's "same rule WC-5 uses, one
  // shared helper" -- WC-5/WC-6/WC-8's own building-material channel hasn't landed a
  // resolved family/rgb for ITEMS yet, only for buildings (`b.rgb`), so this is a documented
  // approximation pending that wire extension (RECONCILE-R3), not oracle-calibrated:
  //   - GLASS_GREEN/CLEAR/CRYSTAL are FIXED df::builtin_mats ids (3/4/5, df.d_basics.xml) --
  //     exact, no raws lookup needed.
  //   - A PLANT-sourced material (builtin ids >= 419, PLANT_1.. in the same enum) on a
  //     furniture item is overwhelmingly WOOD in practice -- an approximation (it doesn't
  //     disambiguate a plant's other tissue materials, but furniture items don't carry those).
  //   - mat_type===0 (INORGANIC) can't be split into STONE vs METAL client-side without a
  //     raws mat_index->family table (not on the wire) -- defaults to STONE (vanilla forts
  //     build far more stone furniture than metal by default). Never a crash, never a missing
  //     render either way -- an unclassifiable mat_type just skips the matvariant step and
  //     falls through to the generic bytype cell.
  function matFamilyFor(mat_type) {
    if (mat_type === 3 || mat_type === 4 || mat_type === 5) return "GLASS";
    if (mat_type >= 419) return "WOOD";
    if (mat_type === 0) return "STONE";
    return null;
  }
  // TX6/TX6-SPECIES-TINT: optional per-material RGB distinguishes species; this coarse
  // family wash remains the fallback for old frames and unresolvable materials.
  const ITEM_SPATTER_TINT_RGB_BY_FAMILY = {
    LEAVES: [82, 116, 48], FRUIT: [194, 120, 38], FRUIT_SMALL: [164, 57, 42], FRUIT_LARGE: [178, 72, 44],
  };
  function itemSpatterTintRgb(family, rgb) {
    if (!ITEM_SPATTER_TINT_RGB_BY_FAMILY[family]) return null;
    return rgb && rgb.length === 3 ? rgb : ITEM_SPATTER_TINT_RGB_BY_FAMILY[family];
  }
  // B138: native DF draws ONE litter decal per tile; drawing every overlapping ITEM_SPATTER
  // record stacked tint passes that multiply-compounded toward brown/black. Deterministic
  // winner among DRAWABLE records (family mapped, not OTHER): highest amount, ties broken by
  // lowest growth_class then item_type -- stable regardless of wire arrival order. Fully
  // equal records keep the first seen. MUST stay logic-identical to dwf-gl.js's copy.
  function itemSpatterWins(a, b) {
    if ((a.amount | 0) !== (b.amount | 0)) return (a.amount | 0) > (b.amount | 0);
    if ((a.growth_class | 0) !== (b.growth_class | 0)) return (a.growth_class | 0) < (b.growth_class | 0);
    return (a.item_type | 0) < (b.item_type | 0);
  }
  function pickItemSpatterLitter(arr, map) {
    if (!arr || !arr.length || !map || !map.growth_class_family || !map.families) return null;
    let best = null;
    for (let i = 0; i < arr.length && i < 4; i++) {
      const isp = arr[i];
      if (!isp || !(isp.amount > 0)) continue;
      const fam = map.growth_class_family[String(isp.growth_class)];
      if (!fam || fam === "OTHER") continue;
      const famDef = map.families[fam];
      if (!famDef) continue;
      if (best && !itemSpatterWins(isp, best.isp)) continue;
      best = { isp: isp, fam: fam, famDef: famDef };
    }
    return best;
  }
  const ITEM_TINT_BY_FAMILY = {
    WOOD: "rgba(140,100,60,0.28)",
    GLASS: "rgba(180,220,220,0.20)",
    // STONE: no tint -- the sprite's own grey is already a reasonable stone read, and
    // guessing a specific stone hue without a raws table would be more often wrong than right.
  };
  function lookupCurrentTile(gx, gy) {
    try {
      if (!latest || !latest.tiles || !latest.origin) return null;
      const x = gx - latest.origin.x, y = gy - latest.origin.y;
      if (x < 0 || y < 0 || x >= latest.width || y >= latest.height) return null;
      return latest.tiles[y * latest.width + x] || null;
    } catch (_) { return null; }
  }

  function drawLiquidEdges(t, px, py, cell, gx, gy) {
    try {
      const Adj = window.DwfAdjacency;
      const tokens = liquidEdgeTokens(t, gx, gy, lookupCurrentTile, Adj);
      let drew = false;
      for (let i = 0; i < tokens.length; i++) {
        const e = resolveCell(tokens[i]);
        if (e && e.sheet && blitCell(e.sheet, e.col, e.row, px, py, cell)) drew = true;
      }
      return drew;
    } catch (_) { return false; }
  }

  function drawItemTint(mat_type, px, py, cell) {
    const fam = matFamilyFor(mat_type);
    const tint = fam && ITEM_TINT_BY_FAMILY[fam];
    if (!tint) return;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = tint;
    ctx.fillRect(px, py, cell, cell);
    ctx.restore();
  }
  // ---- T1a/T1d material identity (asset-material-parity-spec §3/§4-T1d) -------------------
  // With materialMap present, mat_type==0 items resolve their exact inorganic identity offline
  // (mat_index is byte-reproducible, verified 265/265) -> EXACT family (METAL vs STONE, fixing
  // the "furniture always STONE" collapse), per-material palette row, and per-material
  // silhouette cells (gem value tier / boulder mineral / cut-gem default). All null-safe: with
  // no materialMap every helper returns null and resolution is IDENTICAL to the pre-T1 chain.
  // T2 join (identKind 3 = server-resolved INORGANIC token, DLL window #9+): the token is
  // order-independent ground truth, so it OVERRIDES the offline mat_index join when present
  // (modded/generated-material safe; spec tier-2 #1). Unknown token (modded world without an
  // offline entry) => null, never a wrong-index guess. Graceful-dark: absent on today's wire
  // (identKind 3 never sent pre-window-#9) -> the verified offline index join, unchanged.
  let matInorganicById = null; // lazy {ID: entry} over materialMap.inorganic
  function matInorganic(it) {
    if (!materialMap || !materialMap.inorganic || !it || it.mat_type !== 0) return null;
    if (it.identKind === 3 && it.ident) {
      if (!matInorganicById) {
        matInorganicById = Object.create(null);
        for (let j = 0; j < materialMap.inorganic.length; j++) {
          const e2 = materialMap.inorganic[j];
          if (e2 && e2.id) matInorganicById[e2.id] = e2;
        }
      }
      return matInorganicById[it.ident] || null;
    }
    const i = it.mat_index;
    if (typeof i !== "number" || i < 0 || i >= materialMap.inorganic.length) return null;
    return materialMap.inorganic[i] || null;
  }
  // Exact material family for the matvariant step. matvariants only carries WOOD/STONE/METAL/
  // GLASS, so SOIL/GEM inorganics collapse to STONE for the furniture-cell lookup (they never
  // build gem/soil furniture) while METAL is now split out correctly.
  function matFamilyForItem(it) {
    const mt = it.mat_type;
    if (mt === 3 || mt === 4 || mt === 5) return "GLASS";
    if (mt === 0) {
      const e = matInorganic(it);
      if (e && e.family) return (e.family === "METAL") ? "METAL" : (e.family === "GLASS" ? "GLASS" : "STONE");
      return "STONE";
    }
    if (mt >= 419) return "WOOD";
    return null;
  }
  // Palette-swap row for the item's material identity (null => draw untinted). Applied only on
  // palettizable resolution paths (itemdef/material/matvariant/bytype), never identity/missing.
  function matPalRowFor(it) {
    if (!materialMap) return null;
    const mt = it.mat_type;
    if (mt === 0) { const e = matInorganic(it); return e && typeof e.row === "number" ? e.row : null; }
    if (mt === 3 || mt === 4 || mt === 5) {
      const b = materialMap.builtin && materialMap.builtin[String(mt)];
      return b && typeof b.row === "number" ? b.row : null;
    }
    if (mt >= 419 && it.identKind === 1 && it.ident && materialMap.plant) {
      const p = materialMap.plant[it.ident];
      if (p && typeof p.WOOD === "number") return p.WOOD;
    }
    return null;
  }
  const GLASS_ROUGH_KEY = { 3: "GLASS_GREEN", 4: "GLASS_CLEAR", 5: "GLASS_CRYSTAL" };
  function pickRoughTier(value) {
    const tiers = itemMap && itemMap.rough_gem_tiers;
    if (!tiers || !tiers.length) return null;
    let chosen = tiers[0].cell;
    for (let i = 0; i < tiers.length; i++) if (value >= tiers[i].min_value) chosen = tiers[i].cell;
    return chosen || null;
  }
  // Per-material SILHOUETTE cell (item_map v3): rough-gem value tiers, glass roughs, cut-gem
  // defaults, per-mineral boulders. null => no material-specific cell (chain falls through).
  function hatchCoverMaterialCell(it) {
    const map = itemMap && itemMap.hatch_cover_bymat;
    if (!map || !it) return null;
    if (it.mat_type === 0) {
      if (it.identKind === 3 && it.ident && map[it.ident]) return map[it.ident];
      const e = matInorganic(it);
      if (e && e.id && map[e.id]) return map[e.id];
    }
    if (it.mat_type >= 419 && it.identKind === 1 && it.ident) {
      return map["PLANT_MAT:" + it.ident + ":WOOD"] || null;
    }
    return null;
  }
  function materialItemCell(it, type) {
    if (!itemMap) return null;
    if (type === "HATCH_COVER") {
      const hc = hatchCoverMaterialCell(it);
      if (hc) return hc;
    }
    if (it.mat_type === 0) {
      const e = matInorganic(it);
      if (e) {
        if (type === "BOULDER" && itemMap.boulder_bymat && itemMap.boulder_bymat[e.id]) return itemMap.boulder_bymat[e.id];
        if (type === "ROUGH" && e.gem) { const c = pickRoughTier(e.value || 1); if (c) return c; }
        if ((type === "GEM" || type === "SMALLGEM") && e.gem) {
          // T2 join (wire gem `shape` i16, DLL window #9+): shape indexes material_map's
          // shape_tokens (order VERIFIED 43/43 vs live memory) -> item_map.gem_shapes per-cut
          // cells. shape -1 (uncut/spawned) or a cut without gem art (e.g. CLOUD) falls to the
          // GEMS:0:0 / SMALLGEMS:0:0 defaults. Graceful-dark: `shape` absent pre-window-#9.
          if (typeof it.shape === "number" && it.shape >= 0 &&
              materialMap && materialMap.shape_tokens && itemMap.gem_shapes) {
            const stok = materialMap.shape_tokens[it.shape];
            const gsh = stok && itemMap.gem_shapes[stok];
            const cut = gsh && ((type === "GEM") ? gsh.large : gsh.small);
            if (cut) return cut;
          }
          const c = (type === "GEM") ? itemMap.gem_default : itemMap.smallgem_default;
          if (c) return c;
        }
      }
    }
    if (type === "ROUGH" && itemMap.rough_gem_glass) {
      const gk = GLASS_ROUGH_KEY[it.mat_type];
      if (gk && itemMap.rough_gem_glass[gk]) return itemMap.rough_gem_glass[gk];
    }
    return null;
  }
  // Resolution order (WC-3 spec): (1) (type,subtype) -> ITEMDEF_DICT token -> bytoken;
  // (2) furniture/matvariant by material family; (3) bytype[type]; (4) MISSING_ITEM/_default.
  // Item identity extension (WIRE-TAILS): item types whose sprite is per-SPECIES/per-RACE and
  // cannot be resolved from the numeric (item_type, mat) pair -- resolved from the wire's
  // resolved token instead (plant_map species cell for harvested-plant items, creatures_map
  // race cell for corpse/vermin/pet items). Closes B27's seed-placeholder half.
  const ITEM_PLANT_PART = { SEEDS: "SEED", PLANT: "PICKED", PLANT_GROWTH: "PICKED" };
  // GLOB (tallow/fat) is DELIBERATELY excluded: it is a rendered MATERIAL, not a body part -- a
  // "cat tallow" GLOB also carries mat.creature=CAT but must NOT look like a cat. That exclusion
  // is enforced by the [gating] assertion in wc3_we4_wc12_apply_test.mjs and is preserved here.
  // EGG (Phase-3 sweep fix): an EGG item carries mat/race=layer creature (item_eggst.race), so it
  // WAS in this set and resolved to the LAYING creature's flat cell -- a jabberer egg drew a live
  // jabberer, and giant-race eggs drew NOTHING (their flat-cell slot is a blank in the composited
  // sheet). DF draws a single generic egg sprite for EVERY species (tinted by the shell material),
  // never the creature. EGG is therefore EXCLUDED -- it falls through to item_map.bytype.EGG (the
  // generic egg cell, palette/tint-coloured by the egg material). Whole EGG class (315 sweep cells,
  // native nat_fg~0.04 small egg vs browser gl_fg~0.53 creature) is wrong-art without this.
  // MEAT stays excluded: its creature ident selects a material layout, never the living creature
  // sprite. TX13 resolves its mat_type through item_map.creature_food before this identity path.
  // FISH stays IN (prepared FISH ships item_fishst.race server-side).
  const ITEM_CREATURE_TYPES = new Set(["CORPSE", "CORPSEPIECE", "REMAINS", "VERMIN", "PET", "FISH", "FISH_RAW"]);
  function creatureFoodItemCell(it) {
    if (!it || (it.type !== "MEAT" && it.type !== "GLOB") || it.identKind !== 2 || !it.ident)
      return null;
    const food = itemMap && itemMap.creature_food;
    const profile = food && food.by_creature && food.by_creature[it.ident];
    const layout = profile && food.profiles && food.profiles[profile];
    const kind = layout && layout[String(it.mat_type)];
    const entry = kind && food.cells && food.cells[kind];
    return entry && entry.sheet ? entry : null;
  }
  function resolveIdentityEntry(it) {
    if (!it || typeof it.identKind !== "number" || !it.ident) return null;
    if (it.identKind === 1 /* plant */ && plantMap) {
      // B31 FIX: gate on ITEM TYPE, not just ident presence. WOOD/logs, DRINK, POWDER etc.
      // are ALSO plant-material items (the server resolves a plant ident for them), but their
      // sprite is a generic per-TYPE cell (a log, a barrel), NOT a per-species plant cell.
      // Only SEEDS/PLANT/PLANT_GROWTH have per-species art -- everything else must return null
      // here and fall through to the generic type/matvariant chain (else a WOOD log rendered as
      // the species' SEED cell via the old unconditional pm.SEED fallback -- the "all wood
      // textures replaced with seeds" regression).
      const part = ITEM_PLANT_PART[it.type];
      if (!part) return null;
      const pm = plantMap[it.ident];
      if (pm) return pm[part] || pm.PICKED || pm.SHRUB || pm.SEED || null;
    } else if (it.identKind === 2 /* creature */ && creaturesMap && creaturesMap.races) {
      if (ITEM_CREATURE_TYPES.has(it.type)) {
        const cm = creaturesMap.races[it.ident];
        if (cm) {
          // B47 + CORPSETEX-B195 (CORPSETEX_B195_SKELETAL): corpse-class items prefer the raws'
          // EXPLICIT per-creature dead art over the LIVING cell, but WHICH dead art depends on
          // DF's own fresh->skeletal label (it.skeletal, wire iflags bit6):
          //   * skeletal (DF names it "skeleton"): the .skeleton (bone) cell, else .corpse.
          //   * fresh corpse (bit unset OR OLD server that never sends it): a BODY, NEVER the
          //     skeleton cell -- the .corpse cell if the race has one, else fall through to the
          //     flat living cell (cm.sheet) below. On an old server the bit is always 0, so a
          //     race WITH a .corpse cell resolves it exactly as pre-B195 (corpse-first), and a
          //     body-artless civ race (DWARF/ELF/GOBLIN/HUMAN/KOBOLD: only bone_pile exists)
          //     lands on _corpse_fallback just as today -- never a regression. Those 5 civ races
          //     have NO fresh-body sprite in the mapping; a spritepick is queued for that art.
          if (it.type === "CORPSE" || it.type === "CORPSEPIECE" || it.type === "REMAINS") {
            const corpseCell = (cm.corpse && cm.corpse.sheet) ? cm.corpse : null;
            const skelCell   = (cm.skeleton && cm.skeleton.sheet) ? cm.skeleton : null;
            if (it.skeletal) {
              const dead = skelCell || corpseCell;   // bone art first when DF says skeleton
              if (dead) return dead;
            } else {
              if (corpseCell) return corpseCell;      // fresh -> body art, never the skeleton
              // no .corpse cell: fall through to cm.sheet (flat living body) / fallback box.
            }
          }
          if (cm.sheet) return cm;   // real per-race flat cell (vs the generic REMAINS box)
        }
      }
    }
    return null;
  }
  // Full resolution: returns {entry, source} where source records WHICH step matched so the
  // caller knows whether the material palette swap applies. Resolution order (WC-3 + T1d):
  // (0) creature-food material; (1) per-species/per-race identity; (2) (type,subtype)->
  // ITEMDEF token->bytoken; (3) T1d per-material silhouette; (4) furniture matvariant by
  // EXACT family; (5) bytype[type]; (6) corpse fallback; (7) MISSING/_default.
  // Palette swap applies to sources itemdef/material/matvariant/bytype only (palettized art);
  // never to identity/corpse/missing (painted per-species art / placeholder box).
  function resolveItemVisual(it) {
    if (!itemMap) return null;
    const type = it.type;
    const food = creatureFoodItemCell(it);
    if (food) return { entry: food, source: "creaturefood" };
    const ident = resolveIdentityEntry(it);
    if (ident) return { entry: ident, source: "ident" };
    if (itemDefTokens && typeof it.subtype === "number" && it.subtype >= 0) {
      const tok = itemDefTokens.get(type + ":" + it.subtype);
      if (tok && itemMap.bytoken && itemMap.bytoken[tok]) return { entry: itemMap.bytoken[tok], source: "itemdef" };
    }
    const matCell = materialItemCell(it, type);
    if (matCell) return { entry: matCell, source: "material" };
    const base = ITEM_MATVARIANT_BASE[type];
    if (base && itemMap.matvariants && itemMap.matvariants[base]) {
      const fam = matFamilyForItem(it);
      const variants = itemMap.matvariants[base];
      if (fam && variants[fam]) return { entry: variants[fam], source: "matvariant" };
    }
    if (itemMap.bytype && itemMap.bytype[type]) return { entry: itemMap.bytype[type], source: "bytype" };
    // B47: a CORPSE whose race resolved no cell (layered-only races, or no ident on the
    // wire) fell all the way to the _missing placeholder box -- item_map has carried a
    // dedicated `_corpse_fallback` remains cell since WC-2 that nothing consumed. Use it.
    if ((type === "CORPSE" || type === "CORPSEPIECE" || type === "REMAINS") && itemMap._corpse_fallback) {
      return { entry: itemMap._corpse_fallback, source: "corpse" };
    }
    // v1 back-compat: item_map.json v2 uses `_missing`/`bytype`; a stale v1 map (pre-WC-2)
    // only has flat TYPE keys + `_default` -- both fallbacks tried so neither shape 404s.
    const miss = itemMap._missing || itemMap[type] || itemMap._default || null;
    return miss ? { entry: miss, source: "missing" } : null;
  }
  // Thin cell-only wrapper (preserves the WC-3 test-hook contract: returns the cell entry).
  function resolveItemEntry(it) {
    const v = resolveItemVisual(it);
    return v ? v.entry : null;
  }
  // Public UI adapter for the server's stock-item `spriteRef` shape. Keep this conversion at
  // the map resolver boundary so sheets and rows cannot grow a second item-art lookup table.
  // Unlike map tiles, UI art fails open to its existing letter glyph: the map's deliberate
  // MISSING_ITEM placeholder is therefore not a successful sheet-art resolution.
  function resolveItemSpriteRef(ref) {
    if (!ref || typeof ref.itemType !== "string") return null;
    // Studio/oracle fixtures may carry the already-resolved raws token when no live
    // ITEMDEF_DICT connection exists. This is the same canonical bytoken table used by
    // the live (type, subtype) path, not a second sprite lookup or a guessed cell.
    if (typeof ref.itemToken === "string" && ref.itemToken && itemMap && itemMap.bytoken) {
      const tokenEntry = itemMap.bytoken[ref.itemToken];
      if (tokenEntry && tokenEntry.sheet) return tokenEntry;
    }
    const v = resolveItemVisual({
      type: ref.itemType,
      subtype: Number(ref.itemSubtype),
      mat_type: Number(ref.materialType),
      mat_index: Number(ref.materialIndex),
      identKind: Number(ref.identKind),
      ident: typeof ref.ident === "string" ? ref.ident : "",
    });
    return v && v.source !== "missing" ? v.entry : null;
  }
  const PALETTIZABLE_SOURCE = { itemdef: 1, material: 1, matvariant: 1, bytype: 1 };

  // ---- TX1: barrel/bin contents-peek overlay ----------------------------------------------
  // Native draws a container's contents poking out of its open top as a DEDICATED per-category
  // overlay cell composited OVER the container sprite -- vanilla graphics_containers.txt's
  // ITEM_BARREL_TOP_* rows and the 21 ITEM_BIN_TOP_* rows (all already parsed into
  // item_map.bytoken). Verified against the TX1-1 oracle: the fish barrels ARE
  // ITEM_BARREL_TOP_FISH over ITEM_BARREL_WOOD_EMPTY, the red heap IS ITEM_BARREL_TOP_MEAT.
  // The wire's CONTAINER_PEEK tail (0x0A) ships the representative FIRST contained item's
  // (item_type, mat_type, mat_index, subtype, cflags); classification to a category token
  // happens HERE so a mapping tweak never needs a DLL window. The bin map mirrors DF's own
  // category taxonomy (df::item_bin_graphics_contents_type, 21 content values) 1:1. Every
  // token resolves through item_map.bytoken (real raws-parsed cells); an unmapped content
  // type returns null -> plain container, NEVER a guessed cell.
  const PEEK_CRAFT_TYPES = { FIGURINE: 1, AMULET: 1, SCEPTER: 1, CROWN: 1, RING: 1, EARRING: 1, BRACELET: 1, TOTEM: 1, TOY: 1 };
  const PEEK_ARMOR_TYPES = { ARMOR: 1, HELM: 1, GLOVES: 1, SHOES: 1, PANTS: 1 };
  function peekMatIsMetal(p) {
    if (!p || p.mat_type !== 0) return false;
    const e = matInorganic(p);
    return !!(e && e.family === "METAL");
  }
  function peekMatIsLeather(p) {
    // creature-sourced builtin material range (CREATURE_1..200 = mat_type 19..218): leather.
    return !!p && p.mat_type >= 19 && p.mat_type <= 218;
  }
  function containerPeekToken(it, peek) {
    if (!it || !peek || !peek.type) return null;
    const t = peek.type;
    if (it.type === "BARREL") {
      if (t === "MEAT") return "ITEM_BARREL_TOP_MEAT";
      if (t === "FISH" || t === "FISH_RAW") return "ITEM_BARREL_TOP_FISH";
      if (t === "CHEESE") return "ITEM_BARREL_TOP_CHEESE";
      if (t === "FOOD") return "ITEM_BARREL_TOP_MEAL";
      if (t === "PLANT" || t === "PLANT_GROWTH")
        return (peek.cflags & 0x01) ? "ITEM_BARREL_TOP_PLANT_SUBTERRANEAN" : "ITEM_BARREL_TOP_PLANT";
      if (t === "BOX") return "ITEM_BARREL_TOP_BAG";  // bags-in-barrels (seed bags) are BOX items
      if (t === "DRINK" || t === "LIQUID_MISC")
        return (matFamilyForItem(it) === "METAL") ? "LIQUID_FOR_BARREL_METAL" : "LIQUID_FOR_BARREL_WOOD";
      return null;
    }
    if (it.type === "BIN") {
      if (t === "AMMO") return "ITEM_BIN_TOP_AMMO";
      if (t === "BAR") return (peek.mat_type === 7 /*builtin COAL: coke+charcoal*/) ? "ITEM_BIN_TOP_COAL" : "ITEM_BIN_TOP_BARS";
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
      if (t === "CHAIN") return peekMatIsMetal(peek) ? "ITEM_BIN_TOP_CHAINS" : "ITEM_BIN_TOP_ROPES";
      if (PEEK_ARMOR_TYPES[t])
        return peekMatIsMetal(peek) ? "ITEM_BIN_TOP_ARMOR_METAL"
          : (peekMatIsLeather(peek) ? "ITEM_BIN_TOP_ARMOR_LEATHER" : "ITEM_BIN_TOP_CLOTHING");
      if (PEEK_CRAFT_TYPES[t]) return "ITEM_BIN_TOP_CRAFTS";
      return null;
    }
    return null;
  }
  function containerPeekEntry(it, peek) {
    const tok = containerPeekToken(it, peek);
    if (!tok || !itemMap || !itemMap.bytoken) return null;
    const e = itemMap.bytoken[tok];
    return (e && e.sheet) ? e : null;
  }

  // (4) ITEM: topmost ground item sprite. WC-3: token/matvariant/tint resolution replaces the
  // old flat `itemMap[type] || itemMap._default` (which drew a generic box for 85/94 types).
  function drawItem(t, px, py, cell) {
    try {
      if (!itemMap || !t.item) return;
      const it = t.item;
      // Spider web (WC-1 iflags bit0) takes priority over generic resolution -- webs are a
      // THREAD item with no useful per-material cell, but graphics_items.txt's dedicated
      // ITEM_WEB_HARMLESS/THICK families (4 position-hash variants each, WC-2's `web` key).
      if (it.type === "THREAD" && (it.iflags & 0x01) && itemMap.web) {
        const variants = (itemMap.web.harmless && itemMap.web.harmless.length) ? itemMap.web.harmless : itemMap.web.thick;
        if (variants && variants.length) {
          const v = variants[hashInt(px, py) % variants.length];
          if (v && v.sheet && blitCell(v.sheet, v.col, v.row, px, py, cell, undefined, true)) return;
        }
      }
      const v = resolveItemVisual(it);
      if (v && v.entry && v.entry.sheet) {
        // T1c/T1d: on a palettizable path, the per-material palette swap supersedes the old
        // WOOD/GLASS multiply wash (drawItemTint) -- the swap is exact, the wash was a guess.
        let palRow;
        if (materialMap && PALETTIZABLE_SOURCE[v.source]) {
          const pr = matPalRowFor(it);
          if (typeof pr === "number") palRow = pr;
        }
        // T1e: nearest=true -- the whole item layer point-samples like GL (sub-class B halo).
        if (blitCell(v.entry.sheet, v.entry.col, v.entry.row, px, py, cell, palRow, true)) {
          if (palRow === undefined) drawItemTint(it.mat_type, px, py, cell);
          // TX1: contents-peek overlay OVER the container sprite (only when the container
          // itself drew -- an overlay floating on a missing base would be wrong-art). The
          // overlay cells are painted per-category art, never palette-swapped.
          if (t.peek) {
            const pk = containerPeekEntry(it, t.peek);
            if (pk) blitCell(pk.sheet, pk.col, pk.row, px, py, cell, undefined, true);
          }
        }
      }
    } catch (_) { /* layer guarded */ }
  }

  // ---- WC-21: vermin / vermin-colony sprite. The wire's VERMIN tail carries the server-
  // resolved creature token (WIRE-TAILS -- the race index alone is not offline-resolvable),
  // so a lone bug / colony resolves to its real creatures_map flat cell instead of nothing.
  // DF draws one vermin glyph per tile; a colony (vflags bit0) takes precedence. Tokenless
  // entries (unresolved race) are skipped rather than drawn as a wrong sprite.
  function resolveVerminEntry(t) {
    const v = t.vermin;
    if (!v || !v.length || !creaturesMap || !creaturesMap.races) return null;
    let lone = null;
    for (let i = 0; i < v.length; i++) {
      const e = v[i];
      if (!e || !e.token) continue;
      const c = creaturesMap.races[e.token];
      if (!c || !c.sheet) continue;
      if (e.vflags & 0x01) return c;   // colony takes precedence, regardless of list order
      if (!lone) lone = c;
    }
    return lone;
  }
  function drawVermin(t, px, py, cell) {
    try {
      const e = resolveVerminEntry(t);
      if (e && e.sheet) blitCell(e.sheet, e.col, e.row, px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  // ---- WC-11/WC-12: material-spatter decal (family/shape/direction) + fallen-leaves/fruit
  // litter (item-spatter). Replaces the old flat translucent-red wash, which rendered snow,
  // mud, vomit and blood identically (owner-named gap: "snow != blood").
  //
  // Material -> decal-family classification (WC-12's runtime judgment call; documented,
  // NOT oracle-calibrated -- see the item's handoff note): the wire's SPATTER tail (WC-11)
  // carries only numeric mat_type/mat_index/state, no material TOKEN and no resolved color
  // (unlike buildings, which get a server-resolved `rgb` -- RECONCILE-R3 asks W-A for the same
  // on spatter, not yet landed). Builtin materials (df.d_basics.xml `builtin_mats`, stable
  // across DF versions) ARE exactly classifiable from mat_type alone: WATER=6 (matter_state
  // Powder=3 -> SNOW, matching DF's own "snow is frozen/powder-state water" -- the spec's
  // named "water Powder vs Liquid" check; Liquid/other -> WATER_SPATTER), ASH=9 -> DUST,
  // MUD=12 -> MUD, VOMIT=13 -> VOMIT. Creature-sourced materials (mat_type in the
  // CREATURE_1..200 builtin range, 19..218) get a STABLE (same material -> same family every
  // time, not flickering) hash pick among the 5 blood_families -- a true hue classification
  // needs the resolved color the wire doesn't carry yet ("validates against 5+ creature mats
  // and the parity gate arbitrates" per spec; this is the documented placeholder pending that
  // extension). Everything else defaults to MUD (a neutral, plausible generic-contaminant
  // look) rather than ever defaulting to blood-red, which would violate the spec's own named
  // "snow != blood" acceptance check.
  const SPATTER_BUILTIN_FAMILY = { 9: "DUST", 12: "MUD", 13: "VOMIT" };
  // B97: material-spatter amounts are DF's 0..255 byte field. The proprietary native
  // graphics cutoff is not derivable from DFHack sources, so 25 is the first existing
  // 25-wide size-class boundary; calibrate it against paired native captures.
  const SPATTER_VISIBLE_AMOUNT = 25;
  function spatterVisible(amount, threshold) {
    const min = threshold === undefined ? SPATTER_VISIBLE_AMOUNT : threshold;
    return Number.isFinite(amount) && amount >= min;
  }
  function firstVisibleSpatter(arr) {
    if (!arr) return null;
    for (let i = 0; i < arr.length && i < 4; i++) {
      if (arr[i] && spatterVisible(arr[i].amount)) return arr[i];
    }
    return null;
  }
  // Blood-family color extension (WC-22 gap): classify a resolved descriptor rgb to the
  // nearest of the 5 BLOOD_* decal families by max-channel hue (spec §WC-12: red->RED,
  // cyan/blue->CYAN, magenta/purple->MAGENTA, yellow/green->ICHOR, grey/other->GOO).
  // Returns null when rgb is missing/malformed so the caller falls back to the stable-hash
  // pick (never a wrong-but-confident family). Verified against the golden fixture's
  // resolved [180,20,20] -> BLOOD_RED (wire_decode_test A[11][1]).
  function bloodFamilyFromRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    const r = rgb[0], g = rgb[1], b = rgb[2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 36) return "BLOOD_GOO";                    // desaturated grey -> goo
    if (r > g + 30 && b > g + 30) return "BLOOD_MAGENTA";    // red+blue both high -> purple/magenta
    if (b >= r && b >= g) return "BLOOD_CYAN";                // blue/cyan dominant
    if (r >= g && r >= b) {                                   // red dominant
      if (g >= r * 0.6 && b < g) return "BLOOD_ICHOR";        // yellow/orange (green high, blue low)
      return "BLOOD_RED";
    }
    return "BLOOD_ICHOR";                                     // green dominant -> yellow/green ichor
  }
  function spatterFamilyFor(sp) {
    if (!spatterMap || !sp) return null;
    const mt = sp.mat_type;
    if (mt === 6) return (sp.state === 3) ? "SNOW" : "WATER_SPATTER";
    const hint = SPATTER_BUILTIN_FAMILY[mt];
    if (hint) return hint;
    if (mt >= 19 && mt < 419) {
      // Prefer the server-resolved descriptor color when present (real hue classification);
      // otherwise fall back to the stable per-material hash pick over blood_families.
      const byRgb = bloodFamilyFromRgb(sp.rgb);
      if (byRgb) return byRgb;
      const blood = spatterMap.blood_families;
      if (Array.isArray(blood) && blood.length) return blood[hashInt(mt, sp.mat_index) % blood.length];
    }
    return "MUD";
  }
  // amount -> shape name from the generator's threshold table (the spec's own suggested
  // starting values; shipped uncalibrated per WC-12 -- calibration deferred).
  function spatterShapeFor(amount) {
    const thr = (spatterMap && spatterMap.amount_thresholds_default) || [];
    for (let i = 0; i < thr.length; i++) {
      const th = thr[i];
      if (th.max === null || amount <= th.max) return th.shape;
    }
    return "FULL";
  }
  function partialLetterKey(shape, gx, gy) {
    const letters = ["A", "B", "C", "D"];
    return shape + letters[hashInt(gx, gy) % letters.length];
  }
  // FULL_* direction suffix from a same-family neighbor mask (reusing the shared adjacency
  // module's cardinal bits, same infra `drawWallJoin` uses) -- cell-key letters are
  // concatenated in fixed N,S,W,E order (verified against web/spatter_map.json's own key set:
  // pairs/triples/quad all follow this exact order, e.g. "NSE" = N+S+E, skip W).
  function resolveSpatterFullKey(fam, gx, gy) {
    const Adj = window.DwfAdjacency;
    if (!Adj || typeof gx !== "number" || typeof gy !== "number") return "FULL_ISOLATED";
    let mask4 = 0;
    try {
      const mask8 = Adj.computeMask8(tileAt, gx, gy, (nt) => {
        const nsp = nt && ((nt.spatters && nt.spatters[0]) || nt.spatter);
        return !!nt && spatterVisible(nsp && nsp.amount) && spatterFamilyFor(nsp) === fam;
      });
      mask4 = mask8 & Adj.CARDINAL_BITS;
    } catch (_) { mask4 = 0; }
    let suf = "";
    if (mask4 & Adj.BIT.N) suf += "N";
    if (mask4 & Adj.BIT.S) suf += "S";
    if (mask4 & Adj.BIT.W) suf += "W";
    if (mask4 & Adj.BIT.E) suf += "E";
    if (!suf) return "FULL_ISOLATED";
    if (suf === "NSWE") {
      const letters = ["A", "B", "C", "D", "E"];
      return "FULL_NSWE_" + letters[hashInt(gx, gy) % letters.length];
    }
    return "FULL_" + suf;
  }
  // Old flat translucent wash -- kept as the last-resort fallback until spatter_map.json has
  // loaded (never blank, matches this file's "layer falls back, never throws" convention).
  function drawSpatterFallbackWash(sp, px, py, cell) {
    if (!spatterVisible(sp && sp.amount)) return;
    const a = Math.min(0.4, 0.08 + sp.amount / 400);
    ctx.fillStyle = "rgba(140,25,20," + a + ")";
    ctx.fillRect(px, py, cell, cell);
  }
  // (3) SPATTER: material-correct decal families, stacked up to 4 layered events in wire order
  // (server already orders them amount-desc).
  function drawSpatter(t, px, py, cell, gx, gy) {
    try {
      const arr = t.spatters;
      if (!arr || !arr.length) return;
      if (!spatterMap) { drawSpatterFallbackWash(firstVisibleSpatter(arr), px, py, cell); return; }
      let drewAny = false;
      for (let i = 0; i < arr.length && i < 4; i++) {
        const sp = arr[i];
        if (!sp || !spatterVisible(sp.amount)) continue;
        const fam = spatterFamilyFor(sp);
        const famDef = fam && spatterMap.families && spatterMap.families[fam];
        if (!famDef) continue;
        const shape = spatterShapeFor(sp.amount);
        const key = (shape === "FULL") ? resolveSpatterFullKey(fam, gx, gy) : partialLetterKey(shape, gx + i, gy + i);
        const cellDef = famDef.cells[key] || famDef.cells.FULL_ISOLATED;
        if (cellDef && blitCell(famDef.sheet, cellDef.col, cellDef.row, px, py, cell)) drewAny = true;
      }
      if (!drewAny) drawSpatterFallbackWash(firstVisibleSpatter(arr), px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  // (3b) ITEM-SPATTER LITTER: fallen leaves/fruit (owner-named gap). growth_class_family's 4
  // families (LEAVES/FRUIT/FRUIT_SMALL/FRUIT_LARGE) are PARTIAL-only in spatter_map.json (no
  // FULL_* cells -- litter never tiles as a solid neighbor-joined sheet), so amount always
  // maps to a PARTIAL_<n> shape (a FULL threshold hit is downgraded to the densest PARTIAL).
  function drawItemSpatterLitter(t, px, py, cell, gx, gy) {
    try {
      // B138: ONE decal per tile (native parity) -- overlapping records used to each draw a
      // multiply-tinted pass, compounding darkness. pickItemSpatterLitter selects the single
      // deterministic winner; the loser records still ride the cache/hover, just not the draw.
      const best = pickItemSpatterLitter(t.itemSpatters, spatterMap);
      if (!best) return;
      let shape = spatterShapeFor(best.isp.amount);
      if (shape === "FULL") shape = "PARTIAL_4";
      const key = partialLetterKey(shape, gx, gy);
      const cellDef = best.famDef.cells[key];
      if (!cellDef) return;
      const tint = itemSpatterTintRgb(best.fam, best.isp.rgb);
      const tinted = tint && multiplyTintedCell(best.famDef.sheet, cellDef.col, cellDef.row, tint);
      if (tinted) ctx.drawImage(tinted, 0, 0, 32, 32, px, py, cell, cell);
      else blitCell(best.famDef.sheet, cellDef.col, cellDef.row, px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  // (5) PLANT/SHRUB/SAPLING: crops and young growth via plant_map (part SHRUB/SAPLING).
  // For a SAPLING with no crop entry we opportunistically try the tree map's per-species
  // sapling before the generic _default_sapling, since that's strictly a better picture.
  function drawPlant(t, px, py, cell) {
    try {
      const p = t.plant;
      if (!p || !plantMap) return;
      const part = p.part, id = p.id;
      if (part !== "SHRUB" && part !== "SAPLING") return;
      let e = id && plantMap[id] && plantMap[id][part];
      if (!e && part === "SAPLING" && treeMap && id && treeMap[id]) e = treeMap[id].SAPLING;
      if (!e) e = (part === "SHRUB") ? plantMap._default_shrub : plantMap._default_sapling;
      if (e && e.sheet) blitCell(e.sheet, e.col, e.row, px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  // (6) TREE (WC-14, docs/superpowers/specs/2026-07-07-WC-coverage-spec.md chunk E):
  // full part x direction x dead derivation from the tile's own `ttname` (already on the
  // wire/cache -- dwf-cache.js's windowView() resolves every tile's numeric `tt` through
  // the WA-5 /tiletype_meta.json table into {ttname,shape,mat,special}, so `t.ttname` is
  // populated for every tile, no wire change needed here). v1 (pre-WC-14) keyed the sprite on
  // the wire's coarse 6-way `plant.part` enum (TRUNK/BRANCH/CANOPY/LEAVES/SAPLING/SHRUB, set
  // server-side from tiletype_shape+material -- see wire_v1.cpp's PLANT tail comment), which
  // collapsed ~200 tree tiletypes (directional trunk/branch/thick-trunk/cap variants, dead
  // wood) down to ONE cell per part per species. WC-13's tree_map.json v2 kept EVERY
  // [TREE_TILE:...] binding as species -> family -> variantKey -> cell (families: TREE_TRUNK,
  // TREE_TRUNK_THICK, TREE_TRUNK_PILLAR, TREE_BASE, TREE_BRANCH, TREE_HEAVY_BRANCH,
  // TREE_TWIGS, TREE_LEAFLESS_TWIGS, TREE_CAP); this parses the tiletype enum's own ttname
  // grammar (verified this session against the live /tiletype_meta.json: e.g. TreeTrunkNSWE,
  // TreeTrunkThickNW, TreeDeadTrunkPillar, TreeCapWallThickSW, TreeTrunkBranchN, TreeRoots) to
  // pick the exact family+variant instead of the old 4-cell fallback.
  //
  // Gate: only fires for the same 4 "wooden geometry" parts the old code handled (SAPLING/
  // SHRUB stay on drawPlant, unchanged) -- ttname is only ever one of the ~160 Tree* tiletypes
  // when part is TRUNK/BRANCH/CANOPY/LEAVES (mushroom TreeCap*/TreeDeadCap* ttnames also land
  // here via the server's MUSHROOM-material -> TRUNK part mapping).
  //
  // Residuals (documented, not a wire change): (a) TREE_TRUNK_SLOPE_* / TreeRootSloping have
  // NO direction encoded in the tiletype itself (DF renders ramp-shaped trunk/root sections
  // with a single ordinal each) -- falls back to a representative SLOPE_TOP/TRUNK cell rather
  // than neighbor-derived orientation. (b) TREE_TRUNK/TREE_BRANCH/TREE_HEAVY_BRANCH's lowercase
  // sub-adjacency variants (e.g. "NW_se") have no matching ttname at all (DF picks them by a
  // factor beyond the tiletype ordinal) -- unreachable via this parse, same as before. (c)
  // TREE_OVERLEAVES has no backing tiletype (a seasonal decorative overlay DF adds atop canopy
  // tiles) -- never emitted; seasonal leafless hook queues on WC-20's ENV `season` message
  // per the spec. (d) Burning trees (BurningTreeTrunk/... ttnames) never reach here: the
  // server's PLANT tail only fires for tiletype_material TREE/MUSHROOM/shape SAPLING|SHRUB|
  // TWIG|BRANCH|TRUNK_BRANCH, and burning tree tiletypes are tiletype_material FIRE -- no
  // wire signal to derive from client-side (WC-15/16's flow/fire overlay is the intended
  // channel; out of this item's client-only scope).
  const TREE_FLAT_FALLBACK = {
    TREE_TRUNK: "TRUNK", TREE_TRUNK_THICK: "TRUNK", TREE_TRUNK_PILLAR: "TRUNK", TREE_BASE: "TRUNK",
    TREE_BRANCH: "BRANCH", TREE_HEAVY_BRANCH: "BRANCH",
    TREE_CAP: "CANOPY",
    TREE_TWIGS: "LEAVES", TREE_LEAFLESS_TWIGS: "LEAVES",
  };

  // DF's own canonical direction-letter order is N,S,W,E (verified: the existing wallSuffix()/
  // cardinalSuffix() joins and every tree_map.json multi-letter variant key, e.g. "NWE"/"SWE"/
  // "WE", follow this same order) -- but the tiletype ENUM's PascalCase name spells its own
  // direction runs in plain left-to-right raws order, which for a handful of combinations
  // (verified against the live /tiletype_meta.json this session: TreeTrunkEW, TreeTrunkNEW,
  // TreeTrunkSEW, TreeBranchEW, ...) is NOT canonical order (E before W). Re-sorting every
  // captured letter run through this table before using it as a variant key is what makes
  // "TreeTrunkNEW" hit tree_map.json's real "NWE" cell instead of missing on a nonexistent
  // "NEW" key.
  const TREE_DIR_ORDER = "NSWE";
  function canonicalDirs(letters) {
    let out = "";
    for (let i = 0; i < TREE_DIR_ORDER.length; i++) {
      if (letters.indexOf(TREE_DIR_ORDER[i]) !== -1) out += TREE_DIR_ORDER[i];
    }
    return out;
  }

  // ttname (minus "Tree"/"Dead") -> {family, variant, altFamily?, adjacency?} or {skip:true}
  // (renders nothing -- TreeCapRamp/TreeDeadCapRamp: DF's own raws mark these "uses empty
  // tile", the true floor/ramp shows through) or null (unparsed -- falls through to the flat
  // back-compat key so an unmapped/future ttname never goes fully blank).
  function parseTreeTtname(ttname) {
    if (!ttname || ttname.indexOf("Tree") !== 0) return null;
    const dead = ttname.indexOf("Dead") !== -1;
    let rest = ttname.slice(4); // strip leading "Tree"
    if (dead) rest = rest.replace("Dead", "");
    let m;
    if (rest === "TrunkInterior") return { family: "TREE_TRUNK_THICK", variant: "INTERIOR", dead };
    if (rest === "CapInterior") return { family: "TREE_CAP", variant: "THICK_INTERIOR", dead };
    if (rest === "TrunkPillar") return { family: "TREE_TRUNK_PILLAR", variant: "_", dead };
    if (rest === "TrunkSloping") return { family: "TREE_TRUNK", variant: "SLOPE_TOP", dead };
    if (rest === "RootSloping" || rest === "Roots") return { family: "TREE_BASE", variant: "TRUNK", dead };
    if (rest === "CapRamp") return { skip: true };
    if (rest === "Twigs") {
      return { family: dead ? "TREE_LEAFLESS_TWIGS" : "TREE_TWIGS", variant: null, dead, adjacency: true };
    }
    if (rest === "Branches" || rest === "BranchesSmooth") {
      return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "NSWE", dead };
    }
    if (rest === "Branch") return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "_", dead };
    if (rest === "CapPillar") return { family: "TREE_CAP", variant: "PILLAR", dead };
    if ((m = /^CapPillar[NSEW]{1,4}$/.exec(rest))) return { family: "TREE_CAP", variant: "PILLAR", dead };
    if ((m = /^TrunkBranch([NSEW])$/.exec(rest))) return { family: "TREE_BASE", variant: "TRUNK_" + m[1], dead };
    if ((m = /^TrunkThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_TRUNK_THICK", variant: canonicalDirs(m[1]), dead };
    if ((m = /^CapWallThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_THICK_" + canonicalDirs(m[1]), dead };
    // NOTE: unlike every other family, the plain (non-THICK) CAP_WALL raw tokens join their
    // direction letters with underscores (TREE_CAP_WALL_N_S_W_E, verified against the raws --
    // TREE_CAP_WALL_THICK_SW right above stays concatenated, no underscore) -- tree_map.json's
    // variant keys follow the raw token verbatim, so the letters must be re-joined with "_"
    // here even though the ttname itself (like every tiletype enum key) has none.
    if ((m = /^CapWall([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_" + canonicalDirs(m[1]).split("").join("_"), dead };
    if ((m = /^CapFloor([1-4])$/.exec(rest))) return { family: "TREE_CAP", variant: "FLOOR_" + m[1], dead };
    if ((m = /^Trunk([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_TRUNK", variant: canonicalDirs(m[1]), dead };
    if ((m = /^Branch([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: canonicalDirs(m[1]), dead };
    return null;
  }

  // A neighbor "counts" for canopy-twig connectivity when it's a discovered TWIG/BRANCH-shape
  // tile of the tree/mushroom materials (the same connectivity DF's own engine reads to knit
  // canopy tufts together) -- reuses the shared WB-6 8-neighbor primitive (dwf-adjacency.js)
  // rather than inventing a second mask scheme.
  function isCanopyNeighbor(nt) {
    if (!nt || nt.hidden) return false;
    const shape = nt.shape || "";
    if (shape !== "TWIG" && shape !== "BRANCH") return false;
    const mat = nt.mat || "";
    return mat === "TREE" || mat === "MUSHROOM";
  }

  function treeFamilyTable(entry, family) {
    return entry && entry[family];
  }

  function resolveTreeCell(sel, id, gx, gy) {
    if (!treeMap || !sel || sel.skip) return null;
    const species = (id && treeMap[id]) || treeMap._default;
    if (!species) return null;
    let variant = sel.variant;
    if (variant === null && sel.adjacency) {
      variant = "_";
      const Adj = window.DwfAdjacency;
      if (Adj && typeof gx === "number" && typeof gy === "number") {
        const mask = Adj.computeMask8(tileAt, gx, gy, isCanopyNeighbor);
        const suffix = Adj.cardinalSuffix(mask).replace(/_/g, "");
        if (suffix) variant = suffix;
      }
    }
    function lookup(fam) {
      if (!fam) return null;
      const t1 = treeFamilyTable(species, fam);
      if (t1 && t1[variant]) return t1[variant];
      const t2 = treeFamilyTable(treeMap._default, fam);
      if (t2 && t2[variant]) return t2[variant];
      return null;
    }
    let cell = lookup(sel.family) || lookup(sel.altFamily);
    if (!cell && variant !== "_") {
      const savedVariant = variant;
      variant = "_";
      cell = lookup(sel.family) || lookup(sel.altFamily);
      variant = savedVariant;
    }
    if (!cell) {
      const flatKey = TREE_FLAT_FALLBACK[sel.family];
      if (flatKey) cell = species[flatKey] || (treeMap._default && treeMap._default[flatKey]);
    }
    return cell;
  }

  // B47 ("tree trunks render as rocks" -- the canopy z-levels looked like bare bark +
  // grey slices): DF composites a per-species TREE_OVERLEAVES leaf cell ON TOP of live
  // directional trunk/branch cells (tree_map carries them as TRUNK_<dirs> /
  // HEAVY_BRANCH_<dirs> variant keys), which is what makes a living canopy read as
  // leaves instead of bare wood. This was a documented residual ("(c) TREE_OVERLEAVES
  // ... never emitted"); resolve the overlay from the SAME parsed family+variant as the
  // base cell. Dead trees (TreeDead* ttnames) get no overlay -- their leafless look is
  // the correct one. Seasonal leafless deciduous handling remains the WC-20 hook.
  const OVERLEAVES_PREFIX = {
    TREE_TRUNK: "TRUNK_",
    TREE_BRANCH: "HEAVY_BRANCH_",
    TREE_HEAVY_BRANCH: "HEAVY_BRANCH_",
  };
  function resolveOverleaves(sel, id) {
    if (!sel || sel.dead || !treeMap) return null;
    const prefix = OVERLEAVES_PREFIX[sel.family];
    if (!prefix || !sel.variant || sel.variant === "_" || !/^[NSWE]+$/.test(sel.variant)) return null;
    const key = prefix + sel.variant;
    const sp = (id && treeMap[id]) || null;
    const own = sp && sp.TREE_OVERLEAVES && sp.TREE_OVERLEAVES[key];
    if (own) return own;
    const dflt = treeMap._default && treeMap._default.TREE_OVERLEAVES;
    return (dflt && dflt[key]) || null;
  }

  function drawTree(t, px, py, cell, gx, gy) {
    try {
      if (!treeMap) return;
      const p = t.plant;
      // B62-r2: the plant tail is MISSING on see-down-substituted tree tiles (and some live
      // trunk tiles whose wire plant lookup missed) -- previously `if (!p) return` left a bare
      // brown box. The part is fully determined by shape/mat (derivedTreePart's banner), and
      // resolution falls to tree_map._default when the species id is unknown.
      const part = (p && p.part) || derivedTreePart(t);
      if (part !== "TRUNK" && part !== "BRANCH" && part !== "CANOPY" && part !== "LEAVES") return;
      const pid = (p && p.id) || null;
      const sel = parseTreeTtname(t.ttname || "");
      if (sel && sel.skip) return; // TreeCapRamp family: DF draws the bare floor/ramp beneath
      let e = sel && resolveTreeCell(sel, pid, gx, gy);
      if (!e) {
        // Unparsed/unknown ttname (future tiletype, or a v1-era session whose ttname didn't
        // decode) -- fall back to the old flat 4-part cell so nothing goes fully blank.
        e = pid && treeMap[pid] && treeMap[pid][part];
        if (!e) e = treeMap._default && treeMap._default[part];
      }
      if (e && e.sheet) {
        blitCell(e.sheet, e.col, e.row, px, py, cell);
        const over = resolveOverleaves(sel, pid);
        if (over && over.sheet) blitCell(over.sheet, over.col, over.row, px, py, cell);
      }
    } catch (_) { /* layer guarded */ }
  }

  // (7) WALL JOINING (WB-6 upgrade, docs/superpowers/specs/2026-07-07-WB-renderer-spec.md):
  // 8-neighbor mask via the shared, renderer-agnostic dwf-adjacency.js module
  // (computeMask8, bit order N,S,W,E,NW,NE,SW,SE matching shadow_flag bits 2-9) run against
  // the CURRENT screen-window buffer (tileAt below) -- when W-A's world cache lands, the
  // SAME computeMask8 call runs in the ingest worker over chunk+ring instead (RECONCILE-WA
  // §0); only the lookup() changes. Cardinal combos produce the EXACT suffix string the old
  // 4-bit wallnbr path already used (unchanged, proven correct); the upgrade is (a) picking
  // up the bare diagonal-only corner tokens (coverage #10 -- a wall touching another wall
  // only at a corner point, common in irregular vein/cave walls, had NO representable mask
  // bit before and always fell back to the default full-wall art) and (b) routing
  // MINERAL-vein walls to the real ore-vein sheet instead of a generic stone join. Falls back
  // to the old 4-bit `wallnbr` path (module flag: DwfAdjacency missing, or no window
  // grid coords available) for one release per the spec's rollback note.
  function tileAt(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= bufW || gy >= bufH || !tileBuf) return null;
    return tileBuf[gy * bufW + gx] || null;
  }

  // WB-7 (fog report §1/§4.3 -- "the biggest visual character win"): wall/ramp/vision shadow
  // DECALS, keyed by the shared 8-neighbor adjacency mask (WB-6's computeMask8/tileAt) against
  // the committed shadow_cell_map.json table (tools/spikes/fog/derive_shadow_table.py). Pure
  // table lookups, no curves -- blue-black gradient sprite blits on floor/ramp tiles near a
  // wall, or on any discovered tile bordering fog-of-war (the vision-shadow family).
  function resolveShadowToken(table, mask8) {
    if (!shadowCellMap || !spriteMap) return null;
    const tbl = shadowCellMap[table];
    const tok = tbl && tbl[String(mask8)];
    if (!tok) return null;
    return resolveCell(tok);
  }
  function drawShadowDecals(t, px, py, cell, gx, gy) {
    try {
      const Adj = window.DwfAdjacency;
      if (!Adj || !shadowCellMap || typeof gx !== "number" || typeof gy !== "number") return;
      const shape = t.shape || "";
      // (a) wall/ramp shadow: keyed by the wall-neighbor mask of THIS tile (a floor/ramp
      // tile reads darker near an adjacent wall). Never on WALL/FORTIFICATION themselves
      // (they don't need a shadow decal on their own face) or on open air/void.
      if (shape !== "WALL" && shape !== "FORTIFICATION" && shape !== "EMPTY" && shape !== "NONE") {
        const wallMask = Adj.computeMask8(tileAt, gx, gy);
        if (wallMask) {
          const table = (shape === "RAMP" || shape === "RAMP_TOP") ? "rampShadowOnRamp" : "wallShadow";
          const cell8 = resolveShadowToken(table, wallMask);
          if (cell8) ctx.drawImage(cell8.img, cell8.col * 32, cell8.row * 32, 32, 32, px, py, cell, cell);
        }
      }
      // (b) vision shadow: keyed by the HIDDEN-neighbor mask of this (discovered) tile --
      // the fog-of-war edge. Applies regardless of shape. B235: neither a t.hidden tile NOR a
      // WT25 in-bounds tt<0 hatch tile reaches here -- both are hatched, and the caller's
      // overlaysAllowed() gate drops both. (Before B235 the gate was a bare `!t.hidden`, which
      // let the tt<0 ring bordering the last known block paint this decal and draw the
      // loaded/unloaded seam. See overlaysAllowed's banner.)
      const hiddenMask = Adj.computeMask8(tileAt, gx, gy, Adj.isHiddenTile);
      if (hiddenMask) {
        const visCell = resolveShadowToken("visionShadow", hiddenMask);
        if (visCell) ctx.drawImage(visCell.img, visCell.col * 32, visCell.row * 32, 32, 32, px, py, cell, cell);
      }
    } catch (_) { /* layer guarded */ }
  }

  function wallPrefix(mat, base_mt) {
    if (mat === "SOIL") return "SOIL_WALL";
    if (mat === "FROZEN_LIQUID") return "ICE_WALL";
    if (mat === "LAVA_STONE" || mat === "MAGMA") return "MAGMA_WALL";
    // WB-6 (coverage #10): vein material -> the real ore-vein sheet. Gem-vs-ore sub-family
    // (wall_gem.png ships 4 color families, A-D) isn't derivable from the wire's base_mt/
    // base_mi alone -- that needs an inorganic-raw lookup the client doesn't have yet (a
    // W-C wire read) -- so ORE_VEIN is the one safe, non-fabricated choice for now.
    if (mat === "MINERAL") return "ORE_VEIN_WALL";
    // B47 / WALLSFIX ("constructions show as generic grey stone"): a CONSTRUCTED wall's adjacency
    // edges come from DF's dedicated dressed-block family (ROCK_BLOCKS_WALL_<dirs>, 100% default
    // palette -> palette-swapped to the material colour in drawWallJoin), EXCEPT wood, which draws
    // its own WOODEN_WALL_<dirs> family (native oracle: oak wall = brown plank grain, iron/marble =
    // recoloured dressed blocks). The construction material now rides the wire per-tile as base_mt
    // (live since the window-#11 wire guard); base_mt>=419 == plant-sourced wood.
    if (mat === "CONSTRUCTION") return (typeof base_mt === "number" && base_mt >= 419) ? "WOODEN_WALL" : "ROCK_BLOCKS_WALL";
    return "STONE_WALL";
  }
  // B74 ("no textures for smoothed walls"): a player-DETAILED wall (smoothed, or a smoothed
  // wall that has since WORN) is a DISTINCT df::tiletype from the rough natural wall, and DF
  // draws it from a dedicated art family -- NOT the rough STONE_WALL / ORE_VEIN / MAGMA family
  // wallPrefix() returns. The detail state rides in the ttname (df::tiletype special=SMOOTH for
  // *WallSmooth<dirs>, WORN_1..3 for *WallWorn{1,2,3}); the DIRECTION still comes from open-face
  // adjacency exactly like a rough wall (DF renders detailed walls by exposed faces too), so this
  // ONLY swaps the family PREFIX and reuses the identical infix + variant cascade. Families that
  // actually ship in the raws: SMOOTHED_STONE_WALL_* / WORN{1,2,3}_STONE_WALL_* (stone family --
  // stone/mineral/feature/obsidian all smooth to plain dressed stone) and SMOOTHED_ICE_WALL_*
  // (frozen liquid). There is NO worn-ice art in the raws, so a worn ice wall degrades to the
  // smoothed-ice look (the closest real cell -- never a fabricated token). Returns null for a
  // rough/undetailed/constructed wall so the caller keeps the existing wallPrefix() family.
  function wallDetailPrefix(t) {
    const nm = (t && t.ttname) || "";
    const isIce = ((t && t.mat) || "") === "FROZEN_LIQUID";
    if (/WallSmooth/.test(nm)) return isIce ? "SMOOTHED_ICE_WALL" : "SMOOTHED_STONE_WALL";
    const worn = /WallWorn([123])$/.exec(nm);
    if (worn) return isIce ? "SMOOTHED_ICE_WALL" : ("WORN" + worn[1] + "_STONE_WALL");
    return null;
  }
  // Old 4-bit wallnbr suffix (N=1 S=2 E=4 W=8), kept as the documented rollback fallback.
  function wallSuffix(mask) {
    const parts = [];
    if (mask & 1) parts.push("N");
    if (mask & 2) parts.push("S");
    if (mask & 8) parts.push("W"); // DF token order is N, S, W, E
    if (mask & 4) parts.push("E");
    return parts.join("_");
  }
  // B36: draw a WALL's directional rock edge over its darkened base fill. DF selects the wall
  // cell from the tile's EXPOSED (open) faces, not its wall connections -- see
  // dwf-adjacency.js isOpenNeighbor/wallCellSuffix. A horizontal 1-thick wall (open N/S,
  // walls E/W) => "N_S" (rock top+bottom, dark center); a vertical run => "W_E"; an isolated
  // pillar => "N_S_W_E"; a fully-buried interior wall => null (nothing but the dark fill). The
  // per-tile variant digit uses the SHARED hashXY so canvas2d and GL pick byte-identical cells.
  // B62: the wall-join edge TOKEN for a tile given its precomputed open-face mask, or null when
  // no stone edge should be drawn -- pulled out of drawWallJoin as a pure function so the gate
  // (shape WALL, NOT a tree/mushroom trunk, has an exposed face) is unit-testable without a
  // canvas/tileBuf (tools/harness/b62_trunk_walljoin_test.mjs). Returns null for TREE/MUSHROOM
  // so a trunk/cap keeps its round drawTree cell instead of a grey STONE_WALL rubble block.
  function wallJoinBaseToken(t, openMask) {
    if ((t.shape || "") !== "WALL") return null;
    if (isTreeWallMat(t.mat || "")) return null; // B62
    const Adj = window.DwfAdjacency;
    const infix = Adj ? Adj.wallCellSuffix(openMask) : null;
    if (!infix) return null; // fully buried -> darkened base fill only
    // B74: player-smoothed/worn walls use DF's dedicated detailed-wall family; rough walls keep
    // the natural wallPrefix() family. Direction (infix) + variant cascade are identical either way.
    const prefix = wallDetailPrefix(t) || wallPrefix(t.mat || "", t.base_mt);
    return prefix + "_" + infix;
  }
  // WALLSFIX/TX16/B273: the per-material palette-swap row for construction and natural
  // stone/soil/mineral wall faces. Their relevant sheets are palette-authored; null keeps every
  // unrelated or unresolved material on its existing path.
  function wallJoinPalRow(t) {
    const m = wallMaterial(t);
    if (!m || typeof m.palRow !== "number") return null;
    return m.palRow;
  }

  function drawWallJoin(t, px, py, cell, gx, gy, knownOpenMask) {
    try {
      if (!spriteMap || (t.shape || "") !== "WALL") return;
      const Adj = window.DwfAdjacency;
      if (!Adj || typeof gx !== "number" || typeof gy !== "number") return;
      const openMask = (typeof knownOpenMask === "number") ? knownOpenMask
        : Adj.computeMask8(tileAt, gx, gy, Adj.isOpenNeighbor);
      const base = wallJoinBaseToken(t, openMask);
      if (!base) return; // not a stone wall (tree/mushroom trunk), fully buried, or unresolved
      const palRow = wallJoinPalRow(t); // per-material dressed-block colour (null => draw as-authored)
      const v = (hashXY(gx, gy) & 3) + 1;
      const cands = [base + "_" + v, base + "_1", base];
      for (let i = 0; i < cands.length; i++) {
        const e = spriteMap[cands[i]];
        if (e && e.sheet && blitCell(e.sheet, e.col, e.row, px, py, cell, (typeof palRow === "number") ? palRow : undefined)) return;
      }
    } catch (_) { /* layer guarded */ }
  }

  // ============================================================================
  // WC-18: ENGRAVINGS. Art plumbing already exists in the runtime spriteMap (both
  // ENGRAVED_STONE_WALL_* and FLOOR_STONE_ENGRAVED_* are vanilla_environment/graphics
  // TILE_GRAPHICS tokens -- graphics_tiles.txt L834-1080 -- so no generator/map work was
  // needed, unlike every other WC-17/18 sibling item). `t.engravings` is an ARRAY (a tile
  // can carry one record per engraved face -- north wall + south wall + floor
  // independently); this OR-combines every record's eflags into one mask before
  // resolving art, and takes the max quality across records (future W-D hover use).
  //
  // eflags bit layout (matches df::engraving_flags.whole, copied verbatim onto the wire
  // -- src/wire_v1.cpp's make_engraving_tail doc): floor=0, west=1, east=2, north=3,
  // south=4, hidden=5, NW=6, NE=7, SW=8, SE=9.
  const ENG_FLOOR = 0x0001, ENG_W = 0x0002, ENG_E = 0x0004, ENG_N = 0x0008, ENG_S = 0x0010,
        ENG_HIDDEN = 0x0020, ENG_NW = 0x0040, ENG_NE = 0x0080, ENG_SW = 0x0100, ENG_SE = 0x0200;
  const ENG_CARDINAL_MASK = ENG_N | ENG_S | ENG_W | ENG_E;

  // Verified vanilla asset table (graphics_tiles.txt WALL_STONE_ENGRAVED page, 19 cells):
  // every non-empty subset of {N,S,W,E} joined "_" in that canonical order (all 15 exist
  // -- 2^4-1, confirmed exhaustively against the raw) PLUS 4 lone-diagonal tokens with NO
  // underscore (NW/NE/SW/SE). A tile whose combined mask mixes a cardinal bit with a
  // diagonal bit (two separate engraving records on the same tile, e.g. north + northwest)
  // has NO exact art -- documented residual: cardinal bits win outright (diagonals
  // dropped) since a cardinal face is more visually salient than a corner nub.
  function engravingWallToken(mask) {
    const cardinal = mask & ENG_CARDINAL_MASK;
    if (cardinal) {
      const parts = [];
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

  // TX16: engraved wall decals are a wall-face subvariant, and wall_stone_engraved.png is
  // 100% default-palette art just like the rough/smoothed/worn families. Keep token choice and
  // material-row choice together so canvas2d and GL cannot drift.
  function engravingWallPlan(t, mask) {
    const token = engravingWallToken(mask);
    return token ? { token, palRow: wallJoinPalRow(t) } : null;
  }

  // B273: engraved floors ship as an explicitly paired grammar: the NON_PALETTE cell contains
  // zero default-ramp pixels; the PALETTE cell is 100% default-ramp pixels. Use the latter only
  // when the tile carries a resolvable natural material row, otherwise preserve the authored
  // fallback. This is exact substitution, never a wash over the tile or anything above it.
  function engravingFloorPlan(t) {
    const m = wallMaterial(t);
    if (m && typeof m.palRow === "number") {
      return { token: "FLOOR_STONE_ENGRAVED_PALETTE", palRow: m.palRow };
    }
    return { token: "FLOOR_STONE_ENGRAVED_NON_PALETTE", palRow: null };
  }
  function drawEngraving(t, px, py, cell, gx, gy) {
    const hits = t.engravings;
    if (!hits || !hits.length || !spriteMap) return;
    let mask = 0;
    for (let i = 0; i < hits.length; i++) mask |= (hits[i].eflags & 0x03ff);
    if (mask & ENG_HIDDEN) return; // DF hides the decoration -- draw nothing
    if (mask & ENG_FLOOR) {
      const floorPlan = engravingFloorPlan(t);
      const fe = spriteMap[floorPlan.token];
      if (fe && fe.sheet) blitCell(fe.sheet, fe.col, fe.row, px, py, cell,
        (typeof floorPlan.palRow === "number") ? floorPlan.palRow : undefined);
    }
    const plan = engravingWallPlan(t, mask);
    if (plan) {
      const we = spriteMap[plan.token];
      if (we && we.sheet) blitCell(we.sheet, we.col, we.row, px, py, cell,
        (typeof plan.palRow === "number") ? plan.palRow : undefined);
    }
  }

  // WC-4: DF's own "unknown art" placeholder (vanilla_interface/graphics/
  // graphics_defaults.txt DEFAULTS page -> defaults.png, already served via /sprites/img
  // for WC-2's item _missing cell). MISSING_BUILDING = col 0, row 1 (MISSING_CREATURE is
  // 0:0, MISSING_ITEM is 1:0). Used in place of the old workshops_1x1.png (0,0) stamp that
  // every unmapped building (beds, doors, statues, ...) used to fall back to -- a stamp
  // that reads as "this IS a workshop", which was actively misleading.
  const MISSING_BUILDING = { sheet: "defaults.png", col: 0, row: 1 };

  // WC-4: Stockpile/Civzone footprints are EXCLUDED from the building-art pass entirely --
  // they own a dedicated overlay channel (WC-7); a named predicate (rather than an inline
  // literal check) so the (8) BUILDINGS loop's early `continue` and any test of this rule
  // can't drift apart.
  function isOverlayOnlyBuildingType(type) {
    return type === "Stockpile" || type === "Civzone";
  }

  // OVL1 (ex-B57): building art is not commutative because the authored overhang row lands at
  // y1-1. Native DF paints BACK-TO-FRONT: up-screen buildings first (smaller y1, farther), then
  // down-screen buildings LAST (larger y1, nearer), so the nearer building's overhang covers the
  // up-screen one it sits in front of ("native paints down-screen-over": bottom-over-top). The
  // prior wave shipped DESCENDING (by - ay), inverting it. Ascending (ay - by) restores native.
  // Stable source order breaks exact-coordinate ties. Never mutate the AUX vector.
  function buildingsInPaintOrder(list) {
    if (!Array.isArray(list) || list.length < 2) return Array.isArray(list) ? list.slice() : [];
    return list.map((building, index) => ({ building, index })).sort((a, b) => {
      const ay = a.building && Number.isFinite(a.building.y1) ? a.building.y1 : -2147483648;
      const by = b.building && Number.isFinite(b.building.y1) ? b.building.y1 : -2147483648;
      return (ay - by) || (a.index - b.index);
    }).map((entry) => entry.building);
  }

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
  // Rule for the compatibility fallback: crgb when the server resolved a real component color,
  // else NO tint (null). B273's exact cpal palette path is selected separately below.
  // Pure + module-scope so BOTH renderers share ONE selection rule (byte-parity) and the node
  // harness can assert the rule without driving a canvas/GL context.
  function validRgbTriple(v) {
    return Array.isArray(v) && v.length === 3 &&
      Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
  }
  function pickBuildingTintRgb(b) {
    if (!b) return null;
    if (validRgbTriple(b.crgb)) return b.crgb;   // component-derived (native's true source)
    return null;   // header b.rgb NEVER tints: native draws a component-less building untinted
  }
  // B273 exact path: cpal is the first structural component's canonical STATE_COLOR token.
  // Resolve it through the same generated palette table used by items/terrain; an unknown modded
  // token returns null and deliberately retains the older crgb multiply as a graceful fallback.
  function pickBuildingPalRow(b) {
    if (!b || typeof b.cpal !== "string" || !materialMap || !materialMap.palette) return null;
    const r = materialMap.palette.byname && materialMap.palette.byname[b.cpal];
    return typeof r === "number" && materialMap.palette.rows && materialMap.palette.rows[r] ? r : null;
  }
  // B14 material-tint strength (MUST equal dwf-gl.js's BUILDING_TINT_ALPHA -- calibration
  // history lives on that constant's banner). buildingTintRgb is the closed-form white-lerp
  // multiply factor GL bakes into the instance tint; canvas2d applies the SAME factor through
  // multiplyTintedCell so a component-tinted building cell is byte-comparable across renderers
  // AND the tint is masked to the sprite's own alpha (never painted on the ground under/above
  // the art -- the workshoptint one-tile-above ground-tint spill, defect B).
  const BUILDING_TINT_ALPHA = 0.4;
  function buildingTintRgb(rgb) {
    return [
      Math.round(255 * (1 - BUILDING_TINT_ALPHA) + BUILDING_TINT_ALPHA * rgb[0]),
      Math.round(255 * (1 - BUILDING_TINT_ALPHA) + BUILDING_TINT_ALPHA * rgb[1]),
      Math.round(255 * (1 - BUILDING_TINT_ALPHA) + BUILDING_TINT_ALPHA * rgb[2]),
    ];
  }

  // (8) BUILDINGS: resolve a wire building to a building_map entry. Tries the
  // Type:Subtype alias (translating subtype int -> enum name for Workshop/Furnace),
  // then the raw int form, then the bare type token (e.g. "TradeDepot"), then
  // MISSING_BUILDING (WC-4 -- never the old `_default` workshop stamp; Stockpile/Civzone
  // never reach here at all, see the (8) BUILDINGS loop's early `continue`).
  // B63 ("soap maker shows the blue-box fallback"): a CUSTOM workshop's art lives in
  // building_map under "WORKSHOP_CUSTOM:<def id>" (the generator lifts every custom
  // [BUILDING_WORKSHOP] graphics block), but the wire ships only type=Workshop subtype=Custom
  // -- the raw def id (SOAP_MAKER, SCREW_PRESS) is NOT on the wire (world_stream.cpp's BldRec
  // has no custom_type field; a `cdef` wire field is the perfect-version DLL item). Until
  // then, match DATA-DRIVEN by footprint: vanilla's two custom defs have distinct sizes
  // (SOAP_MAKER 3x3, SCREW_PRESS 1x1), so the building's own bbox picks the right entry
  // exactly; if a modded raw set ever has two same-size custom defs, the first key wins
  // (documented residual -- needs the wire field).
  function customWorkshopEntry(b) {
    if (!buildingMap) return null;
    const w = Math.max(1, ((b.x2 | 0) - (b.x1 | 0)) + 1);
    const h = Math.max(1, ((b.y2 | 0) - (b.y1 | 0)) + 1);
    const keys = Object.keys(buildingMap);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("WORKSHOP_CUSTOM:") !== 0) continue;
      const e = buildingMap[keys[i]];
      if (e && e.w === w && e.h === h) return e;
    }
    return null;
  }

  // TX17: resolve a planned/unbuilt Construction building to its DF planned-preview entry.
  // Pure + null-guarded: returns the PLANNED_CONSTRUCTION_* building_map entry for the
  // construction's subtype (=construction_type), or null if not a Construction / subtype out of
  // range / token absent from the map (older sheet) -> caller falls through to its normal path.
  function plannedConstructionEntry(b) {
    if (!buildingMap || !b || b.type !== "Construction") return null;
    const st = (typeof b.subtype === "number") ? b.subtype : -1;
    if (st < 0 || st >= CONSTRUCTION_PLANNED_TOKEN.length) return null;
    const tok = CONSTRUCTION_PLANNED_TOKEN[st];
    return (tok && buildingMap[tok]) ? buildingMap[tok] : null;
  }

  // B253 ("missing the top half and some decorative patterning on the built statues"):
  // A BUILT STATUE IS THREE CELLS, NOT ONE -- and one of them lands on the tile ABOVE it.
  //
  //   statue's own tile : pedestal[material class][quality]   (material-tinted)
  //                     + the subject's BOTTOM cell over it   (same stone -> tinted too)
  //   one tile ABOVE    : the subject's TOP cell              (same stone -> tinted)
  //
  // DF's own model, cited: df.itemdef.xml:44-48 `item_statue_graphics_infost {flags;
  // texpos_top; texpos_bottom;}` -- the ONLY *_graphics_infost in df-structures with a
  // top/bottom texpos PAIR, i.e. a statue is DF's only 2-cell-tall built object. Its `flags`
  // (df.itemdef.xml:24-42) key the sprite on overall subject type, material class AND QUALITY
  // -- the quality column IS the decorative dentil frieze the owner is missing. The subject identity
  // is precomputed by DF onto the ITEM (df.item.xml:1532-1542 item_statuest.art_graphics_type
  // /.art_graphics_id); the BUILDING carries nothing but an unused flag (df.building.xml:1520)
  // -- the same "the art lives on the contained item" root cause as B246.
  //
  // We were resolving the statue from the BUILDING's flat building_map key, which held exactly
  // one cell: statues.png (0,0) = the plainest quality-1 stone PEDESTAL. That flat grey block
  // is pixel-for-pixel the browser capture. Everything above the plinth simply did not exist.
  //
  // WIRE (all optional -- see world_stream.cpp fill_building_ds, DLL-gated):
  //   b.smt/b.smi  the ITEM's material -- classified by the SAME matFamilyForItem() every other
  //                item uses; absent => fall back to the building's header material
  //   b.sq   quality 0..5, 6 = artifact                    -- else 0 (ordinary)
  //   b.sgt  item_statue_graphics_type_overall             -- else the DEFAULT subject
  //   b.sgi  art_graphics_id (the statue_generic_event_type when sgt=GENERIC_EVENT)
  //   b.srt  "RACE" / "RACE:CASTE" when sgt=CREATURE (932 creature statues in the map)
  // With NO wire fields at all (old DLL) this still draws pedestal + the DEFAULT subject, which
  // IS the cube-on-plinth in the native capture -- the top half comes back web-only; the
  // quality frieze and non-default subjects need the DLL.
  const STATUE_OVERALL_CREATURE = 2;      // item_statue_graphics_type_overall
  const STATUE_OVERALL_EVENT = 5;
  const STATUE_QUALITY_ARTIFACT = 6;
  function statueSubject(S, b) {
    if (!S.subjects) return S.default || null;
    const gt = (typeof b.sgt === "number") ? b.sgt : -1;
    if (gt === STATUE_OVERALL_CREATURE && b.srt && S.creature) {
      // "RACE:CASTE" first (peafowl/chicken/duck statues are caste-split), then bare RACE.
      const race = String(b.srt);
      const hit = S.creature[race] || S.creature[race.split(":")[0]];
      if (hit) return hit;
    } else if (gt === STATUE_OVERALL_EVENT && S.event) {
      const tok = S.event[String(b.sgi)];
      if (tok && S.subjects[tok]) return S.subjects[tok];
    } else if (gt >= 0 && S.overall) {
      const tok = S.overall[String(gt)];
      if (tok && S.subjects[tok]) return S.subjects[tok];
    }
    return S.default || null;   // SHAPE/ITEM/unknown/no-wire -> ITEM_DEFAULT_STATUE
  }
  function statueEntry(b) {
    if (!buildingMap || !b || b.type !== "Statue") return null;
    const S = buildingMap.statues;
    if (!S || !S.sheet || !S.pedestal) return null;    // older map -> caller's flat-key path
    // The statue's OWN stone (the item's), not the building header's -- but classified by the
    // one already-tested item classifier, so no second material taxonomy exists anywhere.
    const mat = (typeof b.smt === "number") ? { mat_type: b.smt, mat_index: b.smi } : b;
    const mc = matFamilyForItem(mat) || "STONE";
    const q = (typeof b.sq === "number") ? b.sq : 0;
    let ped = null;
    if (q >= STATUE_QUALITY_ARTIFACT && Array.isArray(S.artifact) && S.artifact.length) {
      // DF keys the artifact plinth on an `artifact_index` we don't carry; pick deterministically
      // by building id so a given artifact statue is at least STABLE across frames and clients.
      ped = S.artifact[Math.abs(b.id | 0) % S.artifact.length];
    } else {
      const row = S.pedestal[mc] || S.pedestal.STONE;
      if (row && row.length) ped = row[Math.min(Math.max(q, 0), row.length - 1)];
    }
    if (!ped) return null;
    const e = { sheet: S.sheet, w: 1, h: 1, cells: [[ped]] };
    const subj = statueSubject(S, b);
    if (subj && subj.top && subj.bottom) {
      const ssheet = subj.sheet || S.sheet;            // creature statues live on their own sheets
      e.overlaySheet = ssheet;
      e.overlay = [[subj.bottom]];
      e.overlayTint = true;                            // subject is the SAME stone as the plinth
      e.overhangSheet = ssheet;
      e.overhang = [subj.top];                         // -> one tile ABOVE (the B14 overhang row)
    }
    return e;
  }

  // B270: placed furniture has always arrived with mat_type/mat_index, and WC-6 already
  // ships `bst` for doors/hatches/floodgates/grates. The generated nested furniture table
  // was nevertheless bypassed in favour of its flat, WOOD-first Type fallback.
  //
  // DF's authored axes are explicit in df-structures: item_door/hatch/floodgate_graphics_flag
  // each carries MATERIAL + OPEN, item_grate_graphics_flag carries MATERIAL + OPEN + WALL,
  // item_cage_graphics_flag carries MATERIAL_HAS_ITEM/MATERIAL_HAS_UNIT, and
  // item_animal_trap_graphics_flag carries OCCUPIED (df.itemdef.xml:1098-1325). The matching
  // ITEM_*_OPEN/CLOSED/OCCUPIED/FULL cells are in vanilla_items_graphics/graphics_items.txt.
  // Synthesize the same one-cell building-entry shape statueEntry() uses; older maps still
  // fall through to the flat key below.
  const FURNITURE_MAT_PREF = ["WOOD", "STONE", "METAL", "GLASS", "GEM", "ROPE"];
  function furnitureMaterialKey(variants, b) {
    const family = matFamilyForItem(b);
    if (family && variants[family]) return family;
    // Rope restraints use plant-fiber materials, which the common classifier correctly calls
    // WOOD for item silhouettes. In this furniture family that same material axis is named ROPE.
    if (family === "WOOD" && variants.ROPE) return "ROPE";
    for (let i = 0; i < FURNITURE_MAT_PREF.length; i++) {
      if (variants[FURNITURE_MAT_PREF[i]]) return FURNITURE_MAT_PREF[i];
    }
    return Object.keys(variants)[0] || null;
  }
  function furnitureStateKey(b) {
    if (typeof b.bst !== "number") return null;
    switch (b.type) {
      case "Door": case "Floodgate": case "Hatch": return (b.bst & 1) ? "CLOSED" : "OPEN";
      case "GrateWall": case "GrateFloor": return (b.bst & 1) ? null : "OPEN";
      // These keys are ready for the corresponding bit when the server exports it. On the
      // current DLL these building types omit bst, so they safely stay on their base cell.
      case "Cage": case "AnimalTrap": return (b.bst & 1) ? "OCCUPIED" : null;
      case "Weaponrack": case "Armorstand": return (b.bst & 1) ? "FULL" : null;
      case "TractionBench": return (b.bst & 1) ? "ROPE" : null;
      case "Hive": return ["EMPTY", "IN_USE", "PRODUCTS"][b.bst] || null;
      default: return null;
    }
  }
  function furnitureEntry(b) {
    if (!buildingMap || !buildingMap.furniture || !b) return null;
    const f = buildingMap.furniture[b.type];
    if (!f || !f.matvariants) return null;
    let variants = f.matvariants;
    const state = furnitureStateKey(b);
    if (state && f.states && f.states[state]) {
      const sv = f.states[state];
      if (sv.sheet) return { sheet: sv.sheet, w: 1, h: 1, cells: [[sv]] };
      variants = sv;
    }
    const material = furnitureMaterialKey(variants, b);
    const c = material && variants[material];
    return c ? { sheet: c.sheet, w: 1, h: 1, cells: [[c]] } : null;
  }

  function buildingEntry(b) {
    if (!buildingMap) return MISSING_BUILDING;
    const type = b.type || "";
    const st = (typeof b.subtype === "number") ? b.subtype : -1;
    // TX17: a Construction building is always a planned/in-progress construction (built ones
    // become tiles, not buildings) -- draw DF's authored planned-preview art, never the
    // "Construction:<st>"/"Construction" keys (which don't exist -> the blue MISSING_BUILDING glyph).
    const pc = plannedConstructionEntry(b);
    if (pc) return pc;
    const furniture = furnitureEntry(b);
    if (furniture) return furniture;
    const cands = [];
    if (type === "Workshop" && st >= 0 && st < WORKSHOP_SUBTYPE.length) {
      const stName = WORKSHOP_SUBTYPE[st];
      // B63: custom workshops resolve by footprint against WORKSHOP_CUSTOM:* (see banner).
      if (stName === "Custom") {
        const ce = customWorkshopEntry(b);
        if (ce) return ce;
      }
      cands.push("Workshop:" + stName);
    }
    if (type === "Furnace" && st >= 0 && st < FURNACE_SUBTYPE.length) cands.push("Furnace:" + FURNACE_SUBTYPE[st]);
    if (type) { cands.push(type + ":" + st); cands.push(type); }
    for (let i = 0; i < cands.length; i++) {
      if (cands[i] && buildingMap[cands[i]]) return buildingMap[cands[i]];
    }
    return MISSING_BUILDING;
  }

  // WC-8: MACHINE buildings (screw pumps, water wheels, windmills, axles, gear assemblies)
  // resolve their sprite from the WC-6 wire fields (b.dir = direction, b.bst = state, bit0 =
  // machine active) against building_map.json's `machines` section (WC-5). DF authors each
  // machine as a distinct token per orientation (SCREWPUMP_N/E/S/W, WATER_WHEEL_NS/WE,
  // WINDMILL_<8dir>, AXLE_HORIZONTAL_NS/WE, AXLE_VERTICAL, GEAR_ASSEMBLY) with a 2-frame
  // animation. We select the family key from direction, pick the frame from active-state +
  // a ~2 Hz parity (rest frame 0 when inactive), and synthesize the SAME {sheet,w,h,cells}
  // shape buildingEntry returns so the existing multi-cell blit loop draws it unchanged.
  // Returns null for non-machine types / missing map data -> caller falls back to buildingEntry.
  const MACHINE_TYPES = { ScrewPump: 1, WaterWheel: 1, Windmill: 1, AxleHorizontal: 1, AxleVertical: 1, GearAssembly: 1 };
  const WINDMILL_DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const SCREWPUMP_DIR4 = ["N", "E", "S", "W"];
  function machineFamilyKey(b) {
    const dir = (typeof b.dir === "number") ? b.dir : 0;
    switch (b.type) {
      case "ScrewPump": return "SCREWPUMP_" + SCREWPUMP_DIR4[dir & 3];
      case "WaterWheel": return dir ? "WATER_WHEEL_NS" : "WATER_WHEEL_WE";
      case "AxleHorizontal": return dir ? "AXLE_HORIZONTAL_NS" : "AXLE_HORIZONTAL_WE";
      case "AxleVertical": return "AXLE_VERTICAL";
      case "GearAssembly": return "GEAR_ASSEMBLY";
      case "Windmill": return "WINDMILL_" + WINDMILL_DIR8[dir & 7];
      default: return null;
    }
  }
  // `sub` cell placement: a 2-element sub is an explicit [dx,dy] footprint offset (water
  // wheel/windmill grids); a 1-element sub is a LINEAR sub-cell index (screw pumps -- the
  // trailing index in the raws' [TILE_GRAPHICS:...:TOKEN:idx]) whose axis depends on the
  // pump's orientation, laid out row-major within the building's OWN bbox footprint (a N/S
  // pump reports a 1x2 bbox -> vertical; an E/W pump a 2x1 -> horizontal, so row-major over
  // the real footprint places both correctly without hardcoding the axis); empty sub = 1x1.
  function hasDrawableMachine(buildings) {
    if (!Array.isArray(buildings)) return false;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b && MACHINE_TYPES[b.type] && (typeof b.bst === "number") && (b.bst & 1)) return true;
    }
    return false;
  }

  function machineEntry(b, map, frameParity) {
    if (!b || !map || !map.machines || !MACHINE_TYPES[b.type]) return null;
    const key = machineFamilyKey(b);
    const fam = key && map.machines[key];
    if (!fam || !Array.isArray(fam.frames) || fam.frames.length === 0) return null;
    const active = (typeof b.bst === "number") && (b.bst & 1);
    const fi = active ? (((frameParity | 0) % fam.frames.length + fam.frames.length) % fam.frames.length) : 0;
    const frame = fam.frames[fi] || fam.frames[0];
    if (!Array.isArray(frame) || frame.length === 0) return null;
    const fpw = Math.max(1, (b.x2 | 0) - (b.x1 | 0) + 1);
    const placed = [];
    let gw = 1, gh = 1;
    for (let i = 0; i < frame.length; i++) {
      const c = frame[i]; const s = c.sub || []; let dx, dy;
      if (s.length >= 2) { dx = (s[0] | 0); dy = (s[1] | 0); }
      else if (s.length === 1) { const idx = (s[0] | 0); dx = idx % fpw; dy = Math.floor(idx / fpw); }
      else { dx = 0; dy = 0; }
      if (dx + 1 > gw) gw = dx + 1; if (dy + 1 > gh) gh = dy + 1;
      placed.push({ dx: dx, dy: dy, col: c.col, row: c.row });
    }
    const cells = [];
    for (let y = 0; y < gh; y++) { const row = []; for (let x = 0; x < gw; x++) row.push(null); cells.push(row); }
    for (let i = 0; i < placed.length; i++) { const p = placed[i]; cells[p.dy][p.dx] = { col: p.col, row: p.row }; }
    return { sheet: fam.sheet, w: gw, h: gh, cells: cells };
  }
  // ~2 Hz animation parity for machines (frozen to 0 under ?freezeAnim=1 for deterministic
  // parity captures, mirroring the GL renderer's freeze seam).
  const MACHINE_ANIM_MS = 500;
  let _machineFreezeAnim = false;
  try { _machineFreezeAnim = /[?&]freezeAnim=1\b/.test(location.search || ""); } catch (_e) { }
  function machineAnimPhase(nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    return Math.floor(nowMs / MACHINE_ANIM_MS);
  }
  function machineFrameParity(nowMs) {
    return _machineFreezeAnim ? 0 : (machineAnimPhase(nowMs) % 2);
  }
  // B206 PAUSE-ANIM: pause-aware WORLD animation clock (dwf-animclock.js). The miasma/flow
  // frame cycle (resolveFlowFrameCell) and machine frames subtract paused spans so they FREEZE
  // while the server-global game is paused and RESUME with no jump. UI clocks (status-icon blink,
  // active-designation blink) deliberately keep raw wall time. Absent module -> offset 0 (the
  // pre-B206 raw-wall-clock behaviour); never throws.
  function _animClockOffset(wallMs) {
    try {
      var c = (typeof window !== "undefined") && window.DFAnimClock;
      if (c && typeof c.offset === "function") return c.offset(wallMs) || 0;
    } catch (_e) { /* inert-graceful */ }
    return 0;
  }
  function worldAnimMs(wallMs) {
    var b = (typeof wallMs === "number" && Number.isFinite(wallMs)) ? wallMs
      : ((window.performance && performance.now) ? performance.now() : Date.now());
    return b - _animClockOffset(b);
  }
  function machineCadenceStep(buildings, nowMs, lastPhase, freezeAnim) {
    if (freezeAnim || !hasDrawableMachine(buildings)) return { phase: -1, dirty: false };
    const phase = machineAnimPhase(nowMs);
    return { phase, dirty: phase !== lastPhase };
  }

  // B27a: FARM PLOTS. texsweep emitted a null-cell FarmPlot entry (draw nothing over the crop)
  // on the assumption a tilled-soil tiletype + the crop plant already rendered the bed -- but
  // farm-plot tiles carry NO such tiletype, so empty plots vanished entirely (invisible). DF
  // draws the plot's OWN bed art: furrowed soil when fallow, the planted-rows cell when a crop
  // is assigned for the season. WC-6 gives us exactly that: b.bextra = plant_id for the current
  // season, 0xFFFF when nothing is planted (world_stream.cpp fill_building_ds). We resolve the
  // environment bed token(s) through spriteMap (the same lazy-sheet path drawWallJoin uses) into
  // the {sheet,w,h,cells} shape the building blit loop already consumes. The empty bed uses a
  // per-tile hashed FURROWED_SOIL_1..4 variant (byte-identical to GL via the shared hashXY) for
  // DF's own texture variety. Residual: a growing crop that has no separate map-plant record
  // renders the bed only (still visible, no longer blank) -- the bed art is the B27a fix.
  const FARM_EMPTY = 0xFFFF;
  function farmCellRef(token) {
    const s = spriteMap && spriteMap[token];
    return (s && s.sheet) ? s : null;
  }
  function farmPlotEntry(b) {
    if (!b || b.type !== "FarmPlot" || !spriteMap) return null;
    const hasExtra = typeof b.bextra === "number";
    const planted = hasExtra && b.bextra !== FARM_EMPTY;
    if (planted) {
      const p = farmCellRef("FARMPLOT_PLANTED") || farmCellRef("FARMPLOT") || farmCellRef("FURROWED_SOIL_1");
      if (!p) return null;
      return { sheet: p.sheet, w: 1, h: 1, cells: [[{ col: p.col, row: p.row }]] };
    }
    const fur = [];
    for (let i = 1; i <= 4; i++) { const c = farmCellRef("FURROWED_SOIL_" + i); if (c) fur.push(c); }
    if (!fur.length) {
      const f = farmCellRef("FARMPLOT");
      if (!f) return null;
      return { sheet: f.sheet, w: 1, h: 1, cells: [[{ col: f.col, row: f.row }]] };
    }
    const x1 = b.x1 | 0, y1 = b.y1 | 0;
    const w = Math.max(1, (b.x2 | 0) - x1 + 1), h = Math.max(1, (b.y2 | 0) - y1 + 1);
    const cells = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) { const c = fur[hashXY(x1 + x, y1 + y) % fur.length]; row.push({ col: c.col, row: c.row }); }
      cells.push(row);
    }
    return { sheet: fur[0].sheet, w: w, h: h, cells: cells };
  }

  // TX4: the plot bed is a building, but its per-tile planted crop must sit on TOP of that
  // bed. Resolve every stage through the shared authored-token policy; no sheet cell is
  // synthesized here. This pass runs immediately after buildings and before creatures.
  function farmCropPlans(tiles, width, height, map) {
    const policy = window.DwfFarmCrops;
    return policy && typeof policy.collect === "function"
      ? policy.collect(tiles, width, height, map || plantMap)
      : [];
  }
  function drawFarmCrops(tiles, width, height, cell) {
    const plans = farmCropPlans(tiles, width, height, plantMap);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i], c = p.cell;
      blitCell(c.sheet, c.col, c.row, p.gx * cell, p.gy * cell, cell);
    }
  }
  function paintFarmLayers(paintBuildings, paintCrops) {
    const policy = window.DwfFarmCrops;
    if (policy && typeof policy.paintAboveBuildings === "function")
      policy.paintAboveBuildings(paintBuildings, paintCrops);
    else { paintBuildings(); paintCrops(); }
  }

  // ============================================================================
  // OVERLAY LAYER (wire:5): player-facing feedback drawn ON TOP of terrain/objects/
  // creatures -- (A) designation markings and (B) multiplayer presence cursors. One
  // cohesive pass at the end of drawInner so both stay pixel-aligned with the tiles
  // and are easy to extend with future overlay kinds (zones, alerts, ...).
  // ============================================================================

  // ---- (A) DESIGNATIONS ----------------------------------------------------------
  // DF ships an in-world designation glyph sheet: designations.png (2 cols x 17 rows
  // of 32px cells; TILE_GRAPHICS:DESIGNATIONS in vanilla_interface, served here via
  // /sprites/img). We blit the matching glyph over each marked tile, under a faint
  // category-colored wash so the mark reads even before the sheet loads (synthetic
  // fallback below). Marker (blueprint) mode draws fainter with a dashed outline;
  // active designations get a solid outline.
  const DESIG_SHEET = "designations.png";
  const DESIG_CELL = {
    dig: [0, 1], channel: [0, 2], stairUp: [0, 3], stairDown: [0, 4],
    stairUpDown: [0, 5], ramp: [0, 6], removeConstruction: [0, 7], chop: [0, 8],
    gather: [0, 9], smooth: [0, 10], engrave: [0, 11], fortify: [0, 12],
    trafficLow: [0, 13], trafficHigh: [0, 14], trafficRes: [0, 15],
  };
  // B269 MINING INDICATORS -- DF's damp/warm-stone warnings, the icons that explain why a dig
  // silently never happens. mining_indicators.png is DF's own sheet (already in
  // web/interface_map.json, already served by /sprites/img):
  //   (0,0) DAMP_STONE_WARNING -- blue water drop      (graphics_interface.txt:3300)
  //   (1,0) WARM_STONE_WARNING -- orange heat waves    (graphics_interface.txt:3301)
  // Each cell has its own dashed tile border baked in (cyan / red), which is why native's damp
  // tiles show a cyan outline and NO designation wash: the icon is the entire overlay.
  // MUST byte-match dwf-gl.js's MINING_SHEET/MINING_CELL/miningIndicatorCell (pinned by
  // b269_mining_indicators_test.mjs) -- same mirrored-table convention as DESIG_CELL above.
  const MINING_SHEET = "mining_indicators.png";
  const MINING_CELL = { damp: [0, 0], warm: [1, 0] };
  let mineMode = false;
  function setMineMode(on) { mineMode = !!on; }
  // The whole decision, one place. `damp`/`warm` are evaluated SERVER-side (src/wire_v1.cpp's
  // B269 banner: DF stores no marker, and the client can reach neither the tile at z+1 nor the
  // aquifer bit nor tile temperature). The two gates are DF's own: mineable terrain only (a WALL
  // -- a floor cannot be dug, so DF never warns about one) and revealed terrain only (undiscovered
  // rock must not advertise the water behind it). Damp beats warm: native paints one 32x32 cell.
  function miningIndicatorCell(t, on) {
    if (!on || !t || t.hidden) return null;
    if ((t.shape || "") !== "WALL") return null;
    if (t.damp) return MINING_CELL.damp;
    if (t.warm) return MINING_CELL.warm;
    return null;
  }

  // carve-track adjacency mask (N=1 S=2 E=4 W=8) -> designations.png col-1 cell.
  const DESIG_TRACK_CELL = {
    1: [1, 0], 2: [1, 1], 8: [1, 2], 4: [1, 3], 3: [1, 4], 9: [1, 5], 5: [1, 6],
    10: [1, 7], 6: [1, 8], 12: [1, 9], 11: [1, 10], 7: [1, 11], 13: [1, 12],
    14: [1, 13], 15: [1, 14],
  };
  // Category color prefix for the synthetic wash / outline (alpha appended per use).
  // Automining uses a native whole-sprite multiply instead, so it has no entry here.
  const DESIG_TINT = {
    dig: "rgba(240,150,40,",
    channel: "rgba(200,105,20,", ramp: "rgba(240,175,60,",
    stair: "rgba(240,195,75,", chop: "rgba(215,150,45,", gather: "rgba(120,200,90,",
    smooth: "rgba(90,150,235,", engrave: "rgba(80,215,225,", traffic: "rgba(225,205,80,",
    track: "rgba(185,140,90,", fortify: "rgba(90,150,235,",
    removeConstruction: "rgba(220,110,55,",
  };
  // AUTOMINE-NATIVE: see the byte-identical evidence/hash and compositing proof beside
  // AUTOMINE_SPRITE_TINT in dwf-gl.js. Pure green multiplies the complete translucent DF
  // designation cell; it is not a separate wash underneath a normal-coloured pick.
  const AUTOMINE_SPRITE_TINT = [0, 255, 0];
  const CHOP_PLANT_PART = new Set(["TRUNK", "BRANCH", "CANOPY", "LEAVES", "SAPLING"]);
  // MARKER-COLOR (2026-07-13 live native probe -- see dwf-gl.js's MARKER_RECOLOR banner for
  // the full fit + residuals). Native marker mode recolours the whole designation cell blue; we
  // replace the invented (0.13 wash / 0.6 glyph / dashed outline) with a fixed blue palette. Must
  // byte-match dwf-gl.js's constants (pinned equal by marker_recolor_test.mjs).
  const DESIG_WASH_ALPHA = 0.28, DESIG_WASH_ALPHA_MARKER = 0.5;
  const MARKER_RECOLOR = [0.43, 0.68, 1.0];   // fitted native per-channel multiply (blue exact)
  const MARKER_GLYPH_TINT = [110, 173, 255];  // round(255*MARKER_RECOLOR): glyph multiply tint
  const MARKER_WASH_RGB = [32, 50, 78];       // native measured marker-wash colour (flat cell)
  const MARKER_WASH_CSS = "rgba(" + MARKER_WASH_RGB[0] + "," + MARKER_WASH_RGB[1] + "," + MARKER_WASH_RGB[2] + ",";
  const MARKER_OUTLINE_CSS = "rgba(" + MARKER_GLYPH_TINT[0] + "," + MARKER_GLYPH_TINT[1] + "," + MARKER_GLYPH_TINT[2] + ",";

  // B35: resolve a designation JOB (djobs wire array) to the same { cell, cat } shape
  // resolveDesig returns, so a tile whose designation bits were cleared by the job conversion
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
        // The track adjacency mask lived in the tile's designation, which the job cleared;
        // reuse any residual mask on the tile, else fall back to the all-directions cell.
        const m = (t && t.desig && t.desig.track) ? (t.desig.track & 15) : 15;
        return { cell: DESIG_TRACK_CELL[m] || DESIG_TRACK_CELL[15], cat: "track" };
      }
    }
    return null;
  }

  // Resolve a tile's desig wire object to { cell:[col,row], cat } or null. dig=="Default"
  // means "dig / fell tree / gather plant"; disambiguate by the tile's own material/shape
  // (the same tile record already carries mat/shape/plant), mirroring DF's own glyph pick.
  function resolveDesig(d, t) {
    if (!d) return null;
    const dig = d.dig;
    if (dig && dig !== "No") {
      switch (dig) {
        case "Channel": return { cell: DESIG_CELL.channel, cat: "channel" };
        case "Ramp": return { cell: DESIG_CELL.ramp, cat: "ramp" };
        case "UpStair": return { cell: DESIG_CELL.stairUp, cat: "stair" };
        case "DownStair": return { cell: DESIG_CELL.stairDown, cat: "stair" };
        case "UpDownStair": return { cell: DESIG_CELL.stairUpDown, cat: "stair" };
        default: {
          const mat = t.mat || "", shape = t.shape || "";
          const plantPart = (t.plant && t.plant.part) || "";
          // Native RemoveConstruction shares tile_dig_designation::Default with mining; the
          // tile material is the authoritative discriminator and the sheet has its own cell.
          if (mat === "CONSTRUCTION")
            return { cell: DESIG_CELL.removeConstruction, cat: "removeConstruction" };
          // Do not treat an arbitrary plant tail as gather. Tree roots are shape=WALL/mat=ROOT
          // but carry a TRUNK plant tail; the old generic fallback made their glyph state-dependent.
          if (mat === "TREE" || mat === "ROOT" || CHOP_PLANT_PART.has(plantPart) ||
            shape.indexOf("TRUNK") !== -1 || shape === "BRANCH" || shape === "TWIG" || shape === "SAPLING")
            return { cell: DESIG_CELL.chop, cat: "chop" };
          if (shape === "SHRUB" || mat === "PLANT" || plantPart === "SHRUB")
            return { cell: DESIG_CELL.gather, cat: "gather" };
          return { cell: DESIG_CELL.dig, cat: d.automine ? "automine" : "dig" };
        }
      }
    }
    if (d.smooth === 2) return { cell: DESIG_CELL.engrave, cat: "engrave" };
    if (d.smooth === 1) return { cell: DESIG_CELL.smooth, cat: "smooth" };
    if (d.track) { const c = DESIG_TRACK_CELL[d.track & 15]; if (c) return { cell: c, cat: "track" }; }
    if (d.traffic === 1) return { cell: DESIG_CELL.trafficLow, cat: "traffic" };
    if (d.traffic === 2) return { cell: DESIG_CELL.trafficHigh, cat: "traffic" };
    if (d.traffic === 3) return { cell: DESIG_CELL.trafficRes, cat: "traffic" };
    return null;
  }

  function resolveTileDesignation(t, djobKind) {
    const d = t && t.desig;
    let glyph = d ? resolveDesig(d, t) : null;
    if (!glyph && djobKind) glyph = resolveDjob(djobKind, t);
    return glyph ? { glyph, marker: d ? !!d.marker : false } : null;
  }

  function drawDesignation(t, px, py, cell, djobKind, nowMs, hasWorker, unitOnTile) {
    try {
      // B35/B54: map bits win; a claimed designation job is the authoritative fallback.
      const resolved = resolveTileDesignation(t, djobKind);
      if (!resolved) return;
      const r = resolved.glyph, marker = resolved.marker;
      const glyphVisible = designationGlyphVisible(djobKind, nowMs, hasWorker, unitOnTile);
      // WB-5 designated-hidden lighten (fog report §1/§4.4, evidence: 154 designated hidden
      // tiles measured rendered-minus-sprite = +(27,29,26) under the pick icon). ADDITIVE
      // (globalCompositeOperation="lighter") so it brightens the hidden-rock hatch underneath
      // rather than tinting it; drawn FIRST (i.e. literally "under" the icon/wash below).
      // B38 (bug list): the pick glyph in designations.png is a ~35%-alpha mid-grey overlay
      // (measured avgRGB ~93,92,98) that only reads over a LIGHTENED backdrop. B36 (e5294e7)
      // turned REVEALED wall interiors from a full bright block into a dark fill, so a revealed
      // designated wall adjacent to a mined corridor lost this backdrop and its pick vanished --
      // while the still-hidden rock behind (which keeps the lighten) stayed visible, exactly as
      // The owner reported. Extend the SAME additive lighten to revealed WALL designated tiles so the
      // glyph reads over B36's dark interior (GL parity: dwf-gl.js buildTile's ATTR_ADDITIVE
      // emit uses the identical hidden||WALL gate + the same 27,29,26 designationLighten value).
      // Non-wall revealed terrain (floors/ramps) is drawn bright already and native does not
      // brighten it, so the dark-backdrop lighten stays gated to hidden || shape==="WALL".
      if (r.cat !== "automine" && (t.hidden || (t.shape || "") === "WALL")) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgb(27,29,26)";
        ctx.fillRect(px, py, cell, cell);
        ctx.restore();
      }
      const tint = DESIG_TINT[r.cat] || DESIG_TINT.dig;
      // (a) category wash -- makes the tile obviously marked in any sheet state. MARKER-COLOR:
      // marker mode swaps the category colour for native's fixed marker-blue (the whole cell
      // reads blue), NOT a fainter version of the orange wash (see MARKER_RECOLOR banner).
      if (marker || r.cat !== "automine") {
        ctx.fillStyle = marker ? (MARKER_WASH_CSS + DESIG_WASH_ALPHA_MARKER + ")") : (tint + DESIG_WASH_ALPHA + ")");
        ctx.fillRect(px, py, cell, cell);
      }
      // (b) DF glyph, or a synthetic icon if the sheet isn't loaded yet. The category wash
      // stays visible while a claimed mining glyph is in its off beat, matching DF's pulse.
      if (glyphVisible) {
        const s = getSheet(DESIG_SHEET);
        let blitted = false;
        if (s && s.loaded && !s.failed) {
          // MARKER-COLOR: marker glyph is recoloured by the fitted per-channel tint via the shared
          // multiplyTintedCell offscreen (draw->multiply->destination-in), byte-identical to
          // dwf-gl.js's `texel * MARKER_GLYPH_TINT` instance-tint path. Non-marker draws raw.
          const spriteTint = marker ? MARKER_GLYPH_TINT : (r.cat === "automine" ? AUTOMINE_SPRITE_TINT : null);
          const tc = spriteTint ? multiplyTintedCell(DESIG_SHEET, r.cell[0], r.cell[1], spriteTint) : null;
          if (tc) {
            ctx.drawImage(tc, 0, 0, 32, 32, px, py, cell, cell);
          } else {
            ctx.drawImage(s.img, r.cell[0] * 32, r.cell[1] * 32, 32, 32, px, py, cell, cell);
          }
          blitted = true;
        }
        if (!blitted && cell >= 4) drawDesigSynthetic(r.cat, px, py, cell);
        // WC-19: dig-priority numeral badge in the tile's bottom-right quadrant (DF shows the
        // priority number on a designated tile; the server only emits a tail for NON-default
        // priority, so a badge appears exactly when the mark isn't the default priority 4).
        drawDesigPriority(t, px, py, cell);
      }
      // (c) outline. MARKER-COLOR: marker mode is now a SOLID marker-blue outline (native has no
      // dashed outline -- the whole cell recolours), not the old dashed category-colour outline.
      if (cell >= 4) {
        ctx.save();
        ctx.strokeStyle = marker ? (MARKER_OUTLINE_CSS + "0.9)") : (tint + "0.9)");
        ctx.lineWidth = marker ? 1 : 1.5;
        ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
        ctx.restore();
      }
    } catch (_) { /* overlay guarded */ }
  }

  // B269: blit DF's damp/warm mining indicator over one tile. Drawn AFTER the designation pass,
  // so a still-designated damp wall shows the pick with the drop on top. No synthetic fallback:
  // the cell is real DF art (mining_indicators.png) and inventing a stand-in glyph is exactly what
  // AGENTS.md forbids -- if the sheet has not loaded yet, getSheet() starts it and the icon appears
  // on the next frame.
  function drawMiningIndicator(t, px, py, cell) {
    try {
      const mc = miningIndicatorCell(t, mineMode);
      if (!mc) return;
      const s = getSheet(MINING_SHEET);
      if (!s || !s.loaded || s.failed) return;
      ctx.drawImage(s.img, mc[0] * 32, mc[1] * 32, 32, 32, px, py, cell, cell);
    } catch (_) { /* overlay guarded */ }
  }

  // Synthetic per-category glyph for when designations.png hasn't loaded -- keeps the
  // overlay meaningful (a mark, not just a wash) so feedback never depends on the sheet.
  function drawDesigSynthetic(cat, px, py, cell) {
    const cx = px + cell / 2, cy = py + cell / 2, r = Math.max(2, cell * 0.28);
    ctx.save();
    ctx.strokeStyle = cat === "automine" ? "rgb(0,255,0)" : "rgba(18,14,8,0.92)";
    ctx.lineWidth = Math.max(1, cell / 12);
    ctx.beginPath();
    if (cat === "dig" || cat === "automine" || cat === "chop") {
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);            // pick shaft
      ctx.moveTo(cx + r * 0.35, cy - r); ctx.lineTo(cx + r, cy - r * 0.35); // pick head
    } else if (cat === "channel") {
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx, cy + r); ctx.lineTo(cx + r, cy - r);
    } else if (cat === "ramp" || cat === "stair") {
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    } else if (cat === "gather") {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (cat === "smooth" || cat === "engrave") {
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      if (cat === "engrave") { ctx.moveTo(cx - r, cy + r * 0.5); ctx.lineTo(cx + r, cy + r * 0.5); }
    } else {                                                            // traffic / track
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    }
    ctx.stroke();
    ctx.restore();
  }

  // WC-19: dig-priority numeral. Blits overlay_map.designation_priority[level] (the vanilla
  // designation_priority.png numerals 1..7) at ~55% scale into the tile's bottom-right corner
  // so it reads alongside, not over, the designation glyph. No-op until overlay_map + the sheet
  // load (same "overlay falls back to nothing, never throws" posture as drawDesignation).
  function drawDesigPriority(t, px, py, cell) {
    try {
      const dp = t.desigPriority;
      if (!dp || !overlayMap || !overlayMap.designation_priority) return;
      const lvl = dp.priority | 0;
      if (lvl < 1 || lvl > 7) return;
      const e = overlayMap.designation_priority[String(lvl)];
      if (!e || !e.sheet) return;
      const s = getSheet(e.sheet);
      if (!s || !s.loaded || s.failed) return;
      const sz = Math.max(8, Math.round(cell * 0.55));
      ctx.drawImage(s.img, e.col * 32, e.row * 32, 32, 32, px + cell - sz, py + cell - sz, sz, sz);
    } catch (_) { /* overlay guarded */ }
  }

  // WC-19: item-designation mark token from an item's iflags (wire_v1.h bits: web=0x01,
  // forbid=0x02, dump=0x04, melt=0x08, on_fire=0x10). Combos resolve to the vanilla
  // DESIGNATION_ITEM_FORBIDDEN_{MELT,DUMP} cells when both bits are set. Returns null when the
  // item carries no drawable mark. Shared shape with the GL port so the two can't drift.
  function itemMarkToken(iflags) {
    if (!iflags) return null;
    const forbid = iflags & 0x02, dump = iflags & 0x04, melt = iflags & 0x08;
    if (forbid && melt) return "DESIGNATION_ITEM_FORBIDDEN_MELT";
    if (forbid && dump) return "DESIGNATION_ITEM_FORBIDDEN_DUMP";
    if (forbid) return "DESIGNATION_ITEM_FORBIDDEN";
    if (melt) return "DESIGNATION_ITEM_MELT";
    if (dump) return "DESIGNATION_ITEM_DUMP";
    return null;
  }
  // WC-19: blit the item-mark glyph over a marked ground item (top-left corner, ~55% scale).
  function drawItemMark(t, px, py, cell) {
    try {
      if (!t.item || !overlayMap || !overlayMap.designation_item) return;
      const token = itemMarkToken(t.item.iflags);
      if (!token) return;
      const e = overlayMap.designation_item[token];
      if (!e || !e.sheet) return;
      const s = getSheet(e.sheet);
      if (!s || !s.loaded || s.failed) return;
      const sz = Math.max(8, Math.round(cell * 0.55));
      ctx.drawImage(s.img, e.col * 32, e.row * 32, 32, 32, px, py, sz, sz);
    } catch (_) { /* overlay guarded */ }
  }

  // WC-22: projectiles + vehicles in flight (data.proj, from the AUX stream). Each record is
  // { x,y,z, fx,fy (sub-tile 0..255), item_type, subtype, mat_type, mat_index, vehicle }.
  // fx/fy encoding (world_stream.cpp:803/818, authoritative): DF's fine offset
  // (-50000..50000, 0 = tile CENTER) remapped to 0..255 -- 128 means "centered on the
  // tile", 0/255 a half-tile either way. Decoded as a signed offset AROUND the tile
  // center, NOT a fraction from the tile origin (origin-fraction decoding renders up to a
  // full tile off -- caught by the completeness-matrix pass against the encoder source).
  // Rendered as a world-positioned marker at the exact sub-tile offset -- a small bright bolt
  // for thrown/fired projectiles, a boxier cart glyph for vehicles (minecarts). z-filtered to
  // the camera plane (the server already window+z-filters, this is belt-and-suspenders).
  function projCenterPx(worldCoord, originCoord, fraw, cell) {
    const off = ((typeof fraw === "number" ? fraw : 128) - 128) / 255; // -0.5..+0.5 tiles
    return (worldCoord - originCoord + 0.5 + off) * cell;
  }
  // B256 ("archers fire white circles instead of the correct bolt sprite"). DF has NO projectile
  // sprite sheet: graphics_items.txt binds the art to the AMMO ITEM itself
  // ([AMMO_GRAPHICS:ITEM_AMMO_BOLTS] -> AMMO_GRAPHICS_STRAIGHT_DEFAULT:ITEM_AMMO:0:1), so a bolt
  // in flight draws the SAME cell a bolt on the floor draws. (The UNIT_STATUS row-37 PROJECTILE
  // icon is a different mechanism -- a UNIT flung through the air, B248's territory.)
  // The AUX wire has carried (item_type, subtype, mat_type, mat_index) per projectile since
  // WC-22; the only missing hop was the numeric item_type -> "AMMO" key (see itemTypeNames).
  // With it, a projectile is just an ITEM, so the ONE resolveItemVisual chain every ground item
  // uses covers bolts/arrows/blowdarts/ballista ammo AND anything thrown (a hurled spear is
  // item_type WEAPON, a catapulted rock is BOULDER) -- no per-ammo table, nothing to keep in sync.
  // Returns null when the type is unknown or resolves to the MISSING placeholder box: the caller
  // then keeps the legacy marker, so a projectile is never invisible.
  function projItemVisual(p) {
    if (!p || typeof p.item_type !== "number" || p.item_type < 0) return null;
    const type = itemTypeNames && itemTypeNames.get(p.item_type);
    if (!type) return null;
    const v = resolveItemVisual({
      type,
      subtype: typeof p.subtype === "number" ? p.subtype : -1,
      mat_type: typeof p.mat_type === "number" ? p.mat_type : -1,
      mat_index: typeof p.mat_index === "number" ? p.mat_index : -1,
      iflags: 0,
    });
    return (v && v.entry && v.entry.sheet && v.source !== "missing") ? v : null;
  }
  function drawProjectiles(data, ox, oy, oz, cell) {
    const projs = Array.isArray(data.proj) ? data.proj : [];
    if (!projs.length) return;
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      if (!p || (typeof p.z === "number" && p.z !== oz)) continue;
      try {
        const cx = projCenterPx(p.x, ox, p.fx, cell), cy = projCenterPx(p.y, oy, p.fy, cell);
        // B256: real item art for a projectile in flight, drawn full-cell centred on the
        // sub-tile position (same palette-swap rule as the ground item layer, so a copper bolt
        // is copper-coloured). Vehicles keep their marker: a minecart's own ITEM sprite is
        // already drawn by the tile layer underneath (T1 parity fix), so a second full-cell
        // cart sprite there would double-draw it.
        if (!p.vehicle) {
          const v = projItemVisual(p);
          if (v) {
            const it = { type: v.entry && itemTypeNames.get(p.item_type), mat_type: p.mat_type, mat_index: p.mat_index };
            let palRow;
            if (materialMap && PALETTIZABLE_SOURCE[v.source]) {
              const pr = matPalRowFor(it);
              if (typeof pr === "number") palRow = pr;
            }
            const px = cx - cell / 2, py = cy - cell / 2;
            if (blitCell(v.entry.sheet, v.entry.col, v.entry.row, px, py, cell, palRow, true)) {
              if (palRow === undefined) drawItemTint(p.mat_type, px, py, cell);
              continue;   // art drew -- no placeholder marker on top of it
            }
          }
        }
        ctx.save();
        if (p.vehicle) {
          // minecart/vehicle: a small filled square outline.
          const s = Math.max(3, cell * 0.5);
          ctx.fillStyle = "rgba(180,150,90,0.9)";
          ctx.strokeStyle = "rgba(40,30,10,0.9)";
          ctx.lineWidth = 1;
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
          ctx.strokeRect(cx - s / 2 + 0.5, cy - s / 2 + 0.5, s - 1, s - 1);
        } else {
          // projectile (bolt/stone/etc.): a bright dot with a dark outline.
          const rr = Math.max(1.5, cell * 0.16);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(250,240,200,0.95)";
          ctx.fill();
          ctx.strokeStyle = "rgba(30,20,10,0.9)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      } catch (_) { /* per-projectile guarded */ }
    }
  }

  // ---- B139: FLOW CLOUDS (miasma/smoke/mist/...) ----------------------------------
  // The block wire has carried a per-tile densest-flow record since WC-15 (t.cloud =
  // {type, density}, decoded by dwf-wire-v1.js and surfaced by the cache's
  // windowView) -- but NEITHER renderer ever consumed it, so the owner saw zero miasma in the
  // browser. Native v50 draws a flow as ONE translucent cloud cell over the tile
  // (creatures/items read through it); this mirrors that -- a soft radial haze filling
  // the cell, opacity from density, breathing gently on the SAME shared 800ms beat the
  // status icons/designations already use (no second timer, no particle system).
  // FLOW_STYLES is the whole per-type policy: adding smoke/mist/dust later is ONE line
  // here (+ its gl.js twin) -- the wire and decode already carry every df::flow_type.
  // TX18: each style names the NATIVE EVENT_FLOWS art token DF authors for that flow type
  // (graphics_flows.txt -> web/flow_map.json, verified by tools/ws2/build_flow_map.py). The
  // token resolves through the SAME spriteMap (/sprites/map.json, WC-10) every terrain sprite
  // uses -- so miasma draws DF's own 4-frame FLOW_MIASMA cloud, not a flat wash. `rgb` is kept
  // ONLY as the fallback tint for the procedural haze used when the sheet isn't loaded yet (or
  // in the headless harness with no real atlas). Adding smoke/mist/dust later is still one line.
  var FLOW_STYLES = {
    0: { token: "FLOW_MIASMA", rgb: [150, 64, 176] },   // Miasma: native EVENT_FLOWS art (TX18; was flat haze in B139)
    // 1 Steam / 9 MaterialGas: { token: "FLOW_BOILING",   rgb: [200, 220, 235] }
    // 2 Mist:                  { token: "FLOW_WATER_MIST", rgb: [200, 220, 235] }
    // 3 MaterialDust:          { token: "FLOW_DUST",       rgb: [180, 160, 120] }
    // 4 MagmaMist:             { token: "FLOW_LAVA_MIST",  rgb: [235, 120, 60]  }
    // 5 Smoke / 6 Dragonfire / 7 Fire ... ride the same record shape (tokens in web/flow_map.json).
  };
  // density -> opacity: floor 0.2 so even a 1-density wisp reads as a cloud (native shows
  // the cloud cell regardless), saturating at ~0.75 by density 64 (miasma lives in 1..~25;
  // hotter flow types can hit the wire's 255 clamp). Beat half B dips to 78% -- a subtle
  // roil, exact anti-phase machinery shared with the status-icon blink.
  function flowOverlayFor(cloud, nowMs) {
    if (!cloud || typeof cloud.type !== "number") return null;
    var style = FLOW_STYLES[cloud.type];
    var d = typeof cloud.density === "number" ? cloud.density : 0;
    if (!style || d <= 0) return null;
    var a = 0.2 + 0.55 * Math.min(1, d / 64);   // fallback-haze alpha (unchanged)
    // TX18: the authored sprite carries DF's own texture + baked translucency, so it draws at a
    // STRONG, non-faint alpha (density only GATES the cloud; native doesn't fade the sprite per
    // density). Both alphas share the 800ms beat roil so the two paths pulse in lockstep.
    var sa = 0.9;
    if (!unitStatusBlinkVisible(nowMs)) { a *= 0.78; sa *= 0.85; }
    return { token: style.token || null, rgb: style.rgb, alpha: a, spriteAlpha: sa };
  }
  // TX18: resolve the native flow art to a concrete sheet cell, cycling the authored frames on
  // the 4Hz clock the GL shader uses for the same token (defaultAnimRateCodeForToken -> 4Hz).
  // Returns null when the sheet isn't loaded (or spriteMap lacks the token) so drawFlows falls
  // back to the procedural haze -- never a blank tile.
  function resolveFlowFrameCell(token, nowMs) {
    var entry = spriteMap && spriteMap[token];
    if (!entry || !entry.sheet) return null;
    var sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    var frames = entry.frames;
    if (frames && frames.length > 1) {
      var fi = Math.floor((nowMs / 1000) * 4) % frames.length;
      var f = frames[fi] || frames[0];
      if (f && typeof f.col === "number") return { img: sheet.img, col: f.col, row: f.row };
    }
    return { img: sheet.img, col: entry.col, row: entry.row };
  }
  function drawFlows(tiles, n, gw, cell, nowMs) {
    for (var i = 0; i < n; i++) {
      var t = tiles[i];
      if (!t || !t.cloud || t.hidden) continue;
      var plan = flowOverlayFor(t.cloud, nowMs);
      if (!plan) continue;
      var a = plan.alpha, sa = plan.spriteAlpha;
      // see-down substituted tile (e.g. waterfall mist below the camera): dim with depth,
      // floored so a deep cloud stays a readable wisp (same instinct as B23's unit floor).
      if (typeof t.depth === "number" && t.depth > 0) {
        var dim = Math.max(0.35, 1 - 0.12 * t.depth); a *= dim; sa *= dim;
      }
      var gx = i % gw, gy = (i - gx) / gw;
      var px = gx * cell, py = gy * cell;
      try {
        // TX18: DF's own authored miasma art (EVENT_FLOWS FLOW_MIASMA) when the sheet is loaded.
        var fs = plan.token ? resolveFlowFrameCell(plan.token, nowMs) : null;
        if (fs) {
          var prevA = ctx.globalAlpha;
          ctx.globalAlpha = Math.max(0, Math.min(1, sa));
          ctx.drawImage(fs.img, fs.col * 32, fs.row * 32, 32, 32, px, py, cell, cell);
          ctx.globalAlpha = prevA;
          continue;
        }
        // Fallback (sheet not loaded / headless): the B139 procedural purple haze.
        var cx = px + cell * 0.5, cy = py + cell * 0.5;
        var rr = cell * 0.72;   // bleeds slightly past the cell so adjacent clouds merge
        var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        grad.addColorStop(0, "rgba(" + plan.rgb[0] + "," + plan.rgb[1] + "," + plan.rgb[2] + "," + a.toFixed(3) + ")");
        grad.addColorStop(0.62, "rgba(" + plan.rgb[0] + "," + plan.rgb[1] + "," + plan.rgb[2] + "," + (a * 0.6).toFixed(3) + ")");
        grad.addColorStop(1, "rgba(" + plan.rgb[0] + "," + plan.rgb[1] + "," + plan.rgb[2] + ",0)");
        ctx.fillStyle = grad;
        ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      } catch (_) { /* per-cloud guarded */ }
    }
  }

  // ---- (B) MULTIPLAYER PRESENCE --------------------------------------------------
  // data.players[] (spliced into /mapdata by the server) lists every connected
  // player's live cursor in WORLD tile coords, plus any in-progress designation drag.
  // Each renders in a stable per-name color with a name label; self is skipped. A
  // player on another z-level is faded and tagged up/dn.
  function playerColor(name) {
    let h = 2166136261 >>> 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    // WP-A color audit: Math.imul yields a SIGNED int32, so `h % 360` could be negative;
    // CSS wraps hsl(-93)->267 so the RENDERED color never changed, but gl.js's playerColorRgb
    // used `(h>>>0)%360` which (2^32 % 360 == 256) rotated ~half of all names' GL tint 104deg
    // off the visible cursor/label color. Both now normalize the SIGNED value the CSS way --
    // render-identical here, and gl.js now matches this exact hue.
    const hue = ((h % 360) + 360) % 360;
    return { fill: `hsl(${hue},85%,58%)`, dark: `hsl(${hue},60%,24%)` };
  }

  // Presence DISPLAY text: a raw session-key name (anon pre-join connection echoed by the roster)
  // must render as "Guest 1665", never as a truncated UUID. Route through dwf-lobby.js's ONE
  // canonical anonymizer (window.DwfLobby.displayName) so cursor labels match the lobby chip / minimap
  // / z-scrollbar exactly; graceful pass-through of the raw name if lobby isn't present (Node harness).
  function presenceLabel(name) {
    try {
      if (window.DwfLobby && typeof DwfLobby.displayName === "function")
        return DwfLobby.displayName(name).text;
    } catch (_) {}
    return String(name == null ? "" : name);
  }

  // WP-A §3.2/§4.1: surface the connected-player roster (the server's additive players[])
  // to non-GL UI -- the WT02 elevation triangles, the WT05 minimap viewboxes, and the WT03(a)
  // lobby panel all read it. BOTH the ws-AUX path (handleAuxV1) and the legacy /mapdata poll
  // path (pollLoop) call publishRoster() so the roster stays fed on either transport. Consumers
  // subscribe via window.DwfPresence.onChange(cb); cb fires at AUX rate and each consumer
  // throttles its own repaint. Kept lightweight (a shared array + subscriber list) with no
  // per-tick allocation churn beyond the array the server already handed us.
  // Created EAGERLY at load (tiles.js loads before the consumers -- controls-placement.js,
  // unit-hud-notifications.js, the lobby) so their onChange() bindings never miss the object.
  (function ensurePresence() {
    try {
      if (window.DwfPresence) return;
      const subs = [];
      window.DwfPresence = {
        roster: [],
        onChange(cb) { if (typeof cb === "function") { subs.push(cb); try { cb(this.roster); } catch (_) {} } },
        _emit(next) {
          this.roster = Array.isArray(next) ? next : [];
          for (let i = 0; i < subs.length; i++) { try { subs[i](this.roster); } catch (_) {} }
        },
      };
    } catch (_) { /* non-browser context */ }
  })();
  function publishRoster(list) {
    try {
      const P = window.DwfPresence;
      if (P && typeof P._emit === "function") P._emit(Array.isArray(list) ? list : []);
    } catch (_) { /* presence surface is best-effort; never break the render path */ }
  }

  function drawPresence(data, ox, oy, oz, cell, gw, gh) {
    const players = Array.isArray(data.players) ? data.players : [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.name === player) continue;               // never draw our own cursor
      // WP-A §1.2 consumer guard: the roster now carries cursor-less entries (idle/no-cursor
      // players). Without numeric x/y the tile math below produces NaN, which slips through the
      // `tx < -1` window guard and paints at NaN -- so skip any entry lacking a live cursor.
      if (typeof p.x !== "number" || typeof p.y !== "number") continue;
      try {
        const col = playerColor(p.name);
        const sameZ = (typeof p.z !== "number") || p.z === oz;
        // (1) their drag rectangle (in-progress designation), in their color.
        if (p.drag && typeof p.dx === "number" && typeof p.dy === "number") {
          const gx0 = Math.min(p.x, p.dx) - ox, gy0 = Math.min(p.y, p.dy) - oy;
          const gx1 = Math.max(p.x, p.dx) - ox + 1, gy1 = Math.max(p.y, p.dy) - oy + 1;
          const rx = gx0 * cell, ry = gy0 * cell, rw = (gx1 - gx0) * cell, rh = (gy1 - gy0) * cell;
          ctx.save();
          ctx.fillStyle = col.fill; ctx.globalAlpha = sameZ ? 0.16 : 0.08;
          ctx.fillRect(rx, ry, rw, rh);
          ctx.globalAlpha = sameZ ? 0.9 : 0.4;
          ctx.strokeStyle = col.fill; ctx.lineWidth = 2;
          ctx.strokeRect(rx + 1, ry + 1, Math.max(1, rw - 2), Math.max(1, rh - 2));
          ctx.restore();
        }
        // (2) cursor marker + name label at their tile.
        const tx = p.x - ox, ty = p.y - oy;
        if (tx < -1 || ty < -1 || tx > gw || ty > gh) continue;   // outside our window
        const cxp = tx * cell, cyp = ty * cell;
        ctx.save();
        ctx.globalAlpha = sameZ ? 1 : 0.5;
        ctx.strokeStyle = col.fill; ctx.lineWidth = 2;
        ctx.strokeRect(cxp + 1, cyp + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));
        // caret in the top-left corner so the exact tile is unambiguous
        ctx.fillStyle = col.fill;
        const cs = Math.min(12, cell * 0.6);
        ctx.beginPath();
        ctx.moveTo(cxp, cyp); ctx.lineTo(cxp + cs, cyp); ctx.lineTo(cxp, cyp + cs); ctx.closePath(); ctx.fill();
        // name (+ up/dn when on another z-level)
        let label = presenceLabel(p.name) || "?";
        if (label.length > 14) label = label.slice(0, 13) + "…";
        if (!sameZ) label += (p.z > oz ? " ↑" : " ↓");
        ctx.font = "11px monospace";
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        const tw = ctx.measureText(label).width;
        const lx = cxp, ly = cyp - 14;
        ctx.globalAlpha = sameZ ? 0.95 : 0.55;
        ctx.fillStyle = col.dark;
        ctx.fillRect(lx, ly, tw + 8, 13);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, lx + 4, ly + 1);
        ctx.restore();
      } catch (_) { /* per-player guarded */ }
    }
  }

  // ---- (C) SMOOTH SUB-TILE CURSORS (Figma-style, over the WebSocket) -------------
  // Upgrade of the tile-snapped presence cursors above to precise, interpolated ones.
  //  SEND: on mousemove we convert the pointer to WORLD coords -- integer tile (x,y) plus a
  //    fractional in-tile offset (fx,fy in 0..1), camera-independent via getRenderRect --
  //    and push {type:"cursor",x,y,z,fx,fy} over the WS at ~25/s. The tile-snapped HTTP
  //    /placement-cursor keeps running as the presence heartbeat + fallback when WS is down.
  //  RECV: the host pushes {type:"cursors",players:[...]} at ~25/s; we interpolate each OTHER
  //    player's cursor between its last two positions (lerp over ~70ms) and paint it on a
  //    dedicated transparent overlay canvas at 60fps -- buttery motion without repainting the
  //    map. Cursors fade with |viewerZ - theirZ| and age out when a player stops moving.
  const CURSOR_SEND_MS = 40;    // ~25/s outbound throttle
  const CURSOR_LERP_MS = 70;    // interpolate over the gap between two received positions
  const CURSOR_TTL_MS = 1500;   // drop a cursor we stop hearing about (player left / idle)
  const CURSOR_ZFADE_N = 6;     // opacity = max(0, 1 - |dz|/N); invisible beyond N z-levels

  let lastCursorSend = 0;
  let lastCursorKey = "";
  const smoothCursors = new Map();   // name -> { rx,ry, fromX,fromY, toX,toY, tStart, z, drag, lastSeen }
  let cursorCanvas = null, cursorCtx = null, cursorRaf = null;

  // SEND: pointer -> world coords, throttled; WS only (HTTP presence remains the fallback).
  function sendSmoothCursor(clientX, clientY) {
    if (!window.DwfWS || typeof DwfWS.isConnected !== "function" ||
        !DwfWS.isConnected()) return;
    const rr = getRenderRect();
    if (!rr || rr.cell <= 0) return;
    const gxf = (clientX - rr.left) / rr.cell;
    const gyf = (clientY - rr.top) / rr.cell;
    if (gxf < 0 || gyf < 0 || gxf >= rr.gw || gyf >= rr.gh) return;   // off the drawn map
    const gx = Math.floor(gxf), gy = Math.floor(gyf);
    const fx = Math.round((gxf - gx) * 1000) / 1000;
    const fy = Math.round((gyf - gy) * 1000) / 1000;
    const x = rr.ox + gx, y = rr.oy + gy;
    const key = x + "," + y + "," + fx + "," + fy;
    if (key === lastCursorKey) return;                               // unchanged -> skip
    lastCursorKey = key;
    DwfWS.send({ type: "cursor", x: x, y: y, z: rr.oz, fx: fx, fy: fy });
  }

  function bindSmoothCursorSend() {
    if (!canvas) return;
    canvas.addEventListener("mousemove", (event) => {
      try {
        const now = Date.now();
        if (now - lastCursorSend < CURSOR_SEND_MS) return;
        lastCursorSend = now;
        sendSmoothCursor(event.clientX, event.clientY);
      } catch (_) { /* never throw out of an input handler */ }
    }, { passive: true });
  }

  // RECV: fold a pushed players[] into the interpolation map. Each update re-aims the lerp
  // target at the new world position, starting from the currently rendered position.
  function ingestSmoothCursors(players) {
    if (!Array.isArray(players)) return;
    const now = Date.now();
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
      if (p.name === player) continue;                               // never our own cursor
      const wx = p.x + (typeof p.fx === "number" ? p.fx : 0);
      const wy = p.y + (typeof p.fy === "number" ? p.fy : 0);
      let c = smoothCursors.get(p.name);
      if (!c) { c = { rx: wx, ry: wy }; smoothCursors.set(p.name, c); }
      c.fromX = (typeof c.rx === "number") ? c.rx : wx;
      c.fromY = (typeof c.ry === "number") ? c.ry : wy;
      c.toX = wx; c.toY = wy;
      c.tStart = now;
      c.z = (typeof p.z === "number") ? p.z : 0;
      c.drag = !!p.drag;
      c.lastSeen = now;
    }
  }

  // Keep the overlay canvas exactly co-located with (and at the same backing resolution as)
  // the map canvas, so world->pixel math lines up with the map 1:1 in any embed layout.
  function syncCursorCanvas() {
    if (!canvas) return false;
    if (!cursorCanvas) {
      try {
        cursorCanvas = document.createElement("canvas");
        cursorCanvas.style.position = "fixed";
        cursorCanvas.style.pointerEvents = "none";
        cursorCanvas.style.zIndex = "40";
        document.body.appendChild(cursorCanvas);
        cursorCtx = cursorCanvas.getContext("2d");
      } catch (_) { cursorCanvas = null; cursorCtx = null; return false; }
    }
    if (!cursorCtx) return false;
    const rect = canvas.getBoundingClientRect();
    if (cursorCanvas.width !== canvas.width) cursorCanvas.width = canvas.width;
    if (cursorCanvas.height !== canvas.height) cursorCanvas.height = canvas.height;
    cursorCanvas.style.left = rect.left + "px";
    cursorCanvas.style.top = rect.top + "px";
    cursorCanvas.style.width = rect.width + "px";
    cursorCanvas.style.height = rect.height + "px";
    return true;
  }

  // -drag2 (owner regression follow-up 2026-07-17): the remote in-progress designation box.
  // Data-wise the box reaches every client (aux players[].drag/dx/dy -- the -drag1 sender fix;
  // presence_drag_broadcast_test pins the wire end to end, and live probes confirmed the fields
  // on /mapdata AND on real v1 AUX frames). Visually, though, the two renderers diverge hard:
  // canvas2d's drawPresence paints a bright 2px stroked rectangle, while GL's emitPresence --
  // whose fixed 32x32 instance format has no stroke geometry (see its banner) -- approximates
  // the box as a 16%-alpha full-tile wash that is nearly invisible over dark terrain at typical
  // zoom. Since WB-14 flipped the default renderer to GL, "watch the box grow live" effectively
  // vanished for watchers even with the presence data flowing. Fix at the COMPOSITOR level:
  // paint the crisp rectangle on THIS always-on 2D overlay -- it already sits above BOTH
  // renderers (z-index 40 over GL's z-index 1), repaints every RAF, and is the same surface the
  // cursor arrows/ping splashes ride, so it needs no renderer machinery at all. Gated to
  // GL-active: when canvas2d is the visible renderer its own drawPresence already draws the
  // identical rect, and doubling it would brighten the stroke.
  // SOURCE OF TRUTH: the aux presence snapshot (lastAux.players -- drag + dx/dy corners),
  // NEVER the smoothCursors fast-channel map: the 25Hz WS cursor entries carry only a drag
  // BOOLEAN (no corners) and cannot reconstruct the box.
  function drawRemoteDragRects(octx) {
    if (!geom || !glOccludesCanvas2d()) return;
    const players = (lastAux && Array.isArray(lastAux.players)) ? lastAux.players : [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.name === player) continue;              // never our own box
      if (!p.drag || typeof p.dx !== "number" || typeof p.dy !== "number" ||
          typeof p.x !== "number" || typeof p.y !== "number") continue;
      const sameZ = (typeof p.z !== "number") || p.z === geom.oz;
      const col = playerColor(p.name);
      const cell = geom.cell;
      const gx0 = Math.min(p.x, p.dx) - geom.ox, gy0 = Math.min(p.y, p.dy) - geom.oy;
      const gx1 = Math.max(p.x, p.dx) - geom.ox + 1, gy1 = Math.max(p.y, p.dy) - geom.oy + 1;
      const rx = gx0 * cell, ry = gy0 * cell, rw = (gx1 - gx0) * cell, rh = (gy1 - gy0) * cell;
      if (rx > cursorCanvas.width || ry > cursorCanvas.height || rx + rw < 0 || ry + rh < 0) continue;
      octx.save();
      // Interior wash kept LIGHT: GL's emitPresence fills the same tiles when its overlay
      // segment is live, so the two compose to roughly canvas2d's 0.16 -- and the stroked
      // border below never depends on the GL segment having rebuilt at all.
      octx.fillStyle = col.fill; octx.globalAlpha = sameZ ? 0.10 : 0.05;
      octx.fillRect(rx, ry, rw, rh);
      octx.globalAlpha = sameZ ? 0.9 : 0.4;
      octx.strokeStyle = col.fill; octx.lineWidth = 2;
      octx.strokeRect(rx + 1, ry + 1, Math.max(1, rw - 2), Math.max(1, rh - 2));
      octx.restore();
    }
  }

  function drawSmoothCursors() {
    if (!syncCursorCanvas()) return;
    const octx = cursorCtx;
    octx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    if (!geom) return;                                    // no map yet -> nothing to place against
    // -drag2: remote in-progress designation boxes, UNDER the cursor arrows + ping splashes.
    try { drawRemoteDragRects(octx); } catch (_) { /* overlay must never throw */ }
    const now = Date.now();
    const cell = geom.cell, ox = geom.ox, oy = geom.oy, oz = geom.oz;
    for (const [name, c] of smoothCursors) {
      if (now - c.lastSeen > CURSOR_TTL_MS) { smoothCursors.delete(name); continue; }
      const a = Math.min(1, (now - c.tStart) / CURSOR_LERP_MS);      // interpolation alpha
      c.rx = c.fromX + (c.toX - c.fromX) * a;
      c.ry = c.fromY + (c.toY - c.fromY) * a;
      const dz = Math.abs(oz - c.z);
      const alpha = Math.max(0, 1 - dz / CURSOR_ZFADE_N);            // z-fade
      if (alpha <= 0.02) continue;
      const px = (c.rx - ox) * cell;                                 // world -> our backing px
      const py = (c.ry - oy) * cell + (oz - c.z) * 3;                // small lift per z-level
      if (px < -40 || py < -40 || px > cursorCanvas.width + 40 || py > cursorCanvas.height + 40) continue;
      try { drawOneCursor(octx, name, px, py, alpha, c, oz); } catch (_) { /* per-cursor guarded */ }
    }
    // WT27: ping splashes ride the SAME cleared overlay + frame, so they compose with cursors and
    // leave no residue (the clearRect at the top of this function wipes the whole overlay each RAF).
    try { drawPingSplashes(octx, now); } catch (_) { /* a splash must never break the overlay */ }
  }

  // A small Figma-style arrow (tip at px,py) + name pill, in the player's stable hashed color.
  function drawOneCursor(octx, name, px, py, alpha, c, oz) {
    const col = playerColor(name);
    octx.save();
    octx.globalAlpha = alpha;
    octx.beginPath();
    octx.moveTo(px, py);
    octx.lineTo(px, py + 16);
    octx.lineTo(px + 4, py + 12);
    octx.lineTo(px + 9, py + 17);
    octx.lineTo(px + 12, py + 14);
    octx.lineTo(px + 7, py + 9);
    octx.lineTo(px + 12, py + 9);
    octx.closePath();
    octx.fillStyle = col.fill;
    octx.strokeStyle = "rgba(0,0,0,0.55)";
    octx.lineWidth = 1;
    octx.fill();
    octx.stroke();
    let label = presenceLabel(name) || "?";
    if (label.length > 14) label = label.slice(0, 13) + "…";
    if (c.z > oz) label += " ↑"; else if (c.z < oz) label += " ↓";
    octx.font = "11px monospace";
    octx.textAlign = "left"; octx.textBaseline = "top";
    const tw = octx.measureText(label).width;
    const lx = px + 13, ly = py + 15;
    octx.globalAlpha = alpha * 0.9;
    octx.fillStyle = col.dark;
    octx.fillRect(lx, ly, tw + 8, 14);
    octx.globalAlpha = alpha;
    octx.fillStyle = "#fff";
    octx.fillText(label, lx + 4, ly + 1);
    octx.restore();
  }

  function startCursorOverlay() {
    if (cursorRaf !== null) return;                       // already running
    const tick = () => {
      cursorRaf = requestAnimationFrame(tick);
      try { drawSmoothCursors(); } catch (_) { /* overlay must never throw */ }
    };
    cursorRaf = requestAnimationFrame(tick);
  }

  // ---- (D) PING SPLASH: LoL/Dota-style location ping (WT27) ----------------------
  // A short expanding-ring burst at a WORLD tile, in the pinging player's cursor color. the
  // ping suggestion already ships a channel: dwf-chat.js pings a location as a chat message
  // carrying a [[loc:x,y,z]] token, broadcast to every client; on the LIVE arrival of a new such
  // message chat calls DwfTiles.pingSplash(x,y,z,author). The splash rides the SAME permanent
  // 2D overlay canvas + RAF as the smooth cursors, so it renders identically over BOTH map renderers
  // (the canvas2d underlay and the GL canvas -- the overlay sits above either; see dwf-gl.js's
  // "the smooth-cursor overlay already IS that" note). drawSmoothCursors clears the overlay every
  // frame and this reaps expired pings, so there is never lingering DOM/canvas garbage.
  const PING_DURATION_MS = 950;      // total lifetime of one splash
  const PING_RINGS = 2;              // concentric rings
  const PING_RING_STAGGER = 0.18;    // each later ring starts this fraction of the lifetime later
  const PING_MAX_R_TILES = 3.2;      // peak ring radius, in world tiles (scales with zoom via cell)
  const PING_MAX_R_PX = 120;         // hard px ceiling so a far-zoom ping stays a tidy burst
  const PING_MAX_ACTIVE = 24;        // hard cap on simultaneous splashes (spam guard)
  const activePings = [];            // { wx, wy, z, col, tStart }

  function pingSplash(worldX, worldY, z, name) {
    const wx = Number(worldX), wy = Number(worldY);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return false;
    activePings.push({
      wx: wx, wy: wy,
      z: Number.isFinite(Number(z)) ? Number(z) : (geom ? geom.oz : 0),
      col: playerColor(name), tStart: Date.now(),
    });
    if (activePings.length > PING_MAX_ACTIVE) activePings.splice(0, activePings.length - PING_MAX_ACTIVE);
    startCursorOverlay();            // ensure the RAF runs even before any cursor has arrived
    return true;
  }

  // Ease-out cubic: fast expansion that settles -- the "pop" that makes a ping feel responsive.
  function pingEaseOut(t) { const u = 1 - Math.max(0, Math.min(1, t)); return 1 - u * u * u; }

  // Draw + reap every active splash against the (already cleared) overlay ctx. Returns the count
  // actually painted this frame. `now` is injected so the lifecycle is deterministically testable.
  function drawPingSplashes(octx, now) {
    if (!octx || !geom || !activePings.length) return 0;
    const cell = geom.cell, ox = geom.ox, oy = geom.oy, oz = geom.oz;
    const cw = (cursorCanvas && cursorCanvas.width) || (canvas && canvas.width) || 4096;
    const ch = (cursorCanvas && cursorCanvas.height) || (canvas && canvas.height) || 4096;
    const maxR = Math.min(PING_MAX_R_PX, PING_MAX_R_TILES * cell + 12);
    const span = 1 - (PING_RINGS - 1) * PING_RING_STAGGER;
    let drawn = 0;
    for (let i = activePings.length - 1; i >= 0; i--) {
      const p = activePings[i];
      const life = (now - p.tStart) / PING_DURATION_MS;
      if (life >= 1 || life < 0) { activePings.splice(i, 1); continue; }   // reap expired
      const dz = Math.abs(oz - p.z);
      const zAlpha = Math.max(0, 1 - dz / CURSOR_ZFADE_N);                 // fade across z-levels
      if (zAlpha <= 0.02) continue;
      const px = (p.wx + 0.5 - ox) * cell;                                 // tile CENTER -> overlay px
      const py = (p.wy + 0.5 - oy) * cell;
      if (px < -maxR || py < -maxR || px > cw + maxR || py > ch + maxR) continue;  // off-screen
      octx.save();
      for (let r = 0; r < PING_RINGS; r++) {
        const rl = (life - r * PING_RING_STAGGER) / span;                 // this ring's own 0..1
        if (rl <= 0 || rl >= 1) continue;
        const radius = 4 + pingEaseOut(rl) * maxR;
        const alpha = zAlpha * (1 - rl) * (1 - rl);                       // quadratic fade-out
        octx.globalAlpha = alpha;
        octx.strokeStyle = p.col.fill;
        octx.lineWidth = Math.max(1.5, 3 * (1 - rl));
        octx.beginPath();
        octx.arc(px, py, radius, 0, Math.PI * 2);
        octx.stroke();
      }
      // center dot: marks the exact tile, fades fastest.
      const dotA = zAlpha * Math.max(0, 1 - life * 2.4);
      if (dotA > 0.02) {
        octx.globalAlpha = dotA;
        octx.fillStyle = p.col.fill;
        octx.beginPath();
        octx.arc(px, py, Math.max(2, cell * 0.2), 0, Math.PI * 2);
        octx.fill();
      }
      octx.restore();
      drawn++;
    }
    return drawn;
  }

  // ---- canvas / DOM setup --------------------------------------------------------
  // Dual-mode. STANDALONE (tiles.html): binds the legacy #tilemap canvas and runs its own
  // camera keys + poll loop. EMBEDDED (index.html full client): dwf-core.js calls
  // DwfTiles.init({canvas, manageCamera:false, ...}) to use us purely as the map
  // surface, owning camera/designation input itself. All sprite/render logic below is shared.
  let canvas = null;
  let ctx = null;
  let hud = null;
  let manageCamera = true;   // bind WASD/arrow camera keys (standalone only)
  let managePoll = true;     // run the /mapdata poll loop ourselves
  let onDrawCb = null;       // fired after every draw() -- embed hook to repaint overlays
  let listenersBound = false;

  let latest = null;      // last good mapdata payload
  let connected = false;  // whether the last poll succeeded with valid JSON
  let wsAlive = false;    // true while the WS push transport is feeding draw() (FIX 2)

  // WA-4 (rAF-batched draw, transport report §C item 5): the WS onMessage callback no
  // longer calls draw() synchronously per pushed message -- under burst delivery that was
  // the client-side replay cost (many redundant full-canvas redraws per animation frame).
  // It now only flips `mapDirty`; a persistent rAF loop below draws AT MOST once per frame,
  // decoupling paint cadence from message arrival cadence entirely. (This is the same seam
  // W-B's renderer takes over -- see dwf-render.js.) The poll fallback path is
  // untouched: it's 2/sec, calling draw() directly is already cheap there.
  let mapDirty = false;
  let mapDrawRaf = null;
  let lastUnitStatusVisSig = 0;
  let lastUnitStatusHadBubble = false;
  let lastDesignationBlinkPhase = -1;
  let lastMachineAnimPhase = -1;
  function startMapDrawLoop() {
    if (mapDrawRaf !== null) return;
    const tick = () => {
      mapDrawRaf = requestAnimationFrame(tick);
      const nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
      if (connected && latest && hasDrawableUnitStatus(latest.units)) {
        // NATIVE per-unit blink cadence: repaint whenever the set of currently-VISIBLE bubbles
        // changes (a unit crossing its own 7000ms/5001 phase edge), NOT on any global clock.
        const sig = unitStatusVisibilitySignature(latest.units, nowMs);
        if (sig !== lastUnitStatusVisSig || !lastUnitStatusHadBubble) { lastUnitStatusVisSig = sig; mapDirty = true; }
        lastUnitStatusHadBubble = true;
      } else {
        lastUnitStatusVisSig = 0;
        lastUnitStatusHadBubble = false;
      }
      if (connected && latest && hasBlinkingDesignationJob(latest.djobs)) {
        // B135: repaint at the 400ms half-beat -- the fastest cadence any glyph can need
        // (state 2). State-1 glyphs land on the same value at every 800ms boundary
        // (phase-locked), so the extra repaint is a visual no-op for them.
        const phase = Math.floor(nowMs / DESIG_ACTIVE_BLINK_MS);
        if (phase !== lastDesignationBlinkPhase) { lastDesignationBlinkPhase = phase; mapDirty = true; }
      } else {
        lastDesignationBlinkPhase = -1;
      }
      if (connected && latest) {
        // B206: machine cadence on the pause-aware world clock -> no repaint churn while paused,
        // and the held frame is what a resumed draw() re-emits. Uses the loop's perf.now `nowMs`
        // (same epoch as the draw path's machine frame + DFAnimClock) for a pop-free freeze edge.
        const mstep = machineCadenceStep(latest.buildings, worldAnimMs(nowMs), lastMachineAnimPhase, _machineFreezeAnim);
        lastMachineAnimPhase = mstep.phase;
        if (mstep.dirty) mapDirty = true;
      } else {
        lastMachineAnimPhase = -1;
      }
      if (mapDirty) {
        mapDirty = false;
        try { draw(); } catch (_) { /* draw() already self-guards; belt & suspenders */ }
      }
    };
    mapDrawRaf = requestAnimationFrame(tick);
  }

  // WB-1 (renderer seam): count of completed scene renders, exposed via getStats() for the
  // seam layer (dwf-render.js) and the gates. canvas2d rebuilds its whole drawable
  // state every draw() (no persistent scene buffer yet), so "scene build" and "draw" coincide
  // 1:1 here; Phase-B's real cadence-limited counter (build only on delta/camera/z-change)
  // replaces this meaning once WB-9 lands -- the NAME is stable across that transition.
  let sceneBuildCount = 0;
  // Geometry of the last valid frame, so the embedder can hit-test screen->tile and place
  // overlays without re-deriving cell size. Set in drawInner(); null while disconnected.
  let geom = null;        // {cell, gw, gh, ox, oy, oz}

  // ============================================================================
  // PERSISTENT TILE BUFFER (high-FPS delta transport). Instead of replacing the whole
  // frame on every WS push, we keep a row-major buffer for the current window and apply
  // only the changed tiles a delta carries. draw() always renders from this buffer, so a
  // delta touches a handful of cells rather than re-parsing ~540KB. A KEYFRAME rebuilds
  // the buffer; a DELTA mutates it in place. The HTTP poll fallback still sets `latest`
  // directly with a full frame (see pollLoop) -- both feed the same draw path.
  // ============================================================================
  let tileBuf = null;                       // row-major Array(bufW*bufH); === latest.tiles
  let bufOx = 0, bufOy = 0, bufOz = 0, bufW = 0, bufH = 0;

  // ---- WA-13: v1 optimistic local windowing -----------------------------------------------
  // On a v1 session there is no server "map push" to derive bufOx/bufOy/bufOz from (BLOCK_SETs
  // feed the cache directly; there's no per-message "window" envelope at all) -- so the window
  // is a purely CLIENT-side mirror, `desiredCam`, driven by local input and reconciled against
  // AUX's authoritative `cam` only when it diverges for a while. This is what makes pan/zoom/z
  // instant (re-window from whatever's already cached, no wire round-trip) while staying
  // eventually-consistent with the server's real camera.
  let desiredCam = null;          // {x,y,z} -- null until the first hello_ack/AUX seeds it
  let v1MapDims = null;           // {w,h,z} world extent from hello_ack.map, for clamping
  let lastPanInputTime = 0;
  const CAM_DIVERGENCE_MS = 500;  // §item2: snap to AUX.cam if desiredCam has been stale this long
  function clampCam(c) {
    if (!v1MapDims) return c;
    return {
      x: Math.max(0, Math.min(v1MapDims.w - 1, c.x)),
      y: Math.max(0, Math.min(v1MapDims.h - 1, c.y)),
      z: Math.max(0, Math.min(v1MapDims.z - 1, c.z)),
    };
  }
  let _lastCamHintZSent = null;
  function pushDesiredCamToBuf() {
    bufOx = desiredCam.x; bufOy = desiredCam.y; bufOz = desiredCam.z;
    const d = desiredWinDims();
    bufW = d.w; bufH = d.h;
    mapDirty = true; // instant re-window from the cache on the next rAF -- no wire wait
    // Throttled to actual z CHANGES (not every ~33Hz AUX tick that calls this via
    // reconcileAuxCam): the eviction heuristic this feeds doesn't need sub-frame precision,
    // and a worker postMessage on every single tick was measurable per-frame overhead this
    // v1 path pays that the legacy path (no cross-thread message at all here) doesn't.
    if (bufOz !== _lastCamHintZSent) {
      _lastCamHintZSent = bufOz;
      try { if (window.DwfCache && typeof DwfCache.setCamHintZ === "function") DwfCache.setCamHintZ(bufOz); } catch (_) {}
    }
  }
  // Called by dwf-core.js's pan/z call sites (queueMove) the INSTANT local input happens,
  // before the HTTP POST /camera round-trip even starts. No-op outside v1 (legacy windowing is
  // entirely server-push-driven, unchanged).
  function noteCamDelta(dx, dy, dz) {
    if (!v1Active()) return;
    lastPanInputTime = Date.now();
    if (!desiredCam) desiredCam = { x: bufOx, y: bufOy, z: bufOz };
    desiredCam = clampCam({ x: desiredCam.x + (dx | 0), y: desiredCam.y + (dy | 0), z: desiredCam.z + (dz | 0) });
    pushDesiredCamToBuf();
  }
  // Called for an ABSOLUTE jump (middle-click center-on-cursor). Same instant-repaint contract.
  function setCamAbsolute(x, y, z) {
    if (!v1Active()) return;
    lastPanInputTime = Date.now();
    desiredCam = clampCam({ x: x | 0, y: y | 0, z: z | 0 });
    pushDesiredCamToBuf();
  }
  // AUX carries the server's AUTHORITATIVE camera every tick (~30Hz, §0.5). Reconcile: while
  // the client has panned/zoomed recently (< CAM_DIVERGENCE_MS ago), the optimistic local
  // window wins outright (AUX is advisory here); once local input goes quiet, a divergence
  // (e.g. another client / a server-side clamp) snaps desiredCam back to truth.
  function reconcileAuxCam(cam) {
    if (!cam || typeof cam.x !== "number") { if (desiredCam) pushDesiredCamToBuf(); return; }
    if (!desiredCam) { desiredCam = { x: cam.x, y: cam.y, z: cam.z }; pushDesiredCamToBuf(); return; }
    const diverged = desiredCam.x !== cam.x || desiredCam.y !== cam.y || desiredCam.z !== cam.z;
    if (diverged && (Date.now() - lastPanInputTime) > CAM_DIVERGENCE_MS) {
      desiredCam = { x: cam.x, y: cam.y, z: cam.z };
    }
    pushDesiredCamToBuf();
  }

  // ---- WA-7 bridge adapter: cache-fed draw path (WA-15: now the ONLY draw path) ----
  // `?cachedraw=0` (WA-7's rollback lever) and the legacy direct-buffer path it fell back to
  // (applyKeyframeLegacy/applyDeltaLegacy, and the applyKeyframe/applyDelta/
  // applyKeyframeCacheFed/applyDeltaCacheFed dispatch machinery around them) are gone: they
  // only ever ran off the legacy WS "map" push, which no longer exists (v1's BLOCK_SET goes
  // straight into DwfCache; AUX drives the window via handleAuxV1/reconcileAuxCam
  // below). shouldUseCacheDraw() now just checks the cache script actually loaded.
  function shouldUseCacheDraw() {
    return !!(window.DwfCache && typeof DwfCache.windowView === "function");
  }
  let lastAux = { units: [], buildings: [], players: [], proj: [], djobs: [], env: null }; // units/buildings/
                                                              // players/proj (WC-22) are NOT
                                                              // cached (tiles only); env (WC-20
                                                              // weather/season) is the last global
                                                              // read. Carried alongside bufOx/...
                                                              // as the "last known window" state.
                                                              // Written by handleAuxV1 below.
  const auxUnitsById = new Map();
  const auxBldgsById = new Map();
  // B263 parking bridge: buildings the server rm'd ONLY because they fell outside its (lagging)
  // interest window while this client still displays them. The zoom-out center-shift reaches the
  // server via POST /camera a full debounce ahead of the grown dims (two channels, no ordering
  // guarantee), so for the interim the server clips AUX to a window smaller than what the client
  // shows and rm's on-screen workshops -- they visibly blinked out (the B263 flash). Every aux
  // message carries the exact cam window it was clipped against, so a windowing rm is precisely
  // recognizable: footprint outside aux.cam but inside OUR display window. Such records are
  // parked here and keep rendering; they are dropped the moment any later aux window covers
  // their footprint without re-upping them (real deconstruction -- the server diffs against
  // sent_bldgs when its window changes, so a surviving building is ALWAYS re-`up`ed by the first
  // covering delta), or when they leave the client's own display window (ordinary pan; no
  // hoarding). Bounded by what was on screen; belt-and-suspenders cap below.
  const auxBldgsParked = new Map();
  const AUX_BLDGS_PARKED_MAX = 256;
  // Mirror of world_stream.cpp:1937-1939's clip test (the rm producer): TRUE only when the
  // record is confidently outside cam's x/y footprint at cam's z. A z-mismatch returns false
  // (seedown visibility is decided server-side; treat as covered so rm keeps its old meaning).
  function bldOutsideWindow(b, cam) {
    if (!b || !cam || typeof cam.x !== "number" || typeof cam.y !== "number" ||
        !(cam.w > 0) || !(cam.h > 0)) return false;
    if (typeof cam.z === "number" && typeof b.z === "number" && b.z !== cam.z) return false;
    return b.x2 < cam.x || b.x1 >= cam.x + cam.w || b.y2 < cam.y || b.y1 >= cam.y + cam.h;
  }
  // Is the record still on THIS client's screen (the optimistic local window)? Parking exists
  // only to bridge records the player is looking at; anything else follows the server verbatim.
  function bldInClientWindow(b) {
    if (!b || bufW <= 0 || bufH <= 0) return false;
    if (typeof b.z === "number" && b.z !== bufOz) return false;
    return !(b.x2 < bufOx || b.x1 >= bufOx + bufW || b.y2 < bufOy || b.y1 >= bufOy + bufH);
  }
  // Runs on every aux (delta and full) AFTER up/rm are applied: a parked record whose footprint
  // the server's window now covers, yet wasn't re-upped, is genuinely gone; one the client no
  // longer displays needs no bridge. Returns true when the parked set changed.
  function reconcileParkedBldgs(cam) {
    if (!auxBldgsParked.size) return false;
    let changed = false;
    for (const [id, b] of auxBldgsParked) {
      if (auxBldgsById.has(id) || !bldOutsideWindow(b, cam) || !bldInClientWindow(b)) {
        auxBldgsParked.delete(id); changed = true;
      }
    }
    return changed;
  }
  function parkBld(b) {
    if (!b || typeof b.id !== "number") return false;
    if (auxBldgsParked.size >= AUX_BLDGS_PARKED_MAX) {
      const oldest = auxBldgsParked.keys().next().value;
      auxBldgsParked.delete(oldest);
    }
    auxBldgsParked.set(b.id, b);
    return true;
  }
  // The renderer-facing building list: live server truth plus the (usually empty) parked bridge.
  function composeAuxBldgs() {
    const live = Array.from(auxBldgsById.values());
    if (!auxBldgsParked.size) return live;
    return live.concat(Array.from(auxBldgsParked.values()));
  }

  // Called at the top of drawInner(), every draw -- cheap no-op when the cache script isn't
  // loaded. Pulls the FRESHEST windowView() for the last known camera window into
  // `tileBuf`/`latest`, so a worker-backend ingest that lands between messages still shows up
  // on the very next rAF tick (this is the seam W-B's GL renderer also reads through).
  function refreshFromCacheIfNeeded() {
    // WA-6 item 5 (poll-fallback isolation): the /mapdata poll path sets `latest` directly
    // (pollLoop above) and must NEVER be clobbered by a stale cache windowView() built from
    // whatever bufOx/.../bufH the WS session left behind before it dropped. wsAlive is the
    // existing signal for "WS is the active source right now" (pollLoop itself gates on the
    // same flag), so this is a no-op for the whole time the poll fallback is driving draw().
    if (!wsAlive || !shouldUseCacheDraw() || bufW <= 0 || bufH <= 0) return;
    let view = null;
    try { view = DwfCache.windowView(bufOx, bufOy, bufOz, bufW, bufH); } catch (_) { view = null; }
    if (!view || !Array.isArray(view.tiles)) return;
    tileBuf = view.tiles;
    latest = {
      wire: 5, origin: { x: bufOx, y: bufOy, z: bufOz }, width: bufW, height: bufH, z: bufOz,
      tiles: tileBuf, units: lastAux.units, buildings: lastAux.buildings, players: lastAux.players,
      proj: lastAux.proj, env: lastAux.env,   // WC-22 projectiles + WC-20 weather/season
      djobs: lastAux.djobs,                   // B35 designation jobs
      // F3 (perf audit §2/F3): the cache's real window CONTENT VERSION (max block world_seq over
      // the window + see-down range). The GL controller keys its scene rebuild on THIS instead of
      // `latest` object identity -- unit/AUX churn mints a fresh `latest` ~30/s but leaves the
      // content version unchanged, so terrain no longer rebuilds on unit-only churn.
      contentVersion: (typeof view.version === "number") ? view.version : undefined,
    };
  }

  // ---- F3 PERF OVERLAY -----------------------------------------------------------
  // Toggled with F3; top-right. Attributes the frame rate to render vs transport: client
  // draw fps + ms/draw, WS msgs/sec + avg bytes (keyframe vs delta), staleness of the last
  // map update, and the buffer size. Purely diagnostic; never touches the render path.
  let diagOn = false, diagEl = null, diagTimer = null;
  let lastDrawMs = 0, lastMapUpdateTime = 0;
  const drawRing = [];                        // timestamps of recent PAINTED draw() calls (fps)
  // F3 GL-rate sampling: when GL is the active renderer this canvas2d surface only paints at the
  // F1 keep-warm cadence (~2/s), so drawRing above is NOT the frame rate the player sees. The
  // real rate is GL's rAF loop; derive it from GL's cumulative drawCount between overlay ticks.
  let glFpsSample = { t: 0, draw: 0 };

  // ---- F1: occluded-canvas2d paint gate (perf audit §2/F1) -----------------------------
  // When GL is the active renderer, this canvas2d surface is stacked-UNDER the GL canvas and
  // 100% occluded (dwf-render.js banner; GL clears opaque -- clearColor alpha 1.0 -- every
  // frame, so nothing of this canvas is ever visible while GL is up). Pre-F1 it still ran a full-
  // viewport repaint on every AUX/dirty tick (~24-33/s live, ~60-125ms/draw at wide zoom) for
  // pixels nobody sees -- the exact main-thread starvation behind the 18-20fps. F1 SKIPPED the
  // paint while GL was active except a keep-warm so a GL demote reveals a recent frame.
  //
  // SAWTOOTH FIX (perf-hitch, 2026-07-08): F1's keep-warm was a FULL-viewport repaint once per
  // CANVAS2D_KEEPWARM_MS (500ms). Measured live on a busy GL page it costs ~47ms @7k tiles and
  // ~140ms at the ~23k -- one blocking hitch ~2/s ON THE GL MAIN THREAD => a visible 30-150fps
  // SAWTOOTH (rafFps averaged 139 but 42 frames/15s ran >33ms; p95 stayed 6.4ms so the old gate
  // never saw it -- see gate_userperf's hitch metrics). The keep-warm is pure DEMOTE INSURANCE:
  // the buffer is invisible until a GL demote, and dwf-render.js's onDemote already FORCE-
  // repaints one fresh FULL frame the instant it flips back to canvas2d. So the warm buffer never
  // needs to be complete or current -- only present. FIX: paint it INCREMENTALLY, one small
  // horizontal TERRAIN band per keep-warm tick (clipped + row-bounded so the tile loop cost is
  // ~KEEPWARM_BAND_TILES tiles ~= a few ms, not the whole viewport), advancing a row cursor so
  // the full buffer refreshes over a couple of seconds. No single occluded frame blocks the GL
  // loop => the sawtooth is gone. Overlays (buildings/designations/units) are intentionally NOT
  // re-painted in a band -- they'd go stale in the invisible buffer, which the demote force-
  // repaint fixes anyway; skipping them keeps each band cheap. The DATA half of drawInner
  // (refreshFromCacheIfNeeded + geom publish) still runs at full cadence -- GL's getLatest() and
  // all hit-testing depend on it, so the decode is NEVER gated, only the paint.
  const KEEPWARM_TICK_MS = 120;               // min gap between incremental occluded band paints
  const KEEPWARM_BAND_TILES = 800;            // ~tiles per band => ~4-6ms, independent of zoom
  let lastPaintTime = 0;                       // performance.now() of the last occluded band paint
  let warmRow = 0;                             // grid-row cursor for the incremental keep-warm cycle
  function glOccludesCanvas2d() {
    // GL is the active renderer -> its opaque-over-map canvas hides this one. On any demote
    // DwfRender.active flips back to "canvas2d" and full painting resumes next frame.
    try { return !!(window.DwfRender && window.DwfRender.active === "gl"); }
    catch (_) { return false; }
  }
  function markMapUpdate() { lastMapUpdateTime = Date.now(); }
  function recordDraw(ms) {
    lastDrawMs = ms;
    const now = Date.now();
    drawRing.push(now);
    while (drawRing.length > 240) drawRing.shift();
  }
  function ensureDiagEl() {
    if (diagEl) return diagEl;
    try {
      diagEl = document.createElement("div");
      diagEl.style.cssText =
        "position:fixed;top:8px;right:8px;z-index:60;font:11px/1.45 monospace;" +
        "background:rgba(0,0,0,0.72);color:#3f6;padding:6px 9px;white-space:pre;" +
        "pointer-events:none;border:1px solid rgba(60,255,120,0.3);border-radius:4px;";
      diagEl.style.display = "none";
      document.body.appendChild(diagEl);
    } catch (_) { diagEl = null; }
    return diagEl;
  }
  function diagText() {
    const now = Date.now();
    let fps = 0;
    for (let i = drawRing.length - 1; i >= 0; i--) { if (now - drawRing[i] > 1000) break; fps++; }
    const ws = (window.DwfWS && typeof DwfWS.getStats === "function") ? DwfWS.getStats() : null;
    const sinceMap = lastMapUpdateTime ? (now - lastMapUpdateTime) : -1;
    const bufN = tileBuf ? tileBuf.length : 0;
    // When GL is active, `fps` above (canvas2d drawRing) is only the F1 ~2/s keep-warm cadence,
    // which reads as a fake "2fps" even though GL runs 100-144fps. Show the ACTIVE renderer's
    // real rate: under GL, the rAF fps from GL's cumulative drawCount (sampled between the 250ms
    // overlay ticks) + GL scene-build ms; the canvas2d keep-warm rate is demoted to a labeled
    // secondary line. Under canvas2d the drawRing fps IS the real paint rate, so it stands.
    let renderLine = `render: ${fps} fps   ${lastDrawMs.toFixed(1)} ms/draw`;
    let keepWarmLine = null;
    try {
      const rs = (window.DwfRender && typeof DwfRender.getStats === "function")
        ? DwfRender.getStats() : null;
      if (rs && rs.renderer === "gl" && typeof rs.drawCount === "number") {
        let gfps = 0;
        if (glFpsSample.t && now > glFpsSample.t) {
          gfps = Math.max(0, Math.round(((rs.drawCount - glFpsSample.draw) * 1000) / (now - glFpsSample.t)));
        }
        glFpsSample = { t: now, draw: rs.drawCount };
        const bms = (typeof rs.lastBuildMs === "number") ? rs.lastBuildMs.toFixed(1) : "?";
        renderLine = `render: ${gfps} fps   ${bms} ms/build (gl)`;
        keepWarmLine = `underlay keep-warm: ${fps}/s`;
      }
    } catch (_) { /* overlay must never throw */ }
    const lines = [
      "Dwf perf  [F3]",
      renderLine,
      `transport: ${wsAlive ? "WS delta" : "HTTP poll"}`,
    ];
    if (keepWarmLine) lines.push(keepWarmLine);
    // F5 (perf audit §2/F5): surface the ACTIVE renderer + how it was chosen. If this shows
    // "canvas2d (localStorage)" on a machine that should be on GL, that user is silently pinned
    // to the slow fallback by the F5 localStorage landmine (now fixed for new pins) -- exactly
    // the 10-second check the audit calls for. "demoted from gl" means a live GL failure.
    try {
      if (window.DwfRender && typeof DwfRender.provenance === "function") {
        const p = DwfRender.provenance();
        const how = p.demoted ? ("demoted from " + p.requested)
          : (p.source === "url" ? "url" : p.source === "stored" ? "localStorage" : "default");
        lines.push(`renderer: ${p.active} (${how})`);
      }
    } catch (_) { /* overlay must never throw */ }
    if (ws) {
      lines.push(`proto: ${ws.proto}   rtt: ${ws.rttMs}ms   ack-lag: ${ws.inflightAcks}`);
      if (ws.proto === "v1") {
        lines.push(`  worldSeq: ${ws.worldSeq}   opens: ${ws.socketOpens}   snap: ${ws.snapshotDone ? "done" : "..."}`);
        lines.push(`  blockSet: ${ws.blockSetBytesPerSec} B/s   aux: ${ws.auxBytesPerSec} B/s` +
          `   behind ~${ws.estBehindMs}ms`);
      } else {
        lines.push(`ws: ${ws.msgsPerSec} msg/s   avg ${ws.avgBytes} B`);
        lines.push(`  key ${ws.keyMsgs}×${ws.keyAvgBytes}B  delta ${ws.deltaMsgs}×${ws.deltaAvgBytes}B`);
        // WA-4 drop-stale backlog metrics (transport report §C): pending/backlog depth,
        // lifetime drop/resync counters, and the arrival-cadence "how far behind" estimate.
        lines.push(`  pending: ${ws.pendingMaps} map / ${ws.pendingInflates} inflate` +
          `   behind ~${ws.estBehindMs}ms`);
        lines.push(`  dropped: ${ws.droppedStale}   resyncs: ${ws.resyncs}   apply: ${ws.clientApplyMs}ms`);
      }
    }
    lines.push(`last map upd: ${sinceMap < 0 ? "-" : sinceMap + " ms"} ago`);
    lines.push(`buffer: ${bufN} tiles (${bufW}×${bufH})`);
    // WA-6 (world cache, shadow-only this wave): chunk/memory footprint of the persistent
    // world cache fed by DwfWS.deliver(). Purely diagnostic -- draw() does not read
    // from the cache yet (WA-7 wires that up).
    try {
      if (window.DwfCache && typeof DwfCache.stats === "function") {
        const cs = DwfCache.stats();
        const mb = (cs.bytes / (1024 * 1024)).toFixed(1);
        lines.push(`cache: ${cs.chunks} chunks / ${cs.zLevels} z / ${mb} MB / ${cs.evictions} evictions`);
      }
    } catch (_) { /* diag must never affect rendering */ }
    return lines.join("\n");
  }
  function toggleDiag() {
    diagOn = !diagOn;
    const el = ensureDiagEl();
    if (!el) return;
    el.style.display = diagOn ? "block" : "none";
    if (diagOn && diagTimer === null) {
      diagTimer = setInterval(() => {
        try { if (diagOn && diagEl) diagEl.textContent = diagText(); } catch (_) { /* overlay must never throw */ }
      }, 250);
      try { diagEl.textContent = diagText(); } catch (_) {}
    } else if (!diagOn && diagTimer !== null) {
      clearInterval(diagTimer); diagTimer = null;
    }
  }

  // FIX 1 + ZOOM: how many map TILES to request for the current canvas. `targetTilePx` is the
  // desired on-screen size of one tile; the requested window (w/h) = canvas / targetTilePx, so
  // the returned window's aspect matches the browser and the map FILLS it (no black bars).
  // ZOOM is just moving targetTilePx: BIGGER px/tile => FEWER tiles requested (zoomed IN, cells
  // bigger); SMALLER px/tile => MORE tiles (zoomed OUT, cells smaller). Clamped to a sane range
  // (the server clamps w/h again); persisted per-session so a reload keeps the view scale.
  // B211 (2026-07-14): ONE zoom regime. The far / "world-map" overview stage (a second LOD-quad
  // renderer below 12 px/tile) and the resistance band that gated entry into it are DELETED --
  // The owner: "the whole feature, not just the scroll friction; just have a normal zoom cap, no world
  // map". Zoom is now a single multiplicative curve clamped to [TILE_PX_MIN, TILE_PX_MAX].
  // TILE_PX_MIN = 12 is exactly the old normal regime's floor (the overview's former ENTER_PX):
  // the last zoom at which real sprites are still drawn per tile. At 12 px/tile a 1920x1080
  // viewport is 160x90 tiles -- inside desiredWinDims()'s 200-tile server-window clamp, so the
  // whole visible map is still real, sprite-rendered terrain. Everything past it was the coarse
  // color-block stage; there is nothing below it any more.
  const TILE_PX_MIN = 12;                 // zoom-out cap: smallest px/tile that still renders sprites
  const TILE_PX_MAX = 64;
  const TILE_PX_DEFAULT = 24;
  const ZOOM_FACTOR = 1.2;                // multiplicative per-tick step (wheel / [ ])
  let targetTilePx = TILE_PX_DEFAULT;
  try {
    const v = parseFloat(sessionStorage.getItem("dwf.tilePx"));
    if (Number.isFinite(v) && v >= TILE_PX_MIN && v <= TILE_PX_MAX) targetTilePx = v;
  } catch (_) { /* no sessionStorage -> default zoom */ }

  function clampTilePx(px) {
    if (!Number.isFinite(px)) return targetTilePx;
    return Math.max(TILE_PX_MIN, Math.min(TILE_PX_MAX, px));
  }
  // WT20 (mobile): devicePixelRatio-aware backing store, COARSE-POINTER DEVICES ONLY. Phones
  // are dpr 2-3; a CSS-px backing store renders the map at 1/4-1/9 native density (visibly
  // blurry). On coarse devices the canvas backing scales by min(dpr,2) while its CSS box stays
  // 100vw/100vh (dwf.css) -- screenToGrid/getRenderRect already normalize through
  // rect.width/canvas.width, so hit-testing and overlay geometry are scale-transparent.
  // targetTilePx KEEPS its CSS-px-per-tile meaning: desiredWinDims divides the backing size
  // back down, so the requested /mapdata window (and therefore bandwidth + server load) is
  // IDENTICAL to a 1x device. Capped at 2 (a 3x backing store triples fragment cost for
  // marginal sharpness -- mobile GPU tuning is deferred, WT20). Kill switch:
  // localStorage['dwf.mobiledpr']='0'. Desktop (fine pointer): scale 1, all math
  // reduces to the previous expressions exactly.
  let backingDpr = 1;
  function mobileBackingScale() {
    try {
      if (typeof window.matchMedia !== "function" ||
          !window.matchMedia("(pointer: coarse)").matches) return 1;
      if (localStorage.getItem("dwf.mobiledpr") === "0") return 1;
      return Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    } catch (_) { return 1; }
  }
  // WT20: DPR-normalized canvas dims, so the requested /mapdata window on a 2x phone backing
  // store stays identical to a 1x device.
  function dimsAtTilePx(px) {
    const cw = (canvas && canvas.width) ? canvas.width / backingDpr : (window.innerWidth || 0);
    const ch = (canvas && canvas.height) ? canvas.height / backingDpr : (window.innerHeight || 0);
    const w = Math.max(1, Math.min(200, Math.round(cw / px)));
    const h = Math.max(1, Math.min(200, Math.round(ch / px)));
    return { w, h };
  }
  // Server interest dimensions: always the canvas at the current px/tile (bounded by the far cap
  // above, so the requested window can never exceed the 200-tile clamp in dimsAtTilePx).
  function desiredWinDims() {
    return dimsAtTilePx(targetTilePx);
  }

  // Change px/tile, resize any live WS push + force a refetch, and return the change in
  // requested window dims {dw,dh} = (new tiles wide/high - old). The embedder (dwf-core)
  // uses that delta to shift the camera by -delta/2 so the zoom stays centered on the view.
  function applyTilePx(px) {
    const before = desiredWinDims();
    const clamped = clampTilePx(px);
    if (clamped === targetTilePx) return { dw: 0, dh: 0 };
    targetTilePx = clamped;
    try { sessionStorage.setItem("dwf.tilePx", String(targetTilePx)); } catch (_) {}
    const after = desiredWinDims();
    // WA-13: on v1, reflect the new window size against the cache INSTANTLY (no wire wait --
    // whatever's cached at the current desiredCam just gets a wider/narrower crop); the CAM
    // message below still tells the server so its interest window (and trickle priority)
    // follows, but that's a background sync, not something the redraw waits on.
    if (v1Active() && desiredCam) { bufW = after.w; bufH = after.h; mapDirty = true; }
    // Keep the WS push sized to the new zoom. Legacy: reopens the socket with the new w/h so
    // pushed frames match. v1 (WA-13 item 1): sends {"type":"cam"} over the EXISTING socket --
    // NEVER reconnects on zoom/resize. If the socket is down the poll below covers dims instead.
    // B263: the send must be IMMEDIATE (updateDimsNow), not the 350ms-debounced resize path.
    // The zoom gesture's /camera center-shift POSTs on the NEXT rAF; if the dims lag it, the
    // server's interim interest window is (shifted position x old dims) and its AUX rm's every
    // building in the abandoned right/bottom band of what this client is already displaying --
    // the "workshops flash invisible on zoom-out". Dims-first is always safe: a grown window
    // at the old position is a superset of everything visible, so nothing gets clipped.
    if (after.w !== before.w || after.h !== before.h) {
      try {
        if (window.DwfWS && typeof DwfWS.updateDimsNow === "function")
          DwfWS.updateDimsNow(after.w, after.h, targetTilePx);
        else if (window.DwfWS && typeof DwfWS.updateDims === "function")
          DwfWS.updateDims(after.w, after.h, targetTilePx);
      } catch (_) { /* ignore */ }
      pollNow();
    }
    mapDirty = true;
    return { dw: after.w - before.w, dh: after.h - before.h };
  }
  // One regime, one step (B211 removal): every wheel / [ ] tick multiplies or divides by
  // ZOOM_FACTOR and clampTilePx stops it at the caps. Pure + exported (_zoomStepPxForTest) so
  // the single-regime clamp is unit-tested canvas-free.
  function zoomStepPx(px, dir) {
    return clampTilePx((dir === "in") ? px * ZOOM_FACTOR : px / ZOOM_FACTOR);
  }
  function zoom(dir) {
    return applyTilePx(zoomStepPx(targetTilePx, dir));
  }
  function zoomTo(px) { return applyTilePx(px); }
  function getZoom() { return { px: targetTilePx, min: TILE_PX_MIN, max: TILE_PX_MAX,
    def: TILE_PX_DEFAULT }; }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    // WT20: coarse-pointer devices get a dpr-scaled backing store (see mobileBackingScale);
    // desktop stays at exactly innerWidth x innerHeight (scale 1). The CSS box is pinned to
    // 100vw/100vh by dwf.css either way.
    backingDpr = mobileBackingScale();
    canvas.width = Math.max(1, Math.round(window.innerWidth * backingDpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * backingDpr));
    ctx.imageSmoothingEnabled = false;
    // Keep the WS push sized to the new canvas (FIX 1 parity with the poll URL).
    try {
      if (window.DwfWS && typeof DwfWS.updateDims === "function") {
        const d = desiredWinDims();
        DwfWS.updateDims(d.w, d.h);
      }
    } catch (_) { /* ignore */ }
    draw();
  }

  function setHud(text) {
    if (hud) hud.textContent = text;
  }

  function isValidMapData(d) {
    return !!d && d.wire >= 1 && d.origin &&
      typeof d.width === "number" && typeof d.height === "number" &&
      Array.isArray(d.tiles);
  }

  // ---- drawing --------------------------------------------------------------------
  function draw() {
    if (!canvas || !ctx) return;
    const _t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    let painted = false;
    try {
      painted = drawInner();       // false when F1 skipped the (occluded) paint this frame
    } catch (_) {
      // Never let a draw error take down the poll loop.
    }
    // Only record frames that actually PAINTED: lastDrawMs/drawsPerSec then reflect real
    // canvas2d paint cost/cadence (the gate reads these -- ~30/s pre-F1, keep-warm post-F1),
    // and the cheap data-refresh-only frames under GL don't dilute the number.
    if (painted) {
      try {
        const _t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        recordDraw(_t1 - _t0);
      } catch (_) { /* diag must never affect rendering */ }
    }
    // Embed hook: ALWAYS fires (F1 preserves it). It repaints the host's zone/drag overlays on
    // a SEPARATE always-visible overlay canvas from the fresh `geom` (published every frame,
    // even when the map paint is skipped), so overlays stay cursor-aligned under GL too.
    if (onDrawCb) { try { onDrawCb(); } catch (_) { /* overlay hook is non-fatal */ } }
  }

  // drawInner returns TRUE if it painted this frame, FALSE if F1 skipped the (occluded) paint.
  function drawInner() {
    // ===== DATA HALF (F1: ALWAYS runs, even when the paint below is skipped) =====
    // WA-7 bridge adapter: pull the freshest cache windowView() into `latest` BEFORE anything
    // reads it. GL's rAF loop reads this via getLatest() every frame -- skipping it here would
    // starve/freeze GL (the exact layering hazard the audit's F1 caution names). No-op when
    // cache-draw is off/unavailable (the legacy direct path already wrote `latest` itself).
    refreshFromCacheIfNeeded();

    const w = canvas.width, h = canvas.height;

    // Publish geometry (DATA, ALWAYS) from the freshest `latest`, so screenToGrid/getRenderRect
    // (hit-testing) and the always-firing onDrawCb overlay hook stay correct even on frames whose
    // occluded canvas2d paint we skip. geom stays null while disconnected (unchanged contract).
    geom = null;
    const connectedValid = connected && latest && latest.width > 0 && latest.height > 0;
    let data = null, gw = 0, gh = 0, cell = 1, ox = 0, oy = 0, oz = 0;
    if (connectedValid) {
      data = latest;
      gw = data.width; gh = data.height;
      // FIX 1: fractional cell (no floor) so the map fills the canvas with no black bars.
      cell = Math.max(1, Math.min(w / gw, h / gh));
      ox = data.origin.x; oy = data.origin.y; oz = data.origin.z;
      geom = { cell, gw, gh, ox, oy, oz };
    }

    // ===== F1 PAINT GATE (incremental keep-warm) =====
    // While GL is the active (opaque-over-map) renderer this canvas is 100% occluded. Instead of
    // the pre-fix full-viewport repaint (or F1's blocking full keep-warm every 500ms -- the ~2/s
    // sawtooth hitch), paint at most ONE small TERRAIN band per KEEPWARM_TICK_MS, bounded to
    // ~KEEPWARM_BAND_TILES tiles (a few ms), advancing warmRow across the grid so the invisible
    // buffer stays roughly warm for the demote reveal without ever blocking the GL loop. A demote
    // (dwf-render.js onDemote) force-repaints one fresh FULL frame regardless, so a partial
    // warm buffer is never actually shown. `bandMode` gates the band-only path below; the full
    // canvas2d-active paint path (bandMode=false) is completely unchanged.
    const nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
    // B206: the game-WORLD animation clock (miasma frame cycle + machine frames) freezes on
    // server pause. `nowMs` stays raw wall time for keep-warm cadence + UI blink phases below.
    const worldMs = worldAnimMs(nowMs);
    let bandMode = false, bandRowStart = 0, bandRowEnd = 0;
    if (glOccludesCanvas2d()) {
      if (!connectedValid) return false;                     // nothing to keep warm yet
      if ((nowMs - lastPaintTime) < KEEPWARM_TICK_MS) return false;  // too soon: skip this frame
      lastPaintTime = nowMs;
      bandMode = true;
    }

    // ===== PAINT HALF (skippable) =====
    if (bandMode) {
      // Refresh one horizontal band [bandRowStart, bandRowEnd) of terrain rows, clipped so the
      // clear + composite touch only the band; the rest of the invisible buffer persists.
      const bandRows = Math.max(2, Math.min(gh, Math.ceil(KEEPWARM_BAND_TILES / Math.max(1, gw))));
      bandRowStart = (warmRow >= gh) ? 0 : warmRow;
      bandRowEnd = Math.min(gh, bandRowStart + bandRows);
      const by0 = bandRowStart * cell, bandH = (bandRowEnd - bandRowStart) * cell;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, by0, w, bandH); ctx.clip();
      ctx.fillStyle = rgbStr(BG);
      ctx.fillRect(0, by0, w, bandH);
    } else {
      ctx.fillStyle = rgbStr(BG);
      ctx.fillRect(0, 0, w, h);
    }
    if (!connectedValid) {
      drawConnectingOverlay();
      return true;
    }
    if (!bandMode) sceneBuildCount++;   // a band is a partial refresh, not a full scene build

    // Camera plane (top-level tiles) is always present -- used for the designation overlay,
    // presence, core build-preview, and as the render source in the legacy fallback.
    const tiles = Array.isArray(data.tiles) ? data.tiles : [];
    const n = Math.min(tiles.length || (gw * gh), gw * gh);
    // Keep-warm band restricts the terrain tile loop to [iStart, iEnd) (row-bounded); a full
    // paint covers [0, n). Everything below the terrain pass is skipped in band mode (see the
    // early return after the terrain pass) so a band only ever pays its own few-hundred tiles.
    const iStart = bandMode ? Math.min(n, bandRowStart * gw) : 0;
    const iEnd = bandMode ? Math.min(n, bandRowEnd * gw) : n;

    // wire:6: if the server sent a stacked layers[] array, composite the multi-z stack
    // (see-below + camera + see-above fog). Otherwise fall back to the single-plane render
    // of the camera tiles exactly as before -- so an older server (or a payload missing
    // layers[]) still draws correctly and never black-screens.
    const layersArr = Array.isArray(data.layers) ? data.layers : null;
    if (layersArr) {
      const byDz = Object.create(null);
      let maxUp = 0, maxDown = 0;
      for (let li = 0; li < layersArr.length; li++) {
        const L = layersArr[li];
        if (!L || !Array.isArray(L.tiles) || typeof L.dz !== "number") continue;
        byDz[L.dz] = L.tiles;
        if (L.dz > maxUp) maxUp = L.dz;
        if (-L.dz > maxDown) maxDown = -L.dz;
      }
      // dz:0 layer is the camera plane; fall back to top-level tiles if it was omitted.
      const cam = byDz[0] || tiles;
      renderComposite(byDz, maxUp, maxDown, cam, gw, gh, cell, n, iStart, iEnd);
    } else {
      // Legacy single-plane: measured see-down fog from any baked wire:2 `depth` field
      // (usually absent now that wire:6 layers[] carries real per-cell descent).
      for (let i = iStart; i < iEnd; i++) {
        const t = tiles[i];
        if (!t) continue;
        const gx = i % gw, gy = (i - gx) / gw;
        drawTileComposite(t, gx * cell, gy * cell, cell, gx, gy, t.depth || 0, 1);
      }
    }

    // Keep-warm band: terrain for this band is refreshed; skip buildings/designations/presence/
    // units (they'd only warm the invisible buffer, and a demote force-repaints them fresh).
    // Advance the row cursor; wrap to 0 when the whole grid has been cycled.
    if (bandMode) {
      ctx.restore();
      warmRow = (bandRowEnd >= gh) ? 0 : bandRowEnd;   // wrap the row cursor at the grid bottom
      return true;
    }

    // (8) BUILDINGS: premium sprites, drawn AFTER terrain/items/plants/trees and
    // BEFORE creatures. Multi-tile buildings blit the correct sub-cell per covered
    // tile: cells[by-y1][bx-x1] (clamped to the grid). If no sprite resolves (unknown
    // type, sheet not yet loaded), fall back to the original orange footprint outline.
    paintFarmLayers(() => {
      const buildings = buildingsInPaintOrder(data.buildings);
      for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi];
      if (!b) continue;
      // WC-4: Stockpile/Civzone are EXCLUDED from the building-art pass entirely -- they
      // used to fall through to the generic `_default` workshop stamp (a bug: every
      // bedroom/stockpile/zone footprint got stamped with a random workshop sprite). They
      // render via a dedicated overlay channel (WC-7); until that lands, rendering NOTHING
      // here is strictly better than a wrong stamp -- zero building-art instances, no
      // fallback outline either.
      if (isOverlayOnlyBuildingType(b.type)) continue;
      // wire:6 z-fade: the server sends buildings across the whole stacked z-range (not
      // just camera z). A building BELOW the camera sits under the same measured see-down
      // fog as the terrain it's on -- buildings/units weren't themselves sampled by the fog
      // fit (grass + stone rubble flats only), so translucency-by-fogAlphaForDepth is a
      // reasoned EXTENSION of the measured terrain curve, not independently verified for
      // sprites. A building ABOVE the camera gets no fade at all (dz==0 => full): see-above
      // is a confirmed deletion (fogparams.json `seeAbove.mode: "delete"`), not a
      // differently-shaped curve, so there is nothing to fade toward.
      // ZBELOW-BUILDINGS: B03 still drops stale off-z AUX ghosts, except when the server tags a
      // below-camera building as visible through an open column. Above-camera is always deleted.
      // Buildings are tile-composite content, so they use the raw terrain ladder (no unit floor).
      const bAlpha = buildingAlphaForZ(b, oz);
      if (bAlpha === null) continue;
      ctx.save();
      ctx.globalAlpha = bAlpha;
      try {
        const e = machineEntry(b, buildingMap, machineFrameParity(worldMs)) || farmPlotEntry(b)
                || statueEntry(b) || buildingEntry(b);   // B253: statues are a 3-cell composite
        let drewBld = false;
        // MATERIAL COLOR (B273/window #13): DF recolors a building's palette-authored art by its
        // COMPONENT item's STATE_COLOR (b.cpal) ONLY; a
        // component-less building draws its authored (default) coloring untinted, and the header
        // material never colors it (native evidence: 2026-07-09 tintprobe differential). Exact
        // default-ramp substitution is primary.
        // COMPATIBILITY LIMIT (INTENTIONALLY INEXACT): when an old DLL sends no cpal, or a modded
        // cpal is absent from material_map.json, B14's crgb path multiplies the WHOLE sprite inside
        // its alpha mask. It cannot spill onto the ground, but it DOES recolor fixed/non-palette
        // painted detail and is not DF palette parity. It is graceful degradation only.
        // DEFECT-B FIX (workshoptint, one-tile-above ground tint): the old path multiply-fillRect'd
        // the WHOLE cell rect after the sprite blit, so wherever building art is transparent
        // (the B14 overhang row above the footprint, sparse furniture art) the tint painted the
        // GROUND (live-measured: overhang row cyan-frac 0.539 in c2d vs 0.041 GL / 0.000 native).
        // Now the tint is composed masked to the sprite's own alpha (multiplyTintedCell -- the
        // same offscreen compose fortifications use), which also matches GL's texel*tint exactly.
        const bldPalRow = pickBuildingPalRow(b);
        let bldTint255 = null;
        const bldTintRgb = pickBuildingTintRgb(b);   // component crgb ONLY (else null -> no tint)
        if (typeof bldPalRow !== "number" && bldTintRgb) bldTint255 = buildingTintRgb(bldTintRgb);
        // Blit one building sub-cell, material tint masked to sprite alpha. Falls back to the
        // plain (untinted) blit if the tinted compose isn't available yet (sheet still decoding /
        // tainted canvas) -- an untinted frame, never a ground-tinting or blank one.
        // B253: `sheet` defaults to the entry's own sheet, but a statue's SUBJECT cells can live
        // on a different sheet than its plinth (932 creature statues sit on the creature statue
        // pages), so the overlay/overhang layers pass their own.
        const blitBldCell = (col, row, px, py, sheet) => {
          const sh = sheet || e.sheet;
          if (typeof bldPalRow === "number") {
            const swapped = paletteSwappedCell(sh, col, row, bldPalRow);
            if (swapped) {
              const sm = ctx.imageSmoothingEnabled;
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(swapped, 0, 0, 32, 32, px, py, cell, cell);
              ctx.imageSmoothingEnabled = sm;
              return true;
            }
          }
          if (bldTint255) {
            const mtc = multiplyTintedCell(sh, col, row, bldTint255);
            if (mtc) { ctx.drawImage(mtc, 0, 0, 32, 32, px, py, cell, cell); return true; }
          }
          return blitCell(sh, col, row, px, py, cell);
        };
        if (e && e.sheet && Array.isArray(e.cells)) {
          const gh2 = e.cells.length;
          const gw2 = e.w || (e.cells[0] ? e.cells[0].length : 1);
          // B47 (wagon 3x3 art broken): a MULTI-CELL art entry NARROWER/SHORTER than the
          // building's real footprint used to be edge-clamp REPEATED across the footprint
          // (the wagon's 1x3 strip stamped on all 3 columns = three wagons side by side).
          // DF centers such art on the footprint and leaves the flanking tiles bare (the
          // ground/items show through). A 1x1 cells entry keeps the historical repeat --
          // that is the deliberate pattern-stamp path (bridges plank-tile their whole
          // span). Larger-than-footprint art keeps the old edge clamp.
          const bfw = b.x2 - b.x1 + 1, bfh = b.y2 - b.y1 + 1;
          const multiCell = (gw2 > 1 || gh2 > 1);
          const offX = (multiCell && gw2 < bfw) ? ((bfw - gw2) >> 1) : 0;
          const offY = (multiCell && gh2 < bfh) ? ((bfh - gh2) >> 1) : 0;
          for (let by = b.y1; by <= b.y2; by++) {
            let ry = by - b.y1 - offY;
            if (multiCell && gh2 < bfh && (ry < 0 || ry >= gh2)) continue; // centered: flanks stay bare
            if (ry >= gh2) ry = gh2 - 1; if (ry < 0) ry = 0;
            const rowArr = e.cells[ry];
            if (!rowArr) continue;
            for (let bx = b.x1; bx <= b.x2; bx++) {
              let rx = bx - b.x1 - offX;
              if (multiCell && gw2 < bfw && (rx < 0 || rx >= gw2)) continue; // centered: flanks stay bare
              if (rx >= gw2) rx = gw2 - 1; if (rx < 0) rx = 0;
              const cd = rowArr[rx] || rowArr[rowArr.length - 1];
              if (!cd) continue;
              const px = (bx - ox) * cell, py = (by - oy) * cell;
              if (blitBldCell(cd.col, cd.row, px, py)) {
                drewBld = true;
                // B20: the tool/decoration OVERLAY layer (base + tools, DF's premium
                // building art). Drawn UNTINTED on top of the material-tinted base cell.
                // B253: `overlayTint` opts the overlay INTO the material tint -- a statue's
                // subject is carved from the same stone as its plinth, unlike a workshop's tools.
                if (e.overlay && e.overlaySheet) {
                  const orow = e.overlay[ry];
                  const ocd = orow && (orow[rx] || orow[orow.length - 1]);
                  if (ocd) {
                    if (e.overlayTint) blitBldCell(ocd.col, ocd.row, px, py, e.overlaySheet);
                    else blitCell(e.overlaySheet, ocd.col, ocd.row, px, py, cell);
                  }
                }
              }
            }
          }
          // B14: the "sticking up above" overhang row (furnace chimney / kiln stack / roof) --
          // DF authors tall building art one tile taller than the footprint; that top row was
          // being clipped, so furnaces/workshops lost their height illusion. Draw it one tile
          // ABOVE the building's top footprint row (world y1 - 1), aligned to footprint columns,
          // material-tinted like the base (+ its overlay row if present).
          if (Array.isArray(e.overhang) && drewBld) {
            // B47: align the overhang with the (possibly centered) art, one row above the
            // ART's own top row, spanning only the art's columns -- a centered wagon strip
            // gets its harness row over the center column, not repeated across all three.
            const opy = (b.y1 + offY - 1 - oy) * cell;
            const ow = e.overhang.length;
            for (let bx = b.x1; bx <= b.x2; bx++) {
              let rx = bx - b.x1 - offX;
              if (multiCell && ow < bfw && (rx < 0 || rx >= ow)) continue;
              if (rx >= ow) rx = ow - 1; if (rx < 0) rx = 0;
              const ocell = e.overhang[rx];
              if (!ocell) continue;
              const opx = (bx - ox) * cell;
              // B253: `overhangSheet` (optional) -- a creature statue's TOP cell is on its own
              // creature-statue page, not on the entry's base sheet. Absent => the base sheet.
              if (blitBldCell(ocell.col, ocell.row, opx, opy, e.overhangSheet)) {
                if (Array.isArray(e.overlayOverhang) && e.overlaySheet) {
                  const oov = e.overlayOverhang[rx];
                  if (oov) blitCell(e.overlaySheet, oov.col, oov.row, opx, opy, cell);
                }
              }
            }
          }
        } else if (e && e.sheet && typeof e.col === "number") {
          for (let by = b.y1; by <= b.y2; by++) {
            for (let bx = b.x1; bx <= b.x2; bx++) {
              const px = (bx - ox) * cell, py = (by - oy) * cell;
              if (blitBldCell(e.col, e.row, px, py)) { drewBld = true; }
            }
          }
        }
        if (!drewBld) {
          const bx1 = (b.x1 - ox) * cell, by1 = (b.y1 - oy) * cell;
          const bx2 = (b.x2 - ox + 1) * cell, by2 = (b.y2 - oy + 1) * cell;
          ctx.strokeStyle = BLD_OUTLINE;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx1 + 0.5, by1 + 0.5, Math.max(1, bx2 - bx1 - 1), Math.max(1, by2 - by1 - 1));
        }
      } catch (_) { /* per-building guarded */ }
        ctx.restore();
      }
    }, () => {
      // (8b) TX4 planted crops: a shared painter contract pins species/stage art above the
      // farm-building bed even when the building data arrived after crop extraction.
      drawFarmCrops(tiles, gw, gh, cell);
    });

    // (9) CREATURES: flat-animal sprite cell (creatures_map.races[rt]) or the baked
    // civ-race PNG (layered races: DWARF/HUMAN/ELF/... -> /dwarf.png, female caste ->
    // /dwarf_female.png). Falls back to the original yellow dot if nothing resolves.
    // Drawn ON TOP of everything else.
    // B135 worked-tile alternation: world-keyed ("x|y|z") tiles whose WORKER-claimed (w:1)
    // designation job alternates with a unit standing on them. A unit on one of these tiles
    // yields it to the designation glyph on the glyph half of the 400ms half-beat
    // (drawDesignation state 2 shows the glyph exactly on activeBlinkVisible -- see
    // workedTileUnitVisible's banner). Workerless posted jobs stay steady, no alternation.
    let workedTiles = null;
    {
      const wdj = Array.isArray(data.djobs) ? data.djobs : null;
      if (wdj) {
        for (let di = 0; di < wdj.length; di++) {
          const dj = wdj[di];
          if (!dj || !dj.w || !isBlinkingDesignationJob(dj.k)) continue;
          if (!workedTiles) workedTiles = new Set();
          workedTiles.add(dj.x + "|" + dj.y + "|" + dj.z);
        }
      }
    }
    const units = Array.isArray(data.units) ? data.units : [];
    const races = creaturesMap && creaturesMap.races;
    const cpx = (creaturesMap && creaturesMap.cell) || 32;
    const r = Math.max(2, Math.floor(cell / 3));
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui];
      if (!u) continue;
      // wire:6 z-fade: units are sent across the stacked z-range. Same extension/caveat as
      // the building z-fade above -- see-below units use the measured fog curve as a
      // translucency proxy (not independently sprite-verified); see-above gets no fade
      // (seeAbove is a confirmed deletion, no curve to fade toward).
      const udz = (typeof u.z === "number") ? u.z - oz : 0;
      // B03/B23: a unit renders on its own z-plane, OR -- when the server explicitly tagged it
      // see-down-visible (u.sd: an unobstructed open column from the unit up to the camera
      // plane, DF's own see-down rule) -- one or more levels BELOW the camera, fog-dimmed by
      // depth (same fogAlphaForDepth ladder the terrain floor under it uses). Untagged off-z
      // units are still dropped: those are the stale cross-z AUX ghosts B03's gate exists for
      // (they'd ghost an unclickable dwarf onto the wrong level). Above-camera units never
      // render (see-above is a confirmed deletion) -- sd is only ever set for below-camera units.
      const seeDownU = !!u.sd && udz < 0;
      if (udz !== 0 && !seeDownU) continue;
      // B135: on the glyph half of the beat a camera-plane unit standing on a claimed
      // designation tile is skipped entirely (sprite + status icon), so the object +
      // designation glyph underneath/above take the tile -- native's dwarf<->object blink.
      if (udz === 0 && workedTiles && workedTiles.has(u.x + "|" + u.y + "|" + u.z) &&
          !workedTileUnitVisible(nowMs)) continue;
      // B23 depth-dim: DF keeps a see-down unit clearly READABLE under a blue veil (native
      // capture at depth 4: units on lower z read as solid-but-blue, not faded to nothing).
      // The raw fog curve (1 - fogAlphaForDepth) hits 0 by depth ~8, which would RE-HIDE deep
      // see-down units -- so floor the opacity; the deepening blue comes from the increasingly
      // fog-washed terrain drawn BEHIND the unit (drawTileComposite already blended it), which
      // shows through the floored transparency. Normal camera-plane units stay fully opaque.
      const uAlpha = seeDownU ? Math.max(0.55, 1 - fogAlphaForDepth(-udz)) : 1;
      // B98 ghost tint: fold DF's ghost translucency into globalAlpha; the green multiply is
      // applied per-sprite via blitGhostTinted (all tiers) and greens the fallback dot below.
      const ghost = unitGhostPlan(u);
      ctx.save();
      ctx.globalAlpha = ghost ? uAlpha * ghost.alpha : uAlpha;
      try {
        const px = (u.x - ox) * cell, py = (u.y - oy) * cell;
        let drewU = false;
        // WE-4 fallback chain (tiers 1/3/4/5; tier 2 is "fetch in flight", handled inside
        // resolveUnitTier by simply not returning tier 1 yet -- the fetch was already kicked
        // off, and its onload callback triggers a repaint once it resolves).
        const sel = resolveUnitTier(u, races);
        if (sel.tier === 1) {
          // Span sw x sh cells, anchored per WE-2 §3 so the unit's OWN tile is the anchor's
          // bottom cell: top-left cell = (x-ax, y-ay).
          const ax = (typeof u.ax === "number") ? u.ax : 0;
          const ay = (typeof u.ay === "number") ? u.ay : Math.max(0, u.sh - 1);
          const spx = (u.x - ax - ox) * cell, spy = (u.y - ay - oy) * cell;
          const usp = sel.sprite;
          if (ghost) blitGhostTinted(usp.img, 0, 0, usp.img.width, usp.img.height, spx, spy, u.sw * cell, u.sh * cell);
          else ctx.drawImage(usp.img, 0, 0, usp.img.width, usp.img.height, spx, spy, u.sw * cell, u.sh * cell);
          drewU = true;
        } else if (sel.tier === 3) {
          const s = getSheet(sel.rec.sheet);
          if (s && s.loaded && !s.failed) {
            // WE-6: LARGE_IMAGE flat creatures (giant animals, anaconda, sperm whale, ...)
            // carry w/h > 1 in creatures_map.json; span that many cells instead of stretching
            // just the top-left cell into one tile. Anchor matches tier 1's per-unit composite
            // rule (WE-2 §3): center column (0 when w==1), bottom row -- the unit's own tile
            // is the anchor's bottom cell. w===h===1 (the overwhelming majority of races)
            // collapses to the exact old single-cell draw (rax=ray=0).
            const rw = sel.rec.w || 1, rh = sel.rec.h || 1;
            const rax = (rw === 1) ? 0 : 1;
            const ray = rh - 1;
            const spx = (u.x - rax - ox) * cell, spy = (u.y - ray - oy) * cell;
            if (ghost) blitGhostTinted(s.img, sel.rec.col * cpx, sel.rec.row * cpx, rw * cpx, rh * cpx,
                          spx, spy, rw * cell, rh * cell);
            else ctx.drawImage(s.img, sel.rec.col * cpx, sel.rec.row * cpx, rw * cpx, rh * cpx,
                          spx, spy, rw * cell, rh * cell);
            drewU = true;
          }
        } else if (sel.tier === 4) {
          const bname = (u.ct === "FEMALE") ? "dwarf_female.png" : (sel.rec.baked || "dwarf.png");
          const bk = getBaked(bname);
          if (bk && bk.loaded && !bk.failed) {
            if (ghost) blitGhostTinted(bk.img, 0, 0, bk.img.width, bk.img.height, px, py, cell, cell);
            else ctx.drawImage(bk.img, 0, 0, bk.img.width, bk.img.height, px, py, cell, cell);
            drewU = true;
          }
        }
        if (!drewU) {
          const ux = px + cell / 2, uy = py + cell / 2;
          ctx.beginPath();
          ctx.arc(ux, uy, r, 0, Math.PI * 2);
          ctx.fillStyle = ghost ? GHOST_TINT_CSS : UNIT_COLOR;
          ctx.fill();
          ctx.strokeStyle = UNIT_OUTLINE;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        const plan = unitStatusDrawPlan(u, ox, oy, cell, nowMs, uAlpha);
        if (plan) {
          const stSheet = getSheet(plan.sheet);
          if (stSheet && stSheet.loaded && !stSheet.failed) {
            ctx.drawImage(stSheet.img, plan.col * 32, plan.row * 32, 32, 32,
                          plan.dx, plan.dy, plan.dw, plan.dh);
          }
        }
      } catch (_) { /* per-unit guarded */ }
      ctx.restore();
    }

    // (9b) WC-22 PROJECTILES/VEHICLES in flight: sparse world-positioned markers at sub-tile
    // precision (fx/fy 0..255). Item-art resolution by item_type index needs a client
    // itemdef/type dictionary this path doesn't yet carry, so this draws a clear bolt/cart
    // marker at the fractional position (never invisible); full item-sprite art + the GL
    // renderer's own dynamic-instance projectile pass are the documented handoff.
    drawProjectiles(data, ox, oy, oz, cell);

    // ---- OVERLAY LAYER (wire:5): designations + presence, ON TOP of everything so
    // player feedback is always visible. Designations iterate the camera plane (tiles);
    // presence uses the world-coord players[] the server spliced into /mapdata.
    // WB-5: hidden tiles are NO LONGER skipped here -- DF itself shows the designation icon
    // (+ the additive lighten, handled inside drawDesignation) over a hidden-rock tile you've
    // marked for digging through fog of war; the old `|| t.hidden` bail silently dropped that
    // entire designated-hidden case.
    // B35: index the designation JOBS (bits already cleared) by grid cell so the loop below
    // draws their glyph even on a tile whose t.desig is now null. Server already z-filters
    // djobs to the camera plane, so only x/y need mapping into the render window.
    let djobMap = null;
    const djobs = Array.isArray(data.djobs) ? data.djobs : null;
    if (djobs && djobs.length) {
      // B135: camera-plane unit tiles ("x|y|z", raw wire coords) decide state 2 (worker ON
      // the work tile -> 400ms half-beat) per djob; `w` off the wire decides state 1 vs 0.
      let unitTiles = null;
      const dus = Array.isArray(data.units) ? data.units : null;
      if (dus && dus.length) {
        unitTiles = new Set();
        for (let ui = 0; ui < dus.length; ui++) {
          const u = dus[ui];
          if (u && typeof u.x === "number" && typeof u.y === "number") unitTiles.add(u.x + "|" + u.y + "|" + u.z);
        }
      }
      djobMap = new Map();
      for (let di = 0; di < djobs.length; di++) {
        const dj = djobs[di];
        if (!dj) continue;
        const gx = dj.x - ox, gy = dj.y - oy;
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        djobMap.set(gy * gw + gx, { k: dj.k, w: !!dj.w,
          onTile: !!(dj.w && unitTiles && unitTiles.has(dj.x + "|" + dj.y + "|" + dj.z)) });
      }
    }
    // B135: reuse this frame's nowMs (declared at the top of draw()) so the glyph phase and
    // the unit-alternation phase can never straddle a beat boundary within one frame.
    const designationNowMs = nowMs;
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      if (!t) continue;
      const dje = djobMap ? djobMap.get(i) : null;
      const dk = dje ? dje.k : 0;
      if (!t.desig && !dk) continue;
      const gx = i % gw, gy = (i - gx) / gw;
      drawDesignation(t, gx * cell, gy * cell, cell, dk, designationNowMs,
        !!(dje && dje.w), !!(dje && dje.onTile));
    }
    // B269 MINING INDICATORS: a SECOND pass over the whole window, not folded into the loop
    // above -- the damp/warm warning is a property of the TERRAIN, not of a designation, which is
    // precisely why it outlives DF clearing the dig designation when the job cancels. That is the
    // bug the owner reported: with no icon of our own, the designation just vanishes and the player is
    // told nothing. Gated to mining designation mode, exactly like native.
    if (mineMode) {
      for (let i = 0; i < n; i++) {
        const t = tiles[i];
        if (!t) continue;
        const gx = i % gw, gy = (i - gx) / gw;
        drawMiningIndicator(t, gx * cell, gy * cell, cell);
      }
    }
    // B139: flow clouds (miasma et al.) sit OVER units + designation glyphs -- native's
    // cloud cell covers the tile's content -- but UNDER presence cursors (player feedback
    // stays visible through a haze).
    drawFlows(tiles, n, gw, cell, worldMs);   // B206: miasma frame cycle freezes on game pause
    drawPresence(data, ox, oy, oz, cell, gw, gh);

    // Standalone shows a small player/origin legend; the embedded full client has its own
    // HUD topbar, so suppress the legend there to avoid overdrawing it. ?nolegend=1
    // suppresses it in standalone too -- the QA parity gate screenshots this canvas and
    // must not diff the legend pixels against DF's frame (tools/harness/gate_parity.py).
    if (manageCamera && !params.has("nolegend")) drawLegend(data);
    return true;   // painted this frame (F1)
  }

  function drawConnectingOverlay() {
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#eee";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("connecting...", w / 2, h / 2);
    ctx.restore();
  }

  function drawLegend(data) {
    const lines = [
      `player: ${player}`,
      `origin: ${data.origin.x}, ${data.origin.y}, ${data.origin.z}`,
    ];
    ctx.save();
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const pad = 6;
    const lineH = 14;
    const boxW = 220;
    const boxH = pad * 2 + lineH * lines.length;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(6, 6, boxW, boxH);
    ctx.fillStyle = "#ddd";
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 6 + pad, 6 + pad + i * lineH);
    }
    ctx.restore();
  }

  // ---- polling loop -----------------------------------------------------------
  const POLL_MS = 500; // ~2x/sec
  let pollTimer = null;

  function scheduleNext(delayMs) {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, Math.max(0, delayMs));
  }

  function pollNow() {
    // Force an immediate refetch (used right after a camera move), without
    // duplicating an in-flight request storm.
    scheduleNext(0);
  }

  async function pollLoop() {
    const start = Date.now();
    // FIX 2: if the WS push is live it is already feeding draw() -- don't double-fetch.
    // Keep the loop scheduled so it instantly resumes fetching if the socket drops.
    if (wsAlive) {
      scheduleNext(POLL_MS - (Date.now() - start));
      return;
    }
    try {
      const dims = desiredWinDims();
      const resp = await fetch(
        `/mapdata?player=${encodeURIComponent(player)}&w=${dims.w}&h=${dims.h}`, {
        cache: "no-store",
      });
      if (!resp.ok) {
        // Includes 503 (server not ready yet) -- just keep retrying on the normal cadence.
        connected = false;
        setHud("connecting...");
        draw();
      } else {
        let data = null;
        try {
          data = await resp.json();
        } catch (_) {
          data = null;
        }
        if (isValidMapData(data)) {
          latest = data;
          connected = true;
          markMapUpdate();
          publishRoster(data.players);   // WP-A: /mapdata poll fallback also feeds the roster surface
          setHud(`player: ${player}  camera: ${data.origin.x}, ${data.origin.y}, ${data.origin.z}`);
          draw();
        } else {
          connected = false;
          setHud("connecting...");
          draw();
        }
      }
    } catch (_) {
      connected = false;
      setHud("connecting...");
      draw();
    } finally {
      const elapsed = Date.now() - start;
      scheduleNext(POLL_MS - elapsed);
    }
  }

  // ---- camera controls (mirrors dwf-core.js's WASD/arrow/PageUp-PageDown) ----
  const STEP = 10;
  const ZSTEP = 1;
  let moveBusy = false;

  function isTextEditingTarget(target) {
    const tag = target && target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!(target && target.isContentEditable);
  }

  function sendMove(dx, dy, dz) {
    if (moveBusy) return;
    moveBusy = true;
    noteCamDelta(dx, dy, dz);   // WA-13: instant cache re-window for standalone tiles.html too
    const url = `/camera?player=${encodeURIComponent(player)}&dx=${dx}&dy=${dy}&dz=${dz}`;
    fetch(url, { method: "POST", cache: "no-store" })
      .catch(() => {})
      .finally(() => {
        moveBusy = false;
        pollNow();
      });
  }

  function handleCameraKey(event) {
    if (!event || isTextEditingTarget(event.target)) return false;
    if (event.altKey || event.metaKey || event.ctrlKey) return false;
    switch (event.key) {
      case "ArrowLeft": case "a": case "A":
        sendMove(-STEP, 0, 0); return true;
      case "ArrowRight": case "d": case "D":
        sendMove(STEP, 0, 0); return true;
      case "ArrowUp": case "w": case "W":
        sendMove(0, -STEP, 0); return true;
      case "ArrowDown": case "s": case "S":
        sendMove(0, STEP, 0); return true;
      case "PageUp": case "e": case "E":
        sendMove(0, 0, ZSTEP); return true;
      case "PageDown": case "q": case "Q":
        sendMove(0, 0, -ZSTEP); return true;
      default:
        return false;
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    // F3 perf overlay (both standalone + embedded). Bound separately from the camera keys
    // so it works even when this instance doesn't manage the camera.
    addEventListener("keydown", (event) => {
      try {
        if (event && event.key === "F3" && !event.altKey && !event.metaKey && !event.ctrlKey) {
          toggleDiag();
          event.preventDefault();
        }
      } catch (_) { /* never throw out of an input handler */ }
    }, { capture: true });
    if (manageCamera) {
      addEventListener("keydown", (event) => {
        try {
          if (handleCameraKey(event)) {
            event.preventDefault();
          }
        } catch (_) {
          // never throw out of an input handler
        }
      }, { capture: true });
    }
    // Always keep the canvas sized to the window (both modes want this).
    addEventListener("resize", () => {
      try { resizeCanvas(); } catch (_) { /* ignore */ }
    });
    // PRESENCE BROADCAST: report THIS page's hover cursor so other players see it. Only
    // in standalone (manageCamera) mode -- the embedded full client (dwf-core.js)
    // owns input and already sends /placement-cursor, so we'd double up otherwise. The
    // server stores hx/hy as grid indices in this player's camera window (origin=camera)
    // and converts them to world coords for everyone's /mapdata presence array. Mapping
    // mouse->tile reuses the same screenToGrid the fill/hit-testing path uses. Throttled.
    if (manageCamera) bindPresenceBroadcast();
    // SMOOTH CURSOR broadcast (both modes): report our precise sub-tile pointer over the WS
    // when it's up. Independent of the tile-snapped HTTP presence above (which stays as the
    // heartbeat/fallback) -- a passive extra listener, so it never interferes with input.
    bindSmoothCursorSend();
  }

  const PRESENCE_MS = 100;  // ~10/s
  let lastPresenceSend = 0;
  let lastPresenceKey = "";

  function sendPresenceCursor(hx, hy) {
    const q = `player=${encodeURIComponent(player)}&hx=${hx}&hy=${hy}` +
              `&w=${(geom && geom.gw) || 0}&h=${(geom && geom.gh) || 0}` +
              `&drag=0&dx=-1&dy=-1&bw=0&bh=0`;
    fetch(`/placement-cursor?${q}`, { method: "POST", cache: "no-store" }).catch(() => {});
  }

  function bindPresenceBroadcast() {
    if (!canvas) return;
    canvas.addEventListener("mousemove", (event) => {
      try {
        const now = Date.now();
        if (now - lastPresenceSend < PRESENCE_MS) return;
        const g = screenToGrid(event.clientX, event.clientY, false);
        if (!g) return;                       // off the drawn map -> don't move the cursor
        const key = g.gx + "," + g.gy;
        if (key === lastPresenceKey) return;  // same tile -> nothing changed
        lastPresenceSend = now;
        lastPresenceKey = key;
        sendPresenceCursor(g.gx, g.gy);
      } catch (_) { /* never throw out of an input handler */ }
    });
    // Clear our cursor when the pointer leaves so it doesn't linger for others.
    canvas.addEventListener("mouseleave", () => {
      try {
        lastPresenceKey = "";
        lastPresenceSend = Date.now();
        sendPresenceCursor(-1, -1);
      } catch (_) { /* ignore */ }
    });
  }

  // ---- screen<->tile hit-testing (used by the embedder for designation/inspect input) ----
  // Returns the grid tile {gx,gy} under a client point, plus the window dims {gw,gh}. These
  // grid indices are exactly what the server's px/w * view_w mapping expects (mapdata's window
  // and the /designate viewport share one camera+dims), so the host sends gx/gy verbatim.
  function screenToGrid(clientX, clientY, clamp) {
    if (!canvas || !geom) return null;
    const rect = canvas.getBoundingClientRect();
    // canvas backing store is set to window.innerWidth/Height (see resizeCanvas), so its CSS
    // box usually matches 1:1; guard the general case with a scale factor anyway.
    const scale = canvas.width ? (rect.width / canvas.width) : 1;
    const cellS = geom.cell * (scale || 1);
    if (cellS <= 0) return null;
    let gx = Math.floor((clientX - rect.left) / cellS);
    let gy = Math.floor((clientY - rect.top) / cellS);
    if (clamp) {
      gx = Math.max(0, Math.min(geom.gw - 1, gx));
      gy = Math.max(0, Math.min(geom.gh - 1, gy));
    } else if (gx < 0 || gy < 0 || gx >= geom.gw || gy >= geom.gh) {
      return null;
    }
    return { gx, gy, gw: geom.gw, gh: geom.gh };
  }

  // The map's drawn rectangle in CLIENT (screen) coordinates + per-tile cell size and the
  // window origin (world tile at grid 0,0). Lets the host place tile-aligned overlays.
  function getRenderRect() {
    if (!canvas || !geom) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width ? (rect.width / canvas.width) : 1;
    const cellS = geom.cell * (scale || 1);
    return {
      left: rect.left, top: rect.top,
      cell: cellS, gw: geom.gw, gh: geom.gh,
      width: cellS * geom.gw, height: cellS * geom.gh,
      ox: geom.ox, oy: geom.oy, oz: geom.oz,
    };
  }

  // ---- WA-12/13: protocol v1 session callbacks -------------------------------------------
  // `hello_ack` (§0.5): world dims, used to clamp desiredCam (noteCamDelta/setCamAbsolute).
  function handleHelloAckV1(ack) {
    try {
      if (ack && ack.map && typeof ack.map.w === "number") {
        v1MapDims = { w: ack.map.w, h: ack.map.h, z: ack.map.z };
        // WT25: hand the footprint to the cache so the GL renderer (which reads dims via
        // cacheReader.mapDims()) and any cache consumer share one source of truth for the
        // in-bounds base-hatch decision.
        try {
          if (window.DwfCache && typeof window.DwfCache.setMapDims === "function") {
            window.DwfCache.setMapDims(ack.map.w, ack.map.h, ack.map.z);
          }
        } catch (_) { /* cache optional; canvas2d reads v1MapDims directly */ }
      }
      // B09(a): adopt the server's authoritative (possibly deduped) player name so this tile
      // client's cursor/HUD AND every core/panel HTTP ?player= key on the same name the server
      // now keys our per-player state under -- fixing the same-name viewport/delta collision.
      // Sent on every hello_ack, so a reconnect self-heals if the server re-assigned a name.
      if (ack && typeof ack.player === "string" && ack.player && ack.player !== player) {
        player = ack.player;
        if (typeof window.__dwfAdoptName === "function") window.__dwfAdoptName(ack.player);
      }
    } catch (_) { /* diagnostic-only field; a missing/malformed map just skips clamping */ }
  }
  // AUX (§0.5, ~30Hz): units/buildings/players + the authoritative server camera. This is the
  // ONLY source of `lastAux`/window-reconciliation on a v1 session -- there is no legacy "map"
  // push to drive it, by design (BLOCK_SETs feed the world cache directly, never this path).
  let auxSeqV1 = 0;
  function handleAuxV1(aux) {
    wsAlive = true;
    try {
      if (!aux || typeof aux !== "object") return;
      if (aux.type === "auxd") {
        if (typeof aux.aseq !== "number" || aux.base !== auxSeqV1) {
          try { if (window.DwfWS) DwfWS.send({ type: "auxr" }); } catch (_) {}
          return;
        }
        let changed = false;
        if (aux.units && typeof aux.units === "object") {
          let unitsChanged = false;
          const up = Array.isArray(aux.units.up) ? aux.units.up : [];
          const rm = Array.isArray(aux.units.rm) ? aux.units.rm : [];
          for (const rec of up) {
            if (!rec || typeof rec.id !== "number") continue;
            auxUnitsById.set(rec.id, rec); unitsChanged = true;
          }
          for (const id of rm) if (auxUnitsById.delete(id)) unitsChanged = true;
          if (unitsChanged) { lastAux.units = Array.from(auxUnitsById.values()); changed = true; }
        }
        {
          let bldgsChanged = false;
          if (aux.buildings && typeof aux.buildings === "object") {
            const up = Array.isArray(aux.buildings.up) ? aux.buildings.up : [];
            const rm = Array.isArray(aux.buildings.rm) ? aux.buildings.rm : [];
            for (const rec of up) {
              if (!rec || typeof rec.id !== "number") continue;
              auxBldgsById.set(rec.id, rec);
              if (auxBldgsParked.delete(rec.id)) { /* bridged record is live again */ }
              bldgsChanged = true;
            }
            for (const id of rm) {
              // B263: a windowing eviction (footprint outside the window THIS delta was clipped
              // against, yet still on our screen) bridges through the parked set instead of
              // blinking out; a covered rm is a real removal and deletes as before.
              const prev = auxBldgsById.get(id);
              if (prev && bldOutsideWindow(prev, aux.cam) && bldInClientWindow(prev)) parkBld(prev);
              else auxBldgsParked.delete(id);
              if (auxBldgsById.delete(id)) bldgsChanged = true;
            }
          }
          // Every delta carries its cam; sweep the bridge even when no buildings section came.
          if (reconcileParkedBldgs(aux.cam)) bldgsChanged = true;
          if (bldgsChanged) { lastAux.buildings = composeAuxBldgs(); changed = true; }
        }
        if (Object.prototype.hasOwnProperty.call(aux, "djobs")) {
          lastAux.djobs = Array.isArray(aux.djobs) ? aux.djobs : []; changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(aux, "proj")) {
          lastAux.proj = Array.isArray(aux.proj) ? aux.proj : []; changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(aux, "env")) {
          lastAux.env = (aux.env && typeof aux.env === "object") ? aux.env : null; changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(aux, "players")) {
          lastAux.players = Array.isArray(aux.players) ? aux.players : [];
          publishRoster(lastAux.players); changed = true;
        }
        auxSeqV1 = aux.aseq;
        reconcileAuxCam(aux.cam);
        connected = true;
        markMapUpdate();
        if (changed) mapDirty = true;
        return;
      }
      if (typeof aux.aseq === "number") auxSeqV1 = aux.aseq;
      // B10 compat: pass the full-frame arrays through UNCHANGED (a pre-win20 live server emits
      // building records without "id"; rebuilding from the id-keyed maps would silently drop
      // them). The maps only need id-carrying records for auxd delta keying, and a server old
      // enough to omit ids never sends auxd frames.
      const fullUnits = Array.isArray(aux.units) ? aux.units : [];
      const fullBldgs = Array.isArray(aux.buildings) ? aux.buildings : [];
      auxUnitsById.clear();
      for (const rec of fullUnits)
        if (rec && typeof rec.id === "number") auxUnitsById.set(rec.id, rec);
      // B263: a full frame is clipped by the same interest window as deltas, so a send_full
      // assembled while the window lags the client's zoom would blank on-screen buildings just
      // like a windowing rm. Bridge identically: previously-held records absent from this frame
      // whose footprint the frame's own cam window doesn't cover, but our screen does, ride the
      // parked set; everything the frame covers is replaced verbatim (the frame is authority).
      const prevBldgs = auxBldgsById.size ? new Map(auxBldgsById) : null;
      auxBldgsById.clear();
      for (const rec of fullBldgs)
        if (rec && typeof rec.id === "number") auxBldgsById.set(rec.id, rec);
      if (prevBldgs) {
        for (const [id, b] of prevBldgs) {
          if (auxBldgsById.has(id) || auxBldgsParked.has(id)) continue;
          if (bldOutsideWindow(b, aux.cam) && bldInClientWindow(b)) parkBld(b);
        }
      }
      reconcileParkedBldgs(aux.cam);
      // B10 compat NOTE preserved: the frame's own (possibly id-less) records pass through
      // UNCHANGED as the base list; only id-carrying parked records are appended.
      const fullBldgsOut = auxBldgsParked.size
        ? fullBldgs.concat(Array.from(auxBldgsParked.values()))
        : fullBldgs;
      lastAux = { units: fullUnits, buildings: fullBldgsOut, players: aux.players || [],
                  proj: Array.isArray(aux.proj) ? aux.proj : [],   // WC-22 projectiles/vehicles
                  djobs: Array.isArray(aux.djobs) ? aux.djobs : [], // B35 designation jobs
                  env: (aux.env && typeof aux.env === "object") ? aux.env : null }; // WC-20 weather/season
      publishRoster(aux.players);   // WP-A: feed the roster surface (elevation bar / minimap / lobby)
      reconcileAuxCam(aux.cam);
      connected = true;
      markMapUpdate();
      setHud(`player: ${player}  camera: ${bufOx}, ${bufOy}, ${bufOz}`);
      mapDirty = true; // belt & suspenders: units/buildings changed even if cam didn't
    } catch (_) { /* never throw out of the socket callback */ }
  }

  // ---- boot / public API ------------------------------------------------------
  function boot() {
    try {
      bindListeners();
      resizeCanvas();
      if (managePoll) pollLoop();
      // FIX 2: instant PUSH transport. Feed pushed /mapdata into the SAME render path as
      // the poll. connect() carries this canvas's tile dims (FIX 1) so pushes are sized
      // to fill exactly like the poll. If the socket never connects or later drops,
      // onClose flips wsAlive false and pollLoop() resumes HTTP polling automatically
      // (never blank, never doubled).
      if (window.DwfWS && managePoll) {
        const d = desiredWinDims();
        DwfWS.connect(player,
          // WA-15: onMessage (the legacy per-player {mode,map} push) is never invoked on a
          // v1-only session -- dwf-ws.js routes BLOCK_SET straight into DwfCache
          // and AUX into onAux below instead (per dwf-ws.js's connect() doc: "a caller
          // may pass a no-op there when opts.proto1 is true"). wsAlive still needs setting
          // here in case a future non-v1 test harness connection ever calls it.
          () => { wsAlive = true; },
          () => { wsAlive = false; },       // onClose: fall back to HTTP polling
          d,
          { proto1: v1Active(), onAux: handleAuxV1, onHelloAck: handleHelloAckV1,
            onItemDefDict: handleItemDefDictV1, clientId: clientId,
            initialCam: desiredCam || { x: 0, y: 0, z: 0 } });
        startMapDrawLoop();
        // Smooth cursors ride the same socket: receive others' precise cursors and paint
        // them on the 60fps overlay. Falls silent (no throw) whenever the socket is down.
        if (typeof DwfWS.setCursorHandler === "function") {
          DwfWS.setCursorHandler(ingestSmoothCursors);
          startCursorOverlay();
        }
      }
      // WA-12 (§0.7): item_type numeric->string table. B256 moved this fetch OUT of the
      // DwfCache guard below: the RENDERER needs the table too (projectile item art --
      // the AUX wire carries a numeric item_type), not just the cache's v1 ITEM-tail ingest,
      // and a cache-less host (a fixture, a legacy JSON session) must still get bolt sprites.
      // applyItemTypeMeta forwards to the cache itself when one exists.
      loadJsonMap("/item_type_meta.json", (d) => {
        if (d && Array.isArray(d.item_types)) applyItemTypeMeta(d.item_types);
      });
      // WA-7 item 1 (§0.7 session meta table): fetch the tt -> {ttname,shape,mat,special}
      // table ONCE and feed it to the cache so windowView() can resolve the strings the
      // existing sprite pipeline (resolveSprite/tileColor/drawWallJoin/...) already expects
      // -- zero renderer changes needed to draw cache-fed data. A missing/failed fetch just
      // leaves the cache's meta table empty, so every tile decodes with blank strings (falls
      // back to flat colors, same "never blank, never throws" posture as the other maps).
      if (window.DwfCache && typeof DwfCache.setTiletypeMeta === "function") {
        loadJsonMap("/tiletype_meta.json", (d) => {
          if (d && Array.isArray(d.tiletypes)) DwfCache.setTiletypeMeta(d.tiletypes);
        });
        // A worker-backend ingest lands asynchronously (postMessage round-trip) -- subscribe
        // so a delta/keyframe that finishes processing AFTER applyKeyframe/applyDelta already
        // returned still triggers its own repaint on the next rAF tick.
        if (typeof DwfCache.onDirty === "function") {
          DwfCache.onDirty(() => { mapDirty = true; });
        }
      }
      // Fire-and-forget: sprite map/sheets load asynchronously and upgrade the map
      // in place as each sheet finishes loading (see getSheet()'s onload -> draw()).
      loadSpriteMap();
      loadTokenMap();
      loadShadowCellMap();
      loadJsonMap("/item_map.json", (d) => { itemMap = d; });
      // T1a/T1c: material identity + palette-swap table (see materialMap decl). The palette
      // default-color lookup is rebuilt on assign so blitCell's per-material remap is ready.
      // __dfcMaterialSettled: set once the fetch ATTEMPT completes (success OR fail) so the
      // sweep harness (tools/spriterange/range_diff.py) can wait for a deterministic material
      // state instead of racing page boot (the 213412Z partial caught c2d swapped vs GL plain
      // in the first windows). Never blocks anything client-side.
      loadJsonMap("/material_map.json?v=w9", (d) => { materialMap = d; buildPaletteLookup(); })
        .then(() => { try { window.__dfcMaterialSettled = true; } catch (_) {} });
      loadJsonMap("/plant_map.json", (d) => { plantMap = d; });
      loadJsonMap("/tree_map.json", (d) => { treeMap = d; });
      loadJsonMap("/building_map.json", (d) => { buildingMap = d; });
      loadJsonMap("/creatures_map.json", (d) => { creaturesMap = d; });
      // WC-12: material -> spatter-decal-family map (blood/mud/snow/vomit/... + fallen-
      // leaves/fruit litter families). Missing/failed fetch just leaves the old translucent
      // wash fallback in drawSpatter/no litter, same "layer falls back" posture.
      loadJsonMap("/spatter_map.json", (d) => { spatterMap = d; });
      // WC-19: designation-priority numerals + item-designation marks (forbid/dump/melt).
      // Interface-dir sheets (designation_priority.png / designation_item.png), served via
      // /sprites/img like designations.png; missing fetch just skips the badge/mark overlay.
      loadJsonMap("/overlay_map.json", (d) => { overlayMap = d; });
      loadGrassColors(); // WC-17: per-species grass tint table
      getBaked("dwarf.png");
      getBaked("dwarf_female.png");
      getSheet("liquids.png");
      getSheet(DESIG_SHEET); // designation-overlay glyph sheet (wire:5)
    } catch (_) {
      // Even boot failures should leave the page inert rather than throwing.
    }
  }

  // Initialize against a specific canvas. opts: {canvas: el|id, hud?: el|id, player?,
  // manageCamera?, managePoll?, onDraw?}. Safe to call once; returns the API (or null).
  function init(opts) {
    opts = opts || {};
    const el = (typeof opts.canvas === "string") ? document.getElementById(opts.canvas) : opts.canvas;
    if (!el || typeof el.getContext !== "function") return null;
    canvas = el;
    ctx = canvas.getContext("2d");
    hud = opts.hud ? ((typeof opts.hud === "string") ? document.getElementById(opts.hud) : opts.hud) : null;
    if (opts.player) player = opts.player;
    if (typeof opts.manageCamera === "boolean") manageCamera = opts.manageCamera;
    if (typeof opts.managePoll === "boolean") managePoll = opts.managePoll;
    onDrawCb = (typeof opts.onDraw === "function") ? opts.onDraw : null;
    boot();
    return api;
  }

  // WB-1: gate/F3-facing stats for THIS implementation (the seam's getStats() merges this
  // with the renderer name). renderer here is always "canvas2d" -- this file IS that
  // implementation; the seam layer (dwf-render.js) is what may report "gl" once WB-9
  // lands.
  // Draws completed in the last rolling second (the exact window diagText's fps line uses).
  // On a GL page this is the canvas2d UNDERLAY's paint cadence -- ~30/s pre-F1, dropping to
  // the keep-warm rate once the F1 paint-gate lands. drawRing is populated by recordDraw(),
  // which the F1 change calls only for frames that actually painted.
  function drawsPerSecNow() {
    const now = Date.now();
    let c = 0;
    for (let i = drawRing.length - 1; i >= 0; i--) { if (now - drawRing[i] > 1000) break; c++; }
    return c;
  }

  function getStats() {
    // perf audit §3 prereq (gate_userperf.py): surface lastDrawMs + drawsPerSec (both already
    // computed internally for the F3 overlay) so the gate can measure the occluded canvas2d
    // paint cost/cadence directly. GL already exposes lastBuildMs/sceneBuildCount/drawCount.
    return {
      renderer: "canvas2d", sceneBuildCount,
      lastDrawMs: +lastDrawMs.toFixed(2),
      drawsPerSec: drawsPerSecNow(),
    };
  }

  const api = {
    init,
    // WP-A §1.4: the ONE canonical name->color helper. New multiplayer UI (elevation
    // triangles, minimap viewboxes, lobby rows, attribution dots, chat names) calls
    // window.DwfTiles.playerColor(name) so every surface matches the presence cursor
    // color exactly -- never a re-implementation. (gl.js's playerColorRgb is the RGB
    // re-expression of the SAME FNV-1a hash for the GL path.)
    playerColor,
    // B131: farm-panel list icons reuse the maps this renderer already fetched instead of
    // issuing duplicate requests or maintaining a second atlas cache.
    getPlantMap: () => plantMap,
    getSpriteMap: () => spriteMap,
    // T1d: the wire-driven (type,subtype)->ITEMDEF token map lives only here (built from the
    // v1 ITEMDEF_DICT message). dwf-render.js forwards it to the GL renderer via setMaps
    // so GL's item resolver gains the itemdef->bytoken step it structurally lacked (the root of
    // the minecart/tool/toy/weapon PARITY-MISMATCH class). Returns the live Map or null.
    getItemDefTokens: () => itemDefTokens,
    // B256: the numeric df::item_type -> "TYPE" table (GET /item_type_meta.json). Forwarded to
    // the GL renderer by dwf-render.js the same way itemDefTokens is, so BOTH renderers
    // can turn the AUX projectile wire's numeric item_type into real item art.
    getItemTypeNames: () => itemTypeNames,
    _projItemVisualForTest: projItemVisual,
    _setItemDefTokensForTest: (m) => { itemDefTokens = m; },
    resolveItemSpriteRef,
    refresh: pollNow,      // force an immediate /mapdata refetch (after a camera move)
    getLatest: () => latest,
    isConnected: () => connected,
    resize: resizeCanvas,
    draw,
    screenToGrid,
    getRenderRect,
    zoom,        // zoom("in"|"out") -> {dw,dh} change in requested window tile dims
    zoomTo,      // zoomTo(px) -> {dw,dh}; set an exact px/tile
    getZoom,     // -> {px,min,max,def}
    pingSplash,  // WT27: pingSplash(x,y,z,name) -> spawn a LoL-style location-ping splash in name's color
    getStats,    // -> {renderer, sceneBuildCount}
    // WT11 (3D world viewer): the SAME material-color resolution path the 2D map uses, exported
    // as a clean public contract so dwf-voxelizer.js colors each solid voxel byte-identically
    // to the 2D tile fill. `tileColor(t, skipLiquidColor)` dispatches into the WALLSFIX/TX16
    // wallMaterialRgb path for walls and matRgb for floors (see tileColor above); the voxelizer
    // always passes skipLiquidColor=true so a flooded floor uses its bed material, not the liquid
    // wash. matRgb/wallMaterialRgb are exported alongside for the voxelizer's parity fixture.
    tileColor: (t, skipLiquidColor) => tileColor(t, skipLiquidColor),
    matRgb,
    wallMaterialRgb,
    _wantsHiddenHatchForTest: wantsHiddenHatch,   // WT25: tt<0 in-bounds -> base-hatch decision
    _inMapBoundsForTest: inMapBounds,             // WT25: (t,dims) footprint test
    _overlaysAllowedForTest: overlaysAllowed,     // B235: only DISCOVERED tiles get the overlay stack
    _setMapDimsForTest: (d) => { v1MapDims = d; }, // WT25: inject hello_ack footprint headless
    // B263 hooks: the renderer-facing AUX state + the windowing-rm parking bridge, so the
    // zoom-flash harness can assert "an on-screen workshop never leaves the building set"
    // without driving a canvas. Debug/fixture-replay only, same convention as every _ForTest.
    _lastAuxForTest: () => lastAux,
    _parkedBldgsForTest: () => Array.from(auxBldgsParked.keys()),
    _bldOutsideWindowForTest: bldOutsideWindow,
    // B211: pure single-regime zoom step (px,dir) -> next px, clamped to [min,max].
    _zoomStepPxForTest: zoomStepPx,
    _windowDimsForTest: desiredWinDims,
    _zoomConstantsForTest: () => ({ min: TILE_PX_MIN, max: TILE_PX_MAX, def: TILE_PX_DEFAULT,
      factor: ZOOM_FACTOR }),
    // WT27: ping-splash lifecycle seams -- spawn, inspect the live queue, and drive one frame at an
    // injected `now` so the splash's spawn/animate/reap can be asserted without a canvas or RAF.
    _pingSplashForTest: pingSplash,
    _pingSplashCountForTest: () => activePings.length,
    _drawPingSplashesForTest: (octx, now) => drawPingSplashes(octx, now),
    _setGeomForTest: (g) => { geom = g; },
    // WA-13: pan/z call sites (dwf-core.js's queueMove/centerOnCursor) call these the
    // INSTANT local input happens, before the HTTP POST /camera round-trip even starts. No-op
    // outside protocol v1 -- legacy windowing stays entirely server-push-driven, unchanged.
    noteCamDelta,     // noteCamDelta(dx,dy,dz) -- relative shift (pan/z-step)
    setCamAbsolute,   // setCamAbsolute(x,y,z) -- absolute jump (center-on-cursor)
    // Camera snap-back fix (2026-07-17): the authoritative CLIENT-side optimistic camera position.
    // dwf-core.js reads this to send the new ABSOLUTE camera over the WS (the primary transport) at
    // each pan/z/absolute flush -- noteCamDelta/setCamAbsolute have already applied the move to
    // desiredCam by the time a flush fires, so this is the exact position to broadcast. Null until
    // the first hello_ack/AUX seeds the window (then dwf-core falls back to the legacy HTTP POST).
    getDesiredCam: () => (desiredCam ? { x: desiredCam.x, y: desiredCam.y, z: desiredCam.z } : null),
    // WC-4 test hooks -- debug/fixture-replay only, NOT part of the public contract (same
    // convention as dwf-render.js's `_impls`): expose the internal building-fallback
    // resolution so tools/harness/wc4_building_test.mjs can assert cell ids without driving
    // the whole canvas pipeline (sprite <img> loads never fire in a headless/node harness).
    _buildingEntryForTest: buildingEntry,
    _statueEntryForTest: statueEntry,     // B253: (b) -> 3-cell statue composite entry | null
    _plannedConstructionEntryForTest: plannedConstructionEntry,  // TX17
    _constructionPlannedTokenForTest: CONSTRUCTION_PLANNED_TOKEN, // TX17
    _buildingsInPaintOrderForTest: buildingsInPaintOrder,
    _buildingAlphaForZForTest: buildingAlphaForZ,
    _resolveDesigForTest: resolveDesig,
    _DESIG_TINT: DESIG_TINT,
    _AUTOMINE_SPRITE_TINT: AUTOMINE_SPRITE_TINT,
    _resolveDjobForTest: resolveDjob,
    _designationGlyphVisibleForTest: designationGlyphVisible,
    _hasBlinkingDesignationJobForTest: hasBlinkingDesignationJob,
    _workedTileUnitVisibleForTest: workedTileUnitVisible,
    _designationBlinkStateForTest: designationBlinkState,   // B135 three-state cadence
    _activeBlinkVisibleForTest: activeBlinkVisible,         // B135 400ms half-beat
    _DESIG_ACTIVE_BLINK_MS: DESIG_ACTIVE_BLINK_MS,
    _resolveTileDesignationForTest: resolveTileDesignation,
    _drawDesignationForTest: drawDesignation,   // B204: drives the designation overlay against the init ctx
    // B269: DF's damp/warm mining-cancellation indicators. setMineMode is the ONE input the
    // overlay needs from the placement UI (dwf-controls-placement.js calls this and
    // DwfGL.setMineMode together on every dig-tool selection change).
    setMineMode: setMineMode,
    MINING_SHEET: MINING_SHEET, MINING_CELL: MINING_CELL,
    _miningIndicatorCellForTest: miningIndicatorCell,
    _drawMiningIndicatorForTest: drawMiningIndicator,
    // MARKER-COLOR: fixed-blue marker palette constants -- pinned equal to dwf-gl.js's by marker_recolor_test.mjs.
    _DESIG_WASH_ALPHA: DESIG_WASH_ALPHA, _DESIG_WASH_ALPHA_MARKER: DESIG_WASH_ALPHA_MARKER,
    _MARKER_RECOLOR: MARKER_RECOLOR, _MARKER_GLYPH_TINT: MARKER_GLYPH_TINT, _MARKER_WASH_RGB: MARKER_WASH_RGB,
    _flowOverlayForTest: flowOverlayFor,  // B139: (cloud, nowMs) -> {rgb,alpha}|null (miasma haze)
    _drawFlowsForTest: drawFlows,         // B139: drives the haze pass against the init ctx directly
    _machineEntryForTest: machineEntry,   // WC-8: (b, buildingMap, frameParity) -> synth entry|null
    _machineFrameParityForTest: machineFrameParity,
    _machineAnimPhaseForTest: machineAnimPhase,
    _machineCadenceStepForTest: machineCadenceStep,
    _hasDrawableMachineForTest: hasDrawableMachine,
    _farmPlotEntryForTest: farmPlotEntry,  // B27a: (b) -> furrowed/planted bed entry|null
    _farmCropPlansForTest: farmCropPlans,  // TX4: shared per-stage crop overlay plans
    _setSpriteMapForTest: (m) => { spriteMap = m; }, // inject a mock /sprites/map.json in a headless harness
    _setTiletypeTokenMapForTest: (m) => { tiletypeTokenMap = m; }, // B71-r3: inject the real token map headless
    _setSheetForTest: (name, sheet) => { sheets[name] = sheet; }, // inject a pre-loaded sheet (TX18 flow-art headless test)
    _resolveFlowFrameCellForTest: resolveFlowFrameCell,
    _worldAnimMsForTest: worldAnimMs,   // B206: pause-aware world clock feeding flows + machines           // TX18: (token, nowMs) -> {img,col,row}|null
    _isOverlayOnlyBuildingTypeForTest: isOverlayOnlyBuildingType,
    _pickBuildingTintRgbForTest: pickBuildingTintRgb,   // window #13 (corrected): component b.crgb ONLY, else null (header b.rgb never tints)
    _pickBuildingPalRowForTest: pickBuildingPalRow,     // B273: component STATE_COLOR token -> exact palette row
    _buildingTintRgbForTest: buildingTintRgb,           // B14 white-lerp multiply factor (must byte-match gl.js's buildingTintRgb)
    _liquidEdgeTokensForTest: (t, gx, gy, lookupTile, Adj) => liquidEdgeTokens(t, gx, gy, lookupTile, Adj),
    _sheetCellGeometryForTest: sheetCellGeometry,
    // WC-3/WC-11/WC-12/WE-4 test hooks -- debug/fixture-replay only, same convention as the
    // WC-4 hooks above: expose the pure resolution helpers so a headless harness can assert
    // cell ids/tier selection without driving the whole canvas pipeline.
    _resolveItemEntryForTest: resolveItemEntry,
    _setItemMapForTest: (m) => { itemMap = m; },
    _setCreaturesMapForTest: (m) => { creaturesMap = m; },
    _resolveItemVisualForTest: resolveItemVisual,   // T1d: {entry,source} incl itemdef+material steps
    _containerPeekEntryForTest: containerPeekEntry, // TX1: (containerItem, peek) -> overlay cell|null
    _drawItemForTest: drawItem,                     // TX1: drives the item layer (incl. peek composite)
    _matPalRowForTest: matPalRowFor,                // T1c: material -> palette row
    _matFamilyForItemForTest: matFamilyForItem,     // T1d: EXACT METAL/STONE family (material-aware)
    _paletteRemapForTest: (palRow) => {             // T1c: pure remap fn used by paletteSwappedCell
      if (!paletteLookup || !materialMap || !materialMap.palette) return null;
      const target = materialMap.palette.rows[palRow];
      if (!target || !target.length) return null;
      return (d) => {
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const k = paletteLookup.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          if (k !== undefined) { const tt = target[k]; if (tt) { d[i] = tt[0]; d[i + 1] = tt[1]; d[i + 2] = tt[2]; } }
        }
      };
    },
    _setMaterialMapForTest: (m) => { materialMap = m; buildPaletteLookup(); },
    _sandFloorPlanForTest: sandFloorPlan,
    _itemSpatterTintRgbForTest: itemSpatterTintRgb,
    _pickItemSpatterForTest: pickItemSpatterLitter,     // B138: one-decal-per-tile winner pick
    // B47 construction floor/track material-art plan (pure: ttname+base_mt/base_mi ->
    // {token, palRow, mask} | null) -- asserted vs the native cons:floor/track families.
    _constructionFloorPlanForTest: constructionFloorPlan,
    _constructionTrackMaskForTest: constructionTrackMask,
    _fortificationOpenTokenForTest: fortificationOpenToken,
    _consMaterialForTest: consMaterial,                 // WALLSFIX: base_mt/mi -> {family,palRow}|null
    _consMaterialRgbForTest: consMaterialRgb,           // WALLSFIX: base_mt/mi -> [r,g,b]|null (fill)
    _wallMaterialForTest: wallMaterial,                 // TX16: construction/natural-stone wall material policy
    _wallJoinPalRowForTest: wallJoinPalRow,             // TX16: construction/natural-stone edge swap row
    _wallBackingTokenForTest: wallBackingToken,         // B281: natural wall dark hidden-rock underlay
    _terrainSpritePalRowForTest: terrainSpritePalRow,   // B273: palette-authored natural terrain classes
    _wallPrefixForTest: wallPrefix,                     // WALLSFIX: (mat, base_mt) -> family prefix
    _resolveVerminEntryForTest: resolveVerminEntry,
    _handleItemDefDictForTest: handleItemDefDictV1,
    _matFamilyForTest: matFamilyFor,
    _spatterFamilyForTest: spatterFamilyFor,
    _bloodFamilyFromRgbForTest: bloodFamilyFromRgb,
    _spatterShapeForTest: spatterShapeFor,
    _spatterVisibleForTest: spatterVisible,
    _spatterVisibleAmountForTest: SPATTER_VISIBLE_AMOUNT,
    _resolveUnitTierForTest: (u) => resolveUnitTier(u, creaturesMap && creaturesMap.races),
    _getUnitSpriteForTest: getUnitSprite,
    _unitGhostPlanForTest: unitGhostPlan,           // B98: (u) -> {rgb,alpha,css} | null
    _ghostTintRgbForTest: GHOST_TINT_RGB,           // B98: shared tint (== dwf-gl.js)
    _ghostAlphaForTest: GHOST_ALPHA,                // B98: shared translucency
    _unitStatusIconForTest: unitStatusIconForBits,
    _unitStatusIconNowForTest: unitStatusIconNow,          // native per-unit phase-gated resolver
    _nativeBubblePhaseForTest: nativeBubblePhase,          // phase = (id*0x86e8 + nowMs) % 7000
    _physicalStatusIconForTest: physicalStatusIconForBits,
    _ordinaryStatusIconForTest: ordinaryStatusIconForBits,
    _unitStatusVisibilitySignatureForTest: unitStatusVisibilitySignature,
    NATIVE_BUBBLE_PERIOD_MS, NATIVE_BUBBLE_ID_STRIDE, NATIVE_BUBBLE_ORDINARY_MS,
    // Bubbles use the NATIVE per-unit phase cadence (nativeBubblePhase), so this NO LONGER describes
    // bubble visibility. It is retained as the shared designation/flow 800ms beat probe
    // (designationGlyphVisible state 1 + flowOverlayFor) for the animation suites that pin those.
    _unitStatusBlinkVisibleForTest: unitStatusBlinkVisible,
    _unitStatusDrawPlanForTest: unitStatusDrawPlan,
    _hasDrawableUnitStatusForTest: hasDrawableUnitStatus,
    // WC-14 test hooks -- same convention: expose the ttname parser and the species/family/
    // variant cell resolver so tools/harness/wc14_tree_test.mjs can assert exact cell ids
    // against the REAL committed web/tree_map.json without driving the canvas pipeline.
    _parseTreeTtnameForTest: parseTreeTtname,
    _resolveTreeCellForTest: resolveTreeCell,
    _resolveOverleavesForTest: resolveOverleaves,   // B47: canopy leaf-overlay resolution
    _isTreeWallMatForTest: isTreeWallMat,           // B62: TREE/MUSHROOM WALL-as-trunk predicate
    _wallJoinBaseTokenForTest: wallJoinBaseToken,   // B62: (t, openMask) -> stone-edge token | null
    _wallDetailPrefixForTest: wallDetailPrefix,     // B74: (t) -> smoothed/worn wall family | null
    _tileColorForTest: tileColor,                   // B62: corner base-fill color assertion
    _derivedTreePartForTest: derivedTreePart,       // B62-r2: tail-less tree part derivation
    _grassBackingCellForTest: grassBackingCell,     // B62-r2: (t,gx,gy,lookup) -> grass cell | null
    _groundBackingCellForTest: groundBackingCell,   // B241: (t,gx,gy,lookup) -> {sheet,col,row,wash} | null
    _boulderVariantForTest: boulderVariant,         // B241: (t,gx,gy) -> {col,row} | null (8-cell fan-out)
    _isGrassBackingSourceForTest: isGrassBackingSource,
    // WC-17/WC-18 test hooks -- same convention: expose the pure resolution helpers
    // (no sheet/Image-load dependency) so tools/harness/wc17_wc18_test.mjs can assert
    // tier/tint/mask selection against the REAL committed web/grass_colors.json without
    // driving the whole canvas pipeline.
    _grassTierIndexForTest: grassTierIndex,
    _grassSpeciesTintForTest: grassSpeciesTint,
    _engravingWallTokenForTest: engravingWallToken,
    _engravingWallPlanForTest: engravingWallPlan,       // TX16: engraved wall token + material row
    _engravingFloorPlanForTest: engravingFloorPlan,     // B273: palette/non-palette floor art + row
    _itemMarkTokenForTest: itemMarkToken,
    _projCenterPxForTest: projCenterPx,
    _resolveSpriteForTest: resolveSprite,
    // Transient-sheet-failure retry test hook (2026-07-07 ledger fix, "blocky flat-color
    // grass"): exposes getSheet() directly so a harness can drive its FakeImage.onerror and
    // assert the sheet recovers after SHEET_RETRY_DELAY_MS instead of staying failed forever.
    _getSheetForTest: getSheet,
    // Sweep-#2 fog verdict test hooks -- expose the measured see-down fog math (fitted
    // against docs/reference/fogparams.json) so a headless harness can assert the
    // canvas2d curve/color directly, same convention as the hooks above.
    _fogAlphaForDepthForTest: fogAlphaForDepth,
    _fogColorForTest: () => FOG_COLOR.slice(),
  };
  try { window.DwfTiles = api; } catch (_) { /* non-browser context */ }

  // Standalone auto-boot: tiles.html ships a #tilemap canvas + #hud status line and no
  // embedder, so claim them with full self-managed camera + poll. In the embedded full
  // client there is no #tilemap, so this is skipped and dwf-core.js calls init().
  try {
    const legacy = document.getElementById("tilemap");
    if (legacy && !canvas) {
      init({ canvas: legacy, hud: "hud", manageCamera: true, managePoll: true });
    }
  } catch (_) { /* ignore */ }
})();
