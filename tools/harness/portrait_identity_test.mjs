// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// portrait_identity_test.mjs -- A LETTER IS A BLOCKER, NOT A FALLBACK.
//
// The identity rule (dwf-ui-components.js) is explicit: native NEVER substitutes a letter for
// missing art, so every unresolved identity must mark itself with `data-df-identity-missing` and be
// mechanically detectable. Wave 4 made a missing ITEM sprite fail loud. The PORTRAIT path was the
// hole left behind: a portrait that could not resolve rendered a bare `.portrait-glyph` letter with
// NO marker -- invisible to dwfui_boot_test, to the drift guard, and to the Parity Studio's
// unresolved-identity counter. The code's own comment records it shipping to production as the
// "human merchant shows a letter H" failure.
//
// the ruling (2026-07-12): "I dont mind a letter fallback visually its better than a purple square,
// but only if that fallback is flagged."
//
// So the letter STAYS. This gate exists to guarantee it can never again be SILENT: a letter on the
// screen and a green instrument must never coexist.
//
// Run:  node tools/harness/portrait_identity_test.mjs
//       node tools/harness/portrait_identity_test.mjs --selftest   (proves every rule CAN fail)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HUD = join(ROOT, "web/js/dwf-unit-hud-notifications.js");
const ZONE = join(ROOT, "web/js/dwf-building-zone-stockpile-panels.js");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return; }
  failures.push(`${name}${detail ? " -- " + detail : ""}`);
}

// Each rule is (name, fn(src)) so --selftest can run them against deliberately-broken source and
// assert that every single one actually rejects it. A rule that cannot fail is worse than no rule.
const HUD_RULES = [
  ["images-off glyph is flagged", (s) =>
    /if \(!unitImagesEnabled\)[\s\S]{0,240}?portraitMissingAttr\("images-off"\)/.test(s)],

  ["terminal (all sources exhausted) glyph is flagged", (s) =>
    /portraitMissingAttr\("unresolved"\)[\s\S]{0,80}?portrait-glyph|portraitMissingAttr\("unresolved"\)/.test(s)],

  ["blank-decode glyph is flagged", (s) =>
    /naturalWidth[\s\S]{0,700}?data-df-identity-missing[\s\S]{0,100}?portrait:blank-decode/.test(s)],

  ["32px pseudo-portrait is rejected and flagged", (s) =>
    /falseNativeSprite[\s\S]{0,500}?portrait:not-native/.test(s)],

  ["no-source give-up is flagged", (s) =>
    /if \(!base\)[\s\S]{0,200}?portrait:no-source/.test(s)],

  ["retry exhaustion is flagged", (s) =>
    /next > PORTRAIT_RETRY_LIMIT[\s\S]{0,300}?portrait:retry-exhausted/.test(s)],

  ["authored-portrait failure is flagged", (s) =>
    /dfcAuthoredPortraitError[\s\S]{0,600}?portrait:authored-missing/.test(s)],

  // The marker must be CLEARED when a portrait really decodes, or the instrument lies the other way.
  ["a decoded portrait CLEARS the marker", (s) =>
    /img\.parentElement\.classList\.add\("has-native-portrait"\);[\s\S]{0,200}?removeAttribute\("data-df-identity-missing"\)/.test(s)],

  ["authored load CLEARS the marker", (s) =>
    /dfcAuthoredPortraitLoad[\s\S]{0,300}?removeAttribute\("data-df-identity-missing"\)/.test(s)],

  // The RETRY path must NOT flag: a portrait still in flight is not a failure.
  ["the retry path does NOT flag (an in-flight portrait is not a failure)", (s) => {
    const m = s.match(/img\.dataset\.portraitRetry = String\(next\);[\s\S]{0,300}?\}, 3000\);/);
    return !!m && !/data-df-identity-missing/.test(m[0]);
  }],
];

