// console_route_gate_test.mjs -- WT26 SECURITY MODEL, asserted at the source level (offline).
//
// The live server behavior (401 for unauthed, 403 for a blocked command, 200 for an authed player's
// allowed command from a NON-loopback peer) is DLL-gated -- it needs a built plugin + a running DF.
// This suite pins the STRUCTURAL invariants that make that behavior true, so a regression that would
// quietly re-introduce a host gate, drop the blocklist, or move the route below the catch-all fails
// here in CI without a DF build:
//
//   1. AUTH, NOT LOOPBACK: console_routes.cpp must NOT call peer_ip_is_loopback anywhere -- the
//      console is for any authed player (decision). (Counterexample: /join-password DOES gate on
//      host authority; session_routes.cpp is checked to still do so, proving the test can tell the
//      two apart.)
//   2. THE BLOCKLIST GATES EXECUTION: the run handler calls console::command_denied BEFORE the
//      bridge, and the bridge (lua_bridge.cpp) ALSO calls it -- two enforcement sites, one table.
//   3. THE GATE HAS NO CALLER IDENTITY: command_denied takes only the command string (no host/
//      loopback/bool parameter), so a rule cannot be written that the host escapes or a friend
//      bypasses.
//   4. WIRING + NON-PUBLIC: register_console_routes is called in register_routes ABOVE the POST ".*"
//      catch-all, and neither /console path is a static-asset extension (so the auth pre-routing gate
//      covers them -- an unauthed caller never reaches the handler).
//   5. TEST-THE-TEST: a seeded source string with a loopback gate in the console handler is proven
//      to trip rule 1.
//
//   node tools/harness/console_route_gate_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const routes = read("src", "console_routes.cpp");
const policy = read("src", "console_policy.h");
const bridge = read("src", "lua_bridge.cpp");
const httpsrv = read("src", "http_server.cpp");
const session = read("src", "session_routes.cpp");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

// Strip // line comments and /* */ block comments so a rule keys on CODE, not prose (the file
// deliberately DISCUSSES loopback in comments; that must not trip rule 1).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const routesCode = stripComments(routes);
const bridgeCode = stripComments(bridge);
const joinPasswordRoute = stripComments(session).slice(
  stripComments(session).indexOf("auto join_password_handler"),
  stripComments(session).indexOf('server.Post("/join-password"'),
);

// ---- 1. AUTH, NOT LOOPBACK ----------------------------------------------------------------------
console.log("\n# 1. any authed player -- NO host/loopback gate in the console routes");
check("console_routes.cpp does NOT call peer_ip_is_loopback (no host gate)",
  !/peer_ip_is_loopback/.test(routesCode));
check("console_routes.cpp does NOT return \"host only\"",
  !/host only/.test(routesCode));
// The discriminator: /join-password legitimately IS host-only. If this flips, the test lost its teeth.
check("(discriminator) the /join-password route still contains a host-authority gate",
  /request_has_host_authority/.test(joinPasswordRoute));

// ---- 2. THE BLOCKLIST GATES EXECUTION -----------------------------------------------------------
console.log("\n# 2. the blocklist is enforced before execution, at two sites, one table");
{
  // In the run handler, the command_denied call must appear BEFORE the console_run_via_lua call.
  const denyAt = routesCode.indexOf("command_denied");
  const runAt = routesCode.indexOf("console_run_via_lua");
  check("run handler calls console::command_denied", denyAt >= 0);
  check("run handler calls the exec bridge console_run_via_lua", runAt >= 0);
  check("...and the deny check is BEFORE the exec call (gate lands WITH the exec path)",
    denyAt >= 0 && runAt >= 0 && denyAt < runAt);
  check("a denied command returns HTTP 403", /res\.status\s*=\s*403/.test(routesCode));
}
{
  // The bridge backstop: console_run_via_lua ALSO calls command_denied before run_lua_locked.
  const fn = bridgeCode.slice(bridgeCode.indexOf("console_run_via_lua"));
  const denyAt = fn.indexOf("command_denied");
  const execAt = fn.indexOf("run_lua_locked");
  check("bridge console_run_via_lua calls command_denied as a backstop", denyAt >= 0);
  check("...before it ever reaches run_lua_locked / the command", denyAt >= 0 && execAt >= 0 && denyAt < execAt);
}

// ---- 3. THE GATE HAS NO CALLER IDENTITY ---------------------------------------------------------
console.log("\n# 3. command_denied binds host and friend identically (no caller parameter)");
{
  const m = policy.match(/Denial\s+command_denied\s*\(([^)]*)\)/);
  check("command_denied signature found", !!m);
  const params = (m ? m[1] : "").replace(/\s+/g, " ").trim();
  check("its ONLY parameter is the command string (no host/loopback/bool)",
    /^const\s+std::string\s*&\s*\w+$/.test(params), `params were: "${params}"`);
  check("no 'loopback' or 'is_host' token anywhere in console_policy.h",
    !/loopback|is_host/i.test(stripComments(policy)));
}

// ---- 4. WIRING + NON-PUBLIC ---------------------------------------------------------------------
console.log("\n# 4. wired above the POST catch-all; not a public static path");
{
  const httpCode = stripComments(httpsrv);
  check("register_console_routes is called in register_routes",
    /register_console_routes\s*\(\s*server\s*\)/.test(httpCode));
  const regAt = httpCode.indexOf("register_console_routes(server)");
  // The catch-all is the LAST server.Post(\".*\"...) in the file; the console registration must
  // precede it. (register_routes is where all register_* calls live; the stream handler + catch-all
  // come after.)
  const catchAt = httpCode.search(/server\.Post\(\s*"\.\*"/);
  check("...ABOVE the POST \".*\" catch-all", regAt >= 0 && catchAt >= 0 && regAt < catchAt,
    `regAt=${regAt} catchAt=${catchAt}`);
  // Non-public: no static-asset extension. The pre-routing auth gate (join_public_path) only exempts
  // static extensions + a fixed allowlist; /console/commands and /console/run have neither.
  check("route paths carry no static-asset extension (so the auth gate covers them)",
    /\/console\/commands/.test(routesCode) && /\/console\/run/.test(routesCode) &&
    !/\/console\/\w+\.(?:js|css|json|png|html|svg)/.test(routesCode));
}

// ---- 5. TEST-THE-TEST ---------------------------------------------------------------------------
console.log("\n# 5. test-the-test: a seeded host gate in the console handler trips rule 1");
{
  const seededBad = routes + "\n// seeded: if (!peer_ip_is_loopback(req.remote_addr)) { res.status = 403; }\n";
  // rule 1 strips comments, so the seed must be in CODE to trip it -- emulate a real regression:
  const seededCode = stripComments(routes) + "\nif (!peer_ip_is_loopback(req.remote_addr)) { }\n";
  guard("a loopback gate added to the console handler would FAIL rule 1",
    /peer_ip_is_loopback/.test(seededCode) === true);
  void seededBad;
}

console.log("\n----------------------------------------");
console.log(`console_route_gate_test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
