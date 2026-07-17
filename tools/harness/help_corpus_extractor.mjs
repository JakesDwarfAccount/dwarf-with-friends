// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// B207 HELP-TOOLTIPS: the build-time help-corpus extractor.
//
// The `?` help panel is a FULL reference of every tooltip/explanation the client UI carries.
// To make that reference impossible to drift from reality, its data is not hand-maintained: this
// extractor HARVESTS the tooltip corpus straight from the source files at build time and bakes it
// into web/js/dwf-help-corpus.js (a generated artifact). The drift guard
// (help_reference_test.mjs) re-runs this extractor and fails if the committed corpus differs from
// a fresh harvest -- so a tooltip that exists in source but not in the baked reference (or vice
// versa) turns the build red until someone regenerates.
//
// Harvested sources (authoritative, on disk -- never a hand copy):
//   1. TOOLBAR_TOOLTIPS   (dwf-controls-placement.js)  -> toolbar/designation tool tips
//   2. TOOL_MODE_LABELS   (dwf-controls-placement.js)  -> active-tool status labels
//   3. HELP_CONTEXTS      (dwf-tooltip.js)             -> DF's first-time context guides
//   4. keymap SECTIONS    (dwf-keymap.js)              -> the keyboard/mouse shortcut list
//   5. static title="..." / title:"..." literals across index.html + the panel JS files
//      -> every hover-tooltip the UI carries (templated `${...}` titles are skipped -- their text
//         is runtime data, not a fixed string a reference could enumerate).
//
// PURE + deterministic: extractCorpus(root) reads the tree and returns a stable, sorted object;
// no timestamps, no ordering by disk. Run as a CLI it (re)writes the generated corpus file.
//
//   node tools/harness/help_corpus_extractor.mjs           # regenerate web/js/dwf-help-corpus.js
//   node tools/harness/help_corpus_extractor.mjs --check    # exit 1 if the committed file is stale

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CORPUS_VERSION = "help-corpus v1 (B207)";
const GENERATED_REL = "web/js/dwf-help-corpus.js";

// ---- source -> surface map -------------------------------------------------------------------
// Every file whose static title literals we harvest, and the surface bucket they land in. Files
// NOT listed are skipped on purpose: dwf-ui-components.js (its title="" live inside the
// component FACTORIES -- config examples, not real tooltips), dwf-tooltip.js/keymap.js (the
// tooltip engine + hotkey list themselves, harvested structurally above), and anything with no
// player-facing chrome. Several files may share one surface id (entries are merged + deduped).
const FILE_SURFACES = [
  ["web/index.html",                           "topbar",   "Top bar & toolbar"],
  ["web/js/dwf-controls-placement.js",   "tools",    "Toolbar & map tools"],
  ["web/js/dwf-building-zone-stockpile-panels.js", "bzs", "Buildings, zones & stockpiles"],
  ["web/js/dwf-build-info-panels.js",    "build",    "Build menu & info panels"],
  ["web/js/dwf-squads.js",               "squads",   "Squads & military"],
  ["web/js/dwf-labor-work-orders.js",    "labor",    "Labor & work orders"],
  ["web/js/dwf-kitchen.js",              "kitchen",  "Kitchen"],
  ["web/js/dwf-tradedepot-panel.js",     "trade",    "Trade depot"],
  // B242: B226 moved the barter + bring-goods screens into their own file and nobody added it here,
  // so every tooltip on both trade screens was missing from the `?` reference.
  ["web/js/dwf-tradescreen.js",          "trade",    "Trade depot"],
  ["web/js/dwf-hospital-panel.js",       "hospital", "Hospital"],
  ["web/js/dwf-unit-hud-notifications.js","units",   "Units & notifications"],
  ["web/js/dwf-fort-admin.js",           "admin",    "Nobles & justice"],
  ["web/js/dwf-combatlog-panel.js",      "combat",   "Combat log"],
  ["web/js/dwf-settings.js",             "settings", "Settings"],
  ["web/js/dwf-escmenu.js",              "menu",     "Menu"],
  ["web/js/dwf-unitcycle.js",            "unitsel",  "Unit selection"],
  ["web/js/dwf-worldmap.js",             "world",    "World map"],
  ["web/js/dwf-world3d.js",              "world3d",  "3D world viewer"],
  ["web/js/dwf-audio.js",                "audio",    "Audio"],
  ["web/js/dwf-lobby.js",                "lobby",    "Lobby"],
  ["web/js/dwf-vote.js",                 "vote",     "Fortress vote"],
  ["web/js/dwf-analytics-panel.js",      "analytics","Fortress activity"],
  ["web/js/dwf-hotkeys.js",              "locations","Saved map locations"],
  ["web/js/dwf-obligations.js",          "obligations","Obligations board"],
  ["web/js/dwf-chat.js",                 "chat",     "Chat"],
];

