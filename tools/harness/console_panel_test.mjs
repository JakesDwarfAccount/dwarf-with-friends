// console_panel_test.mjs -- OFFLINE fixture test for the WT26 command-console panel's pure shapers
// (consoleDenyMatch / consoleFilter / consoleHistoryPush / consoleFreezeWarning / csRenderBody). No
// Dwarf Fortress and no server: a seeded catalog + the server's deny-rule shape drive the client's
// search, block-marking, history, and DWFUI-built markup, plus deliberately-bad rows
// (completeness rule 3, "test the test") that MUST be discriminated.
//
//   node tools/harness/console_panel_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-console-panel.js");
// The panel renders through DWFUI; load the real component library as a browser-ish window global so
// csRenderBody produces the SHIPPING markup, not a stub.
globalThis.window = globalThis;
globalThis.DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkGuard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

// node --check first (the module must parse standalone).
try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-console-panel.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

const M = require(modPath);
check("module exports the pure shapers",
  ["consoleDenyMatch", "consoleFilter", "consoleHistoryPush", "consoleFreezeWarning", "csRenderBody"]
    .every(k => typeof M[k] === "function"));

// The deny rules AS THE SERVER SHIPS THEM (console_routes.cpp deny_rules_json): {kind,token,reason}.
const DENY_RULES = [
  { kind: "prefix", token: "capture-", reason: "capture-* commands control the server itself and are host-console only" },
  { kind: "exact",  token: "capture",  reason: "capture commands control the server itself and are host-console only" },
  { kind: "exact",  token: "die",      reason: "would kill the Dwarf Fortress process" },
  { kind: "prefix", token: "gui/",     reason: "interactive gui/ scripts need a native screen the server does not have" },
  { kind: "prefix", token: "devel/",   reason: "devel/ internals are disabled in the browser console" },
];

// A representative catalog (the shape /console/commands returns).
const CATALOG = [
  { name: "ls", short: "List available commands" },
  { name: "help", short: "Show help for a command" },
  { name: "prospect", short: "Show what's in the ground" },
  { name: "weather", short: "Change the weather" },
  { name: "units", short: "List units" },
  { name: "die", short: "Kill the DF process" },
  { name: "gui/launcher", short: "The interactive command launcher" },
  { name: "capture-join-password", short: "Set the join passphrase" },
  { name: "devel/query", short: "Query internal structures" },
];

// ---------------- consoleDenyMatch: mirrors the server's command_denied semantics ----------------
console.log("\n# consoleDenyMatch (display-only mirror of src/console_policy.h)");
check("prefix rule: capture-join-password denied", M.consoleDenyMatch(DENY_RULES, "capture-join-password x").denied);
check("exact rule: die denied", M.consoleDenyMatch(DENY_RULES, "die").denied);
check("gui/ namespace denied", M.consoleDenyMatch(DENY_RULES, "gui/launcher").denied);
check("devel/ namespace denied", M.consoleDenyMatch(DENY_RULES, "devel/query --table x").denied);
check("case-insensitive head (DIE)", M.consoleDenyMatch(DENY_RULES, "DIE").denied);
check("prospect all denied (arg-aware)", M.consoleDenyMatch(DENY_RULES, "prospect all").denied);
check("bare prospect ALLOWED", !M.consoleDenyMatch(DENY_RULES, "prospect").denied);
check("ls ALLOWED", !M.consoleDenyMatch(DENY_RULES, "ls").denied);
check("empty command denied", M.consoleDenyMatch(DENY_RULES, "   ").denied);
check("deny carries a reason", /host-console only/.test(M.consoleDenyMatch(DENY_RULES, "capture-x").reason));
checkGuard("a SAFE command is NOT reported denied (would flip if the mirror over-blocked)",
  !M.consoleDenyMatch(DENY_RULES, "weather").denied);

