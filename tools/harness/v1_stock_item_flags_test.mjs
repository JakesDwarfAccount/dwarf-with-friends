// v1_stock_item_flags_test.mjs -- v1 gap-closure regression: an item's forbid / dump / hide flags
// must ROUND-TRIP INDEPENDENTLY through the shipped item-sheet builder, so that reopening an item
// reflects exactly the authoritative server flag state.
//
// Release bar (docs/superpowers/plans/2026-07-16-v1-gap-closure-fable-handoff.md, "Stocks and
// items"): "Ordinary forbid/dump/hide changes must survive reopen."
//
// wave4_info_stocks_test already pins the ALL-OFF sheet (CONTAINER) and the ALL-ON sheet
// (FLAGS_ACTIVE). Neither exercises a MIXED state, so a regression that OR-ed the three flags into
// one (or drew the _ACTIVE variant from the wrong field) would still pass there. This suite renders
// the production stockItemSheetMarkup with each flag latched ALONE and proves:
//   * the latched flag shows its `_ACTIVE` sprite variant + its "un-do" title;
//   * the OTHER two flags stay on their resting sprite + resting title (independence);
//   * the all-off sheet carries no `_ACTIVE` flag variant at all.
// A seeded-bad guard proves the independence assertion is load-bearing.
//
//   node tools/harness/v1_stock_item_flags_test.mjs   (exit 0 PASS / 1 FAIL)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

const DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
globalThis.window = globalThis;
globalThis.DWFUI = DWFUI;
globalThis.escapeHtml = v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
globalThis.dfTokenMatch = () => true;
const { stockItemSheetMarkup } = require(join(root, "web/js/dwf-build-info-panels.js"));

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
};
const guard = (name, cond, extra) => check(`(test-the-test) ${name}`, cond, extra);

const ref = t => ({ itemType: t, itemSubtype: -1, materialType: 0, materialIndex: -1 });
const baseItem = (flags) => ({
  id: 7001, title: "<<pig tail cloth>>",
  description: "This is pig tail cloth.", lines: ["This is pig tail cloth."],
  weight: "<1Γ", spriteRef: ref("CLOTH"), isContainer: false, contents: [],
  mapPos: { x: 10, y: 10, z: 100 },
  forbidden: false, dump: false, hidden: false, following: false, ...flags,
});
const render = flags => stockItemSheetMarkup(baseItem(flags), {}).html;

// The exact sprite tokens and paired titles the builder writes (dwf-build-info-panels.js:2058-2069,
// dwf-ui-components.js:386-388). The trailing quote in the resting regex prevents STOCKS_FORBID
// from matching the STOCKS_FORBID_ACTIVE substring.
const FLAG = {
  forbid: { active: "STOCKS_FORBID_ACTIVE", resting: /data-dwfui-sprite="STOCKS_FORBID"/,
    onTitle: "Unforbid item", offTitle: "Forbid item", field: "forbidden" },
  dump:   { active: "STOCKS_DUMP_ACTIVE", resting: /data-dwfui-sprite="STOCKS_DUMP"/,
    onTitle: "Cancel dump", offTitle: "Mark for dumping", field: "dump" },
  hide:   { active: "STOCKS_HIDE_ACTIVE", resting: /data-dwfui-sprite="STOCKS_HIDE"/,
    onTitle: "Show item", offTitle: "Hide item", field: "hidden" },
};
const keys = Object.keys(FLAG);

console.log("# each flag round-trips independently through the shipped item-sheet builder");
for (const on of keys) {
  const html = render({ [FLAG[on].field]: true });
  const f = FLAG[on];
  check(`${on} latched -> its _ACTIVE sprite (${f.active})`, html.includes(f.active));
  check(`${on} latched -> its "un-do" title ("${f.onTitle}")`, html.includes(f.onTitle));
  check(`${on} latched -> the toggle carrier data-item-toggle="${on}" is present`,
    html.includes(`data-item-toggle="${on}"`));
  for (const other of keys.filter(k => k !== on)) {
    const o = FLAG[other];
    check(`${on} latched leaves ${other} resting (no ${o.active})`, !html.includes(o.active));
    check(`${on} latched leaves ${other} on its resting sprite`, o.resting.test(html));
    check(`${on} latched leaves ${other} on its resting title ("${o.offTitle}")`, html.includes(o.offTitle));
  }
}

console.log("# the all-off sheet carries no latched flag variant");
const off = render({});
for (const k of keys) {
  check(`all-off: ${k} shows no _ACTIVE variant`, !off.includes(FLAG[k].active));
  check(`all-off: ${k} shows its resting sprite + "${FLAG[k].offTitle}" title`,
    FLAG[k].resting.test(off) && off.includes(FLAG[k].offTitle));
}

console.log("# both extremes still render (bounds the round-trip)");
const allOn = render({ forbidden: true, dump: true, hidden: true });
check("all-on: every flag shows its _ACTIVE variant",
  keys.every(k => allOn.includes(FLAG[k].active)));

// A regression that OR-ed the flags (any flag lights all) would make dump/hide _ACTIVE appear in the
// forbid-only sheet. Prove that our independence assertion would actually catch it: inject the dump
// _ACTIVE token into the forbid-only html and confirm the "no dump _ACTIVE" check flips to failing.
const forbidOnly = render({ forbidden: true });
guard("independence is load-bearing: an OR'd flag (dump lit under forbid-only) would be caught",
  !forbidOnly.includes(FLAG.dump.active) &&
  forbidOnly.replace(FLAG.dump.resting, () => `data-dwfui-sprite="${FLAG.dump.active}"`).includes(FLAG.dump.active));

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
