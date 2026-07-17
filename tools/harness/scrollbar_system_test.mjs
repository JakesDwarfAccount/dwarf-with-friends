// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// B262 -- THE SCROLLBAR SYSTEM GUARD. The guard that should have existed, and did not.
//
// WHY THIS FILE EXISTS. The owner: "the cancelled task announcement still had a normal scrollbar instead
// of DWFUI. That should be impossible." He was right that it should be impossible, and the reason
// it was not is the point of this guard.
//
// FOUR guards claim to make a browser-default scrollbar unshippable -- ui_drift_guard_test,
// dwfui_adoption_test, panel_frame_test, ui_components_test. ALL FOUR WERE GREEN while the pinned
// announcement popup rendered Chromium's grey bar. The hole:
//
//   * The DF scrollbar art was applied by an ALLOW-LIST -- `:is(.dwfui-scroll, .pf-fill-scroll,
//     .farm-crop-list, ... 12 members)::-webkit-scrollbar-*`. An element got DF's bar only if a
//     human REMEMBERED to type its class into that list.
//   * NOTHING compared that list against the elements that actually SCROLL. `overflow: auto`
//     appears in 66 places in dwf.css and in 3 JS-injected <style> blocks; the list held 12.
//     56 regions scrolled with no art. Nobody had to bypass anything to ship one -- the DEFAULT
//     was the grey bar, and joining the system was the opt-in.
//   * ui_components_test even had a cell TITLED "every scroll region is a MEMBER of the shared
//     skin". It asserted that the 12 names it already knew about appeared in the list it read from
//     the same file. It verified the list against itself, derived NOTHING from the code, and could
//     not have failed. (AGENTS.md: "When a green number looks too good, read the assertion.")
//   * The other three guards never look at `overflow` at all: ui_drift_guard scans for hex tables /
//     copied DWFUI markup / glyphs / raw <button>|<select>|<input>; dwfui_adoption counts builder
//     call sites; panel_frame checks fill-chain geometry. A scroll container is invisible to all
//     of them. A panel can be 100% DWFUI-adopted, geometrically perfect, drift-free -- and grey.
//
// THE FIX IS STRUCTURAL: the skin is now applied to `*`. The FIX'S GUARD is this file, and it does
// what the old cell only claimed to do -- it DERIVES the scroll regions from the source and proves
// the skin reaches every one of them:
//
//   1. every scroll region (CSS rule bodies + JS-injected <style> strings + inline styles +
//      element.style.overflow assignments) must be reached by the skin selector.
//   2. the skin must be UNIVERSAL. A membership list is a re-introduction of the bug and fails
//      here even if every region happens to be listed today.
//   3. `scrollbar-color` / `scrollbar-width` appear NOWHERE -- in CSS *or in JS*. In Chromium >= 121
//      the standard properties WIN and silently disable every ::-webkit-scrollbar-* rule for that
//      element. (The old CSS-only version of this check could not see a JS-injected one.)
//   4. no SECOND skin: every ::-webkit-scrollbar-* rule in the client stylesheet belongs to the one
//      universal system.
//
//   node tools/harness/scrollbar_system_test.mjs             # the gate
//   node tools/harness/scrollbar_system_test.mjs --selftest  # prove each rule reddens on seeded-bad
//
// Exit: 0 PASS, 1 FAIL.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// The game client. texture-lab.css / parity-studio are developer tools, not the product the owner plays.
const CLIENT_CSS = "web/css/dwf.css";
const JS_DIR = "web/js";

const SCROLLY = /overflow(?:-x|-y)?\s*:\s*[^;{}]*\b(?:auto|scroll|overlay)\b/;
const KILLER = /\bscrollbar-(?:color|width)\s*:/;

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineAt = (src, i) => src.slice(0, i).split("\n").length;

