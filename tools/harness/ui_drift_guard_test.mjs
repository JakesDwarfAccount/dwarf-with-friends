// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// WT21 DWFUI drift guard. A cheap static analysis (node, no DF, no server, no browser) that
// FAILS when NEW hand-rolled UI drift appears, while a checked-in BASELINE
// (tools/harness/ui_drift_baseline.json) lets today's known debt pass. Frozen debt may only
// SHRINK; any new violation -- a new hand-rolled hex table, a copied DWFUI structural markup, a
// bypassed glyph, a third pill-switch copy, or a component that exists in code but not the spec
// table -- fails the build. Spec: docs/superpowers/specs/2026-07-10-ui-component-architecture.md
// (see "Component lifecycle procedure" + "Anti-drift rules").
//
//   node tools/harness/ui_drift_guard_test.mjs            # gate against the baseline
//   node tools/harness/ui_drift_guard_test.mjs --selftest # prove each rule catches a seeded-bad
//   UI_DRIFT_WRITE_BASELINE=1 node tools/harness/ui_drift_guard_test.mjs   # (re)freeze the baseline
//
// Gate semantics (line-shift robust): violations are keyed by `${rule}|${file}` -> count. A key
// absent from the baseline, or a count ABOVE its baseline, FAILS. A count BELOW baseline (or a
// baseline key at zero now) is an improvement -> printed as a prunable NOTE, never a failure (R5).
// Exit: 0 PASS, 1 FAIL.

import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const BASELINE_PATH = join(here, "ui_drift_baseline.json");
const COMPONENT_FILE = "web/js/dwf-ui-components.js";
const SPEC_FILE = "docs/superpowers/specs/2026-07-10-ui-component-architecture.md";

const rel = p => relative(root, p).split(sep).join("/");
function jsFiles() {
  const dir = join(root, "web/js");
  return readdirSync(dir).filter(f => f.endsWith(".js")).map(f => "web/js/" + f).sort();
}
function lineOf(src, index) { return src.slice(0, index).split("\n").length; }
function stableSignature(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

// ---- balanced-region + literal scanners (regex/scan-lite, zero deps) --------------------------

// Walk from an opening bracket to its match, returning [start,end) over src.
function balancedRegion(src, openIdx) {
  const open = src[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
}
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;
function countHex(s) { return (s.match(HEX) || []).length; }

// Every backtick template-literal region in the source (naive but adequate: DWFUI panels do not
// nest backticks inside ${} in ways that break this, and false splits only UNDER-count hex).
function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") { if (src[j] === "\\") j++; j++; }
      out.push({ start: i, text: src.slice(i, j + 1) });
      i = j + 1;
    } else i++;
  }
  return out;
}

// ---- the five rules ---------------------------------------------------------------------------
// Each returns [{ rule, file, line, hint }]. Cheap: single pass per file, no AST.

