// attribution_fixture_test.mjs -- OFFLINE fixture test for the WP-C client attribution module's
// pure data-shapers (attribParse / attribLookup / attribShouldShow / attribDotHtml). No Dwarf
// Fortress and no server: seeded /attrib payloads spanning the matrix (each kind, unknown id,
// garbage payload, toggle on/off) plus deliberately-bad rows (completeness rule 3, "test the
// test") that MUST be discriminated.
//
//   node tools/harness/attribution_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-attribution.js");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkGuard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}
function noThrow(name, fn) {
  try { const v = fn(); passed++; console.log(`  ok - ${name} (no throw)`); return v; }
  catch (e) { failed++; console.log(`  FAIL - ${name} threw: ${e.message}`); return undefined; }
}

try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-attribution.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

const M = require(modPath);
check("module exports the 4 pure helpers",
  ["attribParse", "attribLookup", "attribShouldShow", "attribDotHtml"].every(k => typeof M[k] === "function"));

// ---------------- attribParse ----------------
console.log("\n# attribParse");
{
  const raw = {
    world: "region1",
    buildings: { "12": "guest", "13": "host" },
    orders: { "40": "guest-2" },
    stockpiles: { "7": "host" },
    zones: { "3": "guest" },
  };
  const s = M.attribParse(raw);
  check("world preserved", s.world === "region1");
  check("buildings parsed with string keys", s.buildings["12"] === "guest" && s.buildings["13"] === "host");
  check("orders parsed (deduped name kept verbatim)", s.orders["40"] === "guest-2");
  check("stockpiles + zones parsed", s.stockpiles["7"] === "host" && s.zones["3"] === "guest");
}
// TEST-THE-TEST: a garbage / partial payload must yield empty sections, never throw or leak junk.
{
  const s = M.attribParse({ buildings: { "5": 999, "6": "", "7": "ok" }, orders: "not-an-object" });
  checkGuard("non-string values dropped (numeric 999, empty)", s.buildings["5"] === undefined && s.buildings["6"] === undefined);
  checkGuard("valid string kept alongside junk", s.buildings["7"] === "ok");
  checkGuard("non-object section -> empty, not crash", typeof s.orders === "object" && Object.keys(s.orders).length === 0);
}
noThrow("attribParse(null)", () => M.attribParse(null));
noThrow("attribParse(42)", () => M.attribParse(42));

// ---------------- attribLookup ----------------
console.log("\n# attribLookup");
{
  const s = M.attribParse({ buildings: { "12": "guest" }, orders: { "40": "host" }, stockpiles: {}, zones: {} });
  check("lookup building by singular kind", M.attribLookup(s, "building", 12) === "guest");
  check("lookup building by plural kind", M.attribLookup(s, "buildings", 12) === "guest");
  check("lookup workshop maps to buildings section", M.attribLookup(s, "workshop", 12) === "guest");
  check("lookup order", M.attribLookup(s, "order", 40) === "host");
  check("numeric vs string id both hit", M.attribLookup(s, "building", "12") === "guest");
  // TEST-THE-TEST: an unknown id / unknown kind must return null, NOT a default name. A registry
  // that answered "default" (or anything) for a pre-existing/native id would fail here.
  checkGuard("unknown building id -> null (native/pre-existing shows no dot)", M.attribLookup(s, "building", 999) === null);
  checkGuard("unknown kind -> null", M.attribLookup(s, "bogus", 12) === null);
  checkGuard("wrong section for a real id -> null (order id not a building)", M.attribLookup(s, "building", 40) === null);
}
noThrow("attribLookup(null,...)", () => M.attribLookup(null, "building", 1));

// ---------------- attribShouldShow ----------------
console.log("\n# attribShouldShow");
check("default ON when no override / no localStorage", M.attribShouldShow() === true);
check("explicit override true", M.attribShouldShow(true) === true);
check("explicit override false", M.attribShouldShow(false) === false);

