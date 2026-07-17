// v1_twoclient_stale_audit.mjs -- offline structural audit backing the two-client / stale-state
// qualification wave (docs/superpowers/analysis/v1-qualification/two-client-runbook.md).
//
// This proves OFFLINE the two structural facts the live two-client wave rests on, and inventories
// the known HOLDS-STALE code paths so the final integrator sees them without re-deriving them:
//
//   PART A -- STALE-SCRIPT / RECONNECT GATE (hard invariants, must hold):
//     A reconnect or page-refresh can NEVER run an old script against a new server undetected.
//     * the build stamp embeds the wire CRC (protocol id), so any protocol change -> hard banner;
//     * GET /view / GET /version send no-store, and the static bundle is no-cache + ETag/304,
//       so a redeploy is never masked by an HTTP cache;
//     * the client re-checks the server build on EVERY WS hello_ack (i.e. on every reconnect),
//       not just at boot;
//     * a hard mismatch drives location.reload() -- a real refresh, re-fetching index.html.
//
//   PART B -- PANEL CACHE DISCIPLINE (hard invariant): every family panel-detail fetch is
//     `cache:"no-store"`, so the client's staleness is purely "did not re-poll" (by design,
//     documented) and never a browser-HTTP-cache artifact that a reload wouldn't clear.
//
//   PART C -- SELF-CORRECTING LOOPS (hard invariant): the panels we CLAIM self-correct actually
//     carry their live poll (unit sheet 3s /unit; Justice 2s). If a refactor drops the poll, this
//     fails so the runbook's "self-correcting" rows don't silently become stale-holders.
//
//   PART D -- KNOWN HOLDS-STALE INVENTORY (report-only, never fails the build): the three
//     two-client v1-blocker code signatures + the one optimistic-success outlier. Printed as a
//     table with file:line so the integrator can confirm the live runbook's expected FAIL cases.
//     If a signature VANISHES (a fix landed), the row prints "SIGNATURE GONE -- re-audit": the
//     audit does not assert the bug's continued existence, it just tracks it.
//
// Run: node tools/harness/v1_twoclient_stale_audit.mjs [--selftest]
// Exit 0 iff every hard invariant (A/B/C) holds. Part D is informational.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const R = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ` -- ${detail}` : ""}`);
  passed++;
}
// line number of the first match of `re` in `src` (1-based), or 0.
function lineOf(src, re) {
  const m = re.exec(src);
  if (!m) return 0;
  return src.slice(0, m.index).split("\n").length;
}

