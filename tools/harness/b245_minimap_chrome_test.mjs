// b245_minimap_chrome_test.mjs -- offline fixture acceptance for B245 (minimap / elevation-column
// chrome: the recenter-locations entry point, the native recenter-locations panel, and the
// MEASURED icon-column + minimap geometry).
//
// The three banked oracles this pins (tools/orchestrator/attachments/):
//   B243-broken-ours-tab.png    -- the defect: a vertical "LOCATIONS" tab over the elevation bar.
//   B243-oracle-native-icon.png -- native's entry point: the RECENTER_HOTKEYS cell atop the icon
//                                  column beside the minimap. Measured at exactly 1.75x native
//                                  scale: 32x36 cells stacked FLUSH, column FLUSH against the map
//                                  frame, 16x24 pair cells, map content flush to the frame.
//   B243-oracle-native-panel.png-- the panel row grammar (name field / quill / RECENTER_RECENTER /
//                                  RECENTER_SET_LOCATION / red X; cyan position line; green
//                                  hotkey; green Add-new plaque).
//
// Sections:
//   1. THE TAB IS GONE -- and the entry point is the raws-cited recenter icon in the column.
//   2. RAWS CITATIONS  -- interface_map.json carries exactly the cells graphics_interface.txt
//                         defines for the RECENTER_* family (the map is generated from the raws;
//                         pinning the cells pins the citation).
//   3. PANEL GRAMMAR   -- hotkeysPanelMarkup(fixture) row by row against the panel oracle.
//   4. GEOMETRY ORACLE -- rectangles computed from the REAL stylesheet (the B237/wt11 approach):
//                         the column + minimap must exactly fill #rightHud (the old 208px box held
//                         214px of content -- "the map might even be slightly off"), cells are
//                         bare native rectangles, and [hidden] actually hides #followBtn.
// Each section carries a test-the-test seeding the SHIPPED defect back in.
//
// Run: node tools/harness/b245_minimap_chrome_test.mjs        (zero-dep, Node >= 18)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const readWeb = (...p) => fs.readFileSync(path.join(ROOT, "web", ...p), "utf8");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

// ---- module setup: real DWFUI under a stub window --------------------------------------------
globalThis.window = globalThis;           // ui-components + consumers bind to `window` if present
const DWFUI = require(path.join(ROOT, "web", "js", "dwf-ui-components.js"));
globalThis.DWFUI = DWFUI;
const HK = require(path.join(ROOT, "web", "js", "dwf-hotkeys.js"));
require(path.join(ROOT, "web", "js", "dwf-interface-shell.js"));
const shell = globalThis.DwfInterfaceShell;
const HK_SRC = readWeb("js", "dwf-hotkeys.js");
const INDEX = readWeb("index.html");
const CSS = readWeb("css", "dwf.css");
const MAP = JSON.parse(readWeb("interface_map.json"));