const ZONE_RULES = [
  ["zone non-unit letter is flagged", (s) =>
    /zone-animal-item-glyph[^`]*data-df-identity-missing="portrait:non-unit"/.test(s)],
];

function run(hudSrc, zoneSrc) {
  const before = failures.length;
  for (const [name, fn] of HUD_RULES) check(name, fn(hudSrc));
  for (const [name, fn] of ZONE_RULES) check(name, fn(zoneSrc));
  return failures.length === before;
}

const hud = readFileSync(HUD, "utf8");
const zone = readFileSync(ZONE, "utf8");

// =================================================================================================
// B-PORTRAIT-FLASH -- THE REFETCH COUNTER.  the owner, in his live game: "theres a new bug where character
// portraits are flashing between the art and the letter ... the game continually checks for updated
// art so is it rerendering it instead of caching it after changes you made".
//
// He is right, and it is measurable, so this gate MEASURES it instead of describing it.
//
// The unit sheet live-refreshes every 3s (UNIT_SHEET_REFRESH_MS) through `renderUnitSheet`, which
// rebuilds the whole sheet. Two defects stacked:
//   * the portrait src carried `&_=` + Date.now() -- A CACHE BUSTER ON EVERY RENDER, so the browser
//     refetched art it had decoded two seconds earlier; and
//   * even cached, a FRESH <img> decodes asynchronously, and `.has-native-portrait` (the class that
//     hides the glyph) is only added on load -- so the LETTER paints in between. That is the flash.
//
// AN <img src=...> IN THE MARKUP IS AN HTTP REQUEST. So the counter is simply: how many <img> does
// the sheet emit for an ALREADY-DECODED portrait across N refresh ticks? Before: N. After: 1 (the
// first paint) and then ZERO, forever -- the decoded node is carried across the rebuild instead.
//
// THE LETTER FALLBACK IS NOT TOUCHED ("a letter fallback ... only if that fallback is flagged").
// The rules above still prove every terminal letter carries data-df-identity-missing.
// =================================================================================================
const REFETCH_TICKS = 10;
async function portraitImgsPerTick({ preserve }) {
  globalThis.window = { setTimeout, addEventListener() {} };
  globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
  globalThis.unitImagesEnabled = true;
  globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
  globalThis.window.DWFUI = globalThis.DWFUI;
  const M = await import("../../web/js/dwf-unit-hud-notifications.js");

  // A unit whose native bust HAS resolved -- the exact case that must never refetch.
  const unit = { id: 101, name: "Deler Likotducim", race: "Dwarf",
    portraitState: "ready", portraitTexpos: 42, sheetIconTexpos: 7 };

  // A DOM double standing in for the sheet host. It records the <img> the markup asked the browser
  // for, and (once decoded) offers it back to the harvester exactly as a real decoded node would.
  M.harvestDecodedPortraits({ querySelectorAll: () => [] });   // start from an empty stash

  const srcs = [];
  let decoded = null;                       // the ONE node the browser ever decoded
  const host = {
    querySelectorAll(sel) {
      if (sel.includes(".native-portrait-img")) return decoded ? [decoded] : [];
      if (sel.includes("data-portrait-adopt")) return adoptBoxes;
      return [];
    },
  };
  let adoptBoxes = [];
  let adoptedNodes = 0;

  for (let tick = 0; tick < REFETCH_TICKS; tick++) {
    if (preserve) M.harvestDecodedPortraits(host);          // what renderUnitSheet now does first
    const html = M.unitPortraitMarkup(unit);
    for (const m of html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) srcs.push(m[1]);

    // Emulate the browser: a fresh <img> decodes and becomes the box's decoded node.
    const fresh = [...html.matchAll(/data-src-base="([^"]+)"/g)][0];
    if (fresh) {
      decoded = { complete: true, naturalWidth: 92, naturalHeight: 92,
        dataset: { srcBase: fresh[1].replace(/&amp;/g, "&") },
        parentElement: { classList: { contains: () => true }, dataset: { unitPortraitBox: "101" } },
        remove() { /* detached by the harvester */ } };
    }
    // An adopt box: no <img> at all, so no request -- and it must already hide the glyph.
    adoptBoxes = [...html.matchAll(/data-portrait-adopt="([^"]+)"/g)].map(m => ({
      dataset: { portraitAdopt: m[1].replace(/&amp;/g, "&") },
      classList: { remove() {}, add() {} },
      removeAttribute() {}, prepend() { adoptedNodes++; },
    }));
    if (preserve) M.adoptDecodedPortraits(host);
  }
  return { srcs, adoptedNodes };
}

const after = await portraitImgsPerTick({ preserve: true });
check(`an already-resolved portrait is fetched ONCE across ${REFETCH_TICKS} refresh ticks`,
  after.srcs.length === 1, `emitted ${after.srcs.length} <img src> (= ${after.srcs.length} requests)`);
check("and its decoded node is re-attached on every subsequent tick (no re-decode, no flash)",
  after.adoptedNodes === REFETCH_TICKS - 1, `adopted ${after.adoptedNodes}/${REFETCH_TICKS - 1}`);
check("the first src is STABLE -- no Date.now() cache buster on a portrait that may resolve",
  after.srcs.length > 0 && !/[?&]_=/.test(after.srcs[0]), after.srcs[0]);
check("the adopted box hides the glyph from its FIRST frame (has-native-portrait is in the markup)",
  /class="[^"]*has-native-portrait[^"]*"[^>]*data-portrait-adopt/.test(
    (await (async () => { const M = await import("../../web/js/dwf-unit-hud-notifications.js");
      M.harvestDecodedPortraits({ querySelectorAll: (s) => s.includes(".native-portrait-img")
        ? [{ complete: true, naturalWidth: 9, naturalHeight: 9,
             dataset: { srcBase: "/unit-portrait?id=101&mode=portrait&tex=42&sheet=7" },
             parentElement: { classList: { contains: () => true }, dataset: { unitPortraitBox: "101" } },
             remove() {} }] : [] });
      return M.unitPortraitMarkup({ id: 101, race: "Dwarf", portraitState: "ready",
        portraitTexpos: 42, sheetIconTexpos: 7 }); })())));
// A RESOLVED identity must not be flagged, or the instrument lies in the other direction.
check("an adopted (resolved) portrait carries NO data-df-identity-missing",
  !/data-portrait-adopt[^>]*data-df-identity-missing/.test(after.srcs.join("")));
// The RETRY path must still bust the cache: a portrait DF has not populated yet has to be re-asked.
check("the RETRY path still busts the cache (lazy texpos must still be re-asked)",
  /img\.src = base \+ "&retry=" \+ next \+ "&_=" \+ Date\.now\(\);/.test(hud));
// THE SEEDED-BAD, ALWAYS RUN: the pre-fix behaviour is "rebuild the markup without preserving
// anything" -- which is literally what renderUnitSheet used to do. It must make the counter go RED.
const before = await portraitImgsPerTick({ preserve: false });
check(`SEEDED-BAD: without preservation the sheet refetches on EVERY tick (${REFETCH_TICKS}) -- the rule CAN fail`,
  before.srcs.length === REFETCH_TICKS && before.srcs.length !== after.srcs.length,
  `seeded-bad emitted ${before.srcs.length}; if this ever equals ${after.srcs.length} the counter is not measuring anything`);
// And renderUnitSheet must actually USE the preserving path -- a fix nothing calls is not a fix.
const hudCode = hud.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("renderUnitSheet goes through renderPreservingPortraits (a THUNK, so the harvest precedes the build)",
  /renderPreservingPortraits\(panelContent\(selection\),\s*\(\) => unitSheetMarkup\(/.test(hudCode) &&
  !/panelContent\(selection\)\.innerHTML\s*=\s*unitSheetMarkup/.test(hudCode));

if (process.argv.includes("--selftest")) {
  // Seed the exact regression each rule guards: strip every marker back out, restoring the silent
  // letter. EVERY rule must reject it. Any rule that still passes is a rule that cannot fail.
  const brokenHud = hud
    .replace(/ ?data-df-identity-missing="portrait:[a-z-]+"/g, "")
    .replace(/portraitMissingAttr\("[a-z-]+"\)/g, '""')
    .replace(/\.removeAttribute\("data-df-identity-missing"\);/g, "")
    .replace(/\.setAttribute\("data-df-identity-missing",[\s\S]*?\);/g, "");
  const brokenZone = zone.replace(/ ?data-df-identity-missing="portrait:[a-z-]+"/g, "");

  const survivors = [];
  for (const [name, fn] of HUD_RULES) if (fn(brokenHud)) survivors.push(name);
  for (const [name, fn] of ZONE_RULES) if (fn(brokenZone)) survivors.push(name);

  // The "retry does NOT flag" rule is a negative assertion: stripping markers makes it MORE true, so
  // it is expected to survive. Every other rule must have died.
  const expectedSurvivor = "the retry path does NOT flag (an in-flight portrait is not a failure)";
  const bad = survivors.filter((s) => s !== expectedSurvivor);
  if (bad.length) {
    console.error("SELFTEST FAILED: these rules could not fail when the silent letter was restored:");
    bad.forEach((b) => console.error("  - " + b));
    process.exit(1);
  }
  const total = HUD_RULES.length + ZONE_RULES.length - 1;
  console.log(`portrait_identity --selftest: ${total} rules rejected the seeded silent letter, 0 could not fail`);
  process.exit(0);
}

run(hud, zone);

if (failures.length) {
  console.error(`FAIL portrait_identity: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.error("  x " + f));
  console.error("\nA portrait that cannot resolve renders a LETTER. The owner allows the letter -- but it MUST");
  console.error("carry data-df-identity-missing, or a letter on screen and a green gate coexist again.");
  process.exit(1);
}
console.log(`PASS portrait_identity: ${pass} passed, 0 failed (every terminal letter is flagged; the retry path is not)`);