// ---- small helpers ---------------------------------------------------------------------------

// Decode the handful of HTML entities our source titles actually use (index.html writes newlines
// as &#10; and "&amp;" for ampersands). Anything else is left verbatim.
function decodeEntities(s) {
  return String(s)
    .replace(/&#10;|&#x0*a;/gi, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// A raw tooltip string may carry a trailing "Hotkey: X" line (index.html Stocks, the toolbar
// tips). Split it so the reference can render the key as its own badge, exactly like the tooltip
// component does. Returns { text, hotkey }.
function splitHotkey(raw) {
  const lines = String(raw).split("\n");
  let hotkey = "";
  const kept = [];
  for (const line of lines) {
    const m = /^\s*Hotkey:\s*(.+?)\s*$/i.exec(line);
    if (m) hotkey = m[1];
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), hotkey };
}

// Pull every DOUBLE-QUOTED literal that a `title=`/`title:` attribute assigns, honoring escaped
// quotes. Templated titles (containing ${...}) are skipped -- their text is runtime data.
function staticTitleLiterals(src) {
  const out = [];
  const re = /\btitle\s*[=:]\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1];
    if (raw.includes("${")) continue;           // interpolated -> not a fixed reference string
    out.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  // B242: a title whose value is a NAMED CONSTANT is still a fixed string a player reads, but this
  // extractor only saw double-quoted literals -- so when the zone panel moved its tips into
  // `const ZONE_TIP_* = "..."` the help reference silently DROPPED those tooltips (a rebake
  // deleted them, and only a rebake would have revealed it). Resolve same-file string constants.
  const consts = new Map();
  const cre = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  while ((m = cre.exec(src))) consts.set(m[1], m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  const rre = /\btitle\s*[=:]\s*([A-Z][A-Z0-9_]*)\b/g;
  while ((m = rre.exec(src))) if (consts.has(m[1])) out.push(consts.get(m[1]));
  return out;
}

// ---- B247: template-literal titles -----------------------------------------------------------
// A control whose title is built with a template literal -- title: `Assign squads to this barracks
// (${n} assigned)` -- carried NO entry in the ? reference at all, because the harvester only ever
// looked at double-quoted literals. Those controls are not obscure (unit "Center the view on X",
// squad equip, burrow symbols, sort headers), and a reference that silently omits them is worse
// than useless: it looks complete.
//
// THE RULE (chosen deliberately -- a bare skeleton with the `${...}` deleted produces garbage like
// "( assigned)"):
//   1. An interpolation whose value is STATIC TEXT is INLINED. That covers string literals, nested
//      templates, and -- the big one -- ternaries between two strings: `${on ? "on" : "off"}`
//      becomes "on/off" and `${seed.forbidden ? "Claim" : "Forbid"} seed stack` becomes
//      "Claim/Forbid seed stack". The reference gains BOTH states of a toggle, which is strictly
//      more informative than the runtime tooltip a player sees in any single moment.
//   2. An interpolation that is genuinely runtime data becomes a NAMED SLOT in square brackets,
//      named after the expression: `${name}` -> [name], `${relation.name}` -> [name],
//      `${squadCount}` -> [N]. Number-ish names (n/i/count/total/index/secs/...) and arithmetic
//      collapse to [N], so the barracks tip reads "Assign squads to this barracks ([N] assigned)".
//      A slot is honest: it tells the player this tooltip names a thing here, without inventing
//      a value. Anything we cannot parse becomes the anonymous slot [...].
//   3. If, after resolution, the tip has no static words of its own (`${state.action} ${name}` ->
//      "[action] [name]"), it is DROPPED. There is no sensible fixed reference line for a control
//      whose entire tooltip is runtime data, and emitting "[action] [name]" would be garbage in a
//      reference whose whole job is to be readable. extractCorpus counts these; see --report.
const NUMERIC_SLOT = /^(n|i|j|k|idx|index|count|total|num|len|length|size|secs?|ms|qty|amount|pct|percent|z|x|y)$/i;
const NUMERIC_SUFFIX = /(count|total|index|num|secs|size|length|qty|amount)$/i;

// Split an expression on TOP-LEVEL `?` / `:` (a ternary), ignoring anything nested in strings,
// templates, brackets or parens. Returns null when the expression is not a ternary.
function splitTernary(expr) {
  let depth = 0, quote = "", qIdx = -1, colon = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && qIdx < 0 && expr[i + 1] !== ".") qIdx = i;
    else if (depth === 0 && c === ":" && qIdx >= 0 && colon < 0) colon = i;
  }
  if (qIdx < 0 || colon < 0) return null;
  return [expr.slice(0, qIdx), expr.slice(qIdx + 1, colon), expr.slice(colon + 1)];
}