// ---------------- consoleFilter: search-as-you-type + block marking ----------------
console.log("\n# consoleFilter (client-side search)");
{
  const all = M.consoleFilter(CATALOG, "", DENY_RULES);
  check("empty query returns every valid catalog entry", all.length === CATALOG.length);

  const pros = M.consoleFilter(CATALOG, "pros", DENY_RULES);
  check("search narrows to prefix matches (prospect)", pros.length === 1 && pros[0].name === "prospect");

  const gui = M.consoleFilter(CATALOG, "gui", DENY_RULES);
  check("blocked command still appears in results", gui.some(r => r.name === "gui/launcher"));
  check("...marked blocked with a reason", gui.find(r => r.name === "gui/launcher").blocked === true &&
    /native screen/.test(gui.find(r => r.name === "gui/launcher").reason));

  const uNamed = M.consoleFilter(CATALOG, "unit", DENY_RULES);
  check("prefix rank beats substring: 'unit' surfaces units", uNamed[0].name === "units");

  // substring-in-blurb match (query only appears in short help)
  const byBlurb = M.consoleFilter(CATALOG, "passphrase", DENY_RULES);
  check("matches on the short-help blurb too", byBlurb.some(r => r.name === "capture-join-password"));

  // every row carries name + short (the fixture-suite contract)
  check("rows carry name + short", all.every(r => typeof r.name === "string" && typeof r.short === "string"));
}
// seeded-bad catalog rows: a null / numeric-name / missing-name entry must be dropped, never rendered.
{
  const dirty = [{ name: "ls", short: "ok" }, null, { name: 42 }, { short: "no name" }, { name: "", short: "empty" }];
  const rows = M.consoleFilter(dirty, "", DENY_RULES);
  checkGuard("garbage catalog rows are discarded (only the one valid row survives)",
    rows.length === 1 && rows[0].name === "ls");
}

// ---------------- consoleHistoryPush ----------------
console.log("\n# consoleHistoryPush");
{
  let h = M.consoleHistoryPush([], "ls");
  h = M.consoleHistoryPush(h, "weather");
  h = M.consoleHistoryPush(h, "ls");                 // dupe -> moves to front, no duplicate
  check("most-recent-first", h[0] === "ls" && h[1] === "weather");
  check("de-duplicated", h.filter(x => x === "ls").length === 1);
  check("blank is ignored", M.consoleHistoryPush(["ls"], "   ").join() === "ls");
  let big = [];
  for (let i = 0; i < 40; i++) big = M.consoleHistoryPush(big, "cmd" + i);
  check("capped at CONSOLE_HISTORY_MAX", big.length === M.CONSOLE_HISTORY_MAX);
}

// ---------------- csRenderBody: DWFUI-built markup, warning present, no raw controls ----------------
console.log("\n# csRenderBody (DWFUI markup)");
{
  const html = M.csRenderBody({
    catalog: CATALOG, denyRules: DENY_RULES, query: "", cmd: "", output: "", status: null,
    busy: false, armed: false, error: "", history: ["ls", "weather"],
  });
  check("renders a non-empty string", typeof html === "string" && html.length > 0);
  check("the freeze warning is on screen (mandatory UX)", html.indexOf(M.consoleFreezeWarning()) >= 0);
  check("search field is a DWFUI search", /dwfui-search/.test(html));
  check("command list is a DWFUI scroll", /dwfui-scroll/.test(html) && /cs-list/.test(html));
  check("command entry is a real editable <input> (the deliberate non-native exception)",
    /<input[^>]*id="csCmdInput"/.test(html));
  check("Run is a DWFUI plaque, not a hand-built control", /dwfui-plaque[^"]*cs-run/.test(html));
  check("output pane is a DWFUI scroll", /cs-output/.test(html));
  check("history rows render", /cs-hist-row/.test(html));

  // The ONLY <button> allowed is the DWFUI plaque (Run) + DWFUI header close -- never a hand-rolled
  // one. Every <button> in the body must carry a dwfui-* class.
  const buttons = html.match(/<button[^>]*>/g) || [];
  check("every button is DWFUI-emitted (no hand-rolled control)",
    buttons.length > 0 && buttons.every(b => /dwfui-/.test(b)));

  // Run is DISABLED when the field is empty (nothing armed by accident).
  check("Run disabled with an empty command", /cs-run[^>]*disabled|disabled[^>]*cs-run/.test(html) ||
    /class="[^"]*cs-run[^"]*"[^>]*disabled/.test(html));
}
// blocked command in the input surfaces the block banner and disables Run.
{
  const html = M.csRenderBody({ catalog: CATALOG, denyRules: DENY_RULES, cmd: "die", history: [] });
  check("typing a blocked command shows the block banner", /Blocked by the host/.test(html));
  check("...and names the reason", /kill the Dwarf Fortress/.test(html));
}
// armed state restates the freeze cost and names the command.
{
  const html = M.csRenderBody({ catalog: CATALOG, denyRules: DENY_RULES, cmd: "ls", armed: true, history: [] });
  check("armed state asks for a second confirm press", /Press again to run/.test(html));
}
// XSS: command output must be escaped, never live markup.
{
  const html = M.csRenderBody({ catalog: CATALOG, denyRules: DENY_RULES, cmd: "ls",
    output: "<img src=x onerror=alert(1)>", status: 0, history: [] });
  checkGuard("command output is escaped end-to-end (no live <img> injection)",
    html.indexOf("<img src=x") < 0 && /&lt;img src=x/.test(html));
}

console.log("\n----------------------------------------");
console.log(`console_panel_test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
