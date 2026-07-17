// v1_shell_single_pop_test.mjs -- v1 gap-closure regression: Escape peels EXACTLY ONE topmost
// framework layer per keypress across a MULTI-LAYER stack.
//
// Release bar (docs/superpowers/plans/2026-07-16-v1-gap-closure-fable-handoff.md, "Shared shell"):
//   "Back and Escape close exactly one topmost layer. No trapped panel ... double-close ..."
//
// uiflow_test pins the Escape CASCADE ORDER (which branch fires first) and panel_frame_test pins
// the two-layer topmost-first pop order via the pure focusStack helper. Neither exercises the
// framework layer's actual single-pop invariant across a >=3 panel stack: that ONE Esc closes the
// topmost panel ONLY (no double-close, no survivor lost), that the NEXT Esc peels the new topmost,
// and that Esc on an empty stack is a no-op. escCloseTopmost() (dwf-panelframe.js) selects the
// topmost still-open escClosable panel as `escStack.filter(open).pop()`; this suite drives that exact
// selection over the REAL exported focusStack helper, layer by layer.
//
//   node tools/harness/v1_shell_single_pop_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);
const P = require(join(root, "web/js/dwf-panelframe.js"));

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
};
const guard = (name, cond, extra) => check(`(test-the-test) ${name}`, cond, extra);

check("focusStack (the real z/esc-order helper) is exported", typeof P.focusStack === "function");

// A faithful model of the framework escape layer:
//   * open/focus a panel  -> escStack = focusStack(escStack, key)  (the REAL helper)
//   * escCloseTopmost      -> topmost still-open candidate = escStack.filter(open).pop(); close it.
// `open` is the live set of escClosable panels currently visible.
function makeShell() {
  let escStack = [];
  const open = new Set();
  return {
    openPanel(key) { open.add(key); escStack = P.focusStack(escStack, key); },
    focusPanel(key) { if (open.has(key)) escStack = P.focusStack(escStack, key); },
    // returns the key it closed, or null when nothing was open (Esc no-op / would fall through)
    escCloseTopmost() {
      const candidate = escStack.filter(k => open.has(k)).pop();
      if (candidate == null) return null;
      open.delete(candidate);
      return candidate;
    },
    openKeys() { return [...open].sort(); },
    openCount() { return open.size; },
  };
}

console.log("# a 3-layer stack peels one topmost layer per Escape, in reverse-open order");
{
  const s = makeShell();
  s.openPanel("units"); s.openPanel("stocks"); s.openPanel("squads");
  check("three layers are open before any Escape", s.openCount() === 3);

  const c1 = s.escCloseTopmost();
  check("Esc #1 closes exactly the topmost (last-opened) layer", c1 === "squads");
  check("Esc #1 leaves the other two open (no double-close, no survivor lost)",
    s.openCount() === 2 && JSON.stringify(s.openKeys()) === JSON.stringify(["stocks", "units"]));

  const c2 = s.escCloseTopmost();
  check("Esc #2 peels the NEW topmost layer", c2 === "stocks" && s.openCount() === 1);

  const c3 = s.escCloseTopmost();
  check("Esc #3 peels the last layer", c3 === "units" && s.openCount() === 0);

  const c4 = s.escCloseTopmost();
  check("Esc on an empty stack is a no-op (returns nothing to close -- Esc falls through)", c4 === null);
}

console.log("# focus raises a layer to topmost, so Escape closes the focused one first");
{
  const s = makeShell();
  s.openPanel("units"); s.openPanel("stocks"); s.openPanel("squads");
  s.focusPanel("units"); // user clicks the units panel: it becomes topmost
  const first = s.escCloseTopmost();
  check("after focusing an older panel, Esc closes THAT panel first", first === "units");
  check("exactly one layer closed on the focus-raised pop", s.openCount() === 2 &&
    JSON.stringify(s.openKeys()) === JSON.stringify(["squads", "stocks"]));
}

console.log("# seeded-bad: a bottom-of-stack (oldest-first) selection would close the wrong layer");
{
  // Rebuild the same escStack the model used, then compare pop() (correct: topmost) with a
  // seeded-bad shift() (oldest). If they agreed, the topmost-only assertions above would be vacuous.
  const escStack = P.focusStack(P.focusStack(P.focusStack([], "units"), "stocks"), "squads");
  const open = new Set(["units", "stocks", "squads"]);
  const topmost = escStack.filter(k => open.has(k)).pop();
  const oldest = escStack.filter(k => open.has(k)).shift();
  guard("topmost pop != oldest-first pop, so the single-topmost assertions are load-bearing",
    topmost === "squads" && oldest === "units" && topmost !== oldest);
}

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
