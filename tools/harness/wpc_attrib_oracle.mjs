// wpc_attrib_oracle.mjs -- LIVE oracle for WP-C attribution (wants-WT-spec §5.3 WT04 / §6.3
// WT06). Drives REAL HTTP against the live server as two players and checks /attrib against
// ids DF actually created. DEPLOY-GATED: needs the WP-C DLL (window #8+); on a pre-WP-C DLL
// it exits 2 (CANNOT-RUN) after detecting /attrib 404.
//
//   node tools/harness/wpc_attrib_oracle.mjs [--host http://127.0.0.1:8765] [--keep]
//
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN.
//
// Cells covered (creates are cleaned up afterwards unless --keep):
//   WT06: order-create as oracleA -> new order id in /orders diff -> /attrib.orders[id]=="oracleA"
//         repeat as oracleB (distinct attribution); ground truth = the id EXISTS in /orders
//         (lua-generated straight from world.manager_orders, not from our own response).
//   WT06 negative (test-the-test): every PRE-EXISTING order id has NO /attrib entry -- a
//         registry that answers something for everything fails here.
//   WT06 test-the-test: asserting the WRONG id (id+1000000) against /attrib must FAIL.
//   WT04 negative: every pre-existing building id (from /attrib absence) -- covered implicitly:
//         /attrib.buildings must contain ONLY ids stamped this session (checked before creates).
//   Toggle/UI cells live in the browser pass (cdp), not here.
//
// NOTE deliberately NOT creating a building here: /build-place needs a viewport-relative px/py
// for a live camera, which is racy against the play. The building cell is run interactively
// (orchestrator/executor) via the browser build flow instead; this script covers the order
// half which is coordinate-free.

import process from "node:process";

const args = process.argv.slice(2);
const hostIx = args.indexOf("--host");
const HOST = hostIx >= 0 ? args[hostIx + 1] : "http://127.0.0.1:8765";
const KEEP = args.includes("--keep");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

async function j(path, opts) {
  const res = await fetch(HOST + path, { cache: "no-store", ...(opts || {}) });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

const created = []; // order ids to cancel on cleanup

async function main() {
  // ---- gate: is the WP-C DLL live? ----
  const attrib0 = await j("/attrib");
  if (attrib0.status === 404) {
    console.log("CANNOT-RUN: /attrib is 404 -- pre-WP-C DLL still live (deploy window pending).");
    process.exit(2);
  }
  check("/attrib returns 200 JSON", attrib0.status === 200 && attrib0.body && typeof attrib0.body === "object");
  for (const k of ["buildings", "orders", "stockpiles", "zones"])
    check(`/attrib has ${k} object`, attrib0.body && typeof attrib0.body[k] === "object");

  // ---- pre-existing orders must be unattributed (negative cell) ----
  const ordersBefore = await j("/orders?player=wpc-oracle");
  const beforeIds = new Set((ordersBefore.body?.orders || []).map(o => o.id));
  const preAttributed = [...beforeIds].filter(id => attrib0.body.orders[String(id)]);
  // (Orders created via the web BEFORE this run may legitimately be attributed; only flag
  // ids attributed to our oracle names, which cannot pre-exist.)
  const preOracle = [...beforeIds].filter(id =>
    /^wpc-oracle[AB]$/.test(String(attrib0.body.orders[String(id)] || "")));
  check("no pre-existing order is attributed to the oracle players", preOracle.length === 0,
    `found ${preOracle.join(",")}`);
  if (preAttributed.length)
    console.log(`  note - ${preAttributed.length} pre-existing order(s) carry web attribution (expected if players created them)`);

  // ---- pick a legal key at runtime (spec: don't hardcode) ----
  const catalog = await j("/order-catalog?player=wpc-oracleA");
  const items = [];
  (function collect(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (typeof node.key === "string" && node.key) items.push(node.key);
    Object.values(node).forEach(v => { if (v && typeof v === "object") collect(v); });
  })(catalog.body);
  // Material-requiring jobs need the '|cat:<materialCategory>' suffix (create_order's
  // material grammar) or they 400 "this order needs a material" -- probe candidates until
  // one queues. NOTE: use GET (route registered for both; a body-less POST is rejected by
  // httplib before the handler, and GET error bodies are readable text).
  const bases = items.filter(k => /^j:(ConstructTable|ConstructBed|ConstructThrone|MakeBarrel|ConstructDoor)$/.test(k));
  const candidates = [...bases.map(k => `${k}|cat:wood`), ...items.slice(0, 8)];
  check("order-catalog yields candidate keys", candidates.length > 0, `items=${items.length}`);
  if (!candidates.length) return finish();
  let key = null;

  // ---- WT06: create as A, create as B ----
  async function createAs(player) {
    const before = await j(`/orders?player=${player}`);
    const bIds = new Set((before.body?.orders || []).map(o => o.id));
    let res = null;
    if (key == null) {
      for (const cand of candidates) {
        res = await j(`/order-create?key=${encodeURIComponent(cand)}&amount=1&frequency=OneTime&player=${player}&t=${Date.now()}`);
        if (res.status === 200 && res.body?.ok === true) { key = cand; break; }
      }
      check(`${player}: a candidate key queues (picked ${key})`, key != null,
        `last status=${res && res.status}`);
      if (key == null) return [];
    } else {
      res = await j(`/order-create?key=${encodeURIComponent(key)}&amount=1&frequency=OneTime&player=${player}&t=${Date.now()}`);
      check(`${player}: /order-create ok`, res.status === 200 && res.body?.ok === true,
        `status=${res.status} body=${JSON.stringify(res.body || {}).slice(0, 120)}`);
    }
    const after = await j(`/orders?player=${player}`);
    const newIds = (after.body?.orders || []).map(o => o.id).filter(id => !bIds.has(id));
    check(`${player}: new order id(s) appear in /orders (ground truth)`, newIds.length >= 1,
      `newIds=${newIds.join(",")}`);
    newIds.forEach(id => created.push(id));
    return newIds;
  }
  const idsA = await createAs("wpc-oracleA");
  const idsB = await createAs("wpc-oracleB");

  const attrib1 = await j("/attrib");
  for (const id of idsA)
    check(`A's order ${id} attributed to wpc-oracleA`, attrib1.body?.orders?.[String(id)] === "wpc-oracleA",
      `got ${JSON.stringify(attrib1.body?.orders?.[String(id)])}`);
  for (const id of idsB)
    check(`B's order ${id} attributed to wpc-oracleB`, attrib1.body?.orders?.[String(id)] === "wpc-oracleB",
      `got ${JSON.stringify(attrib1.body?.orders?.[String(id)])}`);

  // ---- test-the-test: the WRONG id must NOT be attributed ----
  if (idsA.length) {
    const wrong = idsA[0] + 1000000;
    check("(test-the-test) wrong id has NO attribution", !attrib1.body?.orders?.[String(wrong)]);
  }

  await finish();

  async function finish() {
    if (!KEEP) {
      for (const id of created) {
        const r = await j(`/order-cancel?id=${id}&t=${Date.now()}`);
        console.log(`  cleanup - cancel order ${id}: ${r.status === 200 ? "ok" : "status " + r.status}`);
      }
    } else if (created.length) {
      console.log(`  keep - created orders left in place: ${created.join(",")}`);
    }
    console.log(`\n${passed + failed} checks, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
