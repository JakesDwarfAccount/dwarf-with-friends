// husbandry_client_test.mjs -- OFFLINE fixture for the Pets/Livestock GELD button (the one native
// husbandry flow the web client lacked: pasture/pen assignment, war/hunt training, adoption, and
// slaughter already shipped in building_zone.cpp + B16/B33; gelding did not). No DF, no server:
// exercises the pure geldButtonSpec() gate exported from dwf-build-info-panels.js + a
// seeded-bad (mutant) case proving the test discriminates (completeness rule 3).
//   node tools/harness/husbandry_client_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-build-info-panels.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-build-info-panels.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
check("exports the pure geldButtonSpec helper", typeof M.geldButtonSpec === "function");
check("exports the B43 sex glyph helper", typeof M.creatureSexGlyphHtml === "function");
const spec = M.geldButtonSpec;

// ---- GATE: button shows iff the caste is geldable AND the animal isn't already gelded ----
console.log("\n# geldButtonSpec gate (server sends geldable=false for non-GELDABLE OR already-gelded)");
check("geldable + not-marked -> button, label 'Geld', inactive",
  (() => { const s = spec({ geldable: true, geld: false }); return s && s.action === "geld" && s.label === "Geld" && s.active === false; })());
check("geldable + marked -> button ACTIVE (toggle state reflected)",
  (() => { const s = spec({ geldable: true, geld: true }); return s && s.active === true; })());
check("title flips: unmarked -> 'Mark for gelding'", spec({ geldable: true, geld: false }).title === "Mark for gelding");
check("title flips: marked -> cancel copy", spec({ geldable: true, geld: true }).title === "Marked for gelding (click to cancel)");

// ---- COUNTEREXAMPLES (completeness rule 5): non-geldable must yield NO button ----
console.log("\n# counterexamples: non-geldable animals must NOT render a Geld button");
check("non-geldable caste (geldable:false) -> null (no button)", spec({ geldable: false, geld: false }) === null);
check("already-gelded (server sends geldable:false) -> null", spec({ geldable: false, geld: false }) === null);
check("OLD DLL omits the field (geldable undefined) -> null (dormant-safe)", spec({ slaughter: true }) === null);
check("null livestock (non-animal row) -> null", spec(null) === null);
check("empty object -> null", spec({}) === null);

// ---- TEST-THE-TEST: a gate that ignores geldable would wrongly show the button ----
console.log("\n# TEST-THE-TEST (a seeded-bad gate must be discriminated)");
const mutantAlwaysShows = (ls) => ({ action: "geld", active: !!(ls && ls.geld), label: "Geld", title: "x" });
guard("a gate ignoring `geldable` WRONGLY renders on a non-geldable animal; real gate returns null",
  mutantAlwaysShows({ geldable: false }) !== null && spec({ geldable: false }) === null);
const mutantIgnoresMarked = (ls) => (ls && ls.geldable ? { action: "geld", active: false, label: "Geld", title: "x" } : null);
guard("a gate ignoring `geld` shows a stale inactive button; real gate reflects marked=true as active",
  mutantIgnoresMarked({ geldable: true, geld: true }).active === false && spec({ geldable: true, geld: true }).active === true);

console.log("\n# B43 sex glyphs for creature list rows");
check("row.sex=female -> female glyph", /&#9792;/.test(M.creatureSexGlyphHtml({ sex: "female" })));
check("row.sex=male -> male glyph", /&#9794;/.test(M.creatureSexGlyphHtml({ sex: "male" })));
check("row.ct=FEMALE fallback -> female glyph", /&#9792;/.test(M.creatureSexGlyphHtml({ ct: "FEMALE" })));
check("unknown sex keeps the grid cell but emits no ? glyph", !/[?]/.test(M.creatureSexGlyphHtml({ ct: "CHILD" })) && /creature-sex-glyph/.test(M.creatureSexGlyphHtml({})));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
