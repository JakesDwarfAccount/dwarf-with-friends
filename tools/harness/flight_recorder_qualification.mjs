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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inflateSync, deflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

import {HttpClient, parseArgs, sleep} from '../lib/mdutil.mjs';
import {resolveDfRoot} from '../lib/dfroot.mjs';
import {validateV3Manifest} from '../ground_truth/recorder_v3_contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK_HELPER = 'tools/harness/df_lock.sh';
const LOCK_NAME = `flight-recorder-qualification-${process.pid}`;
const DEFAULT_BASE = 'http://127.0.0.1:8765';
const EXPECTED_GPS_BASE = new Map([
  ['gps.screen', 8],
  ['gps.texpos', 4],
  ['gps.texpos_lower', 4],
  ['gps.texpos_anchored', 4],
  ['gps.texpos_anchored_x', 4],
  ['gps.texpos_anchored_y', 4],
  ['gps.texpos_flag', 4],
]);
const EXPECTED_GPS_TOP = new Map([
  ['gps.screen_top', 8],
  ['gps.texpos_top_lower', 4],
  ['gps.texpos_top_anchored', 4],
  ['gps.texpos_top', 4],
  ['gps.texpos_top_anchored_x', 4],
  ['gps.texpos_top_anchored_y', 4],
  ['gps.texpos_top_flag', 4],
]);
const EXPECTED_VP = [
  'background', 'floor_flag', 'background_two', 'liquid_flag', 'spatter_flag',
  'spatter', 'ramp_flag', 'shadow_flag', 'building_one', 'item', 'vehicle',
  'vermin', 'left_creature', 'creature', 'right_creature', 'building_two',
  'projectile', 'high_flow', 'top_shadow', 'signpost', 'designation', 'interface',
  'upleft_creature', 'up_creature', 'upright_creature', 'tree_plus_one',
].map(name => `vp.${name}`);
const FILTER_KEYS = [
  'compare_type', 'compare_val', 'item_type', 'item_subtype', 'mat_type', 'mat_index',
  'flags1', 'flags2', 'flags3', 'flags4', 'flags5', 'reaction_class',
  'reaction_product', 'metal_ore', 'min_dimension', 'contains', 'reaction_id',
  'tool_use', 'dye_color',
];