// Resolve one `${...}` expression to reference text (rule 1 + rule 2 above).
function resolveExpr(expr) {
  const e = String(expr).trim();
  if (!e) return "[...]";

  // A plain string literal -> its text.
  const str = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(e);
  if (str) return (str[1] ?? str[2]).replace(/\\(.)/g, "$1");
  // A nested template -> recurse through the same resolver.
  if (e.startsWith("`") && e.endsWith("`") && e.length >= 2) return resolveTemplate(e.slice(1, -1));

  // Ternary between two resolvable arms -> show BOTH ("Claim/Forbid").
  const t = splitTernary(e);
  if (t) {
    const a = resolveExpr(t[1]).trim(), b = resolveExpr(t[2]).trim();
    if (!a || a === "[...]") return b || "[...]";
    if (!b || b === "[...]") return a;
    return a === b ? a : a + "/" + b;
  }

  // Cosmetic wrappers (`String(label).toLowerCase()`) still name their slot: [label], not [...].
  const wrapped = /^(?:String|Number)\(\s*([A-Za-z_$][\w$.]*)\s*\)(?:\.\w+\(\))*$/.exec(e);
  if (wrapped) return resolveExpr(wrapped[1]);
  const chained = /^([A-Za-z_$][\w$.]*)(?:\.(?:toLowerCase|toUpperCase|trim|toString)\(\))+$/.exec(e);
  if (chained) return resolveExpr(chained[1]);

  // `a || b` fallback chains: take the first arm (the intended value; the rest is a default).
  const or = e.split("||");
  if (or.length > 1 && !/[`"']/.test(or[0])) return resolveExpr(or[0]);

  // Arithmetic on identifiers (`i + 1`, `total * 2`) -> a number slot.
  if (/[+\-*/%]/.test(e) && !/[`"']/.test(e)) return "[N]";

  // A plain identifier / property path / no-arg call -> a slot named after its last segment.
  const path = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/.exec(e);
  if (path) {
    const last = e.replace(/\(\)$/, "").split(".").pop();
    if (NUMERIC_SLOT.test(last) || NUMERIC_SUFFIX.test(last)) return "[N]";
    // camelCase / SHOUT_CASE -> readable words: activeCategoryLabel -> "active category label".
    const words = last.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
    return "[" + words + "]";
  }
  return "[...]";                                     // calls with args, ??, complex expressions
}

// Resolve a template literal's BODY (the text between the backticks) to reference text.
export function resolveTemplate(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {                            // \n, \t, \` ... keep JS escape semantics
      const n = body[i + 1];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === undefined ? "\\" : n;
      i++;
      continue;
    }
    if (body[i] === "$" && body[i + 1] === "{") {
      let depth = 0, quote = "", j = i + 1;
      for (; j < body.length; j++) {
        const c = body[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = "";
          continue;
        }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) break; }
      }
      out += resolveExpr(body.slice(i + 2, j));
      i = j;
      continue;
    }
    out += body[i];
  }
  // Tidy the seams an inlined/removed interpolation can leave behind.
  return out
    .replace(/\(\s*\)/g, "")                           // an emptied parenthetical
    .replace(/[ \t]{2,}/g, " ")
    .split("\n").map(l => l.replace(/[ \t]+$/g, "")).join("\n")
    .trim();
}

