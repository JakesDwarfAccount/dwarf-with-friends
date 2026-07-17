// join_version_test.mjs -- VERSION-MISMATCH GATE, pure logic (ship-blocker, PROJECT-CLOSEOUT
// Phase 5). Loads the REAL web/js/dwf-join.js (verbatim, via vm.runInThisContext) and
// exercises its pure comparators: compareBuild (the banner tiers), parseStamp, and fnv1a (the
// soft-tier asset fingerprint). fnv1a is cross-checked against (a) the canonical FNV-1a 32-bit
// test vectors and (b) an INDEPENDENT re-implementation of the C++ server formula
// (session_routes.cpp assets_fingerprint, ex-http_server.cpp -- B212) so client + server provably agree on the soft-tier hash.
//
// Acceptance matrix (version axis): {match, DLL-newer, web-newer, wire-CRC-changed, missing route
// (=old DLL), dev build} x banner level. Plus test-the-test: a deliberately WRONG expectation must
// make the suite FAIL.
//
// Run: node tools/harness/join_version_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOIN_PATH = path.resolve(__dirname, "../../web/js/dwf-join.js");

// Minimal browser globals -- the pure comparators touch none of them, but the IIFE assigns
// window.DwfJoin at load.
globalThis.window = globalThis;
globalThis.document = { getElementById() { return null; }, querySelectorAll() { return []; },
                        createElement() { return { style: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }; },
                        head: { appendChild() {} }, documentElement: { appendChild() {} },
                        body: { appendChild() {} } };

vm.runInThisContext(fs.readFileSync(JOIN_PATH, "utf8"), { filename: JOIN_PATH });
const J = globalThis.DwfJoin;
assert.ok(J && typeof J.compareBuild === "function", "dwf-join.js did not install DwfJoin");

