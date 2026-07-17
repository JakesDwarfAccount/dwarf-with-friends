// wa5_conditional_test.mjs -- WA-5 acceptance deliverable (docs/superpowers/specs/
// 2026-07-07-WA-foundation-spec.md, "session meta-table endpoints" + its If-None-Match/304
// follow-up). Unlike the other tools/harness/*.mjs suites (which replay committed fixtures
// through the web/js modules with zero server), conditional-request behavior is a property of
// the plugin's HTTP server itself, so this suite drives the LIVE server at localhost:8765 --
// run it AFTER a deploy (kill+copy DLL + the owner loads the fort), the same live-server precondition
// the python gates (gate_perf.py, gate_parity.py) already carry. It proves, per the WA-5
// pass criteria, for the static web assets (served through httplib's mount via the new
// set_file_request_handler hook) AND the cacheable def/snapshot endpoints:
//   1. a first GET returns 200 with an ETag header,
//   2. a conditional GET (If-None-Match: <that etag>) returns 304 with an empty body,
//   3. changed content yields a different ETag -- proven two ways: (a) two assets with
//      different bytes carry different ETags (the ETag is content-derived, not a fixed
//      constant), and (b) a conditional GET carrying a STALE/wrong validator returns a full
//      200 with the real current ETag (a mismatched validator never yields a 304 -- a wrong
//      304 would be far worse than a missed one).
//
// Run: node tools/harness/wa5_conditional_test.mjs   [--host http://localhost:8765]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable).

import process from "node:process";
import { requireLiveOptIn } from "./live_guard.mjs";

const argHost = (() => {
  const i = process.argv.indexOf("--host");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "http://localhost:8765";
})();
const BASE = argHost.replace(/\/+$/, "");

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
requireLiveOptIn("wa5_conditional_test.mjs", BASE);

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

async function get(path, headers) {
  const res = await fetch(`${BASE}${path}`, { headers: headers || {}, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, etag: res.headers.get("etag"), len: buf.length, body: buf };
}

// A conditional-request contract holds identically for every cacheable endpoint: first GET is
// 200 + ETag; re-GET with that ETag is a 304 with no body; a bogus validator is a full 200
// again with the real ETag (never a spurious 304).
async function assertConditional(label, path) {
  console.log(`TEST: ${label}  (${path})`);
  const first = await get(path);
  check(`${label}: first GET is 200`, first.status === 200, `got ${first.status}`);
  check(`${label}: first GET carries an ETag`, !!first.etag, `etag=${first.etag}`);
  check(`${label}: first GET body is non-empty`, first.len > 0, `len=${first.len}`);
  if (!first.etag) return null;

  const cond = await get(path, { "If-None-Match": first.etag });
  check(`${label}: conditional GET (matching If-None-Match) is 304`, cond.status === 304, `got ${cond.status}`);
  check(`${label}: 304 response has an empty body`, cond.len === 0, `len=${cond.len}`);

  const stale = await get(path, { "If-None-Match": '"deadbeefdeadbeef-stale"' });
  check(`${label}: stale/wrong If-None-Match returns a full 200 (never a spurious 304)`,
    stale.status === 200, `got ${stale.status}`);
  check(`${label}: the full 200 re-advertises the real current ETag`,
    stale.etag === first.etag, `etag=${stale.etag} vs ${first.etag}`);
  check(`${label}: the full 200 body matches the original length`, stale.len === first.len);
  return first.etag;
}

(async () => {
  // Fail fast with CANNOT-RUN (exit 2) if the server isn't up, rather than a misleading FAIL.
  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) throw new Error(`/health ${h.status}`);
  } catch (e) {
    console.log(`CANNOT RUN - server unreachable at ${BASE} (${e.message}). Deploy + load a fort first.`);
    process.exit(2);
  }

  // Static web assets, served through httplib's mount point -> the new set_file_request_handler
  // hook attaches the content-hash ETag and answers If-None-Match with a 304.
  const etagJs = await assertConditional("static JS asset", "/js/dwf-ws.js");
  const etagCss = await assertConditional("static CSS asset", "/css/dwf.css");

  // Cacheable def/snapshot endpoints (explicit routes with their own ETag handling).
  await assertConditional("sprite-map def", "/sprites/map.json");
  await assertConditional("tiletype meta def", "/tiletype_meta.json");
  await assertConditional("item_type meta def", "/item_type_meta.json");

  // Content-derived ETag: two assets with different bytes must not collide on one fixed ETag.
  console.log("TEST: distinct assets carry distinct ETags (ETag is content-derived, not constant)");
  check("JS asset and CSS asset have different ETags", !!etagJs && !!etagCss && etagJs !== etagCss,
    `js=${etagJs} css=${etagCss}`);

  console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`FAIL - unexpected error: ${e && e.stack || e}`);
  process.exit(1);
});
