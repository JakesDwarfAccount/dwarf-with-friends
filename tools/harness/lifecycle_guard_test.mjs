// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const ws = readFileSync(join(root, 'src/websocket.cpp'), 'utf8');
const http = readFileSync(join(root, 'src/http_server.cpp'), 'utf8');
const world = readFileSync(join(root, 'src/world_stream.cpp'), 'utf8');

function transportGuard(source) {
  assert.match(source, /launch_upgrade\(sock, head\);\s*return true;/, 'WS lifetime leaves the shared HTTP pool');
  assert.match(source, /SO_SNDTIMEO/, 'ordinary HTTP writes have a kernel deadline');
  assert.match(source, /configure_http_socket\(sock\);/, 'HTTP delegate applies bounded socket configuration');
  assert.match(source, /const bool was_closed = closed_\.exchange\(true\);[\s\S]*socket_shutdown_\.exchange\(true\)\) shutdown_fd\(sock_\)/, 'logical close cannot skip transport shutdown');
  assert.match(source, /handle_ws_connection\(conn\);[\s\S]*close_fd\(sock\);/, 'the WS owner closes the descriptor exactly once after teardown');
}

function lockScopeGuard(source) {
  assert.match(source, /\{\s*std::lock_guard<std::recursive_mutex> lock\(capture_state_mutex\(\)\);\s*json = build_map_json_for_camera\([\s\S]*?\);\s*\}\s*if \(json\.empty\(\)\)/, 'mapdata releases capture lock before response I/O');
  assert.match(source, /AFTER release: assemble \+ enqueue per connection \(no DF access below\)[\s\S]*enqueue_v1_aux/, 'WS enqueue occurs after CoreSuspender release');
}

transportGuard(ws);
lockScopeGuard(http + '\n' + world);

const badClose = ws.replace(/\s*if \(!socket_shutdown_\.exchange\(true\)\) shutdown_fd\(sock_\);/, '');
assert.throws(() => transportGuard(badClose), 'seeded-bad send failure without shutdown must fail');
const badPool = ws.replace(/launch_upgrade\(sock, head\);\s*return true;/, 'return handle_upgrade(sock, head);');
assert.throws(() => transportGuard(badPool), 'seeded-bad WS occupying the HTTP pool must fail');
const badLock = http.replace(/\r?\n        \}\r?\n        if \(json\.empty\(\)\)/, '\n        if (json.empty())');
assert.throws(() => lockScopeGuard(badLock + '\n' + world), 'seeded-bad response write under capture lock must fail');

const GRACE = 5000;
const SILENCE = 45000;
class RosterModel {
  constructor() { this.deadline = new Map(); }
  observe(name, now, hasSocket, lastInbound) {
    if (hasSocket && now - lastInbound <= SILENCE) {
      this.deadline.delete(name);
      return true;
    }
    if (!this.deadline.has(name)) this.deadline.set(name, now + GRACE);
    return now < this.deadline.get(name);
  }
}

const hard = new RosterModel();
assert.equal(hard.observe('alice', 0, true, 0), true);
assert.equal(hard.observe('alice', 1000, false, 0), true, 'hard disconnect starts grace');
assert.equal(hard.observe('alice', 5999, false, 0), true, 'blip shorter than grace keeps row');
assert.equal(hard.observe('alice', 6001, false, 0), false, 'expired grace removes ghost');
assert.equal(hard.observe('alice', 9000, false, 0), false, 'late teardown cannot resurrect expired tombstone');

const reconnect = new RosterModel();
assert.equal(reconnect.observe('bob', 0, true, 0), true);
assert.equal(reconnect.observe('bob', 1000, false, 0), true);
assert.equal(reconnect.observe('bob', 4000, true, 4000), true, 'reconnect re-adopts pending row');
assert.equal(reconnect.deadline.has('bob'), false, 'reconnect cancels removal deadline');

const silent = new RosterModel();
assert.equal(silent.observe('carol', SILENCE + 1, true, 0), true, 'heartbeat loss starts grace');
assert.equal(silent.observe('carol', SILENCE + GRACE + 2, true, 0), false, 'silent socket ages out');

const seededImmediateDrop = (_name, _now, hasSocket) => hasSocket;
assert.equal(seededImmediateDrop('alice', 1000, false), false, 'seeded-bad immediate removal exposes roster flicker');
assert.notEqual(seededImmediateDrop('alice', 1000, false), hard.observe('alice2', 1000, false, 0), 'fixture discriminates no-grace implementation');

console.log('PASS lifecycle guards: bounded HTTP, WS pool isolation, transport shutdown, lock release, roster grace + seeded-bad');
