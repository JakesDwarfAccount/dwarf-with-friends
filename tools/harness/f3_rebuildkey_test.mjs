// f3_rebuildkey_test.mjs -- F3 (perf audit §2/F3, docs/superpowers/specs/2026-07-08-perf-
// audit.md) BOTH-DIRECTIONS regression, mandated by the audit + the completeness protocol.
//
// F3 fixes the post-B29 over-correction: the GL scene rebuild key was keyed on `latest` OBJECT
// IDENTITY (a monotonic seq bumped on every fresh `latest`), but refreshFromCacheIfNeeded() mints
// a fresh `latest` on every canvas2d draw (~30/s, unit/AUX-driven), so buildScene ran ~30x/s on a
// busy fort even when only units moved. The fix keys on the cache's real window CONTENT VERSION.
//
// This asserts BOTH directions at BOTH layers of the fix, so neither the B29 bug (never rebuilds)
// nor the F3 bug (always rebuilds) can regress:
//   Part A -- dwf-cache.js windowView().version (the data source):
//     * INVARIANT across a no-ingest re-read           (unit/AUX churn -> NO rebuild)
//     * ADVANCES after a real block re-ingest           (designation/dig -> rebuild, B29 covered)
//     * window-scoped (0 over a window with no blocks)  (off-window churn ignored)
//   Part B -- dwf-render.js dataKeyComponent() (the GL rebuild key's data component):
//     * two distinct `latest` objects, SAME contentVersion -> IDENTICAL key  (unit churn, no rebuild)
//     * a bumped contentVersion                          -> DIFFERENT key    (designation, rebuild)
//     * no contentVersion -> identity-seq fallback still updates             (poll/legacy path)
//   + SEEDED-BAD rows proving the fix is not the old behavior renamed.
//
// Run: node tools/harness/f3_rebuildkey_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rel = (p) => path.resolve(__dirname, p);

let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ---- shared browser-shaped globals (fallback/sync cache mode: NO Worker global) ------------
globalThis.window = globalThis;
globalThis.document = {
  getElementsByTagName: () => [],
  createElement: () => ({ style: {}, addEventListener() {}, getContext: () => null }),
  body: { appendChild() {} },
};
globalThis.location = { search: "" };
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } };
globalThis.requestAnimationFrame = () => 0;

// ===========================================================================================
console.log("PART A -- dwf-cache.js windowView().version (F3 data source)");
// ===========================================================================================
vm.runInThisContext(fs.readFileSync(rel("../../web/js/dwf-cache-worker.js"), "utf8"),
  { filename: "dwf-cache-worker.js" });
vm.runInThisContext(fs.readFileSync(rel("../../web/js/dwf-cache.js"), "utf8"),
  { filename: "dwf-cache.js" });
const C = globalThis.DwfCache;
check("cache stack loaded in sync fallback mode", !!C && C._backend && C._backend() === "sync");

C._resetForTest();
C._setBudgetForTest(128 * 1024 * 1024);

// A void-free single real tile at world (32,48,z=50) -> chunk key (2*4096+3).
const baseTile = { x: 32, y: 48, tt: 2, base_mt: 1, base_mi: 1, flow: 0, liquid: "none", hidden: 0, outside: 0 };
C.ingest({ origin: { x: 32, y: 48, z: 50 }, width: 1, height: 1, z: 50, tiles: [baseTile] });

const v1 = C.windowView(32, 48, 50, 4, 4).version;
check("windowView() returns a numeric, non-zero content version for a window over an ingested block",
  typeof v1 === "number" && v1 > 0);

// unit/AUX churn: a fresh windowView with NO new ingest (units are never ingested into this
// tiles-only cache) must report the SAME version -> the GL key does not change -> NO rebuild.
const v1b = C.windowView(32, 48, 50, 4, 4).version;
check("A/unit-churn: version is STABLE across a no-ingest re-read (unit/AUX churn -> no GL rebuild)",
  v1b === v1);

// designation/dig: re-ingesting the block (legacy ingest bumps chunk.ver = ++globalVer, v1 sets
// it to the newer world_seq) must ADVANCE the version -> rebuild. This is exactly the B29 case
// (a fresh designation reaching a camera-still client) -- kept covered from the data side.
C.ingest({ origin: { x: 32, y: 48, z: 50 }, width: 1, height: 1, z: 50,
  tiles: [{ ...baseTile, desig: { dig: "Default", smooth: 0, traffic: 0, track: 0, marker: 0 } }] });
const v2 = C.windowView(32, 48, 50, 4, 4).version;
check("A/designation: version ADVANCES after a real block re-ingest (a dig -> rebuild; B29 covered)",
  v2 > v1);

// window-scoped: a window intersecting NO ingested block reports 0 -- off-window block churn
// (F2's whole-viewport-any-block problem) does NOT force a rebuild here.
const vEmpty = C.windowView(1000, 1000, 50, 4, 4).version;
check("A/window-scoped: version is 0 over a window with no ingested block (off-window churn ignored)",
  vEmpty === 0);

// SEEDED-BAD: if windowMaxVer wrongly returned a global counter (F2 behavior) instead of a
// window-scoped max, vEmpty would equal v2. Assert it does NOT.
check("A/seeded-bad: an empty-window version must NOT equal the busy-window version (window-scoped, not global)",
  vEmpty !== v2);

// ===========================================================================================
console.log("PART B -- dwf-render.js dataKeyComponent() (F3 GL rebuild key)");
// ===========================================================================================
vm.runInThisContext(fs.readFileSync(rel("../../web/js/dwf-render.js"), "utf8"),
  { filename: "dwf-render.js" });
const R = globalThis.DwfRender;
const dk = R && R._dataKeyComponentForTest;
check("dwf-render.js exposes the _dataKeyComponentForTest hook", typeof dk === "function");

// unit-only churn: two DISTINCT `latest` objects (fresh each draw) with the SAME contentVersion,
// and DIFFERENT fallback seqs (the identity churned). The key component must be IDENTICAL ->
// same rebuild key -> NO buildScene.
const kA = dk({ contentVersion: 100 }, 5);
const kB = dk({ contentVersion: 100 }, 9);
check("B/unit-churn: same contentVersion -> IDENTICAL key component despite new identity/seq (NO rebuild)",
  kA === kB);

// designation: a real terrain change bumps contentVersion -> different component -> rebuild.
const kC = dk({ contentVersion: 101 }, 5);
check("B/designation: a bumped contentVersion -> DIFFERENT key component (rebuild; B29 covered)",
  kC !== kA);

// poll/legacy fallback: no contentVersion -> the identity seq still distinguishes frames so that
// path (which mints `latest` ~2/s and carries no version) keeps updating.
check("B/fallback: without contentVersion, the identity seq still distinguishes frames (poll path updates)",
  dk({}, 5) !== dk({}, 6));

// SEEDED-BAD: prove the fix is NOT the pre-F3 identity behavior renamed. The old approach keyed on
// the seq unconditionally, so the two unit-churn frames (seq 5 vs 9) would get DIFFERENT keys (the
// bug -> spurious rebuild). Our contentVersion path collapses them to one.
const oldIdentityKey = (seq) => "s" + seq;
check("B/seeded-bad: the OLD identity-seq key WOULD have rebuilt on unit churn (s5 != s9); the fix does not (kA == kB)",
  oldIdentityKey(5) !== oldIdentityKey(9) && kA === kB);

console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