// ---- the skin ---------------------------------------------------------------------------------
// Read the selector the ::-webkit-scrollbar-thumb rule is actually written with, and decide whether
// it is universal. Universal == at least one selector in the list whose subject is `*` (or a bare
// pseudo-element with no subject) and which is not gated on a class/id/attribute.
export function skinSelectors(css) {
  const out = [];
  const re = /([^{}]*?)::-webkit-scrollbar(?:-[\w-]+)?(?:\([^)]*\))?(?::[\w-]+)*\s*(?=[,{])/g;
  const s = stripComments(css);
  let m;
  while ((m = re.exec(s))) {
    const subject = m[1].replace(/^[\s,]+/, "").trim();
    out.push({ subject, line: lineAt(s, m.index) });
  }
  return out;
}
const isUniversalSubject = sub => sub === "*" || sub === "" || sub === ":root, *" ;

// Does `skin` (a selector SUBJECT, e.g. `*` or `.dwfui-scroll` or `.building-panel .ws-contents`)
// reach an element whose own rule subject is `region`? Only the LAST compound matters: that is the
// element that scrolls and therefore the element the pseudo-element attaches to.
export function skinReaches(skin, region) {
  if (isUniversalSubject(skin)) return true;
  const lastCompound = sel => sel.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || "";
  const parts = sel => ({
    cls: new Set(sel.match(/\.[-\w]+/g) || []),
    ids: new Set(sel.match(/#[-\w]+/g) || []),
  });
  // an `:is(a, b, c)` skin reaches the region if ANY of its arms does
  const arms = /^:is\(([\s\S]*)\)$/.exec(skin.trim());
  if (arms) return splitTop(arms[1]).some(a => skinReaches(a, region));
  const S = parts(lastCompound(skin));
  const R = parts(lastCompound(region));
  if (!S.cls.size && !S.ids.size) return false;
  return [...S.cls].every(c => R.cls.has(c)) && [...S.ids].every(i => R.ids.has(i));
}
// split a comma list at depth 0 (commas inside :is()/:not() belong to the arm)
function splitTop(list) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

// ---- scroll regions, DERIVED (never declared) ---------------------------------------------------
export function cssScrollRegions(css, label) {
  const s = stripComments(css);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(s))) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    if (!selector || selector.startsWith("@") || !SCROLLY.test(m[2])) continue;
    for (const one of splitTop(selector)) {
      if (one.startsWith("@") || one.includes("::")) continue;   // at-rules / pseudo-elements
      out.push({ where: `${label}:${lineAt(s, m.index)}`, subject: one });
    }
  }
  return out;
}

// A JS module can inject a <style> block, set style="overflow:auto" in markup, or assign
// element.style.overflow -- three shapes the CSS scan cannot see, and the shape that hid
// #dfDigestPanel and #dfHotkeysPanel .hk-body from every guard in the repo.
export function jsScrollRegions(dir, files) {
  const out = [];
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*(?:\/\/|\*).*$/, "");      // drop comment-only lines
      if (!code) return;
      const where = `${JS_DIR}/${file}:${i + 1}`;
      if (/\.style\.overflow\w*\s*=\s*["'`](?:auto|scroll|overlay)/.test(code))
        out.push({ where, subject: "[element.style.overflow]", raw: code.trim() });
      if (!SCROLLY.test(code)) return;
      // an injected CSS rule: `SEL{...overflow:auto...}` inside a JS string
      const rule = /([#.:*\[][^{};"'`]*?)\s*\{[^{}]*overflow(?:-x|-y)?\s*:\s*[^;{}]*\b(?:auto|scroll|overlay)\b/.exec(code);
      if (rule) { out.push({ where, subject: rule[1].trim(), raw: code.trim() }); return; }
      // an inline style attribute in hand-written markup
      if (/style\s*=\s*["'`][^"'`]*overflow/.test(code))
        out.push({ where, subject: "[inline style attribute]", raw: code.trim() });
    });
  }
  return out;
}

export function jsKillers(dir, files) {
  const out = [];
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*(?:\/\/|\*).*$/, "");
      // `scrollbarWidth`/`scrollbarColor` are the JS-DOM spellings of the same two killers.
      if (KILLER.test(code) || /\.style\.scrollbar(?:Width|Color)\s*=/.test(code))
        out.push({ where: `${JS_DIR}/${file}:${i + 1}`, raw: code.trim() });
    });
  }
  return out;
}