let passed = 0;
function check(name, got, want) {
  assert.deepEqual(got, want, `${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  passed++;
}

// ---- parseStamp ------------------------------------------------------------------------------
check("parseStamp two-part", J.parseStamp("0x538dea9c-23092973d"), { crc: "0x538dea9c", git: "23092973d" });
check("parseStamp no-git", J.parseStamp("0x538dea9c"), { crc: "0x538dea9c", git: "" });
check("parseStamp null", J.parseStamp(""), null);

// ---- compareBuild MATRIX ---------------------------------------------------------------------
const CRC = "0x538dea9c";
const A = `${CRC}-aaaaaaaaa`, B = `${CRC}-bbbbbbbbb`;

// match (same commit, same wire)
check("match", J.compareBuild(A, A).level, "ok");
// DLL-newer: server git advanced past the client tab -> stale tab, hard
check("DLL-newer -> hard/stale", J.compareBuild(A, B), { level: "hard", reason: "stale" });
// web-newer: client git ahead of server (client redeployed, server not) -> still a mismatch, hard
check("web-newer -> hard/stale", J.compareBuild(B, A), { level: "hard", reason: "stale" });
// wire CRC changed (window re-golden) -> protocol mismatch, hard/protocol (takes priority over git)
check("wire-CRC changed -> hard/protocol",
      J.compareBuild(`0x11111111-aaaaaaaaa`, `0x22222222-bbbbbbbbb`), { level: "hard", reason: "protocol" });
// missing /version route (old DLL) -> server build "" -> unknown (NO banner: graceful)
check("missing route -> unknown", J.compareBuild(A, "").level, "unknown");
check("both missing -> unknown", J.compareBuild("", "").level, "unknown");
// un-replaced server-side stamp placeholder (old DLL that doesn't inject) -> unknown, no banner
check("unreplaced placeholder (server) -> unknown", J.compareBuild(A, "__DFCAPTURE_BUILD__").level, "unknown");
check("unreplaced placeholder (client) -> unknown", J.compareBuild("__DFCAPTURE_BUILD__", A).level, "unknown");
// dev build on either side -> unknown (no false positives before lockstep deploy machinery)
check("dev client -> unknown", J.compareBuild("dev", A).level, "unknown");
check("dev server -> unknown", J.compareBuild(A, "0x538dea9c-dev").level, "unknown");
// soft tier: SAME build stamp but different asset fingerprints -> soft (busters bumped, no commit)
check("assets differ, build same -> soft",
      J.compareBuild(A, A, "aaaa1111", "bbbb2222"), { level: "soft", reason: "assets" });
// same build + same assets -> ok
check("assets same -> ok", J.compareBuild(A, A, "aaaa1111", "aaaa1111").level, "ok");

// ---- fnv1a: canonical vectors ----------------------------------------------------------------
// FNV-1a 32-bit reference vectors (offset basis 2166136261, prime 16777619).
check("fnv1a('')", J.fnv1a(""), "811c9dc5");
check("fnv1a('a')", J.fnv1a("a"), "e40c292c");
check("fnv1a('foobar')", J.fnv1a("foobar"), "bf9cf968");

// ---- fnv1a: cross-check against an INDEPENDENT copy of the C++ server formula ------------------
// session_routes.cpp (ex-http_server.cpp, B212): uint32_t h=2166136261u; for each byte { h ^= b; h *= 16777619u; } -> %08x.
function serverFnv(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}
for (const s of ["", "a", "1.0.0-shipblock|1.1.6-cimpolish|2.1.0-wd27", "0x538dea9c-23092973d"]) {
  assert.equal(J.fnv1a(s), serverFnv(s), `fnv1a client/server mismatch for ${JSON.stringify(s)}`);
  passed++;
}

// ---- SESSION-PINNED DRIFT GATE (stalepin1, 2026-07-17) -----------------------------------------
// Live-verified hole: only GET /view substitutes __DFCAPTURE_BUILD__; a tab loaded via "/" or
// "/index.html" carries the RAW placeholder, so compareBuild() is permanently "unknown" there and
// the stale-tab banner could NEVER fire -- a redeploy under an open tab produced mystery UI
// glitches with no refresh prompt (the class of failure behind the 2026-07-17 "stockpile repaint
// button glitching" report). The pin closes it: the first REAL server stamp a page load sees pins
// the session; a later differing stamp is a hard mismatch even with no baked stamp at all.
console.log("# session-pinned drift gate (unstamped tabs still catch a mid-session redeploy)");
// pure matrix
check("pin: no real pin -> unknown", J.compareSessionPin("", "", A).level, "unknown");
check("pin: placeholder pin -> unknown", J.compareSessionPin("__DFCAPTURE_BUILD__", "", A).level, "unknown");
check("pin: same stamp -> ok", J.compareSessionPin(A, "", A).level, "ok");
check("pin: git moved -> hard/stale", J.compareSessionPin(A, "", B), { level: "hard", reason: "stale" });
check("pin: wire CRC moved -> hard/protocol",
      J.compareSessionPin("0x11111111-aaaaaaaaa", "", "0x22222222-bbbbbbbbb"),
      { level: "hard", reason: "protocol" });
check("pin: same build, assets moved -> soft",
      J.compareSessionPin(A, "aaaa1111", A, "bbbb2222"), { level: "soft", reason: "assets" });
check("pin: same build, same assets -> ok", J.compareSessionPin(A, "aaaa1111", A, "aaaa1111").level, "ok");

// stateful wiring through the public API: this harness page has NO baked stamp
// (window.DFCAPTURE_BUILD is unset), which is exactly the live unstamped-"/" shape.
assert.equal(globalThis.DFCAPTURE_BUILD, undefined, "harness precondition: no baked stamp");
check("checkVersion #1 (boot): unstamped tab, first server stamp -> no banner tier",
      J.checkVersion(A, "aaaa1111").level, "unknown");
check("checkVersion #2 (hello_ack, same deploy): still no banner tier",
      J.checkVersion(A, "aaaa1111").level, "unknown");
check("checkVersion #3 (hello_ack after a REDEPLOY): unstamped tab STILL hard-banners",
      J.checkVersion(B, "aaaa1111"), { level: "hard", reason: "stale" });
// test-the-test: the pre-fix path (compareBuild alone, no pin) is blind to that exact drift --
// proving the pin is the thing that catches it, not some other change.
check("pre-fix shape really was blind (compareBuild alone -> unknown)",
      J.compareBuild(globalThis.DFCAPTURE_BUILD || "", B, "", "aaaa1111").level, "unknown");

// ---- TEST-THE-TEST: a seeded WRONG expectation must FAIL --------------------------------------
let sawFailure = false;
try {
  assert.equal(J.compareBuild(A, A).level, "hard");   // a real match is "ok", not "hard"
} catch (_) {
  sawFailure = true;
}
assert.ok(sawFailure, "TEST-THE-TEST FAILED: a wrong expectation was accepted -- the suite is blind");
passed++;

console.log(`join_version_test: OK (${passed} assertions)`);