function runInvariants(files, label) {
  const t = (n, c, d) => check(`${label}: ${n}`, c, d);
  const { ws, join, authCpp, httpCpp, unit, fortAdmin, css } = files;

  // ---- PART A: stale-script / reconnect gate --------------------------------------------------
  // A1: build stamp = wire CRC + git. The CRC is the protocol fingerprint; a wire change bumps it.
  t("A1 build_stamp embeds the wire CRC (kSelftestFixtureCrc)",
    /std::string build_stamp\(\)[\s\S]{0,300}kSelftestFixtureCrc/.test(authCpp),
    "build stamp must carry the protocol CRC so a wire change forces a hard mismatch");
  // A2: /version carries build + assets, no-store.
  t("A2 /version version_json carries build+assets",
    /version_json[\s\S]{0,400}"build"[\s\S]{0,200}"assets"/.test(authCpp) ||
    /\\"build\\":[\s\S]{0,400}assets/.test(authCpp),
    "version_json must expose build and assets to the client gate");
  // A3: client re-checks build on EVERY WS hello_ack (reconnect), not just boot.
  t("A3 hello_ack re-runs DwfJoin.checkVersion on reconnect",
    /hello_ack[\s\S]{0,600}DwfJoin\.checkVersion|msg\.build[\s\S]{0,120}DwfJoin\.checkVersion/.test(ws),
    "a reconnect must re-verify the server build, or an old tab silently rides a redeploy");
  // A4: compareBuild returns a HARD tier on a differing stamp (protocol or stale).
  t("A4 compareBuild yields a hard tier on protocol/stale mismatch",
    /function compareBuild[\s\S]{0,600}level:\s*"hard"/.test(join),
    "a differing build must be a hard (blocking) mismatch, not silent");
  // A5: a hard mismatch actually reloads the tab (re-fetches index.html).
  t("A5 hard banner drives location.reload()",
    /location\.reload/.test(join),
    "the refresh action must reload so the stale bundle is replaced");
  // A6: server never lets the browser cache /view (index.html) or /version.
  t("A6 /view sends no-store (index.html never browser-cached)",
    /server\.Get\("\/view"[\s\S]{0,900}?no-store/.test(files.sessionCpp),
    "index.html must be no-store so a redeploy is seen");
  t("A6b /version sends no-store",
    /server\.Get\("\/version"[\s\S]{0,400}?no-store/.test(files.sessionCpp),
    "the stale-tab probe response must not be cached");
  // A7: the static bundle is no-cache + ETag/304 (revalidated every load, never blindly reused).
  t("A7 static file bundle is no-cache + ETag (revalidate-always)",
    /set_file_request_handler[\s\S]{0,300}no-cache[\s\S]{0,120}ETag|set_file_request_handler[\s\S]{0,300}ETag[\s\S]{0,120}no-cache/.test(httpCpp),
    "served JS/CSS must revalidate so a byte change is never skipped");

  // ---- PART B: panel cache discipline ---------------------------------------------------------
  // Every family detail file must never issue a family fetch WITHOUT no-store. We check that each
  // file's fetch() count equals its no-store/no-cache count (the shared discipline the code uses).
  for (const [name, src] of Object.entries(files.panelBundle)) {
    const fetches = (src.match(/fetch\(/g) || []).length;
    const nostore = (src.match(/no-store|no-cache/g) || []).length;
    if (fetches === 0) continue;
    t(`B ${name}: no bare (cacheable) fetch (${fetches} fetch / ${nostore} no-store)`,
      nostore >= fetches,
      "a family fetch without no-store could serve browser-cached stale JSON");
  }

  // ---- PART C: self-correcting loops still present --------------------------------------------
  t("C1 unit sheet keeps its 3s /unit self-correct poll",
    /UNIT_SHEET_REFRESH_MS\s*=\s*3000/.test(unit) && /setInterval/.test(unit),
    "the unit sheet's two-client self-correction is this poll");
  t("C2 Justice tab keeps its 2s self-correct poll",
    /justicePollTimer\s*=\s*setInterval/.test(fortAdmin) && /2000/.test(fortAdmin),
    "the Justice tab's two-client self-correction is this poll");
}

// The known HOLDS-STALE two-client signatures. Report-only: presence => the runbook's expected
// live FAIL case is still real; absence => a fix may have landed, re-audit.
const HOLDS_STALE = [
  { id: "S1-item-sheet", file: "web/js/dwf-build-info-panels.js",
    // The item sheet has NO poll -> holds stale while open; on a failed action the non-ok is
    // swallowed with no honest "gone" surfaced. Signature: an item-sheet file with zero setInterval.
    re: /setInterval/,
    absentMeansStale: true,
    note: "Item/Stocks sheet: no poll while open; failed action swallowed silently (no honest unavailable)." },
  { id: "S2-stockpile-spe", file: "web/js/dwf-building-zone-stockpile-panels.js",
    re: /if \(updated && it\)/,
    absentMeansStale: false,
    note: "Stockpile settings editor: optimistic cache mutation; deleted-pile POST silently no-ops (guard `if (updated && it)`)." },
  { id: "S3-zone-repaint", file: "web/js/dwf-controls-placement.js",
    re: /function ensureZoneRepaintDraft/,
    absentMeansStale: false,
    note: "Zone exact-shape repaint: baseline frozen at first stroke, sent mode=replace -> clobbers a concurrent edit (last-writer-wins), claims success." },
  { id: "S4-standing-orders", file: "web/js/dwf-labor-work-orders.js",
    re: /renderStandingOrdersPanel\(\);\s*\n\s*\}\s*catch \(_\) \{\}/,
    absentMeansStale: false,
    note: "Standing-orders toggle: optimistic local update, empty catch, no r.ok check (GLOBAL fort flags, not a scratch entity -- truthfulness gap, not a two-client entity blocker)." },
];

function reportInventory() {
  console.log("\n--- KNOWN HOLDS-STALE INVENTORY (report-only; live runbook must observe these) ---");
  for (const s of HOLDS_STALE) {
    let src = "";
    try { src = R(...s.file.split("/")); } catch { console.log(`  ${s.id}: FILE MISSING (${s.file}) -- re-audit`); continue; }
    const present = s.re.test(s.re.global ? src : src); s.re.lastIndex = 0;
    const ln = present ? lineOf(src, s.re) : 0;
    const stillStale = s.absentMeansStale ? !present : present;
    const tag = stillStale ? "HOLDS-STALE (blocker signature present)" : "SIGNATURE GONE -- re-audit (fix may have landed)";
    console.log(`  ${s.id.padEnd(20)} ${s.file}${ln ? ":" + ln : ""}\n      ${tag}\n      ${s.note}`);
  }
  console.log("  (Unit sheet + Justice tab are SELF-CORRECTING; all squad/workorder/zone/stockpile-parent panels are HONEST-UNAVAILABLE-ON-ACTION.)");
}

// ---- load the real files --------------------------------------------------------------------
function loadFiles() {
  const panelBundle = {
    "dwf-squads.js": R("web/js/dwf-squads.js"),
    "dwf-fort-admin.js": R("web/js/dwf-fort-admin.js"),
    "dwf-labor-work-orders.js": R("web/js/dwf-labor-work-orders.js"),
    "dwf-building-zone-stockpile-panels.js": R("web/js/dwf-building-zone-stockpile-panels.js"),
    "dwf-build-info-panels.js": R("web/js/dwf-build-info-panels.js"),
    "dwf-controls-placement.js": R("web/js/dwf-controls-placement.js"),
  };
  return {
    ws: R("web/js/dwf-ws.js"),
    join: R("web/js/dwf-join.js"),
    authCpp: R("src/auth.cpp"),
    httpCpp: R("src/http_server.cpp"),
    sessionCpp: R("src/session_routes.cpp"),
    unit: R("web/js/dwf-unit-hud-notifications.js"),
    fortAdmin: R("web/js/dwf-fort-admin.js"),
    panelBundle,
  };
}

const files = loadFiles();

if (process.argv.includes("--selftest")) {
  // Each seeded-bad must make runInvariants THROW; a selftest that passes on bad input is the bug.
  let failures = 0;
  const mustFail = (name, mutate) => {
    const bad = structuredCloneFiles(files);
    mutate(bad);
    try { runInvariants(bad, `selftest:${name}`); console.error(`SELFTEST FAIL: "${name}" not caught`); failures++; }
    catch { passed++; console.log(`selftest ok: seeded-bad "${name}" correctly caught`); }
  };
  mustFail("hello_ack drops reconnect version re-check",
    b => { b.ws = b.ws.replace(/DwfJoin\.checkVersion/g, "DwfJoin.noop"); });
  mustFail("build stamp drops the wire CRC",
    b => { b.authCpp = b.authCpp.replace(/kSelftestFixtureCrc/g, "0"); });
  mustFail("hard banner no longer reloads",
    b => { b.join = b.join.replace(/location\.reload/g, "noReload"); });
  mustFail("a panel fetch loses no-store",
    b => { b.panelBundle["dwf-squads.js"] = 'x(); fetch("/squads"); fetch("/squad");'; });
  mustFail("unit self-correct poll removed",
    b => { b.unit = b.unit.replace(/UNIT_SHEET_REFRESH_MS\s*=\s*3000/, "UNIT_SHEET_REFRESH_MS = 0"); });

  if (failures) process.exit(1);
  console.log(`\nv1_twoclient_stale_audit --selftest PASS (${passed} checks)`);
  process.exit(0);
}

function structuredCloneFiles(f) {
  return { ...f, panelBundle: { ...f.panelBundle } };
}

runInvariants(files, "live");
console.log(`v1_twoclient_stale_audit PASS (${passed} hard invariants) -- stale-script gate + panel cache discipline + self-correct polls verified offline`);
reportInventory();