// R1 -- a module owning its own colour hex table when TOKENS owns colours. Two shapes:
//   (a) a `const IDENT = { ... }` / `[ ... ]` initializer whose body holds >= 3 hex literals;
//   (b) a template-literal (injected <style> / CSS-in-JS block) holding >= 5 hex literals.
//   (c) WAVE-5: a string-CONCATENATED or array-JOINed <style> block. R1 used to see (a) and (b) ONLY,
//       so a palette escaped detection purely by its SYNTAX: `st.textContent = [ "...", "..." ].join("")`
//       (settings), `el.innerHTML = "..." + "..."` (chat/join/audio/lobby) are member-expression
//       assignments, not declarations, and hold no backticks. Result: settings (52 hex), chat (24),
//       join (18), audio (13) and lobby (12) were ALL unbaselined while hostpanel was caught -- purely
//       because hostpanel happened to use a template literal. R1's green on those files was a FALSE
//       NEGATIVE, not a clean bill. We now scan any assignment into textContent/innerHTML/cssText, and
//       any adjacent run of string literals dense in hex, regardless of how it is spelled.
function ruleHexTables(file, src) {
  const out = [];
  const seenLines = new Set();
  const push = (idx, hint) => {
    const line = lineOf(src, idx);
    if (seenLines.has(line)) return;       // one finding per line: (a)/(b)/(c) can overlap
    seenLines.add(line);
    out.push({ rule: "R1", file, line, hint });
  };
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([{[])/g;
  let m;
  while ((m = decl.exec(src))) {
    const region = balancedRegion(src, m.index + m[0].length - 1);
    if (countHex(region) >= 3)
      push(m.index, `${m[1]}: colour table -> move colours into DWFUI.TOKENS.palette (no per-module hex maps)`);
  }
  for (const t of templateLiterals(src))
    if (countHex(t.text) >= 5)
      push(t.start, `embedded style/CSS palette (${countHex(t.text)} hex) -> reference TOKENS.palette / dwf.css vars`);
  // (c) an injected style block written as a concatenation / .join() into a style sink.
  const sink = /\.(?:textContent|innerHTML|cssText)\s*=\s*/g;
  while ((m = sink.exec(src))) {
    const region = src.slice(m.index, m.index + 8000);
    const stop = region.search(/\n\s*\}\s*\n|\n\s*(?:const|let|var|function)\b/);
    const body = stop === -1 ? region : region.slice(0, stop);
    const hex = countHex(body);
    if (hex >= 5)
      push(m.index, `injected style/CSS palette (${hex} hex, string-concat or .join) -> reference TOKENS.palette / dwf.css vars`);
  }
  return out;
}

// R2 -- hand-building DWFUI's OWN structural markup instead of calling the factory. Consumers pass
// their pinned class names through the cfg `cls` hooks; they must NEVER string-write dwfui-* markup
// into a rendered HTML `class="..."` attribute. We require the token to sit inside an HTML
// class attribute (class="...dwfui-row...") -- a legitimate factory call passes `cls: "dwfui-actions"`
// (a config value, no `class=`), so those are correctly NOT flagged.
const DWFUI_STRUCT = ["dwfui-row", "dwfui-tabs", "dwfui-tab", "dwfui-head", "dwfui-actions",
  "dwfui-plaque", "dwfui-art-btn", "dwfui-sidewin", "dwfui-mark", "dwfui-scroll", "dwfui-search",
  "dwfui-check", "dwfui-latch", "dwfui-segmented", "dwfui-modal", "dwfui-grid", "dwfui-cell",
  "dwfui-stepper", "dwfui-switch", "dwfui-status", "dwfui-stat-tile", "dwfui-bar-row", "dwfui-occupant-rail",
  "dwfui-sort-header", "dwfui-selectcell", "dwfui-selectcells"];
function ruleHandRolledMarkup(file, src) {
  const out = [];
  const re = new RegExp(`class\\s*=\\s*(["'\`])[^"'\`]*\\b(${DWFUI_STRUCT.join("|")})\\b`, "g");
  let m;
  while ((m = re.exec(src)))
    out.push({ rule: "R2", file, line: lineOf(src, m.index),
      hint: `hand-rolled markup with DWFUI class "${m[2]}" -> call DWFUI.${structFactory(m[2])} instead of copying its markup` });
  return out;
}
function structFactory(cls) {
  return ({ "dwfui-row": "rowHtml", "dwfui-tabs": "tabsHtml", "dwfui-tab": "tabsHtml",
    "dwfui-head": "headerHtml", "dwfui-actions": "actionButtonsHtml", "dwfui-plaque": "plaqueBtnHtml",
    "dwfui-art-btn": "artBtnHtml", "dwfui-sidewin": "sideWindowHtml", "dwfui-mark": "triState.markHtml",
    "dwfui-scroll": "scrollHtml", "dwfui-search": "searchHtml", "dwfui-check": "checkHtml",
    "dwfui-latch": "latchHtml", "dwfui-segmented": "segmentedHtml", "dwfui-modal": "modalHtml",
    "dwfui-grid": "gridHtml", "dwfui-cell": "gridCellHtml", "dwfui-stepper": "stepperHtml",
    "dwfui-switch": "switchHtml", "dwfui-status": "statusHtml", "dwfui-stat-tile": "statTileHtml",
    "dwfui-bar-row": "barRowHtml", "dwfui-occupant-rail": "occupantRailHtml",
    "dwfui-sort-header": "sortHeaderHtml", "dwfui-selectcell": "selectCellHtml",
    "dwfui-selectcells": "selectCellGroupHtml" })[cls] || "the factory";
}

// R3 -- glyph bypass: literal use of a DISTINCTIVE action/control glyph from TOKENS.glyphs instead
// of referencing TOKENS.glyphs.*. Scoped to the high-signal action vocabulary (view/follow/forbid/
// dump/hide/building/repeat/pause/play) -- the census's "3 glyph vocabularies for the same actions"
// drift. Generic marks (check/cross/back/close X) are deliberately EXCLUDED: they are ubiquitous
// and would drown the signal in false positives (they are the binary-check-classname debt, not this).
const GLYPH_ENTITIES = { 128269: "view", 127909: "follow", 128274: "forbid", 128465: "dump",
  128065: "hide", 127968: "building", 8635: "repeat", 10074: "pause", 9654: "play" };
const GLYPH_CHARS = { "\u{1F50D}": "view", "\u{1F3A5}": "follow", "\u{1F512}": "forbid",
  "\u{1F5D1}": "dump", "\u{1F441}": "hide", "\u{1F3E0}": "building" };
function ruleGlyphBypass(file, src) {
  const out = [];
  const ent = /&#(\d+);/g;
  let m;
  while ((m = ent.exec(src))) {
    const name = GLYPH_ENTITIES[Number(m[1])];
    if (name) out.push({ rule: "R3", file, line: lineOf(src, m.index),
      hint: `literal '${name}' glyph (&#${m[1]};) -> use DWFUI.TOKENS.glyphs.${name}` });
  }
  for (const [ch, name] of Object.entries(GLYPH_CHARS)) {
    let idx = src.indexOf(ch);
    while (idx !== -1) {
      out.push({ rule: "R3", file, line: lineOf(src, idx),
        hint: `literal '${name}' glyph -> use DWFUI.TOKENS.glyphs.${name}` });
      idx = src.indexOf(ch, idx + ch.length);
    }
  }
  return out;
}

// R4 -- duplicated pill toggle-switch. The shared native identity is the 34x18 gold-bordered pill;
// every hand-copied CSS block reproduces its geometry+colour verbatim. A 3rd copy must instead
// consume DWFUI.switchHtml (born once a third consumer exists -- B169's rule; census Wave 9).
const PILL_RE = /width:\s*34px;\s*height:\s*18px;\s*border:\s*1px solid #d89b27/g;
function rulePillSwitch(file, src) {
  const out = [];
  let m;
  while ((m = PILL_RE.exec(src)))
    out.push({ rule: "R4", file, line: lineOf(src, m.index),
      hint: `pill toggle-switch CSS copy -> extract DWFUI.switchHtml (+.dwfui-switch) and consume it` });
  return out;
}

// R5 -- bitmap text is the DEFAULT. A raw *Html text slot is an explicit bypass and must call the
// declared escape hatch (`rawHtml(reason, html)`) or already be a bitmap composition. Existing debt
// is frozen; a new silent `labelHtml: '<span>plain text</span>'` fails the ratchet.
function ruleRawTextBypass(file, src) {
  const out = [];
  const re = /\b(labelHtml|titleHtml|promptHtml|textHtml|valueHtml)\s*:/g;
  let m;
  while ((m = re.exec(src))) {
    const tail = src.slice(re.lastIndex, re.lastIndex + 260).split(/,\s*(?=[A-Za-z_$][\w$]*\s*:)|\n\s*\}/)[0];
    if (/\b(?:DWFUI|window\.DWFUI)\.(?:bitmapTextHtml|rawHtml)\s*\(/.test(tail)) continue;
    out.push({ rule: "R5", file, line: lineOf(src, m.index), signature: `${m[1]}:${stableSignature(tail)}`,
      hint: `${m[1]} bypasses bitmap text -> use the plain text field, DWFUI.bitmapTextHtml(), or DWFUI.rawHtml(reason, html)` });
  }
  return out;
}

// R7 -- once a module consumes DWFUI it may not grow new hand-built native controls. This freezes
// today's migration debt and makes the component factories the default path for every fan-out.
//
// WAVE-5 WIDENING. R7 used to fingerprint <button>, <input type=search> and hand-built ARIA roles --
// and NOTHING ELSE. Every other native form control was invisible to it. Concretely, in
// dwf-squads.js the guard saw 42 <button> and reported a clean ratchet while 14 <select>,
// 19 <option>, 8 checkboxes and 3 colour inputs stood untouched. A lane could migrate every button
// it could see, go green on all four gates, and change nothing a player notices -- the exact
// "this machine lies with exit 0" failure AGENTS.md documents. Native DF has NO <select> in any of
// the 33 captures: every choice there is a plaque, a row, a cycler, or a chooser screen.
function ruleRawControlBypass(file, src) {
  if (!/\bDWFUI\b/.test(src)) return [];
  const out = [];
  const patterns = [
    [/<button\b[^>]*>/gi, "raw <button> -> use the matching DWFUI button component"],
    [/<input\b[^>]*\btype\s*=\s*["']search["'][^>]*>/gi, "raw search input -> use DWFUI.searchHtml"],
    [/\brole\s*=\s*["'](?:tablist|dialog|switch|radiogroup)["']/gi,
      "hand-built native interaction role -> use tabsHtml/modalHtml/switchHtml/segmentedHtml"],
    // --- Wave-5: the controls R7 could not see ---
    [/<select\b[^>]*>/gi,
      "raw <select> -> native DF has NO dropdown: use cyclerHtml (<value>), segmentedHtml (2-4 options), or rowHtml in a chooser"],
    [/<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*>/gi,
      "raw checkbox -> use DWFUI.checkHtml (the 2-state native tile; native renders a real tile when UNchecked too)"],
    [/<input\b[^>]*\btype\s*=\s*["']radio["'][^>]*>/gi,
      "raw radio -> use DWFUI.rowHtml({state}) or segmentedHtml"],
    [/<input\b[^>]*\btype\s*=\s*["']number["'][^>]*>/gi,
      "raw number input -> use DWFUI.stepperHtml (native order: value [#][+][-], value cell BORDERLESS)"],
    [/<input\b[^>]*\btype\s*=\s*["']color["'][^>]*>/gi,
      "raw colour input -> the OS colour dialog is not DF chrome; use the native picker composition"],
  ];
  for (const [re, hint] of patterns) {
    let m;
    while ((m = re.exec(src))) out.push({ rule: "R7", file, line: lineOf(src, m.index),
      signature: stableSignature(m[0]), hint });
  }
  return out;
}

const RULES = [ruleHexTables, ruleHandRolledMarkup, ruleGlyphBypass, rulePillSwitch,
  ruleRawTextBypass, ruleRawControlBypass];

// R8 -- THE B270 LOOPHOLE. Every rule above reads JS. B270 (the zone-add palette's icon overlapping
// its label) lived entirely in the STYLESHEET: the palette CALLED DWFUI.rowHtml (so the adoption
// census + R2 both passed it green), then wrapped its DWFUI-built rows in a PRIVATE css grid whose
// icon column was a hardcoded `32px` track. `.dwfui-icon` renders at `32px * --dwfui-interface-scale`
// (40px at the 1.25 default), so the scaled icon overflowed the fixed track and crushed the
// icon->label gap to -2px. No JS-only guard could ever see this: the drift is a css grid track, and
// the child it mis-sizes is built correctly. So R8 reads the css. INVARIANT: a grid that lays out
// DWFUI-built children must express its tracks in SCALE-COUPLED units (calc(... * --dwfui-interface-scale),
// var(--dwfui-*), auto, minmax, fr) -- never a bare `NNpx` track that cannot track the scaled icon.
// The fix is either `.dwfui-row--icon` (rowHtml layout:'icon', which owns the icon column) or, for a
// genuine multi-column grid, `calc(<n>px * var(--dwfui-interface-scale))` tracks. Baselined debt may
// only shrink; a NEW private px-track grid over DWFUI children FAILS.
const CSS_FILE = "web/css/dwf.css";
// Classes handed to a DWFUI row/icon builder anywhere in the client (cls:/labelCls: config values).
function dwfuiLaidOutClasses() {
  const set = new Set();
  for (const file of jsFiles()) {
    const src = readFileSync(join(root, file), "utf8");
    if (!/DWFUI\./.test(src)) continue;
    for (const m of src.matchAll(/\bcls\s*:\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')/g)) {
      const raw = m[1] || m[2] || m[3] || "";
      for (const tok of raw.split(/[\s${}?:+()]+/)) {
        const t = tok.trim();
        if (/^[a-z][a-z0-9-]{2,}$/i.test(t)) set.add(t);
      }
    }
  }
  return set;
}
// A single track is "unscaled px" if it is exactly `NNpx` (or `NN.NNpx`). Tracks written as
// calc(...*scale), var(...), auto, fr, minmax(...), repeat(...), % etc. are scale-aware / fluid.
function hasBarePxTrack(gtc) {
  // split top-level tracks (do not split inside minmax()/repeat() parens)
  const tracks = gtc.match(/(?:[^\s()]+(?:\([^()]*\))?)+/g) || [];
  return tracks.some(t => /^\d+(?:\.\d+)?px$/.test(t));
}
function ruleCssIconTrack(cssSrc, dwfuiClasses) {
  const out = [];
  for (const m of cssSrc.matchAll(/([^{}]+)\{([^{}]*?grid-template-columns\s*:\s*([^;]+);[^{}]*?)\}/g)) {
    const gtc = m[3].replace(/\s+/g, " ").trim();
    if (!hasBarePxTrack(gtc)) continue;
    if (/var\(\s*--dwfui-interface-scale\s*\)/.test(gtc)) continue;   // whole grid is scale-coupled
    const sel = m[1].trim().split("\n").pop().trim();
    const line = lineOf(cssSrc, m.index);
    // the offending DWFUI-laid-out class in this selector (there is usually one)
    const cls = [...sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(x => x[1]).find(c => dwfuiClasses.has(c));
    if (!cls) continue;
    out.push({ rule: "R8", file: CSS_FILE, line, signature: cls,
      hint: `.${cls} lays out DWFUI-built children with a bare px grid track (${gtc}) -- the icon column ` +
        `cannot hold the scale-sized .dwfui-icon (B270). Use rowHtml layout:'icon' (.dwfui-row--icon) or ` +
        `calc(<n>px * var(--dwfui-interface-scale)) tracks.` });
  }
  return out;
}
function scanCss() {
  const cssSrc = readFileSync(join(root, CSS_FILE), "utf8");
  return ruleCssIconTrack(cssSrc, dwfuiLaidOutClasses());
}

function scan() {
  const violations = [];
  for (const file of jsFiles()) {
    if (file === COMPONENT_FILE) continue;               // the source of truth is exempt
    const src = readFileSync(join(root, file), "utf8");
    for (const rule of RULES) violations.push(...rule(file, src));
  }
  violations.push(...scanCss());                          // R8: the css icon-track loophole
  return violations;
}

// counts keyed by `${rule}|${file}` --------------------------------------------------------------
function toCounts(violations) {
  const counts = {};
  for (const v of violations) {
    const key = `${v.rule}|${v.file}${v.signature ? "|" + v.signature : ""}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ---- spec / code cross-sync (spec drift is drift too) -----------------------------------------
// Every markup-builder EXPORT of DWFUI must appear in the spec's §3 component table, and every
// `DWFUI.Name` the §3 table names must be a real export. Utility exports (esc etc.) are allowed to
// appear either as their own row or folded into a combined row, so we check by name-substring.
function crossSync() {
  // The architecture spec is an internal design doc (see docs/NAMING.md) not in the public repo;
  // without it only this spec-sync check is skipped -- the code-side drift pins above still ran.
  if (!existsSync(join(root, SPEC_FILE))) {
    console.log("  ok - spec cross-sync skipped (internal spec absent from this distribution)");
    return;
  }
  const specSrc = readFileSync(join(root, SPEC_FILE), "utf8");
  const s3 = sliceSection(specSrc, "## 3.", "## 4.");
  const mod = readFileSync(join(root, COMPONENT_FILE), "utf8");
  // exports: the top-level keys of the `const api = { ... }` object. Strip the inner body of the
  // one nested value ({ stateFor... } under triState) so its sub-keys are not read as exports,
  // then split the remaining top level on commas and take each key (before any `:`).
  const apiRegion = balancedRegion(mod, mod.indexOf("{", mod.indexOf("const api =")));
  const inner = apiRegion.slice(1, -1).replace(/\{[^{}]*\}/g, "");   // drop nested object bodies
  const exports = [...new Set(inner.split(",")
    .map(part => (part.split(":")[0].match(/[A-Za-z_$][\w$]*/) || [])[0])
    .filter(Boolean))];
  const missingFromSpec = exports.filter(name => !new RegExp(`\\b${name}\\b`).test(s3));
  // reverse: a DWFUI.Name named in a TABLE ROW (lines starting with '|') that is not exported.
  // Prose forward-references to unbuilt components (e.g. "build DWFUI.switchHtml when a third
  // consumer appears") are intentionally NOT table rows, so they are excluded.
  const tableRows = s3.split("\n").filter(l => l.trimStart().startsWith("|")).join("\n");
  const mentioned = [...new Set([...tableRows.matchAll(/DWFUI\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))];
  const missingFromCode = mentioned.filter(name => !exports.includes(name.split(".")[0]));
  return { exports, missingFromSpec, missingFromCode };
}
function sliceSection(src, startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) return "";
  const b = src.indexOf(endMark, a + startMark.length);
  return src.slice(a, b < 0 ? src.length : b);
}

// ---- self-test: prove each rule rejects a seeded-bad fixture -----------------------------------
function selftest() {
  const q = '"';   // avoid quote-collisions inside these source-string fixtures
  const fixtures = {
    R1: `const NOBLE_COLORS = { a: ${q}#d9443f${q}, b: ${q}#56ce42${q}, c: ${q}#ffd45c${q} };`,
    R2: `panel.innerHTML = ${q}<div class='dwfui-row'>${q} + label;`,
    R3: `const btn = ${q}<button>&#128274;</button>${q}; // padlock, should be TOKENS.glyphs.forbid`,
    R4: `.x-sw{width:34px;height:18px;border:1px solid #d89b27;background:#2a2a2a;}`,
    R5: `const row = DWFUI.rowHtml({ labelHtml: "<span>plain inherited text</span>" });`,
    R7: `const x = DWFUI.TOKENS; panel.innerHTML = "<button>Invented</button>";`,
  };
  const fns = { R1: ruleHexTables, R2: ruleHandRolledMarkup, R3: ruleGlyphBypass, R4: rulePillSwitch,
    R5: ruleRawTextBypass, R7: ruleRawControlBypass };
  let bad = 0;
  for (const [rule, src] of Object.entries(fixtures)) {
    const hits = fns[rule]("fixture.js", src).filter(v => v.rule === rule);
    if (hits.length >= 1) console.log(`PASS selftest ${rule}: seeded-bad caught (${hits.length}) -- ${hits[0].hint}`);
    else { bad++; console.error(`FAIL selftest ${rule}: seeded-bad NOT caught`); }
  }
  // negative controls: clean fixtures must NOT trip the rule (guards against a rule that always fires)
  const clean = {
    R1: `const n = 3; const label = "#" + id;`,
    R2: `panel.innerHTML = DWFUI.rowHtml({ cls: "farm-crop-row", label });`,
    R3: `const x = "<button>" + DWFUI.TOKENS.glyphs.forbid + "</button>";`,
    R4: `.x-sw{width:40px;height:20px;border:1px solid #333;}`,
    R5: `const row = DWFUI.rowHtml({ label: name }); const rich = DWFUI.rowHtml({ labelHtml: DWFUI.rawHtml("icon plus label", html) });`,
    R7: `const x = DWFUI.plaqueBtnHtml({ label: "Done" });`,
  };
  for (const [rule, src] of Object.entries(clean)) {
    const hits = fns[rule]("clean.js", src).filter(v => v.rule === rule);
    if (hits.length === 0) console.log(`PASS selftest ${rule}-clean: no false positive`);
    else { bad++; console.error(`FAIL selftest ${rule}-clean: false positive (${hits.length})`); }
  }
  // R8 (CSS icon-track) has a different signature (cssSrc, classes), so it self-tests separately.
  {
    const cls = new Set(["seeded-icon-row"]);
    const seededBad = `.seeded-icon-row { display:grid; grid-template-columns: 32px minmax(0,1fr); }`;
    const seededClean1 = `.seeded-icon-row { display:grid; grid-template-columns: calc(32px * var(--dwfui-interface-scale)) minmax(0,1fr); }`;
    const seededClean2 = `.seeded-icon-row { display:grid; grid-template-columns: auto minmax(0,1fr); }`;
    const unrelated = `.not-a-dwfui-grid { display:grid; grid-template-columns: 32px 1fr; }`;  // class not fed to DWFUI
    const badHits = ruleCssIconTrack(seededBad, cls).filter(v => v.rule === "R8");
    if (badHits.length >= 1) console.log(`PASS selftest R8: seeded-bad px icon track caught -- ${badHits[0].hint.slice(0, 60)}...`);
    else { bad++; console.error("FAIL selftest R8: seeded-bad px icon track NOT caught"); }
    if (ruleCssIconTrack(seededClean1, cls).length === 0) console.log("PASS selftest R8-clean(scaled calc): no false positive");
    else { bad++; console.error("FAIL selftest R8-clean(scaled calc): false positive"); }
    if (ruleCssIconTrack(seededClean2, cls).length === 0) console.log("PASS selftest R8-clean(auto): no false positive");
    else { bad++; console.error("FAIL selftest R8-clean(auto): false positive"); }
    if (ruleCssIconTrack(unrelated, cls).length === 0) console.log("PASS selftest R8-clean(non-DWFUI class): no false positive");
    else { bad++; console.error("FAIL selftest R8-clean(non-DWFUI class): false positive"); }
  }
  console.log(bad ? `\n${bad} SELFTEST FAILURES` : "\nSELFTEST ALL PASS");
  process.exit(bad ? 1 : 0);
}

// ---- main --------------------------------------------------------------------------------------
if (process.argv.includes("--selftest")) selftest();

const violations = scan();
const counts = toCounts(violations);

if (process.env.UI_DRIFT_WRITE_BASELINE === "1") {
  const cross = crossSync();
  const baseline = { _comment: "WT21 DWFUI drift baseline -- frozen known debt. May only SHRINK. "
    + "Regenerate with UI_DRIFT_WRITE_BASELINE=1; a decrease is expected, an increase means new drift slipped in.",
    counts: Object.fromEntries(Object.entries(counts).sort()) };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`baseline written: ${Object.keys(counts).length} (rule|file) entries, ${violations.length} total violations`);
  console.log(`cross-sync: exports=${cross.exports.length} missingFromSpec=${JSON.stringify(cross.missingFromSpec)} missingFromCode=${JSON.stringify(cross.missingFromCode)}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`FAIL: no baseline at ${rel(BASELINE_PATH)} -- generate with UI_DRIFT_WRITE_BASELINE=1`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).counts || {};

// detail lookup for printing offenders
const byKey = {};
for (const v of violations) (byKey[`${v.rule}|${v.file}`] ||= []).push(v);

let failed = 0;
const newKeys = [], grown = [], prunable = [];
for (const key of Object.keys(counts)) {
  const cur = counts[key], base = baseline[key] || 0;
  if (base === 0) { newKeys.push(key); failed++; }
  else if (cur > base) { grown.push({ key, cur, base }); failed++; }
}
for (const key of Object.keys(baseline)) {
  const cur = counts[key] || 0, base = baseline[key];
  if (cur < base) prunable.push({ key, cur, base });
}

function printOffenders(key) {
  for (const v of (byKey[key] || [])) console.error(`    ${v.file}:${v.line}  ${v.hint}`);
}

if (newKeys.length) {
  console.error("\nNEW DRIFT (not in baseline) -- these FAIL:");
  for (const key of newKeys) { console.error(`  ${key}  (+${counts[key]})`); printOffenders(key); }
}
if (grown.length) {
  console.error("\nGROWN DRIFT (above baseline) -- these FAIL:");
  for (const g of grown) { console.error(`  ${g.key}  ${g.base} -> ${g.cur}`); printOffenders(g.key); }
}
if (prunable.length) {
  console.log("\nNOTE prunable baseline entries (debt shrank -- re-freeze to tighten the gate):");
  for (const p of prunable) console.log(`  ${p.key}  ${p.base} -> ${p.cur}`);
}

// spec / code cross-sync gate ---------------------------------------------------------------------
const cross = crossSync() || { exports: [], missingFromSpec: [], missingFromCode: [] };
if (cross.missingFromSpec.length) {
  failed += cross.missingFromSpec.length;
  console.error("\nSPEC DRIFT -- exported but NOT in the spec's §3 component table:");
  for (const n of cross.missingFromSpec) console.error(`  DWFUI.${n}  -> add a row to ${SPEC_FILE} §3`);
}
if (cross.missingFromCode.length) {
  failed += cross.missingFromCode.length;
  console.error("\nSPEC DRIFT -- named in the §3 table but NOT exported by the module:");
  for (const n of cross.missingFromCode) console.error(`  DWFUI.${n}  -> remove from spec or add the export`);
}

// per-rule debt inventory (always printed) --------------------------------------------------------
const perRule = {};
for (const key of Object.keys(baseline)) {
  const r = key.split("|")[0];
  perRule[r] = (perRule[r] || 0) + baseline[key];
}
console.log("\nBaseline drift-debt inventory (frozen known debt, per rule):");
for (const r of ["R1", "R2", "R3", "R4", "R5", "R7", "R8"])
  console.log(`  ${r}: ${perRule[r] || 0} violation(s) across ${new Set(Object.keys(baseline)
    .filter(k => k.startsWith(r + "|")).map(k => k.split("|")[1])).size} file(s)`);
console.log(`  cross-sync: ${cross.exports.length} exports, all present in spec §3: ${cross.missingFromSpec.length === 0}`);

console.log(failed ? `\n${failed} FAILED (new/grown drift or spec desync)` : "\nALL PASS (no new drift; baseline holds)");
// R6 (B202, 07-11): UNCLOSED SCRIPT TAGS in index.html. An unclosed <script src=...> makes
// the HTML parser swallow the NEXT tag as script text -- that module silently never runs
// (the win31 nobody-can-select outage). Every script tag must close on its own line.
{
  const htmlB202 = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  const badB202 = htmlB202.split(/\r?\n/).map((l, i) => [l, i + 1])
    .filter(([l]) => /<script\s[^>]*src=/.test(l) && !/<\/script>/.test(l));
  if (badB202.length) {
    failed += badB202.length;
    for (const [l, n] of badB202) console.log(`R6 FAIL unclosed script tag index.html:${n}: ${l.trim().slice(0, 90)}`);
  } else {
    console.log("R6 ok: every script tag in index.html closes on its own line");
  }
}

process.exit(failed ? 1 : 0);