// A resolved tip is only useful if it says something FIXED. Strip the slots and require real words.
export function hasStaticWords(text) {
  const bare = String(text).replace(/\[[^\]]*\]/g, " ").replace(/[^A-Za-z]+/g, "");
  return bare.length >= 3;
}

// Pull every TEMPLATE-LITERAL title (`title: \`...\`` / `title=\`...\``), resolved per the rule
// above. Returns { text, dropped } -- `dropped` is the count of tips with no static words, which
// the CLI reports so a genuinely un-summarizable control is visible instead of silently missing.
function templateTitleLiterals(src) {
  const out = [];
  let dropped = 0;
  const re = /\btitle\s*[=:]\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    // Comments in THIS repo quote code in markdown backticks -- "...scanning source for `title:`
    // followed by a quoted literal..." -- which is a literal `title:` + backtick and matches the
    // pattern exactly. Harvesting those produced three paragraphs of C-comment prose as "tooltips".
    // A tooltip is never written inside a comment, so: skip any match preceded on its own line by
    // a line-comment / block-comment opener, or sitting in a `* ...` block-comment body.
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (before.includes("//") || before.includes("/*") || /^\s*\*/.test(before)) continue;
    // Walk to the matching backtick, honoring nested ${ ... `...` ... } templates.
    const start = re.lastIndex;
    let depth = 0, quote = "", end = -1;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") { i++; continue; }
      if (quote) { if (c === quote) quote = ""; continue; }
      if (depth > 0 && (c === '"' || c === "'")) { quote = c; continue; }
      if (c === "$" && src[i + 1] === "{") { depth++; i++; continue; }
      if (c === "}" && depth > 0) { depth--; continue; }
      if (c === "`" && depth === 0) { end = i; break; }
      if (c === "`" && depth > 0) {                   // a nested template inside ${...}
        for (let j = i + 1; j < src.length; j++) {
          if (src[j] === "\\") { j++; continue; }
          if (src[j] === "`") { i = j; break; }
        }
      }
    }
    if (end < 0) continue;                            // unterminated: leave it alone
    const resolved = resolveTemplate(src.slice(start, end));
    re.lastIndex = end + 1;
    if (!resolved) { dropped++; continue; }
    out.push(resolved);
  }
  return { titles: out, dropped };
}

// index.html gives us more than the string: the element's id / data-action / data-panel names the
// CONTROL the tooltip belongs to. Capture {control, title} pairs from every titled tag.
function indexTitlePairs(html) {
  const out = [];
  const re = /<([a-zA-Z0-9]+)\b([^>]*?)\btitle="([^"]*)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = (m[2] || "") + " " + (m[4] || "");
    if (m[3].includes("${")) continue;
    const control =
      (/\bdata-action="([^"]+)"/.exec(attrs) || [])[1] ||
      (/\bdata-panel="([^"]+)"/.exec(attrs) || [])[1] ||
      (/\bid="([^"]+)"/.exec(attrs) || [])[1] || "";
    out.push({ control, title: decodeEntities(m[3]) });
  }
  return out;
}

// Balanced [..] or {..} region starting at the opening bracket index.
function balanced(src, openIdx) {
  const open = src[openIdx], close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
}
function regionAfter(src, marker, bracket) {
  const at = src.indexOf(marker);
  if (at < 0) return "";
  const open = src.indexOf(bracket, at);
  if (open < 0) return "";
  return balanced(src, open);
}

// ---- structured harvesters -------------------------------------------------------------------

