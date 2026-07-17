// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

// zone_repaint_status_test.mjs -- END-TO-END guard for s5's zone-panel status sink follow-up:
// a /zone-repaint REFUSAL must REACH the reopened zone panel (openZonePanel opts.status), never a
// silent reopen that looks like a successful no-op.
//
//   node tools/harness/zone_repaint_status_test.mjs
//
// This does NOT regex the source and hope. It EXTRACTS the actual shipped commitZoneRepaintDraft body out
// of web/js/dwf-controls-placement.js and EXECUTES it inside a sandbox whose fetch/openZonePanel are
// mocks, so the assertions ride the real control flow (the same body the browser runs). A refactor
// that reintroduces the pre-s5 silent catch -- or drops opts.status on a refusal -- fails here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(here, "../../web/js/dwf-controls-placement.js"), "utf8");

// Pull the function verbatim (from its signature to the module-level `\n  }` that closes it -- inner
// braces are all more deeply indented, so the 2-space close is unambiguous).
const fnMatch = /async function commitZoneRepaintDraft\(id, draft\) \{[\s\S]*?\n  \}\n/.exec(src);
let passed = 0, failed = 0;
function check(value, name) {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

console.log("# s5 follow-up: a /zone-repaint refusal reaches the zone-panel status sink (end-to-end)");
check(!!fnMatch, "commitZoneRepaintDraft is extractable from the shipped source");

// Build a runnable copy of the real body with every free identifier it references injected as a
// parameter. Reassigning the `zoneRepaintId` parameter inside is legal (the body sets it to null).
function makeRun(deps) {
  const names = ["player", "openZonePanel", "disarmZoneRepaint", "loadZones", "fetch",
    "zoneRepaintFinalShape", "setZoneStatus", "AbortController", "setTimeout", "clearTimeout"];
  const factory = new Function(...names, `${fnMatch[0]}\n return commitZoneRepaintDraft;`);
  return factory(...names.map(n => deps[n]));
}

// A mock fetch whose response the scenario dictates. text() returns exactly what the server writes.
function fetchReturning({ ok, status, body }) {
  return async () => ({ ok, status, text: async () => body });
}
function baseDeps(overrides) {
  const calls = [];
  const deps = {
    player: "p1",
    openZonePanel: (id, opts) => { calls.push({ id, opts }); },
    disarmZoneRepaint: () => {},
    loadZones: () => {},
    zoneRepaintFinalShape: () => ({ x1: 10, y1: 20, x2: 12, y2: 22, z: 100,
      extents: "111101111" }),
    setZoneStatus: () => {},
    fetch: fetchReturning({ ok: true, status: 200, body: '{"ok":true,"id":7}\n' }),
    AbortController, setTimeout, clearTimeout,
    ...overrides,
  };
  return { deps, calls };
}
const draft = { zone: {}, changes: new Map([["11,21", false]]) };

// ---- Scenario 1: a 409 refusal (the canonical "cannot erase an entire zone", the exact body
// src/building_zone.cpp:2401 writes) must reopen the panel WITH an error status carrying the reason.
{
  const body = "zone-repaint refused: repaint cannot erase an entire zone; zone left unchanged\n";
  const { deps, calls } = baseDeps({ fetch: fetchReturning({ ok: false, status: 409, body }) });
  await makeRun(deps)(7, draft);
  check(calls.length === 1, "refusal still reopens the zone panel exactly once");
  const st = calls[0]?.opts?.status;
  check(!!st && st.isError === true, "the reopen carries an ERROR status (isError:true) -- not a silent no-op");
  check(!!st && /cannot erase an entire zone/.test(st.text),
    "the server's own reason reaches the sink, stripped of the 'zone-repaint refused:' wire prefix");
  check(!!st && !/^zone-repaint (?:failed|refused):/i.test(st.text),
    "the wire prefix is not shown to the player");
  check(calls[0]?.id === 7, "the panel reopens on the same zone id that was armed");
}

// ---- Scenario 2: success (200 + {"ok":true,"id":N}) keeps the OLD behavior -- reopen with NO status.
{
  const { deps, calls } = baseDeps({ fetch: fetchReturning({ ok: true, status: 200, body: '{"ok":true,"id":9}\n' }) });
  await makeRun(deps)(7, draft);
  check(calls.length === 1 && calls[0].id === 9 && !calls[0].opts,
    "a successful extend reopens on the server-returned id with NO status (success path unchanged)");
}

// ---- Scenario 3: no response at all (fetch rejects -- the old-DLL / aborted shape) must STILL reopen
// with an error status, never the pre-s5 bare `catch (_) {}` that swallowed the outcome silently.
{
  const { deps, calls } = baseDeps({ fetch: async () => { throw new Error("no response"); } });
  await makeRun(deps)(7, draft);
  check(calls.length === 1 && calls[0]?.opts?.status?.isError === true,
    "a route that never answers reopens with an error status (no silent catch)");
  check(/did not respond|older than this client/i.test(calls[0]?.opts?.status?.text || ""),
    "the no-response status names the old-DLL degradation honestly");
}

// test-the-test: prove the guard would CATCH a regression to the pre-s5 silent reopen (drop opts on
// a refusal). If this seeded-bad body passed the scenario-1 assertions, the guard would be worthless.
{
  const silentBody = fnMatch[0].replace(
    /reopen\(id, \{ text: reason[^;]*isError: true \}\);/,
    "reopen(id);"); // seeded regression: refusal reopens with NO status
  const names = ["player", "openZonePanel", "disarmZoneRepaint", "loadZones", "fetch",
    "zoneRepaintFinalShape", "setZoneStatus", "AbortController", "setTimeout", "clearTimeout"];
  const calls = [];
  const badFn = new Function(...names, `${silentBody}\n return commitZoneRepaintDraft;`)(
    "p1", (id, opts) => calls.push({ id, opts }), () => {}, () => {},
    fetchReturning({ ok: false, status: 409, body: "zone-repaint refused: x\n" }),
    () => ({ x1: 10, y1: 20, x2: 12, y2: 22, z: 100, extents: "111101111" }), () => {},
    AbortController, setTimeout, clearTimeout);
  await badFn(7, draft);
  check(calls.length === 1 && !calls[0].opts,
    "(test-the-test) the seeded silent-reopen regression really does drop the status (guard is live)");
}

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