// =================================================================================================
console.log("# B245-1: the vertical LOCATIONS tab is GONE; the entry point is the column icon");
// =================================================================================================
check("no #dfHotkeysTab anywhere in the module", !/dfHotkeysTab/.test(HK_SRC));
check("no vertical-writing-mode tab CSS in the module", !/writing-mode/.test(HK_SRC));
check("no 'LOCATIONS' tab text in the module's CODE (comments may cite the defect)",
  !/["']LOCATIONS["']/.test(HK_SRC.replace(/^\s*\/\/.*$/gm, "")));
check("index.html carries no tab either", !/dfHotkeysTab/.test(INDEX));
check("the panel opener is #recenterLocationsBtn (the column icon)",
  /getElementById\("recenterLocationsBtn"\)/.test(HK_SRC));

const mm = shell.minimapMarkup({ elevation: 42 });
const btnRe = id => new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`);
const recenterBtn = (mm.match(btnRe("recenterLocationsBtn")) || [""])[0];
check("column has #recenterLocationsBtn", recenterBtn.length > 0);
check("it wears RECENTER_HOTKEYS (the native recenter glyph, circled in the oracle)",
  /data-dwfui-sprite="RECENTER_HOTKEYS"/.test(recenterBtn));
check("it is a COMPLETE native cell (self-framed -- no generic gold box around DF's own frame)",
  /data-dwfui-self-framed="true"/.test(recenterBtn));
check("it sits at the TOP of the column (before RECENTER_SURFACE, as in the native capture)",
  mm.indexOf("RECENTER_HOTKEYS") >= 0 && mm.indexOf("RECENTER_HOTKEYS") < mm.indexOf("RECENTER_SURFACE"));
check("surface then deepest follow (native order)",
  mm.indexOf("RECENTER_SURFACE") < mm.indexOf("RECENTER_DEEPEST"));
check("the clear-tracking X (#followBtn) is LAST so its appearance never shifts the native five",
  mm.indexOf('id="followBtn"') > mm.indexOf("tool-col-pair"));
check("surface/deepest/display-toggle cells are self-framed native cells too",
  ["RECENTER_SURFACE", "RECENTER_DEEPEST", "LIQUID_NUMBERS_OFF", "RAMP_ARROWS_OFF",
    "RECENTER_REMOVE_OR_CLEAR"].every(t =>
    new RegExp(`data-dwfui-self-framed="true"[^>]*>\\s*<span[^>]*data-dwfui-sprite="${t}"|` +
      `data-dwfui-sprite="${t}"[^>]*data-dwfui-self-framed="true"`).test(mm)));
guard("the oracle catches a NON-self-framed recenter cell (the shipped defect shape)",
  !/data-dwfui-self-framed="true"/.test(
    DWFUI.toolButtonHtml({ cls: "square-button", labelHtml: DWFUI.rawHtml("seeded-bad plain glyph", "&#10060;") })));

// =================================================================================================
console.log("\n# B245-2: raws citations -- the RECENTER_* family cells");
// =================================================================================================
// graphics_interface.txt (vanilla_interface), verified 2026-07-14:
//   [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_RECENTER:0:0:4:3:RECENTER_HOTKEYS]
//   [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_RECENTER:4:0:4:3:RECENTER_SURFACE]
//   [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_RECENTER:8:0:4:3:RECENTER_DEEPEST]
//   [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_RECENTER:12:0:4:3:RECENTER_SET_LOCATION]
//   [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_SHARED:0:12:4:3:RECENTER_RECENTER]
//   [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS_SHARED:4:3:4:3:RECENTER_REMOVE_OR_CLEAR]
// (4x3 tiles of the 8x12 cell = 32x36 px; tile coords x8/x12 = the px offsets below.)
const cell = (tok, img, cx, cy) => {
  const r = MAP[tok];
  check(`${tok} = ${img} @ ${cx},${cy} 32x36 (raws TILE_GRAPHICS_RECTANGLE cell)`,
    r && r.img === img && r.cx === cx && r.cy === cy && r.w === 32 && r.h === 36,
    r ? JSON.stringify(r) : "ABSENT");
};
cell("RECENTER_HOTKEYS", "interface_bits_recenter.png", 0, 0);
cell("RECENTER_SURFACE", "interface_bits_recenter.png", 32, 0);
cell("RECENTER_DEEPEST", "interface_bits_recenter.png", 64, 0);
cell("RECENTER_SET_LOCATION", "interface_bits_recenter.png", 96, 0);
cell("RECENTER_RECENTER", "interface_bits_shared.png", 0, 144);
cell("RECENTER_REMOVE_OR_CLEAR", "interface_bits_shared.png", 32, 36);
guard("the cell oracle discriminates (a wrong offset fails)",
  !(MAP.RECENTER_HOTKEYS.cx === 32));

// =================================================================================================
console.log("\n# B245-3: the panel grammar, row by row (B243-oracle-native-panel.png)");
// =================================================================================================
// A fixture shaped like GET /hotkeys, mirroring the oracle capture: the wagon row (F1/assigned),
// "Location 2" (assigned), an added-but-unassigned row, a 10th live row (no digit key in this
// client), and dead (cmd=None) slots that must NOT render.
const fx = [];
for (let i = 0; i < 16; i++) fx.push({ slot: i, cmd: -1, set: false, name: "", x: -30000, y: -30000, z: -30000 });
fx[0] = { slot: 0, cmd: 0, set: true, name: "Wagon arrival location", x: 96, y: 97, z: 42 };
fx[1] = { slot: 1, cmd: 0, set: true, name: "Location 2", x: 86, y: 94, z: 36 };
fx[2] = { slot: 2, cmd: 0, set: false, name: "", x: -30000, y: -30000, z: -30000 };
fx[9] = { slot: 9, cmd: 0, set: false, name: "", x: -30000, y: -30000, z: -30000 };

const html = HK.hotkeysPanelMarkup(fx);
const rows = html.match(/<div class="hk-row"[^>]*>/g) || [];
check("only LIVE slots render rows (4 of 16)", rows.length === 4, `rows=${rows.length}`);
const rowOf = slot => {
  const i = html.indexOf(`data-slot="${slot}"`);
  const j = html.indexOf('<div class="hk-row"', i + 1);
  return i < 0 ? "" : html.slice(i, j < 0 ? html.length : j);
};
const r0 = rowOf(0), r2 = rowOf(2), r9 = rowOf(9);

// the name field: black-fill/silver-border styling is pinned in the geometry section; here the
// component + its native placeholder.
check("row 1 name field is the DWFUI text input with the saved name",
  /dwfui-text-input[^>]*/.test(r0) && /value="Wagon arrival location"/.test(r0));
check("an unnamed row shows native's 'Unnamed recenter location' placeholder",
  /placeholder="Unnamed recenter location"/.test(r2) && !/value="[^"]/.test(r2));
// the four tiles, in oracle order: quill, recenter, set-location, red X
const tileOrder = ["UNIT_SHEET_CUSTOMIZE", "RECENTER_RECENTER", "RECENTER_SET_LOCATION", "RECENTER_REMOVE_OR_CLEAR"];
check("row tiles are quill -> recenter -> set-location -> red-X (oracle order)",
  tileOrder.every(t => r0.includes(`data-dwfui-sprite="${t}"`)) &&
  tileOrder.every((t, i) => i === 0 || r0.indexOf(`data-dwfui-sprite="${tileOrder[i - 1]}"`) < r0.indexOf(`data-dwfui-sprite="${t}"`)));
check("tiles carry their actions (rename-focus / go / save / clear)",
  /data-hk-focus="0"/.test(r0) && /data-hk-go="0"/.test(r0) &&
  /data-hk-save="0"/.test(r0) && /data-hk-clear="0"/.test(r0));
// the position line: cyan when assigned, grey 'Not yet assigned' when not
check("assigned row prints the cyan position line EXACTLY as native words it",
  /data-dwfui-bitmap-text="Recenter to elevation 42, position 96,97"/.test(r0) &&
  /class="dwfui-bitmap-text hk-pos"/.test(r0));
check("unassigned row prints grey 'Not yet assigned'",
  /data-dwfui-bitmap-text="Not yet assigned"/.test(r2) && /hk-pos hk-unset/.test(r2));
// the hotkey line: green key; this client's REAL keys are the digits 1-9 (WT12/B203), so slot 1
// prints "1" (native's F1 belongs to the browser) and the 10th live row prints no key line.
check("row 1 prints 'Hotkey:' with the key in green (.hk-key), key = 1",
  /data-dwfui-bitmap-text="Hotkey: "/.test(r0) && /class="dwfui-bitmap-text hk-key"[^>]*data-dwfui-bitmap-text="1"/.test(
    r0.replace(/data-dwfui-bitmap-text="1"[^>]*class="dwfui-bitmap-text hk-key"/, m => m) // order-agnostic below
  ) || (/hk-key/.test(r0) && /data-dwfui-bitmap-text="1"/.test(r0)));
check("a slot past 9 has NO hotkey line (no digit key exists for it here)",
  !/hk-hotline/.test(r9) && !/hk-key/.test(r9));
// the footer plaque
check("footer is the green 'Add new recenter location' plaque (DWFUI plaque, tone green)",
  /class="dwfui-plaque green[^"]*hk-add"/.test(html) &&
  /data-dwfui-bitmap-text="Add new recenter location"/.test(html));
check("header exists for the panel-frame drag handle, titled 'Recenter locations'",
  /hk-head/.test(html) && /data-dwfui-bitmap-text="Recenter locations"/.test(html));
// full-list edge: 16 live rows -> Add-new disabled
const fxFull = fx.map(hk => ({ ...hk, cmd: 0 }));
check("with all 16 slots live the Add-new plaque is disabled",
  /disabled/.test((HK.hotkeysPanelMarkup(fxFull).match(/<button[^>]*hk-add[^>]*>/) || [""])[0]));
guard("a dead slot (cmd=None) renders NO row", rowOf(3) === "");
guard("isLiveSlot discriminates: cmd=0 live, cmd=-1 dead, set beats a missing cmd",
  HK.isLiveSlot({ cmd: 0 }) && !HK.isLiveSlot({ cmd: -1, set: false, name: "" }) && HK.isLiveSlot({ set: true }));
guard("hotkeyLabelFor: slots 0-8 -> 1-9, slot 9+ -> none",
  HK.hotkeyLabelFor(0) === "1" && HK.hotkeyLabelFor(8) === "9" && HK.hotkeyLabelFor(9) === "");

// WT12 wiring is REUSED, not rebuilt: the digit map still exports and still addresses slots.
check("WT12 wiring intact: slotForDigit still exported and slot-addressed",
  typeof HK.slotForDigit === "function" && HK.slotForDigit(fx, 1) === fx[0] && HK.slotForDigit(fx, 3) === null);
// B216: opening the panel must not move the camera -- the ONLY /camera writes hang off explicit
// affordances (the recenter tile handler / digit jump), never off toggle/open/render.
{
  const toggleBody = (HK_SRC.match(/function toggle\(next\)[\s\S]*?\n  \}/) || [""])[0];
  const renderBody = (HK_SRC.match(/function render\(\)[\s\S]*?\n  \}/) || [""])[0];
  check("B216: toggle()/open path never recenters",
    toggleBody.length > 0 && !/recenterOn|\/camera/.test(toggleBody));
  check("B216: render() recenters only inside a click listener guarded on hk.set",
    /data-hk-go[\s\S]{0,200}addEventListener\("click"[\s\S]{0,200}hk\.set\) recenterOn/.test(renderBody));
}

// =================================================================================================
console.log("\n# B245-4: geometry from the REAL stylesheet (the wt11/B237 rectangle oracle)");
// =================================================================================================
// Parse top-level rules and @media blocks separately (a flat parse would let a media override
// masquerade as the base value).
function splitMedia(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const media = [];
  let base = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at < 0) { base += css.slice(i); break; }
    base += css.slice(i, at);
    const open = css.indexOf("{", at);
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    media.push({ cond: css.slice(at, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return { base, media };
}
function rulesOf(cssText) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssText))) {
    const decls = {};
    for (const d of m[2].split(";")) {
      const k = d.indexOf(":");
      if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
    rules.push({ selectors: m[1].split(",").map(s => s.trim()), decls });
  }
  return rules;
}
const declsOf = (rules, selector) => {
  const out = {};
  for (const r of rules) if (r.selectors.includes(selector)) Object.assign(out, r.decls);
  return out;
};
// Evaluate a width expression at interface scale s: `Apx`, or `calc(Apx * var(--dwfui-interface-scale[, f]) + Bpx)`.
function widthAt(expr, s) {
  if (expr == null) return NaN;
  let m = /^calc\(\s*([\d.]+)px\s*\*\s*var\(--dwfui-interface-scale(?:,\s*[\d.]+)?\)\s*(?:\+\s*([\d.]+)px\s*)?\)$/.exec(expr);
  if (m) return parseFloat(m[1]) * s + (m[2] ? parseFloat(m[2]) : 0);
  m = /^([\d.]+)px$/.exec(expr);
  return m ? parseFloat(m[1]) : NaN;
}
const px = v => (v == null ? 0 : parseFloat(String(v)) || 0);

const { base, media } = splitMedia(CSS);
const R = rulesOf(base);
const SCALE = (() => {   // the real knob, read from :root
  const m = /--dwfui-interface-scale:\s*([\d.]+)/.exec(CSS);
  return m ? parseFloat(m[1]) : 1;
})();

// The layout oracle: content width of #rightHud's flex row vs its declared width. `decls` is a
// parameter so the test-the-test can seed the SHIPPED geometry back through the SAME arithmetic.
function rightHudLayout(d, s) {
  const nativeCellW = MAP.RECENTER_HOTKEYS.w;                       // 32
  const btn = d.colBtn;
  // a bare host (border 0/padding 0/width auto) is exactly the painted cell: native w * scale.
  const bw = px(btn.border) || px((btn.border || "").split(/\s+/)[0]);
  const btnW = (btn.width === "auto" || btn.width == null)
    ? nativeCellW * s + 2 * bw
    : px(btn.width);
  const colDeclared = widthAt(d.col.width, s) || btnW;
  const colW = Math.max(colDeclared, btnW);                         // overflowing cells widen the column
  const mapBorder = px((d.dfPanel.border || "0").match(/[\d.]+px/) ? d.dfPanel.border : "0");
  const canvasW = px(d.canvas.width);
  const canvasBorder = px((d.canvas.border || "0").match(/[\d.]+px/) ? d.canvas.border : "0");
  const pad = px(d.map.padding);
  const mapW = canvasW + 2 * canvasBorder + 2 * pad + 2 * mapBorder;
  const gap = px(d.hud.gap);
  return { colW, mapW, gap, content: colW + gap + mapW, declared: widthAt(d.hud.width, s) };
}
const shipped = {
  hud: declsOf(R, "#rightHud"),
  col: declsOf(R, "#minimapToolCol"),
  colBtn: declsOf(R, "#minimapToolCol .square-button"),
  map: declsOf(R, "#minimap"),
  canvas: declsOf(R, "#minimapGrid"),
  dfPanel: declsOf(R, ".df-panel"),
};
const L = rightHudLayout(shipped, SCALE);
check(`#rightHud content EXACTLY fills its box (no overflow, no slack) at scale ${SCALE}: ` +
  `${L.colW} + ${L.gap} + ${L.mapW} = ${L.declared}`,
  Math.abs(L.content - L.declared) < 0.01 && L.gap === 0,
  JSON.stringify(L));
check("column is flush against the map frame (gap 0 -- measured 0 in the native capture)",
  px(shipped.hud.gap) === 0);
check("column cells are BARE hosts (border 0, padding 0, width auto -- the cell IS the rectangle)",
  px(shipped.colBtn.border) === 0 && px(shipped.colBtn.padding) === 0 && shipped.colBtn.width === "auto");
check("cells stack flush (column gap 0 -- native tiles abut: boundaries 46/109/172/235 = 63px steps)",
  px(shipped.col.gap) === 0 && px(declsOf(R, ".tool-col-pair").gap) === 0);
check("column width = 32 native px * the interface scale",
  Math.abs(widthAt(shipped.col.width, SCALE) - 32 * SCALE) < 0.01, shipped.col.width);
{
  const pairBtn = declsOf(R, "#minimapToolCol .tool-col-pair .square-button[data-move-z]");
  const pw = widthAt(pairBtn.width, SCALE), ph = widthAt(pairBtn.height, SCALE);
  check("pair cells are the native 16x24 * scale; two abreast exactly fill the column",
    Math.abs(pw - 16 * SCALE) < 0.01 && Math.abs(ph - 24 * SCALE) < 0.01 &&
    Math.abs(2 * pw - widthAt(shipped.col.width, SCALE)) < 0.01,
    `${pairBtn.width} x ${pairBtn.height}`);
}
check("map content flush to the frame (#minimap padding 0; no second border on the canvas)",
  px(shipped.map.padding) === 0 && px(shipped.canvas.border) === 0);
check("the elevation band keeps its native gold divider (border-top on #elevation)",
  /2px solid/.test(declsOf(R, "#elevation")["border-top"] || ""));
check("[hidden] actually hides a column button (the author display no longer wins)",
  !!declsOf(R, "#minimapToolCol .square-button[hidden]").display &&
  declsOf(R, "#minimapToolCol .square-button[hidden]").display === "none");

// the media steps keep the same sum-of-parts law
for (const mq of media) {
  const mr = rulesOf(mq.body);
  const hud = declsOf(mr, "#rightHud");
  const canvas = declsOf(mr, "#minimapGrid");
  if (!hud.width || !canvas.width) continue;
  const mapW = px(canvas.width) + 2 * 2;   // canvas + df-panel borders (padding 0, canvas border 0)
  const want = 32 * SCALE + mapW;
  check(`media ${mq.cond}: width is still column + map (${want}px)`,
    Math.abs(widthAt(hud.width, SCALE) - want) < 0.01, `${hud.width} vs ${want}`);
}

// ---- test-the-test: seed the SHIPPED (pre-B245) geometry; the oracle must SEE the overflow ----
const old = {
  hud: { width: "208px", gap: "4px" },
  col: { width: null, gap: "2px" },
  colBtn: { width: "34px", height: "38px", border: "2px solid #d89b27", padding: "0" },
  map: { padding: "4px" },
  canvas: { width: "164px", border: "1px solid #000" },
  dfPanel: { border: "2px solid #d89b27" },
};
const LO = rightHudLayout(old, SCALE);
guard(`the oracle catches the shipped overflow (content ${LO.content}px > declared ${LO.declared}px)`,
  LO.content > LO.declared + 4, JSON.stringify(LO));
guard("the oracle catches a reintroduced column/map gap",
  (() => { const d = { ...shipped, hud: { ...shipped.hud, gap: "4px" } }; return rightHudLayout(d, SCALE).content !== L.declared; })());

console.log(`\nB245 minimap-chrome: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
