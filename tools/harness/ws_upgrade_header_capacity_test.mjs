// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// WS UPGRADE HEADER CAPACITY. OFFLINE: no DF, no server, no browser.
//
// ROOT CAUSE PIN (2026-07-16). Joining via http://localhost:8765/view rendered units/buildings in
// a black void with no terrain, while http://127.0.0.1:8765/view and the cloudflare tunnel URL
// rendered fine. Live diagnosis:
//   * The client WS never connected on the localhost origin (socketOpens kept climbing; isConnected
//     false) and fell back to the legacy /mapdata HTTP poll, which paints units/buildings but NOT
//     the terrain layer.
//   * The ONLY difference between the origins was the request header size. Cookies are HOST-scoped,
//     not port-scoped, so a ~2.5 KB Supabase "sb-<ref>-auth-token" cookie set by ANOTHER dev app on
//     the shared "localhost" hostname rode along on the /ws handshake (localhost cookie header 2564
//     bytes vs 14 on 127.0.0.1). Causally reproduced: adding a 2.4 KB dummy cookie to the KNOWN-GOOD
//     127.0.0.1 origin made its WS handshake fail identically; removing it restored it.
//   * websocket.cpp's Upgrade classifier (process_and_close_socket) MSG_PEEKs the request head into
//     a fixed buffer and only recognizes a WebSocket once it sees the "\r\n\r\n" terminator inside
//     that buffer. The buffer was 2048 bytes, so a header block larger than ~2 KiB was misclassified
//     as non-WS -> 404 on /ws -> browser aborts (1006) -> silent drop to slow, terrain-less polling.
//
// This pins the fix: WS classification must be independent of how big the browser's (origin-varying)
// cookie jar is. The peek buffer must hold a realistic worst-case header block, and the classifier
// must still key off the full "\r\n\r\n" header terminator.
//
//   node tools/harness/ws_upgrade_header_capacity_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const ws = read("src/websocket.cpp");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// The Upgrade-classifier peek buffer: `std::array<char, <SIZE>> peek{};`. <SIZE> may be a literal or
// a constexpr name; resolve a constexpr name to its integer value.
function peekBufferBytes() {
  const decl = /std::array<char,\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*>\s*peek\b/.exec(ws);
  assert.ok(decl, "could not find the `std::array<char, N> peek` upgrade-classifier buffer");
  const tok = decl[1];
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  // constexpr size_t kWsUpgradePeekBytes = 16384;
  const cre = new RegExp("constexpr\\s+(?:std::)?size_t\\s+" + tok + "\\s*=\\s*(\\d+)");
  const cm = cre.exec(ws);
  assert.ok(cm, "peek buffer size symbol `" + tok + "` has no constexpr integer definition");
  return parseInt(cm[1], 10);
}

// A single cookie can be ~4 KiB and browsers send the whole same-host jar; 2 KiB was the shipped
// regression. Require enough headroom for a real header block (request line + UA + a large cookie).
// 8 KiB is the floor; the fix ships 16 KiB.
const MIN_PEEK_BYTES = 8192;

check("upgrade-classifier peek buffer holds a realistic large-cookie header block", () => {
  const bytes = peekBufferBytes();
  assert.ok(
    bytes >= MIN_PEEK_BYTES,
    `WS Upgrade peek buffer is ${bytes} bytes; must be >= ${MIN_PEEK_BYTES} so a header block with a ` +
    `large (origin-varying) cookie jar is still classified as a WebSocket rather than 404'd into ` +
    `the terrain-less HTTP-poll fallback. 2048 was the localhost-void regression.`
  );
});

check("regression guard: the shipped 2048-byte peek buffer is not reintroduced", () => {
  assert.ok(
    !/std::array<char,\s*2048\s*>\s*peek\b/.test(ws),
    "the 2048-byte WS Upgrade peek buffer is back -- large-cookie origins (e.g. localhost) will " +
    "silently drop to terrain-less HTTP polling again."
  );
});

check("classifier still keys off the full \\r\\n\\r\\n header terminator", () => {
  // The whole point of a large-enough buffer is that the terminator search now succeeds; keep that
  // mechanism present (a change that stopped requiring the full block would re-open the split-header
  // misclassification the buffer growth exists to prevent).
  const at = ws.indexOf("process_and_close_socket");
  assert.ok(at > 0, "process_and_close_socket() classifier not found");
  const body = ws.slice(at, at + 4000);
  assert.ok(body.includes("MSG_PEEK"), "classifier no longer MSG_PEEKs the head");
  assert.ok(body.includes('"\\r\\n\\r\\n"'), "classifier no longer waits for the full header terminator");
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