// ---- the audit ----------------------------------------------------------------------------------
export function auditScrollSystem(repoRoot = root) {
  const css = readFileSync(join(repoRoot, CLIENT_CSS), "utf8");
  const jsDir = join(repoRoot, JS_DIR);
  const files = readdirSync(jsDir).filter(f => f.endsWith(".js")).sort();
  const findings = [];

  // (2) the skin must be universal, and (4) there must be exactly one of it.
  const skins = skinSelectors(css);
  if (!skins.length)
    findings.push({ rule: "SB2", where: CLIENT_CSS, msg: "there is NO ::-webkit-scrollbar skin at all -- every scroll region renders the browser's grey bar" });
  const nonUniversal = skins.filter(s => !isUniversalSubject(s.subject) && !/^\[data-dwfui-scrollbar/.test(s.subject));
  for (const s of nonUniversal)
    findings.push({ rule: "SB2", where: `${CLIENT_CSS}:${s.line}`,
      msg: `the scrollbar skin is gated on \`${s.subject}\` -- a MEMBERSHIP LIST is the B262 bug. `
         + "The skin must be applied to `*`: an element that scrolls gets DF's art because it scrolls, "
         + "not because someone remembered to add its class to a list." });

  // (3) the two properties that silently kill the art, in BOTH languages.
  const cssNoComments = stripComments(css);
  cssNoComments.split(/\r?\n/).forEach((line, i) => {
    if (KILLER.test(line))
      findings.push({ rule: "SB3", where: `${CLIENT_CSS}:${i + 1}`,
        msg: `\`${line.trim()}\` -- in Chromium >= 121 scrollbar-color/scrollbar-width WIN and every ::-webkit-scrollbar-* rule for that element is IGNORED. The art becomes dead code.` });
  });
  for (const k of jsKillers(jsDir, files))
    findings.push({ rule: "SB3", where: k.where,
      msg: `\`${k.raw.slice(0, 90)}\` -- a JS-injected scrollbar-color/width kills the native art for that region just as dead as a CSS one, and the CSS-only scan cannot see it.` });

  // (1) THE CORE RULE: every region that scrolls must be reached by the skin.
  const regions = [...cssScrollRegions(css, CLIENT_CSS), ...jsScrollRegions(jsDir, files)];
  const subjects = skins.map(s => s.subject);
  for (const r of regions) {
    if (r.subject.startsWith("[")) continue;   // inline style / style.overflow: universal skin covers it; a list cannot be proven to
    if (subjects.some(s => skinReaches(s, r.subject))) continue;
    findings.push({ rule: "SB1", where: r.where,
      msg: `\`${r.subject}\` SCROLLS but the scrollbar skin does not reach it -> Chromium's grey bar. This is B262.` });
  }
  // an inline/computed scroll region is only safe under a universal skin -- there is no class to list.
  const universal = skins.some(s => isUniversalSubject(s.subject));
  if (!universal)
    for (const r of regions.filter(r => r.subject.startsWith("[")))
      findings.push({ rule: "SB1", where: r.where,
        msg: `${r.subject} makes an element scroll with NO class the skin could be keyed on. Under a membership skin this region can never be covered.` });

  return { findings, regionCount: regions.length, skinCount: skins.length, universal };
}

// ---- selftest: prove every rule reddens on the real, seeded defect ------------------------------
function selftest() {
  let bad = 0;
  const t = (name, cond, detail = "") => {
    if (cond) console.log(`PASS selftest ${name}`);
    else { bad++; console.error(`FAIL selftest ${name} ${detail}`); }
  };

  // SB1 -- THE B262 DEFECT ITSELF, in the shape the owner asked for: a plain `overflow: auto` scroll
  // container in an announcement panel, under the OLD membership skin. It must go red.
  const oldSkin = ":is(.dwfui-scroll, .pf-fill-scroll, .an-body)::-webkit-scrollbar-thumb { }";
  const seededAnnouncement = "#alertPopup {\n  max-height: calc(100vh - 66px);\n  overflow-y: auto;\n}";
  const seededCss = oldSkin + "\n" + seededAnnouncement;
  const skins = skinSelectors(seededCss).map(s => s.subject);
  const regions = cssScrollRegions(seededCss, "seed.css");
  t("SB1: a plain overflow:auto announcement panel under a MEMBERSHIP skin is caught",
    regions.length === 1 && !skins.some(s => skinReaches(s, regions[0].subject)),
    JSON.stringify({ skins, regions }));

  // ...and the same seed under the UNIVERSAL skin is correctly NOT a finding (no false positive:
  // under `*` the announcement panel renders DF's art, which is the whole point of the fix).
  const newSkin = "*::-webkit-scrollbar-thumb { }";
  const okSkins = skinSelectors(newSkin + "\n" + seededAnnouncement).map(s => s.subject);
  t("SB1-clean: the same panel under the UNIVERSAL skin is NOT flagged",
    okSkins.some(s => skinReaches(s, cssScrollRegions(seededAnnouncement, "s")[0].subject)));

  // SB1 must also see a scroll region that only exists inside a JS-injected <style> string --
  // the shape that hid #dfDigestPanel and #dfHotkeysPanel .hk-body from every guard in the repo.
  const injected = `      "#dfDigestPanel{max-height:min(70vh,520px);overflow:auto;pointer-events:auto}",`;
  const found = parseOneJsLine(injected);
  t("SB1: a scroll region injected from a JS <style> string is derived",
    found && found.subject === "#dfDigestPanel", JSON.stringify(found));

  // SB2 -- the membership list is itself the bug, even when fully populated today.
  t("SB2: a membership-list skin is rejected on sight",
    !isUniversalSubject(":is(.dwfui-scroll, .pf-fill-scroll)"));
  t("SB2-clean: the universal skin is accepted", isUniversalSubject("*"));

  // SB3 -- the killer properties, in the JS spelling the CSS-only scan could never see.
  t("SB3: a JS-injected scrollbar-color is caught",
    KILLER.test(`st.textContent = ".an-body{scrollbar-color:#d89b27 #151416;overflow:auto}";`));
  t("SB3: the DOM-property spelling is caught",
    /\.style\.scrollbar(?:Width|Color)\s*=/.test(`el.style.scrollbarWidth = "thin";`));
  t("SB3-clean: an ordinary overflow declaration is not a killer",
    !KILLER.test(".dwfui-scroll { overflow-y: auto; }"));

  console.log(bad ? `\n${bad} SELFTEST FAILURES` : "\nSELFTEST ALL PASS");
  process.exit(bad ? 1 : 0);
}
// tiny shim so the selftest can exercise the JS-line parser without touching disk
function parseOneJsLine(code) {
  const rule = /([#.:*\[][^{};"'`]*?)\s*\{[^{}]*overflow(?:-x|-y)?\s*:\s*[^;{}]*\b(?:auto|scroll|overlay)\b/.exec(code);
  return rule ? { subject: rule[1].trim() } : null;
}

// ---- main ---------------------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--selftest")) selftest();
  const { findings, regionCount, skinCount, universal } = auditScrollSystem();
  const byRule = r => findings.filter(f => f.rule === r);
  for (const rule of ["SB2", "SB3", "SB1"]) {
    const hits = byRule(rule);
    if (!hits.length) continue;
    console.error(`\n${rule} -- ${hits.length} FAILURE(S):`);
    for (const f of hits) console.error(`  ${f.where}\n      ${f.msg}`);
  }
  console.log(`\nscrollbar system: ${regionCount} scroll region(s) derived from the client, `
    + `${skinCount} skin rule(s), universal=${universal}`);
  if (findings.length) {
    console.error(`\nFAIL scrollbar_system: ${findings.length} region(s)/rule(s) can render a browser-default scrollbar.`);
    process.exit(1);
  }
  console.log("PASS scrollbar_system: every scroll region in the client is reached by DF's own scrollbar art.");
}
