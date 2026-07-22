// Deterministic inventory of literal cpp-httplib route registrations.
// `--write` refreshes route-policy.json; the default mode checks it for drift.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = path.join(root, "src");
const policyPath = path.join(root, "tools", "security", "route-policy.json");

const publicPaths = new Set(["/", "/view", "/health", "/version", "/join"]);
const hostPaths = new Set([
  "/save", "/join-password", "/pause-config", "/console-config", "/music",
]);
const diagnosticPaths = new Set([
  "/diag", "/host-state", "/zoom-probe", "/frame.jpg", "/tiledump", "/menu-oracle",
  "/statustruth", "/statusharvest", "/recorder/start", "/recorder/stop", "/recorder/status",
]);
const mutationWords = /(?:action|toggle|create|delete|remove|rename|assign|cancel|clear|dismiss|paint|repaint|place|designate|save|reset|config|run|start|stop|set|link|convict|interrogate|request-priority)/;
const noDfPrefixes = ["/join", "/health", "/version", "/chat", "/sound", "/music"];

function classify(method, route) {
  let authority = "authenticated-player";
  if (publicPaths.has(route)) authority = "public";
  if (hostPaths.has(route)) authority = "host-only";
  if (diagnosticPaths.has(route) || route.startsWith("/recorder/")) authority = "local-diagnostic";
  const effect = method !== "GET" || mutationWords.test(route) ?
    (hostPaths.has(route) ? "persistent-host-configuration" : "fortress-mutation") : "read";
  const dfMemory = !noDfPrefixes.some((prefix) => route.startsWith(prefix)) && route !== "/ws";
  return {
    authority, effect,
    requestBodyCapBytes: method === "POST" ? 4096 : null,
    outputCapBytes: authority === "local-diagnostic" ? null : 4 * 1024 * 1024,
    dfMemory,
    allowedDuringSaveLoad: !dfMemory,
    focusedTest: authority === "local-diagnostic" ? "diagnostic_route_gate_test.mjs" :
      authority === "host-only" ? "request_origin_test.mjs" : "route_policy_completeness_test.mjs",
  };
}

export function scanRoutes() {
  const routes = [];
  const registration = /\bserver\.(Get|Post|Put|Patch|Delete|Options)\(\s*"([^"]+)"/g;
  for (const owner of readdirSync(src).filter((name) => name.endsWith(".cpp")).sort()) {
    const text = readFileSync(path.join(src, owner), "utf8");
    for (const match of text.matchAll(registration)) {
      const method = match[1].toUpperCase();
      const route = match[2];
      routes.push({ method, path: route, owner, ...classify(method, route) });
    }
  }
  routes.push({ method: "GET", path: "/ws", owner: "websocket.cpp", ...classify("GET", "/ws") });
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) ||
    a.owner.localeCompare(b.owner));
  return routes;
}

const actual = scanRoutes();
const keys = actual.map((route) => `${route.method} ${route.path}`);
assert.equal(new Set(keys).size, keys.length, "duplicate method/path registrations require manual reconciliation");
const document = { schemaVersion: 1, routes: actual };
const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes("--write")) {
  writeFileSync(policyPath, serialized);
  console.log(`WROTE ${path.relative(root, policyPath)} (${actual.length} routes)`);
} else {
  const checkedIn = readFileSync(policyPath, "utf8").replace(/\r\n/g, "\n");
  assert.equal(checkedIn, serialized,
    "route-policy.json is stale; inspect registrations and run node tools/security/route_inventory.mjs --write");
  for (const route of JSON.parse(checkedIn).routes) {
    assert(["public", "authenticated-player", "host-only", "local-diagnostic"].includes(route.authority));
    assert(["read", "fortress-mutation", "persistent-host-configuration"].includes(route.effect));
    assert.equal(typeof route.owner, "string");
    assert.equal(typeof route.dfMemory, "boolean");
    assert.equal(typeof route.allowedDuringSaveLoad, "boolean");
    assert.equal(typeof route.focusedTest, "string");
  }
  console.log(`PASS route inventory completeness (${actual.length} registered routes)`);
}