// ---------------- attribDotHtml ----------------
console.log("\n# attribDotHtml");
{
  const colorOf = name => (name === "guest" ? "#e33" : "#3e3");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const html = M.attribDotHtml("guest", colorOf, esc);
  check("chip contains the dot glyph", /&#9679;|●/.test(html));
  check("chip injects the player color", html.includes("#e33"));
  check("chip contains the escaped name", html.includes(">guest<"));
  check("chip title carries the name", /title="Ordered by guest"/.test(html));
  // TEST-THE-TEST: an XSS-y name must be escaped, never injected raw.
  const evil = M.attribDotHtml('<img src=x onerror=alert(1)>', colorOf, esc);
  checkGuard("malicious name is HTML-escaped", !/<img/.test(evil) && /&lt;img/.test(evil));
  // TEST-THE-TEST (live-found bug, window #8): the canonical DwfTiles.playerColor returns
  // an OBJECT {fill,dark}, not a string -- the chip must use .fill, never "[object Object]".
  const objColor = M.attribDotHtml("guest", () => ({ fill: "hsl(92,85%,58%)", dark: "hsl(92,60%,24%)" }), esc);
  checkGuard("object-shaped playerColor uses .fill", objColor.includes("hsl(92,85%,58%)"), objColor.slice(0, 120));
  checkGuard("never emits [object Object]", !objColor.includes("[object Object]"));
  const junkColor = M.attribDotHtml("guest", () => ({ nope: 1 }), esc);
  checkGuard("unknown color shape -> no inline style", !/style=/.test(junkColor));
  // empty / non-string player -> empty chip (no stray markup).
  checkGuard("empty player -> empty string", M.attribDotHtml("", colorOf, esc) === "" && M.attribDotHtml(null, colorOf, esc) === "");
}
noThrow("attribDotHtml with no colorOf/escaper", () => M.attribDotHtml("solo"));

// ---------------- panel "Ordered by" composition (WT04 injection) ----------------
// The building/workshop/stockpile/zone inspect panels each compose their line as:
//   attribShouldShow() ? (attribLookup(state, KIND, id) ? attribDotHtml(player) : "") : ""
// wrapped in `Ordered by <chip>`. This mirrors attribRowHtml (a browser-global that reads the
// module's private _attribState, so it isn't node-requireable) using the EXPORTED pure pieces,
// and locks the KIND each panel passes to its own /attrib section. The real regression risk is a
// mis-wired kind (e.g. a stockpile panel querying "zone") -- the cross-section guards below fail
// loudly if that happens.
console.log("\n# panel Ordered-by composition");
{
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const colorOf = () => "#abc";
  // Ground-truth /attrib payload: one id per kind, each stamped by a distinct player.
  const state = M.attribParse({
    world: "region1",
    buildings: { "12": "guest" },   // plain building AND workshop share this section
    orders: { "40": "host" },
    stockpiles: { "7": "visitor" },
    zones: { "3": "mate" },
  });
  // Reproduce the panels' line composition for a given (kind, id).
  const orderedByLine = (kind, id, showOverride) => {
    if (!M.attribShouldShow(showOverride)) return "";
    const player = M.attribLookup(state, kind, id);
    const chip = player ? M.attribDotHtml(player, colorOf, esc) : "";
    return chip ? `Ordered by ${chip}` : "";
  };
  // Each panel's own kind resolves its own creator, wrapped in the "Ordered by" line + a dot.
  check("building panel line -> creator", /Ordered by .*guest/.test(orderedByLine("building", 12, true)));
  check("workshop panel line (kind 'building') -> creator", /Ordered by .*guest/.test(orderedByLine("workshop", 12, true)));
  check("stockpile panel line -> creator", /Ordered by .*visitor/.test(orderedByLine("stockpile", 7, true)));
  check("zone panel line -> creator", /Ordered by .*mate/.test(orderedByLine("zone", 3, true)));
  check("workshop order-row chip -> creator", /Ordered by .*host/.test(orderedByLine("order", 40, true)));
  check("every line carries the dot glyph", /&#9679;/.test(orderedByLine("stockpile", 7, true)));
  // TEST-THE-TEST: a native / pre-existing thing (id not in the registry) yields NO line at all,
  // on every panel -- the whole graceful-dormant contract for the live pre-WP-C DLL rides on this.
  checkGuard("native stockpile id -> no line", orderedByLine("stockpile", 999, true) === "");
  checkGuard("native zone id -> no line", orderedByLine("zone", 999, true) === "");
  checkGuard("native building id -> no line", orderedByLine("building", 999, true) === "");
  // TEST-THE-TEST: cross-section isolation. A stockpile id must NOT resolve under the zone section
  // (and vice-versa) -- catches a panel that passed the wrong kind string.
  checkGuard("stockpile id under 'zone' kind -> no line (mis-wire guard)", orderedByLine("zone", 7, true) === "");
  checkGuard("zone id under 'stockpile' kind -> no line (mis-wire guard)", orderedByLine("stockpile", 3, true) === "");
  checkGuard("order id under 'building' kind -> no line (mis-wire guard)", orderedByLine("building", 40, true) === "");
  // The showAttribution toggle suppresses the line on every panel.
  checkGuard("toggle OFF -> no line even with a known creator", orderedByLine("stockpile", 7, false) === "");
}

// ---------------- summary ----------------
console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
