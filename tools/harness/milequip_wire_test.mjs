// milequip_wire_test.mjs -- PRE-DEPLOY static wire-contract check for the milequip routes.
//
// Targets the exact failure class flagged in the completeness protocol ("how ... opus [misses]
// so many wire connections"): a request param the client sends that the server never reads, or
// a response field the server emits that the client never consumes (or vice-versa). It asserts,
// by cross-reading src/squads.cpp and web/js/dwf-squads.js, that:
//   (1) every REQUEST param in the contract is BOTH read by the server route AND sent by the
//       client for that endpoint;
//   (2) every RESPONSE field in the contract is BOTH emitted by the server JSON AND consumed by
//       the client.
// It is a STRUCTURAL check (the authoritative behavioural oracle is milequip_oracle_test.mjs,
// which mutates over HTTP and reads back via lua). Rule-3 "test the test": the checker is proven
// to DISCRIMINATE against deliberately-wrong names before any PASS is trusted.
//
// Run: node tools/harness/milequip_wire_test.mjs      (no server needed). Exit 0 PASS / 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPP = fs.readFileSync(path.resolve(__dirname, "../../src/squads.cpp"), "utf8");
const JS = fs.readFileSync(path.resolve(__dirname, "../../web/js/dwf-squads.js"), "utf8");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

// --- server-side matchers ---------------------------------------------------------------------
// A request param P is "read" if squads.cpp references it in a query_int / get_param_value /
// has_param call: i.e. the quoted token "P" appears.
function serverReadsParam(p) {
  return new RegExp(`(query_int\\(req,\\s*"${p}"|get_param_value\\("${p}"\\)|has_param\\("${p}"\\))`).test(CPP);
}
// A response field F is "emitted" if squads.cpp writes a JSON key "F": into a body stream.
function serverEmitsField(f) {
  return new RegExp(`\\\\"${f}\\\\":`).test(CPP) || CPP.includes(`"\\"${f}\\":"`) ||
    new RegExp(`"${f}\\\\":"`).test(CPP) || CPP.includes(`\\"${f}\\":`);
}
// A server route path is registered.
function serverHasRoute(routePath) {
  return CPP.includes(`"${routePath}"`);
}