function fail(message) { throw new Error(message); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function gitBashCandidates({env = process.env, gitPaths = null} = {}) {
  const candidates = [];
  if (env.DWF_GIT_BASH) candidates.push(path.resolve(env.DWF_GIT_BASH));

  let resolvedGitPaths = gitPaths;
  if (!resolvedGitPaths) {
    const where = spawnSync('where.exe', ['git.exe'], {encoding: 'utf8', windowsHide: true});
    resolvedGitPaths = where.status === 0
      ? String(where.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      : [];
  }
  for (const gitExe of resolvedGitPaths) {
    const parent = path.dirname(gitExe);
    const root = ['cmd', 'bin'].includes(path.basename(parent).toLowerCase())
      ? path.dirname(parent) : parent;
    candidates.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  }

  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    if (!base) continue;
    candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'),
                    path.join(base, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  return [...new Set(candidates.map(value => path.normalize(value)))];
}

function resolveBash({platform = process.platform, env = process.env,
                      exists = fs.existsSync, gitPaths = null} = {}) {
  if (platform !== 'win32') return 'bash';
  const candidates = gitBashCandidates({env, gitPaths});
  if (env.DWF_GIT_BASH && !exists(path.resolve(env.DWF_GIT_BASH)))
    fail(`DWF_GIT_BASH does not exist: ${path.resolve(env.DWF_GIT_BASH)}`);
  const found = candidates.find(candidate => exists(candidate));
  if (found) return found;
  fail(`Git Bash was not found. Install Git for Windows or set DWF_GIT_BASH. Checked:\n  ${
    candidates.join('\n  ') || '(no candidates)'}`);
}

function runLock(action) {
  const bash = resolveBash();
  const args = ['--noprofile', '--norc', LOCK_HELPER, action];
  if (action !== 'check') args.push(LOCK_NAME);
  const result = spawnSync(bash, args, {cwd: ROOT, encoding: 'utf8', windowsHide: true});
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error) fail(`cannot run DF_LOCK helper with ${bash}: ${result.error.message}`);
  if (result.status !== 0) fail(`DF_LOCK ${action} refused (exit ${result.status}): ${output}`);
  if (output) console.log(output);
}

function decodePlane(plane) {
  assert.ok(plane && typeof plane.name === 'string', 'plane has a name');
  assert.ok(Number.isInteger(plane.elem) && plane.elem > 0, `${plane.name}: positive elem`);
  assert.ok(Number.isInteger(plane.raw_len) && plane.raw_len >= 0,
            `${plane.name}: non-negative raw_len`);
  let raw;
  if (typeof plane.zb64 === 'string') raw = inflateSync(Buffer.from(plane.zb64, 'base64'));
  else if (typeof plane.b64 === 'string') raw = Buffer.from(plane.b64, 'base64');
  else fail(`${plane.name}: missing zb64/b64 payload`);
  assert.equal(raw.length, plane.raw_len, `${plane.name}: decoded length`);
  return raw;
}

function parseSession(file) {
  assert.ok(fs.existsSync(file), `session file exists: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2, `session has manifest + record: ${file}`);
  const parsed = lines.map((line, i) => {
    try { return JSON.parse(line); }
    catch (error) { fail(`${file}:${i + 1}: invalid JSON: ${error.message}`); }
  });
  assert.equal(parsed[0].kind, 'manifest', 'first JSONL line is the manifest');
  return {file, manifest: parsed[0], records: parsed.slice(1)};
}

function validateManifest(session, version, {mode, vp, hz}) {
  const m = session.manifest;
  assert.ok([2, 3].includes(m.v), 'manifest schema version is supported');
  if (m.v === 3) validateV3Manifest(m);
  assert.equal(m.format, 'dwf-flight-recorder-jsonl', 'manifest format');
  assert.equal(m.mode, mode, 'manifest mode');
  assert.equal(m.vp, vp, 'manifest vp flag');
  assert.equal(m.hz, hz, 'manifest sample rate');
  assert.ok(Number.isInteger(m.started_ms) && m.started_ms > 0, 'manifest start time');
  assert.equal(m.build, version.git, 'manifest plugin build equals /version git identity');
  assert.ok(typeof m.df_version === 'string' && m.df_version.length > 0,
            'manifest has DF version');
}

function validateGpsPlanes(record) {
  const gpsPlanes = record.planes.filter(plane => plane.name.startsWith('gps.'));
  const names = gpsPlanes.map(plane => plane.name);
  assert.equal(new Set(names).size, names.length, 'GPS plane names are unique');

  assert.equal(typeof record.gps_top_in_use, 'boolean',
               'record.gps_top_in_use explicitly declares top overlay state');
  const expected = new Map(EXPECTED_GPS_BASE);
  if (record.gps_top_in_use)
    for (const entry of EXPECTED_GPS_TOP) expected.set(...entry);
  const missing = [...expected.keys()].filter(name => !names.includes(name));
  const extra = names.filter(name => !expected.has(name));
  assert.deepEqual(missing, [], `all GPS UI planes observed; missing=${missing.join(',')}`);
  assert.deepEqual(extra, [], `no unknown GPS UI planes; extra=${extra.join(',')}`);
  for (const plane of gpsPlanes)
    assert.equal(plane.elem, expected.get(plane.name), `${plane.name}: canonical element width`);
}

function validateBaseRecord(record, {vp}) {
  assert.ok([2, 3].includes(record.v), 'record schema version is supported');
  for (const key of ['t_ms', 'frame', 'ui_tick'])
    assert.ok(Number.isInteger(record[key]), `record.${key} is an integer`);
  assert.ok(record.t_ms > 0, 'record timestamp is positive');
  assert.ok(Array.isArray(record.focus), 'record focus is an array');
  for (const group of ['window', 'mouse', 'dims'])
    assert.ok(record[group] && Number.isInteger(record[group].x) &&
              Number.isInteger(record[group].y), `record ${group} coordinates`);
  assert.ok(record.dims.x > 0 && record.dims.y > 0, 'text grid dimensions are positive');
  assert.ok(Array.isArray(record.planes) && record.planes.length > 0, 'record has planes');
  const names = new Set(record.planes.map(plane => plane.name));
  validateGpsPlanes(record);
  for (const plane of record.planes) {
    const raw = decodePlane(plane);
    const dims = plane.name.startsWith('vp.') ? record.vp_dims : record.dims;
    assert.ok(dims, `${plane.name}: dimensions present`);
    assert.equal(raw.length, dims.x * dims.y * plane.elem,
                 `${plane.name}: payload matches grid dimensions`);
  }
  if (!vp) assert.ok(![...names].some(name => name.startsWith('vp.')), 'vp=0 has no vp planes');
}

function validateVp26(records) {
  const seen = new Set();
  const elem = new Map();
  for (const record of records) {
    assert.ok(record.vp_dims && record.vp_dims.x > 0 && record.vp_dims.y > 0,
              'vp=1 record has viewport dimensions');
    for (const plane of record.planes) {
      if (!plane.name.startsWith('vp.')) continue;
      seen.add(plane.name);
      elem.set(plane.name, plane.elem);
    }
  }
  const missing = EXPECTED_VP.filter(name => !seen.has(name));
  const extra = [...seen].filter(name => !EXPECTED_VP.includes(name));
  assert.deepEqual(missing, [], `all 26 viewport planes observed; missing=${missing.join(',')}`);
  assert.deepEqual(extra, [], `no unknown viewport planes; extra=${extra.join(',')}`);
  assert.equal(seen.size, 26, 'exactly 26 viewport planes observed');
  assert.equal(elem.get('vp.floor_flag'), 8, 'floor flag uses u64 elements');
  assert.equal(elem.get('vp.ramp_flag'), 8, 'ramp flag uses u64 elements');
  assert.equal(elem.get('vp.tree_plus_one'), 2, 'tree species uses i16 elements');
}

function validateRich(records) {
  assert.ok(records.length > 0, 'rich session has records');
  for (const record of records) validateBaseRecord(record, {vp: true});
  validateVp26(records);
  const mapped = records.find(record => Array.isArray(record.unit_status_texpos));
  assert.ok(mapped, 'rich record has live UNIT_STATUS texture mapping');
  assert.equal(mapped.unit_status_texpos.length, 41, 'UNIT_STATUS mapping has 41 native rows');
  assert.ok(mapped.unit_status_texpos.every(Number.isInteger), 'UNIT_STATUS ids are integers');
  return mapped.unit_status_texpos;
}

function validateFilter(filter, label) {
  assert.ok(filter && typeof filter === 'object', `${label}: filter object`);
  for (const key of FILTER_KEYS) assert.ok(Object.hasOwn(filter, key), `${label}: ${key}`);
  assert.ok(Array.isArray(filter.contains), `${label}: contains vector`);
}

function screenText(record) {
  const plane = record.planes.find(value => value.name === 'gps.screen');
  if (!plane) return '';
  const raw = decodePlane(plane);
  const rows = [];
  for (let y = 0; y < record.dims.y; ++y) {
    let row = '';
    for (let x = 0; x < record.dims.x; ++x) {
      const c = raw[(x * record.dims.y + y) * plane.elem];
      row += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    }
    rows.push(row);
  }
  return rows.join('\n');
}

function validateWorkOrder(records, expectExisting) {
  const record = records.find(value => value.work_order?.open);
  assert.ok(record,
    'no work_order slice: manually open a native work-order Conditions editor, then rerun');
  assert.match(screenText(record), /Suggested conditions/i,
               'recorded native screen contains Suggested conditions');
  const work = record.work_order;
  for (const key of ['id', 'job_type', 'item_type', 'item_subtype', 'mat_type', 'mat_index'])
    assert.ok(Number.isInteger(work[key]), `work_order.${key}`);
  for (const key of ['requested_items', 'suggestions', 'existing'])
    assert.ok(Array.isArray(work[key]), `work_order.${key} array`);
  assert.ok(work.suggestions.length > 0, 'native suggestion vector is non-empty');
  for (const [i, item] of work.requested_items.entries()) validateFilter(item, `requested[${i}]`);
  for (const [i, item] of work.suggestions.entries()) validateFilter(item, `suggestion[${i}]`);
  for (const [i, item] of work.existing.entries()) validateFilter(item, `existing[${i}]`);
  if (expectExisting)
    assert.ok(work.existing.length > 0, 'expected at least one existing item condition');
  return {orderId: work.id, suggestions: work.suggestions.length,
          requested: work.requested_items.length, existing: work.existing.length};
}

function statusHits(records, mapping) {
  const wanted = new Set(mapping.filter(value => value > 0));
  const hits = [];
  for (const record of records) {
    for (const plane of record.planes) {
      if (!plane.name.startsWith('vp.') || plane.name.endsWith('_flag') || plane.elem !== 4)
        continue;
      const raw = decodePlane(plane);
      for (let offset = 0; offset + 4 <= raw.length; offset += 4) {
        const texpos = raw.readInt32LE(offset);
        if (wanted.has(texpos)) {
          hits.push({frame: record.frame, uiTick: record.ui_tick,
                     phase: record.ui_tick % 1000, plane: plane.name, texpos});
        }
      }
    }
  }
  return hits;
}

async function requestJson(client, method, route, expected) {
  const response = await client.json(method, route, {timeoutMs: 15000});
  assert.equal(response.status, expected, `${method} ${route}: HTTP ${expected}`);
  assert.ok(response.json, `${method} ${route}: JSON response`);
  return response.json;
}

async function stopRecorder(client) {
  try {
    return {json: await requestJson(client, 'GET', '/recorder/stop', 200), recovered: false};
  } catch (error) {
    // A 5+ second passive capture can outlive httplib's idle keep-alive socket. The stop still
    // completes server-side, but Node can receive ECONNRESET instead of the response. Recover only
    // through a fresh authoritative status read; any running/unreachable recorder remains a fail.
    if (error?.code !== 'ECONNRESET') throw error;
    await sleep(100);
    const status = await requestJson(client, 'GET', '/recorder/status', 200);
    if (status.running)
      return {json: await requestJson(client, 'GET', '/recorder/stop', 200), recovered: true};
    console.log('recorder stop reply reset; recovered from authoritative stopped status');
    return {json: {ok: true, status}, recovered: true};
  }
}

async function waitForRecord(client, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestJson(client, 'GET', '/recorder/status', 200);
    if (!status.running) fail(`recorder stopped early: ${JSON.stringify(status)}`);
    if (status.records >= 1) return status;
    await sleep(100);
  }
  fail(`recorder produced no record within ${timeoutMs}ms`);
}

async function runSession(client, outputDir, {mode, vp, hz, seconds, duplicateProbe = false}) {
  fs.mkdirSync(outputDir, {recursive: true});
  const query = new URLSearchParams({mode, vp: vp ? '1' : '0', hz: String(hz),
                                     max_mb: '16', dir: outputDir});
  let running = false;
  try {
    const started = await requestJson(client, 'GET', `/recorder/start?${query}`, 200);
    running = true;
    assert.equal(started.ok, true, 'start reports ok');
    assert.equal(started.status.running, true, 'start status is running');
    assert.equal(started.status.mode, mode, 'start status mode');
    assert.equal(started.status.vp, vp, 'start status vp');
    assert.equal(started.status.hz, hz, 'start status hz');
    if (duplicateProbe) {
      const conflict = await requestJson(client, 'GET', `/recorder/start?${query}`, 409);
      assert.equal(conflict.ok, false, 'duplicate start reports failure');
      assert.match(conflict.err, /already running/i, 'duplicate start explains conflict');
    }
    await waitForRecord(client);
    if (seconds > 0) await sleep(seconds * 1000);
    const stop = await stopRecorder(client);
    const stopped = stop.json;
    running = false;
    assert.equal(stopped.ok, true, 'stop reports ok');
    assert.equal(stopped.status.running, false, 'stop status is stopped');
    assert.ok(stopped.status.records >= 1, 'stop status reports records');
    assert.ok(stopped.status.bytes_written > 0, 'stop status reports bytes');
    const session = parseSession(path.resolve(stopped.status.file));
    assert.equal(session.records.length, stopped.status.records,
                 'status record count equals JSONL records');
    return {session, status: stopped.status, stopTransportRecovered: stop.recovered};
  } catch (error) {
    if (running) {
      try { await client.json('GET', '/recorder/stop', {timeoutMs: 15000}); }
      catch { /* preserve the primary qualification failure */ }
    }
    throw error;
  }
}

async function probeFailureReporting(client, outputRoot) {
  const parentFile = path.join(outputRoot, 'not-a-directory');
  fs.mkdirSync(outputRoot, {recursive: true});
  fs.writeFileSync(parentFile, 'qualification failure probe\n');
  try {
    const query = new URLSearchParams({dir: path.join(parentFile, 'child')});
    const response = await client.json('GET', `/recorder/start?${query}`, {timeoutMs: 15000});
    if (response.status === 200) {
      await client.json('GET', '/recorder/stop', {timeoutMs: 15000});
      fail('invalid output directory unexpectedly started a recorder session');
    }
    assert.equal(response.status, 500, 'invalid output directory reports HTTP 500');
    assert.ok(response.json, 'invalid output directory returns JSON');
    assert.equal(response.json.ok, false, 'directory failure reports ok:false');
    assert.match(response.json.err, /cannot create dir/i, 'directory failure explains cause');
  } finally {
    fs.rmSync(parentFile, {force: true});
  }
}

function verifyDeployedDll(expected) {
  if (!expected) return {status: 'SKIP', reason: '--expected-dll-sha256 not supplied'};
  assert.match(expected, /^[0-9a-f]{64}$/i, 'expected DLL SHA-256 must be 64 hex digits');
  const resolved = resolveDfRoot();
  if (!resolved.root) fail('cannot resolve DF root for deployed DLL identity check');
  // Post-rename this gate REQUIRES the new dwf.plug.dll — deliberately NO fallback to the old
  // dfcapture.plug.dll name: a stale pre-rename DLL passing the SHA check would mean the deploy
  // never happened, exactly the failure this qualification exists to catch. Fail loud on absence.
  const dll = path.join(resolved.root, 'hack', 'plugins', 'dwf.plug.dll');
  assert.ok(fs.existsSync(dll), `deployed DLL exists: ${dll}`);
  const actual = sha256(dll);
  assert.equal(actual, expected.toUpperCase(), 'deployed DLL SHA-256 matches cleared build');
  return {status: 'PASS', file: dll, sha256: actual};
}

function fixturePlane(name, elem, x, y, fill = 0) {
  const raw = Buffer.alloc(elem * x * y, fill);
  return {name, elem, raw_len: raw.length, zb64: deflateSync(raw).toString('base64')};
}

function packedPlane(name, elem, raw) {
  return {name, elem, raw_len: raw.length, zb64: deflateSync(raw).toString('base64')};
}

async function selftest() {
  const fakeGit = path.join('C:\\Tools', 'Git', 'cmd', 'git.exe');
  const fakeBash = path.normalize(path.join('C:\\Tools', 'Git', 'bin', 'bash.exe'));
  assert.equal(resolveBash({platform: 'win32', env: {}, gitPaths: [fakeGit],
                            exists: candidate => path.normalize(candidate) === fakeBash}), fakeBash,
               'Windows launcher derives Git Bash from git.exe instead of using WSL bash');
  assert.equal(resolveBash({platform: 'linux'}), 'bash', 'non-Windows launcher uses bash on PATH');
  assert.throws(() => resolveBash({platform: 'win32', env: {DWF_GIT_BASH: 'Z:\\missing.exe'},
                                   gitPaths: [], exists: () => false}), /does not exist/,
                'an explicit missing Git Bash fails closed');

  const stopCalls = [];
  const recoveredStop = await stopRecorder({json: async (_method, route) => {
    stopCalls.push(route);
    if (route === '/recorder/stop' && stopCalls.length === 1)
      throw Object.assign(new Error('seeded reset'), {code: 'ECONNRESET'});
    if (route === '/recorder/status')
      return {status: 200, json: {running: false, records: 1, bytes_written: 10, file: 'x'}};
    throw new Error(`unexpected selftest route: ${route}`);
  }});
  assert.equal(recoveredStop.recovered, true, 'lost stop reply recovers through stopped status');
  assert.deepEqual(stopCalls, ['/recorder/stop', '/recorder/status'],
                   'stop recovery makes one authoritative status read and no blind retry');

  const version = {git: 'abc123'};
  const manifest = {v: 2, kind: 'manifest', format: 'dwf-flight-recorder-jsonl',
                    build: 'abc123', df_version: '53.15', started_ms: 1,
                    mode: 'rich', vp: true, hz: 5};
  const record = {v: 2, t_ms: 1, frame: 2, ui_tick: 345, gps_top_in_use: true,
                  focus: ['dwarfmode/Info/WORK_ORDERS'],
                  window: {x: 1, y: 2, z: 3}, mouse: {x: 0, y: 0}, dims: {x: 2, y: 2},
                  vp_dims: {x: 2, y: 2}, unit_status_texpos: Array.from({length: 41}, (_, i) => i + 1),
                  planes: [[...EXPECTED_GPS_BASE], [...EXPECTED_GPS_TOP]].flat().map(
                             ([name, elem]) => fixturePlane(name, elem, 2, 2)).concat(
                           ...EXPECTED_VP.map(name => fixturePlane(
                             name, name === 'vp.floor_flag' || name === 'vp.ramp_flag' ? 8 :
                                   name === 'vp.tree_plus_one' ? 2 : 4, 2, 2)))};
  const session = {manifest, records: [record]};
  validateManifest(session, version, {mode: 'rich', vp: true, hz: 5});
  validateRich(session.records);
  assert.throws(() => validateVp26([{...record,
    planes: record.planes.filter(plane => plane.name !== 'vp.tree_plus_one')}]), /missing=/);
  assert.throws(() => validateBaseRecord({...record,
    planes: record.planes.filter(plane => plane.name !== 'gps.texpos_lower')}, {vp: true}),
  /GPS UI planes observed; missing=gps\.texpos_lower/);
  assert.throws(() => validateBaseRecord({...record,
    planes: record.planes.filter(plane => plane.name !== 'gps.screen_top')}, {vp: true}),
  /GPS UI planes observed; missing=gps\.screen_top/,
  'gps_top_in_use=true fails when any top plane is missing');
  assert.throws(() => validateBaseRecord({...record, gps_top_in_use: false}, {vp: true}),
  /no unknown GPS UI planes; extra=.*gps\.screen_top/,
  'gps_top_in_use=false fails when any top plane is present');
  assert.throws(() => validateBaseRecord({...record, planes: record.planes.map(plane =>
    plane.name === 'gps.texpos_anchored_x' ? {...plane, elem: 8} : plane)}, {vp: true}),
  /gps\.texpos_anchored_x: canonical element width/);
  assert.throws(() => decodePlane({...record.planes[0], raw_len: 1}), /decoded length/);
  assert.throws(() => decodePlane({...record.planes[0], zb64: 'AAAA'}),
                /compression|incorrect header|unexpected end|invalid/i);

  const designation = Buffer.alloc(16);
  designation.writeInt32LE(7, 0);
  const statusRecord = {...record, planes: record.planes.map(plane =>
    plane.name === 'vp.designation' ? packedPlane(plane.name, 4, designation) : plane)};
  assert.equal(statusHits([statusRecord], record.unit_status_texpos).length, 1,
               'UNIT_STATUS texpos is found in a texture plane');

  const phrase = 'Suggested conditions';
  const grid = Buffer.alloc(phrase.length * 8);
  for (let x = 0; x < phrase.length; ++x) grid[x * 8] = phrase.charCodeAt(x);
  const filter = Object.fromEntries(FILTER_KEYS.map(key => [key, key === 'contains' ? [] : 0]));
  const workRecord = {...record, dims: {x: phrase.length, y: 1},
    planes: [packedPlane('gps.screen', 8, grid)],
    work_order: {open: true, id: 1, job_type: 2, item_type: 3, item_subtype: -1,
      mat_type: -1, mat_index: -1, requested_items: [], suggestions: [filter], existing: [filter]}};
  assert.equal(validateWorkOrder([workRecord], true).existing, 1,
               'work-order screen and complete filters validate');

  console.log('flight recorder qualification selftest: PASS (v2/v3 envelope compatibility, explicit top-stack contract, 14 GPS UI planes, 26 viewport planes, status, work-order and corruption checks)');
}

function usage() {
  console.log(`Usage:
  node tools/harness/flight_recorder_qualification.mjs --selftest
  node tools/harness/flight_recorder_qualification.mjs --phase baseline [--password ...]
       [--expected-dll-sha256 HEX] [--df-root PATH]
  node tools/harness/flight_recorder_qualification.mjs --phase status --seconds 5 [auth/options]
  node tools/harness/flight_recorder_qualification.mjs --phase work-order [--expect-existing]

Live phases are read-only/passive recorder checks. They acquire DF_LOCK and perform no input.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    phase: '', base: DEFAULT_BASE, password: process.env.DWF_JOIN_PASSWORD || '',
    seconds: '2', 'expected-dll-sha256': '',
  });
  if (args.selftest) { await selftest(); return; }
  if (args.help || !['baseline', 'status', 'work-order'].includes(args.phase)) {
    usage();
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  runLock('acquire');
  const client = new HttpClient(args.base);
  const outputRoot = path.join(ROOT, 'recordings', 'qualification', `${stamp()}-${args.phase}`);
  const report = {phase: args.phase, startedAt: new Date().toISOString(), outputRoot};
  try {
    const duration = Number(args.seconds);
    assert.ok(Number.isFinite(duration) && duration >= 0 && duration <= 60,
              '--seconds must be between 0 and 60');
    const version = await requestJson(client, 'GET', '/version', 200);
    report.version = version;
    if (version.authRequired) {
      if (!args.password) fail('server requires auth; pass --password or set DWF_JOIN_PASSWORD');
      await client.auth(args.password);
    }
    const initial = await requestJson(client, 'GET', '/recorder/status', 200);
    if (initial.running) fail(`another recorder session is active: ${JSON.stringify(initial)}`);
    report.deployedDll = verifyDeployedDll(args['expected-dll-sha256']);

    if (args.phase === 'baseline') {
      await probeFailureReporting(client, outputRoot);
      const cheap = await runSession(client, path.join(outputRoot, 'cheap'),
        {mode: 'cheap', vp: false, hz: 5, seconds: 0, duplicateProbe: true});
      validateManifest(cheap.session, version, {mode: 'cheap', vp: false, hz: 5});
      for (const record of cheap.session.records) validateBaseRecord(record, {vp: false});
      assert.ok(cheap.session.records.every(record => !record.unit_status_texpos && !record.work_order),
                'cheap records omit rich-only slices');

      const rich = await runSession(client, path.join(outputRoot, 'rich-vp'),
        {mode: 'rich', vp: true, hz: 5, seconds: duration, duplicateProbe: false});
      validateManifest(rich.session, version, {mode: 'rich', vp: true, hz: 5});
      validateRich(rich.session.records);
      report.sessions = {cheap: cheap.session.file, rich: rich.session.file};
      report.sessionSha256 = {cheap: sha256(cheap.session.file), rich: sha256(rich.session.file)};
      report.failureReporting = 'PASS (409 duplicate start; 500 invalid output directory)';
    } else if (args.phase === 'status') {
      const run = await runSession(client, path.join(outputRoot, 'status'),
        {mode: 'rich', vp: true, hz: 10, seconds: duration, duplicateProbe: false});
      validateManifest(run.session, version, {mode: 'rich', vp: true, hz: 10});
      const mapping = validateRich(run.session.records);
      const hits = statusHits(run.session.records, mapping);
      assert.ok(hits.length > 0,
        'no UNIT_STATUS texture hit; center visible needy dwarves and rerun for at least 5 seconds');
      assert.ok(new Set(hits.map(hit => hit.phase)).size >= 2,
        'only one UI phase observed; rerun longer with visible status bubbles');
      report.session = run.session.file;
      report.sessionSha256 = sha256(run.session.file);
      report.statusHits = hits.slice(0, 100);
      report.uiPhases = [...new Set(hits.map(hit => hit.phase))].sort((a, b) => a - b);
    } else {
      const run = await runSession(client, path.join(outputRoot, 'work-order'),
        {mode: 'rich', vp: false, hz: 5, seconds: duration, duplicateProbe: false});
      validateManifest(run.session, version, {mode: 'rich', vp: false, hz: 5});
      for (const record of run.session.records) validateBaseRecord(record, {vp: false});
      report.session = run.session.file;
      report.sessionSha256 = sha256(run.session.file);
      report.workOrder = validateWorkOrder(run.session.records, Boolean(args['expect-existing']));
    }
    report.finishedAt = new Date().toISOString();
    report.result = 'PASS';
    fs.mkdirSync(outputRoot, {recursive: true});
    const reportFile = path.join(outputRoot, 'qualification-report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`PASS flight recorder ${args.phase} qualification`);
    console.log(`report: ${reportFile}`);
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.result = 'FAIL';
    report.error = error.stack || error.message;
    fs.mkdirSync(outputRoot, {recursive: true});
    const reportFile = path.join(outputRoot, 'qualification-report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.error(`failure report: ${reportFile}`);
    throw error;
  } finally {
    client.agent.destroy();
    try { runLock('release'); } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

main().catch(error => {
  console.error(`FAIL flight recorder qualification: ${error.stack || error.message}`);
  process.exitCode = 1;
});
