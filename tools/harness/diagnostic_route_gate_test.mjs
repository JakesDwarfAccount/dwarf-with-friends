// Local-only diagnostic policy; remote authenticated friends receive an uninformative 404.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const http = readFileSync(path.join(root, "src", "http_server.cpp"), "utf8");
const gateStart = http.indexOf("bool local_diagnostic_path");
const gateEnd = http.indexOf("std::string url_decode");
const gate = http.slice(gateStart, gateEnd);

for (const route of ["/diag", "/host-state", "/zoom-probe", "/frame.jpg", "/tiledump",
  "/menu-oracle", "/statustruth", "/statusharvest", "/recorder/start", "/recorder/stop",
  "/recorder/status"])
  assert(gate.includes(`\"${route}\"`), `${route} must be classified local-diagnostic`);
assert.match(http, /local_diagnostic_path\(req\.path\) && !request_has_host_authority\(req\)/,
  "the pre-routing gate must use the shared origin authority");
assert.match(http, /res\.status = 404;[\s\S]*?not found/,
  "remote diagnostics must not advertise why they were refused");
assert(http.indexOf("local_diagnostic_path(req.path)") < http.indexOf("if (!auth::enabled())"),
  "diagnostic containment must remain active when no join password is configured");

console.log("PASS diagnostic_route_gate_test (11 host-only diagnostic endpoints, remote 404)");