// --- client-side matchers ---------------------------------------------------------------------
// The client "sends" param P if the JS references it as a query key (object shorthand/explicit or
// a URL literal). We look for the bare token boundary.
function clientSendsParam(p) {
  return new RegExp(`\\b${p}\\b`).test(JS);
}
// The client "consumes" response field F if it reads .F or ["F"] or "F" as an object key.
function clientConsumesField(f) {
  return new RegExp(`\\.${f}\\b`).test(JS) || new RegExp(`\\b${f}:`).test(JS) ||
    new RegExp(`"${f}"`).test(JS) || new RegExp(`\\[\\s*${f}\\s*\\]`).test(JS);
}
function clientCallsEndpoint(routePath) {
  const bare = routePath.replace(/^\//, "");
  return JS.includes(routePath) || JS.includes(`"${bare}"`);
}

// --- the contract -----------------------------------------------------------------------------
// req/res: params/fields that MUST round-trip on BOTH sides. reqServerOnly/resServerOnly: the
// server SUPPORTS them (reads/emits) but the UI intentionally does not surface them this pass --
// specific-material (mattype/matindex) overrides and the informational itemType echo. The spec
// scopes the specific-material PICKER as a follow-up; the numeric path stays server-addressable.
const ROUTES = [
  { path: "/uniforms", req: [], res: ["uniforms", "subtypes", "materialClasses", "items", "cat",
      "subtype", "materialClass", "materialName", "color", "choice",
      "replaceClothing", "exactMatches", "value"],
    resServerOnly: ["mattype", "matindex", "itemType", "itemTypeName"] },
  { path: "/uniform-create", req: ["name", "type"], res: ["id"] },
  { path: "/uniform-rename", req: ["id", "name"], res: [] },
  { path: "/uniform-delete", req: ["id"], res: [] },
  { path: "/uniform-item-add", req: ["id", "cat", "subtype", "matclass", "color", "choice"],
    reqServerOnly: ["mattype", "matindex"], res: [] },
  { path: "/uniform-item-remove", req: ["id", "cat", "index"], res: [] },
  { path: "/uniform-flags", req: ["id", "replaceClothing", "exactMatches"], res: [] },
  { path: "/squad-ammo", req: ["squad", "action", "subtype", "amount", "matclass", "combat",
      "training", "index"], reqServerOnly: ["mattype", "matindex"], res: [] },
  // /squad detail additive ammo fields (read on the client's ammo editor):
  { path: "/squad", req: [], res: ["ammo", "ammoDefs", "ammoName", "amount", "combat", "training",
      "ammoClass", "materialName", "materialClass"], resServerOnly: ["mattype", "matindex"] },
];

console.log("TEST: milequip request/response wire contract (server <-> client)");
for (const r of ROUTES) {
  if (r.path !== "/squad") // /squad is pre-existing; only its additive fields are milequip's
    check(`route ${r.path} registered server-side`, serverHasRoute(r.path));
  if (r.req.length && r.path !== "/squad")
    check(`client calls ${r.path}`, clientCallsEndpoint(r.path));
  for (const p of r.req) {
    check(`${r.path} req '${p}': server reads it`, serverReadsParam(p), "(query_int/get_param_value/has_param)");
    check(`${r.path} req '${p}': client sends it`, clientSendsParam(p));
  }
  for (const p of (r.reqServerOnly || [])) {
    check(`${r.path} req '${p}': server accepts it (server-only, UI follow-up)`, serverReadsParam(p));
  }
  for (const f of r.res) {
    check(`${r.path} res '${f}': server emits it`, serverEmitsField(f));
    check(`${r.path} res '${f}': client consumes it`, clientConsumesField(f));
  }
  for (const f of (r.resServerOnly || [])) {
    check(`${r.path} res '${f}': server emits it (server-only, UI follow-up)`, serverEmitsField(f));
  }
}

// --- object-path check: /squad detail emits ammo + ammoDefs as TOP-LEVEL siblings of `squad`
//     (like schedule), so the client MUST read them off squadDetail, not the nested squad object.
//     (A false pass here would let the ammo editor silently render empty -- the exact bug the
//     first review of this pass caught.)
// (B60 restructure: the ammo editor became the pure builder sqAmmoSection(detail, catalog),
// where `detail` IS the top-level /squad payload passed in from buildSquadPanel(model.squadDetail)
// -> sqEquipView(detail,...). The contract is unchanged -- ammo/ammoDefs are read off the
// top-level detail object, never the nested squad -- only the local param name (squadDetail
// -> detail) changed. These assertions track that.)
console.log("TEST: top-level detail fields read off the detail payload (not squad.*)");
check("ammo editor reads detail.ammo (top-level)", /\bdetail\.ammo\b/.test(JS));
check("ammo editor reads detail.ammoDefs (top-level)", /\bdetail\.ammoDefs\b/.test(JS));
check("equip view passes the top-level detail into sqAmmoSection", /sqAmmoSection\(detail\b/.test(JS));
check("buildSquadPanel feeds model.squadDetail (top-level) into the equip view", /squadDetail\s*=\s*model\.squadDetail|model\.squadDetail/.test(JS));
check("client does NOT read squad.ammo (would be undefined)", /\bsquad\.ammo\b/.test(JS) === false);

// --- rule 3: prove the checker DISCRIMINATES (would catch a real wire break) -------------------
console.log("TEST: test-the-test (checker must reject deliberately-wrong names)");
check("seeded-bad: server does NOT read a bogus param", serverReadsParam("frobnicate_xyz") === false);
check("seeded-bad: server does NOT emit a bogus field", serverEmitsField("frobnicate_xyz") === false);
check("seeded-bad: client does NOT consume a bogus field", clientConsumesField("frobnicate_xyz") === false);
// And a real name IS found (positive control), so the matchers aren't just always-false.
check("positive control: server reads 'subtype'", serverReadsParam("subtype") === true);
check("positive control: client consumes 'ammoDefs'", clientConsumesField("ammoDefs") === true);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