// TOOLBAR_TOOLTIPS: `key: { text: "...", hotkey: "x", verified: bool }`
function harvestToolbarTooltips(src) {
  const region = regionAfter(src, "TOOLBAR_TOOLTIPS = {", "{");
  const out = [];
  const re = /(\w+):\s*\{\s*text:\s*"((?:[^"\\]|\\.)*)"\s*,\s*hotkey:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(region))) {
    out.push({ control: m[1], text: m[2].replace(/\\"/g, '"'), hotkey: m[3] || "" });
  }
  return out;
}

// TOOL_MODE_LABELS: `key: "label"`
function harvestToolModeLabels(src) {
  const region = regionAfter(src, "TOOL_MODE_LABELS = {", "{");
  const out = [];
  const re = /(\w+):\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(region))) {
    out.push({ control: m[1], text: m[2].replace(/\\"/g, '"'), group: "Active-tool status" });
  }
  return out;
}

// HELP_CONTEXTS: `id: { title: "...", body: [ "...", "..." ] }` -- DF's first-time guides.
function harvestGuides(src) {
  const region = regionAfter(src, "HELP_CONTEXTS = {", "{");
  const out = [];
  // Iterate top-level `id: {` entries within the region.
  const re = /(\w+):\s*\{/g;
  let m;
  while ((m = re.exec(region))) {
    const objStart = region.indexOf("{", m.index + m[0].length - 1);
    const obj = balanced(region, objStart);
    const title = (/title:\s*"((?:[^"\\]|\\.)*)"/.exec(obj) || [])[1];
    if (!title) continue;
    const bodyRegion = regionAfter(obj, "body:", "[");
    const body = [];
    const br = /"((?:[^"\\]|\\.)*)"/g;
    let bm;
    while ((bm = br.exec(bodyRegion))) {
      body.push(bm[1].replace(/\\"/g, '"').replace(/\{\{(.+?)\}\}/g, "$1"));
    }
    out.push({ control: m[1], title: decodeEntities(title), body });
    re.lastIndex = objStart + obj.length;       // don't re-scan into the object we just consumed
  }
  return out;
}

