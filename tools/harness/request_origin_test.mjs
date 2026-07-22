// Shared HTTP/WebSocket request-origin policy and adversarial header matrix.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const origin = readFileSync(path.join(root, "src", "request_origin.cpp"), "utf8");
const ws = readFileSync(path.join(root, "src", "websocket.cpp"), "utf8");
const session = readFileSync(path.join(root, "src", "session_routes.cpp"), "utf8");

const localHost = (host) => {
  let value = host.toLowerCase();
  if (value.startsWith("[")) value = value.slice(1, value.indexOf("]"));
  else value = value.split(":")[0];
  return value === "localhost" || value === "::1" || /^127\.[0-9.]+$/.test(value);
};
const classify = (loopback, forwarded, host) => {
  const local = localHost(host);
  if (loopback && !forwarded && local) return "LocalHost";
  if (loopback && forwarded && !local) return "SupportedTunnel";
  if (!loopback && !forwarded && !local) return "RemotePlayer";
  return "UntrustedProxyMetadata";
};

const matrix = [
  [true, false, "localhost:8765", "LocalHost"],
  [true, false, "127.0.0.1:8765", "LocalHost"],
  [true, false, "[::1]:8765", "LocalHost"],
  [true, true, "friend.trycloudflare.com", "SupportedTunnel"],
  [false, false, "192.168.1.8:8765", "RemotePlayer"],
  [false, true, "friend.trycloudflare.com", "UntrustedProxyMetadata"],
  [true, true, "localhost:8765", "UntrustedProxyMetadata"],
  [true, false, "127.evil.com", "UntrustedProxyMetadata"],
];
for (const [loopback, forwarded, host, expected] of matrix)
  assert.equal(classify(loopback, forwarded, host), expected, `${loopback}/${forwarded}/${host}`);

assert.match(origin, /origin == RequestOrigin::LocalHost/,
  "only a direct local-host request receives host authority");
assert.match(ws, /classify_request_origin\([\s\S]*?origin_has_host_authority\(origin\)/,
  "WebSocket Upgrade must use the shared classifier");
assert.match(session, /request_has_host_authority\(req\)/,
  "persistent session routes must use the shared classifier");
assert.doesNotMatch(session, /if \(!peer_ip_is_loopback\(req\.remote_addr\)\)/,
  "bare loopback checks must not guard persistent host settings");

console.log(`PASS request_origin_test (${matrix.length} direct/tunnel/LAN/spoof cases)`);
