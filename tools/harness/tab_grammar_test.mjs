// tab_grammar_test.mjs -- THE F3 TAB-GRAMMAR GATE.
//
// WHY THIS FILE EXISTS. `DWFUI.tabsHtml` was an API TRAP. `cls`/`tabCls` REPLACED the `dwfui-tabs`/
// `dwfui-tab` base classes instead of adding to them, and a missing `level` SILENTLY degraded the row
// to browser text in a plain CSS box. Measured live in the Parity Studio: of ~12 call sites in
// web/js, EXACTLY ONE passed `level`. Every other tab row in the app -- justice, labor, creatures,
// tasks, places, objects, workshop, farm -- had no native tab art and no DF bitmap font, while the
// Foundation studio card, which used the DEFAULTS, rendered perfectly and passed review. The API let
// every real consumer opt out of the grammar without saying so. That is the exact failure this
// programme exists to kill, and no test in the repo could see it.
//
// So this gate does not check that a file "uses DWFUI". It checks the two properties whose absence
// caused the defect, and it checks them so that the OLD CODE FAILS:
//
//   R1  Every tabsHtml call site DECLARES a level. (The old code passed none: R1 rejects it.)
//   R2  The builder is ADDITIVE: a consumer's cls/tabCls/activeCls can never strip dwfui-tabs /
//       dwfui-tab / active. (The old builder replaced them: R2 rejects it.)
//   R3  A missing or unknown level THROWS. It must be mechanically detectable, never a fallback.
//   R4  Native levels always paint a DF bitmap label, never escaped browser text.
//   R5  The opt-out is DECLARED: nonNativeTabsHtml requires a written `reason`, emits ZERO dwfui-*
//       classes, and its call sites are PINNED to the justified set below. A new opt-out fails.
//   R6  Nobody hand-rolls a tab row: no `role="tablist"` in web/js outside the two builders.
//   R7  The `primary` level is SHORT_TAB (40x24), not the tall TAB (40x36), and its CSS height is the
//       native cell x --dwfui-interface-scale. (We shipped the TALL token at 1:1: R7 rejects it.)
//
//   node tools/harness/tab_grammar_test.mjs              (exit 0 PASS / 1 FAIL)
//   node tools/harness/tab_grammar_test.mjs --selftest   seeds BROKEN input and proves each rule
//                                                        can actually fail. A test that cannot fail
//                                                        is worse than no test.

import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));

