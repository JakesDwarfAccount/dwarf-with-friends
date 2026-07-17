// view_stamp_test.mjs -- B210: the /view build-stamp gate must actually stamp the page.
//
// Since win31, GET /view served index.html with the __DFCAPTURE_BUILD__ placeholder un-replaced:
// index.html had grown an explanatory comment that spelled the token out literally, and the DLL's
// stamping code replaced only the FIRST occurrence -- so the stamp landed in the comment and the
// real <script>window.DFCAPTURE_BUILD = "..."</script> assignment kept the raw placeholder. The
// client's compareBuild() treats an un-replaced placeholder as "unknown" (deliberately bannerless),
// so the version-mismatch gate silently died and stale/mixed-cache tabs persisted (the dead-?
// report, 2026-07-11).
//
// This test guards BOTH halves of the fix, against the REAL files:
//   S1. src/session_routes.cpp stamps EVERY occurrence (the replace loop is present, and its
//       placeholder literal matches index.html's).
//   S2. web/index.html contains EXACTLY ONE literal occurrence of the token -- deployed DLLs up
//       to win33 replace only the first occurrence, so a second literal (comment, doc block,
//       second script tag) would re-kill the gate on every server that predates the loop.
//   S3. Simulating the server's stamping over the real index.html leaves ZERO placeholders and
//       produces a stamped window.DFCAPTURE_BUILD assignment -- under BOTH semantics: the current
//       replace-all loop AND the legacy first-occurrence replace still in the field.
//
// Test-the-test: --selftest replays the checks against the actual win31 known-bad shape (token
// duplicated in a comment above the script tag) and a first-only C++ body, and requires each
// seeded-bad to FAIL. A guard that has never failed is unvalidated (completeness protocol rule 3).
//
// Run: node tools/harness/view_stamp_test.mjs [--selftest]

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const INDEX_PATH = path.join(root, "web", "index.html");
const CPP_PATH = path.join(root, "src", "session_routes.cpp");

const TOKEN = "__DFCAPTURE_BUILD__";
const STAMP = "0x538dea9c-abcdef123"; // realistic "0x<crc>-<gitshort>" shape

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ` -- ${detail}` : ""}`);
  passed++;
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Mirror of the C++ replace-all loop in session_routes.cpp's /view handler.
function stampAll(html, token, stamp) {
  let out = html;
  for (let at = out.indexOf(token); at !== -1; at = out.indexOf(token, at + stamp.length))
    out = out.slice(0, at) + stamp + out.slice(at + token.length);
  return out;
}

// Mirror of the LEGACY (pre-B210-fix, still deployed) first-occurrence replace.
function stampFirstOnly(html, token, stamp) {
  const at = html.indexOf(token);
  return at === -1 ? html : html.slice(0, at) + stamp + html.slice(at + token.length);
}

// The suite, parameterized so --selftest can replay it against seeded-bad inputs.
function runChecks(indexHtml, cppSource, label) {
  const t = (name, cond, detail) => check(`${label}: ${name}`, cond, detail);

  // S1 -- the server side.
  const phMatch = cppSource.match(/const std::string ph = "([^"]+)";/);
  t("cpp declares the placeholder literal", !!phMatch);
  t("cpp placeholder matches the canonical token", phMatch[1] === TOKEN, phMatch[1]);
  const viewBody = cppSource.slice(cppSource.indexOf('"/view"'));
  t("cpp /view handler exists", cppSource.includes('"/view"'));
  t("cpp stamps EVERY occurrence (replace loop present, not a single find/replace)",
    /for \(size_t at = html\.find\(ph\);[\s\S]{0,200}?html\.find\(ph, at \+ stamp\.size\(\)\)/.test(viewBody),
    "the replace-all loop is missing -- a first-occurrence replace resurrects B210");

  // S2 -- the client-file shape.
  const occurrences = countOccurrences(indexHtml, TOKEN);
  t("index.html carries the placeholder (gate is wired)", occurrences >= 1);
  t("index.html carries EXACTLY ONE literal token (first-only DLLs in the field stamp only #1)",
    occurrences === 1, `found ${occurrences}`);
  t("the one occurrence is the script-tag assignment",
    indexHtml.includes(`window.DFCAPTURE_BUILD = "${TOKEN}"`));

  // S3 -- end-to-end simulation over the real page, both server semantics.
  for (const [semantics, stampFn] of [["replace-all", stampAll], ["legacy first-only", stampFirstOnly]]) {
    const stamped = stampFn(indexHtml, TOKEN, STAMP);
    t(`${semantics}: no placeholder survives stamping`, !stamped.includes(TOKEN));
    t(`${semantics}: script tag got the real stamp`,
      stamped.includes(`window.DFCAPTURE_BUILD = "${STAMP}"`));
  }
}

const indexHtml = fs.readFileSync(INDEX_PATH, "utf8");
const cppSource = fs.readFileSync(CPP_PATH, "utf8");

if (process.argv.includes("--selftest")) {
  // Each seeded-bad must make runChecks THROW; a selftest that passes on bad input is the bug.
  let failures = 0;
  const mustFail = (name, badIndex, badCpp) => {
    try {
      runChecks(badIndex, badCpp, `selftest:${name}`);
      console.error(`SELFTEST FAIL: seeded-bad "${name}" was not caught`);
      failures++;
    } catch {
      passed++;
      console.log(`selftest ok: seeded-bad "${name}" correctly caught`);
    }
  };

  // (a) The actual win31 regression: the token spelled out in a comment ABOVE the script tag.
  mustFail("win31 duplicate-token comment",
    indexHtml.replace("<!-- VERSION-MISMATCH GATE:",
      `<!-- VERSION-MISMATCH GATE: GET /view replaces ${TOKEN} with its build id.`),
    cppSource);
  // (b) The pre-fix C++: single find/replace instead of the loop.
  mustFail("first-only C++ replace",
    indexHtml,
    cppSource.replace(
      /const std::string stamp = auth::build_stamp\(\);[\s\S]*?html\.replace\(at, ph\.size\(\), stamp\);/,
      "size_t at = html.find(ph);\n        if (at != std::string::npos) html.replace(at, ph.size(), auth::build_stamp());"));
  // (c) Gate unwired: no placeholder in the page at all.
  mustFail("placeholder missing from index.html",
    indexHtml.replaceAll(TOKEN, "stamped-at-build-time"), cppSource);
  // (d) Renamed token in the page (server would no-op silently).
  mustFail("token renamed in index.html only",
    indexHtml.replaceAll(TOKEN, "__DFCAP_BUILD__"), cppSource);

  if (failures) process.exit(1);
  console.log(`view_stamp_test --selftest PASS (${passed} checks)`);
  process.exit(0);
}

runChecks(indexHtml, cppSource, "live");
console.log(`view_stamp_test PASS (${passed} checks) -- /view stamping guarded against the real web/index.html`);