// keymap SECTIONS: array of { title: "...", rows: [ ["key","label"], ... ] }
function harvestHotkeys(src) {
  const region = regionAfter(src, "const SECTIONS = [", "[");
  const out = [];
  const secRe = /\{\s*title:\s*"([^"]*)"\s*,\s*rows:\s*\[/g;
  let m;
  while ((m = secRe.exec(region))) {
    const rowsStart = region.indexOf("[", m.index + m[0].length - 1);
    const rows = balanced(region, rowsStart);
    const group = m[1];
    const rr = /\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
    let rm;
    while ((rm = rr.exec(rows))) {
      out.push({ control: rm[1], text: rm[2].replace(/\\"/g, '"'), group });
    }
    secRe.lastIndex = rowsStart + rows.length;
  }
  return out;
}

// ---- the extractor ---------------------------------------------------------------------------

function dedupeSort(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = `${e.control || ""} ${e.group || ""} ${e.text || e.title || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort((a, b) =>
    String(a.group || "").localeCompare(String(b.group || "")) ||
    String(a.control || "").localeCompare(String(b.control || "")) ||
    String(a.text || a.title || "").localeCompare(String(b.text || b.title || "")));
  return out;
}

// `stats` (optional) collects harvest telemetry the CLI prints -- notably B247's count of
// template titles that resolve to nothing a reference could state. extractCorpus's RETURN VALUE is
// deliberately unchanged by it: the baked corpus and the round-trip drift guard must stay a pure
// function of the source tree.
export function extractCorpus(root, stats) {
  const read = rel => {
    const p = join(root, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const controls = read("web/js/dwf-controls-placement.js");
  const tooltipJs = read("web/js/dwf-tooltip.js");
  const keymapJs = read("web/js/dwf-keymap.js");

  const surfaces = new Map();   // id -> { id, label, kind, entries: [] }
  const bucket = (id, label, kind) => {
    if (!surfaces.has(id)) surfaces.set(id, { id, label, kind, entries: [] });
    return surfaces.get(id);
  };

  // 1. Hotkeys (structured) -- rendered first, the "hotkeys as one section" the report calls out.
  bucket("hotkeys", "Keyboard & mouse shortcuts", "hotkeys").entries.push(...harvestHotkeys(keymapJs));

  // 2. Toolbar tools + active-tool status labels (structured).
  const tools = bucket("tools", "Toolbar & map tools", "tools");
  tools.entries.push(...harvestToolbarTooltips(controls));
  tools.entries.push(...harvestToolModeLabels(controls));

  // 3. DF's first-time context guides (structured, multi-paragraph).
  bucket("guides", "Guides", "guides").entries.push(...harvestGuides(tooltipJs));

  // 4. Every static hover-tooltip literal, bucketed by source file.
  const droppedTips = [];      // B247: template titles with no fixed text to state
  for (const [rel, id, label] of FILE_SURFACES) {
    const src = read(rel);
    if (!src) continue;
    const surf = bucket(id, label, id === "tools" ? "tools" : "tooltips");
    if (rel === "web/index.html") {
      for (const { control, title } of indexTitlePairs(src)) {
        const { text, hotkey } = splitHotkey(title);
        if (text) surf.entries.push({ control, text, hotkey });
      }
    } else {
      for (const raw of staticTitleLiterals(src)) {
        const { text, hotkey } = splitHotkey(decodeEntities(raw));
        if (text) surf.entries.push({ control: "", text, hotkey });
      }
    }
    // B247: TEMPLATE-literal titles, in every file (index.html's inline JS builds them too).
    const { titles, dropped } = templateTitleLiterals(src);
    for (let i = 0; i < dropped; i++) droppedTips.push({ file: rel, text: "(resolved to nothing)" });
    for (const raw of titles) {
      const { text, hotkey } = splitHotkey(decodeEntities(raw));
      if (!text) continue;
      if (!hasStaticWords(text)) { droppedTips.push({ file: rel, text }); continue; }
      surf.entries.push({ control: "", text, hotkey });
    }
  }
  if (stats) stats.droppedTips = droppedTips;

  // Deterministic output: dedupe + sort each surface, then order surfaces (structured buckets
  // first in a fixed order, then the tooltip surfaces alphabetically by label).
  const ORDER = ["hotkeys", "tools", "guides"];
  const list = [...surfaces.values()]
    .map(s => ({ ...s, entries: dedupeSort(s.entries) }))
    .filter(s => s.entries.length > 0);
  list.sort((a, b) => {
    const ia = ORDER.indexOf(a.id), ib = ORDER.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.label.localeCompare(b.label);
  });
  return { version: CORPUS_VERSION, surfaces: list };
}

// ---- CLI: (re)generate the baked corpus file --------------------------------------------------

export function renderGeneratedFile(corpus) {
  const json = JSON.stringify(corpus, null, 2);
  return [
    "// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin",
    "// Copyright (C) 2026 Gabriel Rios",
    "// Copyright (C) 2026 Jake Taplin",
    "//",
    "// SPDX-License-Identifier: AGPL-3.0-only",
    "//",
    "// GENERATED FILE -- do not edit by hand. Regenerate with:",
    "//   node tools/harness/help_corpus_extractor.mjs",
    "// It is the baked tooltip corpus for the ? help reference (B207). The drift guard",
    "// (tools/harness/help_reference_test.mjs) fails if this file falls out of sync with source.",
    "(function (root) {",
    "  \"use strict\";",
    "  var DFHelpCorpus = " + json.split("\n").map((l, i) => (i === 0 ? l : "  " + l)).join("\n") + ";",
    "  root.DFHelpCorpus = DFHelpCorpus;",
    "  if (typeof module !== \"undefined\" && module.exports) module.exports = DFHelpCorpus;",
    "})(typeof window !== \"undefined\" ? window : (typeof globalThis !== \"undefined\" ? globalThis : this));",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  const stats = {};
  const corpus = extractCorpus(root, stats);
  // B247: a control whose tooltip is 100% runtime data has no fixed line a reference could print.
  // Say so out loud rather than baking "[action] [name]" into the player's help.
  for (const d of stats.droppedTips || [])
    console.error("SKIPPED (no fixed text): " + d.file + "  ->  " + JSON.stringify(d.text));
  const generated = renderGeneratedFile(corpus);
  const target = join(root, GENERATED_REL);
  const check = process.argv.includes("--check");
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (check) {
    if (current !== generated) {
      console.error("STALE: " + GENERATED_REL + " differs from a fresh extract. Regenerate it.");
      process.exit(1);
    }
    console.log("OK: baked corpus matches a fresh extract (" + corpus.surfaces.length + " surfaces).");
  } else {
    writeFileSync(target, generated);
    const n = corpus.surfaces.reduce((s, x) => s + x.entries.length, 0);
    console.log("Wrote " + GENERATED_REL + ": " + corpus.surfaces.length + " surfaces, " + n + " entries.");
  }
}