const SELFTEST = process.argv.includes("--selftest");
let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "\n      " + x : ""}`); } };

// THE PINNED OPT-OUT SET. Each of these is EVIDENCED not to be a native DF tab row. Adding a row here
// is a deliberate, reviewable act; a new nonNativeTabsHtml call that is not listed FAILS R5.
const NON_NATIVE = {
  // RETIRED in Wave 5: the squad equip nav no longer opts out -- it now IS the green plaque row that
  // this pin's own text described (5. Equip Squad Menu.PNG). The opt-out was a promise to fix it later;
  // it has been fixed, so the pin is stale debt and the gate is right to say so. Do not re-add it.
  //
  // RETIRED in B242, for the same reason -- both pins named a call site that no longer exists, and
  // the gate below (which is the whole point of pinning) was correctly failing on them:
  //   dwf-build-info-panels.js       -- the co-located item strip's nonNativeTabsHtml call is
  //       gone; the file only names the builder in its DWFUI.require allow-list now.
  //   dwf-unit-hud-notifications.js  -- B232 R2 deleted the merged Alerts+Reports tab row
  //       (the ALERT button opens the NATIVE alert box), so the surface the pin justified is gone.
  // Do not re-add either without a real, current call site.
  "dwf-settings.js": "browser-client settings screen -- no native DF counterpart exists to copy",
};

// ---- source scan ---------------------------------------------------------------------------------
// Pull the argument text of every `<x>.tabsHtml(` / `<x>.nonNativeTabsHtml(` call by brace matching.
function callSites(src, fnName) {
  const out = [];
  const re = new RegExp(`\\.${fnName}\\(`, "g");
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, args: src.slice(m.index, i + 1) });
  }
  return out;
}

const JS_DIR = join(root, "web", "js");
const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith(".js"));
const COMPONENT = "dwf-ui-components.js";
const LEVELS = ["primary", "primary-short", "subtab", "subsubtab"];

// SELFTEST seeds the two exact defects the owner found: a level-less call, and a tabCls that (under the old
// builder) stripped the base class. Both are injected into a copy of the real source scan.
const seeded = SELFTEST
  ? [{ file: "SEEDED-defect.js", line: 1, args: `.tabsHtml({ cls: "info-tab-row", tabCls: "info-tab", dataAttr: "info-tab", tabs: [] })` }]
  : [];

console.log("\n# R1: every tabsHtml call site DECLARES a native level (the old code passed NONE)");
const offendersR1 = [];
for (const f of files) {
  if (f === COMPONENT) continue;
  const src = fs.readFileSync(join(JS_DIR, f), "utf8");
  for (const c of callSites(src, "tabsHtml")) {
    const lvl = /\blevel:\s*["']([a-z-]+)["']/.exec(c.args);
    if (!lvl || !LEVELS.includes(lvl[1])) offendersR1.push(`${f}:${c.line}  ${lvl ? "unknown level " + lvl[1] : "NO level"}`);
  }
}
for (const s of seeded) {
  const lvl = /\blevel:\s*["']([a-z-]+)["']/.exec(s.args);
  if (!lvl) offendersR1.push(`${s.file}:${s.line}  NO level  (SEEDED)`);
}
check("every tabsHtml call site declares one of " + LEVELS.join(" | "),
  offendersR1.length === 0, offendersR1.join("\n      "));

console.log("\n# R2: cls/tabCls/activeCls are ADDITIVE -- a consumer can never strip the base classes");
// The R2 predicates, named once so --selftest can run them against a SEEDED replacement-mode mutant
// (the exact markup the OLD builder produced for justice: `class="info-tab"` and nothing else).
const R2 = {
  row: h => /class="dwfui-tabs dwfui-tabs--primary info-tab-row"/.test(h),
  tab: h => /class="dwfui-tab dwfui-tab--primary info-tab active on"/.test(h),
  noOld: h => !/class="info-tab-row"/.test(h) && !/class="info-tab on"/.test(h),
};
const CFG = { level: "primary", cls: "info-tab-row", tabCls: "info-tab", activeCls: "on",
  tabs: [{ key: "justice", label: "Justice" }], active: "justice" };
// SEEDED MUTANT: the pre-fix builder, verbatim -- `cls`/`tabCls` REPLACE the base classes.
const mutantReplacing = SELFTEST
  ? `<div class="info-tab-row" role="tablist"><button class="info-tab on" role="tab" aria-selected="true" data-dwfui-tab="justice">Justice</button></div>`
  : null;
const consumer = SELFTEST ? mutantReplacing : DWFUI.tabsHtml(CFG);
check("the row keeps dwfui-tabs AND carries the consumer class" + (SELFTEST ? "  [SEEDED base-class-stripping mutant]" : ""),
  R2.row(consumer));
check("the tab keeps dwfui-tab + level + `active`, AND carries the consumer classes" + (SELFTEST ? "  [SEEDED]" : ""),
  R2.tab(consumer));
check("(test-the-test) the OLD replacement markup is now unrenderable" + (SELFTEST ? "  [SEEDED]" : ""),
  R2.noOld(consumer));

console.log("\n# R3: a missing or unknown level THROWS (no silent degrade to a browser-text box)");
const throwsOn = cfg => { try { DWFUI.tabsHtml(cfg); return false; } catch (e) { return /`level` is REQUIRED/.test(e.message); } };
check("no level        -> throws", throwsOn({ cls: "info-tab-row", tabCls: "info-tab", tabs: [] }));
check("unknown level   -> throws", throwsOn({ level: "primaryish", tabs: [] }));
check("null level      -> throws", throwsOn({ level: null, tabs: [] }));
check("(test-the-test) a builder that ACCEPTED a level-less config would fail this rule",
  !throwsOn({ level: "subtab", tabs: [] }) === true);

console.log("\n# R4: a native level ALWAYS paints a DF bitmap label, never escaped browser text");
for (const level of LEVELS) {
  const html = DWFUI.tabsHtml({ level, tabs: [{ key: "j", label: "Justice" }], active: "j" });
  check(`${level}: label is a bitmap-text host`,
    // the button's DIRECT child is the bitmap host, not raw escaped text (the old level-less path).
    // (The inner .dwfui-bitmap-fallback span is the a11y/no-canvas fallback and is expected.)
    /<button[^>]*><span class="dwfui-bitmap-text dwfui-tab-label" data-dwfui-bitmap-text="Justice">/.test(html) &&
    !/<button[^>]*>Justice</.test(html));
}

console.log("\n# R5: the opt-out is DECLARED, justified, and PINNED");
check("nonNativeTabsHtml THROWS without a written reason",
  (() => { try { DWFUI.nonNativeTabsHtml({ tabs: [] }); return false; } catch (e) { return /`reason` is REQUIRED/.test(e.message); } })());
const nn = DWFUI.nonNativeTabsHtml({ reason: "x", cls: "sq-tabbar-main", tabCls: "sq-tab", tabs: [{ key: "a", label: "A" }], active: "a" });
check("nonNativeTabsHtml emits ZERO dwfui-* classes and no bitmap label (it wears no grammar it lacks)",
  !/dwfui-tab/.test(nn) && !/data-dwfui-bitmap-text/.test(nn));
check("nonNativeTabsHtml keeps the CAPABILITY (tablist + active + data attr)",
  /role="tablist"/.test(nn) && /aria-selected="true"/.test(nn) && /data-nntab="a"/.test(nn));

const optOuts = {};
for (const f of files) {
  if (f === COMPONENT) continue;
  const src = fs.readFileSync(join(JS_DIR, f), "utf8");
  for (const c of callSites(src, "nonNativeTabsHtml")) {
    if (!/\breason:\s*["'`]/.test(c.args) && !/nonNativeTabsHtml\(cfg\)/.test(c.args)) continue;
    optOuts[f] = (optOuts[f] || 0) + 1;
  }
  // unitcycle builds its cfg object separately, then hands it to the builder -- the reason lives on
  // the cfg literal, so accept a `reason:` anywhere in the file that calls the builder.
  if (/\.nonNativeTabsHtml\(/.test(src) && /\breason:\s*["'`]/.test(src)) optOuts[f] = optOuts[f] || 1;
}
if (SELFTEST) optOuts["dwf-SEEDED-newoptout.js"] = 1;
const unpinned = Object.keys(optOuts).filter(f => !NON_NATIVE[f]);
check("every non-native tab row is in the pinned, justified set (a NEW opt-out fails this gate)",
  unpinned.length === 0,
  unpinned.length ? "unjustified opt-out in: " + unpinned.join(", ") : "");
check("every pinned opt-out is still real (a stale pin is debt)",
  Object.keys(NON_NATIVE).every(f => optOuts[f]),
  Object.keys(NON_NATIVE).filter(f => !optOuts[f]).join(", "));

// -------------------------------------------------------------------------------------------------
// R7 -- THE TAB TOKEN. *** WE WERE PAINTING THE WRONG ONE. *** (the decision 3, wave-4 close-out.)
//
// MEASURED on the lossless oracle (Menu Oracle Screenshots/unit profiles/Steam relations.png): the
// unit-profile tab band is `SHORT_TAB` -- a 40x24 record -- drawn at ~30px tall (a least-squares fit
// of 1.230 against DF's own cell). We were rendering `TAB`, the 40x36 TALL token, at 1:1.
//
// So the tab was TOO TALL (wrong token) while its label was TOO SMALL (1.0 interface scale): TWO
// ERRORS IN OPPOSITE DIRECTIONS, which is precisely why they hid each other, and why scaling the
// tall tab up without fixing the token would have made the first one WORSE, not better.
//
// This rule pins the token AND the geometry, and it FAILS on the tall token -- which is what the
// SELFTEST proves below by feeding it the pre-fix table verbatim.
console.log("\n# R7: `primary` is SHORT_TAB (40x24), not the TALL TAB (40x36) -- The owner decision 3");
const MAP = JSON.parse(fs.readFileSync(join(root, "web", "interface_map.json"), "utf8"));
const TAB_TABLE = SELFTEST
  // the pre-fix table, verbatim: the TALL token on the primary level.
  ? { primary: { off: "TAB", on: "TAB_SELECTED", w: 40, h: 36 },
      "primary-short": { off: "SHORT_TAB", on: "SHORT_TAB_SELECTED", w: 40, h: 24 },
      subtab: { off: "SHORT_SUBTAB", on: "SHORT_SUBTAB_SELECTED", w: 40, h: 24 },
      subsubtab: { off: "SHORT_SUBSUBTAB", on: "SHORT_SUBSUBTAB_SELECTED", w: 40, h: 24 } }
  : DWFUI.TOKENS.tabs;
check("the `primary` level resolves to SHORT_TAB / SHORT_TAB_SELECTED (the oracle's tab band)" +
  (SELFTEST ? "  [SEEDED pre-fix table]" : ""),
  TAB_TABLE.primary.off === "SHORT_TAB" && TAB_TABLE.primary.on === "SHORT_TAB_SELECTED",
  `got ${TAB_TABLE.primary.off} / ${TAB_TABLE.primary.on} -- the TALL TAB is 12px too high`);
check("...and every level's declared geometry matches DF's OWN record, and is the SHORT 24px cell",
  Object.values(TAB_TABLE).every(p =>
    MAP[p.off] && MAP[p.on] && p.h === 24 && MAP[p.off].h === p.h && MAP[p.off].w === p.w),
  "a declared height that disagrees with interface_map is a fabricated grammar");
// The CSS half: the tab's height must be the NATIVE 24px cell TIMES the one interface-scale token --
// never a fixed 36px, and never a fixed 30px either (that would re-hardcode the oracle's window).
const TAB_CSS = SELFTEST
  ? ".dwfui-tab--primary {\n  height:36px; background:var(--dwfui-plum);\n}"
  : fs.readFileSync(join(root, "web", "css", "dwf.css"), "utf8");
check("CSS: .dwfui-tab--primary is calc(24px * var(--dwfui-interface-scale)) -- native cell x DF's scale" +
  (SELFTEST ? "  [SEEDED pre-fix CSS]" : ""),
  /\.dwfui-tab--primary \{\s*height:calc\(24px \* var\(--dwfui-interface-scale\)\)/.test(TAB_CSS),
  "a hardcoded tab height cannot follow DF's window, and 36px is the wrong token's height");

console.log("\n# R6: nobody hand-rolls a tab row (the class must come from the builder -- drift rule R2)");
const handRolled = [];
for (const f of files) {
  if (f === COMPONENT) continue;
  const src = fs.readFileSync(join(JS_DIR, f), "utf8");
  if (/role="tablist"/.test(src)) handRolled.push(f);
  if (/class="[^"]*\bdwfui-tabs?\b/.test(src)) handRolled.push(f + " (hand-rolled dwfui-tab class)");
}
if (SELFTEST) handRolled.push("dwf-SEEDED-handrolled.js");
check("no file outside the component builds a tablist or a dwfui-tab class by hand",
  handRolled.length === 0, handRolled.join(", "));

// -------------------------------------------------------------------------------------------------
if (SELFTEST) {
  // Seeded defects: R1 a level-less tabsHtml call; R2 x3 the base-class-stripping builder mutant
  // (the two named defects); R5 an unjustified new opt-out; R6 a hand-rolled tablist; R7 x3 the
  // pre-fix TALL-TAB table + its hardcoded 36px CSS height.
  const expected = 9;
  console.log(`\n--selftest: seeded ${expected} defects; ${failed} rule(s) rejected them.`);
  if (failed !== expected) {
    console.log(`SELFTEST FAILED -- expected exactly ${expected} rules to fail, got ${failed}. A rule that ` +
      "cannot fail is worse than no test.");
    process.exit(1);
  }
  console.log("SELFTEST PASS: every seeded defect was caught. The gate can fail.");
  process.exit(0);
}
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
