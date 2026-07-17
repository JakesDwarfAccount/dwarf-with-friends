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
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cpp = fs.readFileSync(path.join(root, 'src', 'flight_recorder.cpp'), 'utf8');
const v3 = fs.readFileSync(path.join(root, 'src', 'flight_recorder_v3.cpp'), 'utf8');
const header = fs.readFileSync(path.join(root, 'src', 'flight_recorder.h'), 'utf8');
const cmake = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8');
const http = fs.readFileSync(path.join(root, 'src', 'http_server.cpp'), 'utf8');

function between(source, begin, end) {
  const a = source.indexOf(begin);
  const b = source.indexOf(end, a + begin.length);
  assert.ok(a >= 0 && b > a, `missing source region ${begin} .. ${end}`);
  return source.slice(a, b);
}

const gpsExpected = new Map([
  ['gps.texpos', 'screentexpos'],
  ['gps.texpos_lower', 'screentexpos_lower'],
  ['gps.texpos_anchored', 'screentexpos_anchored'],
  ['gps.texpos_anchored_x', 'screentexpos_anchored_x'],
  ['gps.texpos_anchored_y', 'screentexpos_anchored_y'],
  ['gps.texpos_flag', 'screentexpos_flag'],
  ['gps.texpos_top_lower', 'screentexpos_top_lower'],
  ['gps.texpos_top_anchored', 'screentexpos_top_anchored'],
  ['gps.texpos_top', 'screentexpos_top'],
  ['gps.texpos_top_anchored_x', 'screentexpos_top_anchored_x'],
  ['gps.texpos_top_anchored_y', 'screentexpos_top_anchored_y'],
  ['gps.texpos_top_flag', 'screentexpos_top_flag'],
]);
const gps = between(cpp, 'std::vector<VpPlane> gps_texture_planes',
                    'std::vector<VpPlane> viewport_planes');
const gpsNames = [...gps.matchAll(/\{"(gps\.[a-z_]+)"/g)].map(match => match[1]);
assert.equal(gpsNames.length, 12, 'GPS capture must declare all 12 generated texture planes');
assert.equal(new Set(gpsNames).size, 12, 'GPS texture plane names must be unique');
for (const [name, field] of gpsExpected) {
  assert.ok(gpsNames.includes(name), `GPS texture plane ${name} must be present`);
  const elem = name.endsWith('_flag') ? '4' : 'int\\(sizeof\\(long\\)\\)';
  assert.match(gps, new RegExp(`\\{"${name}"\\s*,\\s*gps->${field}\\s*,\\s*${elem}\\}`),
               `${name} must bind generated graphic.${field} at its exact element width`);
}

const vp = between(cpp, 'std::vector<VpPlane> viewport_planes', 'void hash_plane');
const vpNames = [...vp.matchAll(/\{"vp\.([a-z_]+)"/g)].map(match => match[1]);
assert.equal(vpNames.length, 26, 'vp=1 must capture the canonical 26 current-frame planes');
assert.equal(new Set(vpNames).size, 26, 'viewport plane names must be unique');
for (const name of ['floor_flag', 'liquid_flag', 'spatter_flag', 'ramp_flag', 'shadow_flag',
                    'tree_plus_one']) {
  assert.ok(vpNames.includes(name), `viewport plane ${name} must be present`);
}

const screen = between(cpp, 'bool sample_screen(', 'struct ScreenRequest');
for (const token of ['df::global::map_renderer->cur_tick_count',
                     'DFHack::Gui::getCurFocus(true)', 'df::global::texture']) {
  assert.ok(screen.includes(token), `screen capture/hash must include ${token}`);
}
assert.ok(screen.includes('gps_texture_planes(gps, top != 0)'),
          'render sample must bind generated GPS texture planes once per frame');
assert.match(screen, /for \(const VpPlane& p : gps_tex_planes\) hash_plane/,
             'every GPS UI plane must participate in change-only hash gating');
assert.match(screen, /for \(const VpPlane& p : gps_tex_planes\) copy_plane/,
             'the exact hash-gated GPS UI planes must use the safe copy path');
assert.match(screen, /if \(top && !gps->screen_top\) return false/,
             'top_in_use must fail the sample if its top screen plane is unavailable');
assert.match(screen, /for \(const VpPlane& p : gps_tex_planes\)\s+if \(!p\.arr\) return false/,
             'v2 must fail a sample instead of writing an incomplete GPS plane stack');

const loop = between(cpp, 'void capture_loop(', 'std::string status_json()');
const renderSample = loop.indexOf('sample_screen_on_render_thread');
const changedGuard = loop.indexOf('if (!changed)');
const richSuspend = loop.indexOf('suspended_enrich_rich_record');
assert.ok(renderSample >= 0 && changedGuard > renderSample && richSuspend > changedGuard,
          'unchanged ticks must return before any rich-mode suspension');

const renderHop = between(cpp, 'bool sample_screen_on_render_thread(',
                          'ItemFilterSlice copy_condition');
assert.ok(!renderHop.includes('capture_state_mutex'),
          'render callback must not acquire capture_state_mutex (capture deadlock)');
assert.ok(renderHop.includes('cancelled.load') && renderHop.includes('cancelled.store'),
          'timed-out render requests must cancel before queued work starts');
assert.match(cpp, /bool sample_screen_seh[\s\S]*__except/,
             'queued render reads must be SEH-guarded against grid resize');

const richEnrich = between(cpp, 'bool enrich_rich_record(', 'bool enrich_rich_record_seh');
assert.ok(!richEnrich.includes('getCurFocus') && !richEnrich.includes('global::texture'),
          'worker enrichment must not read render-owned focus or texture vectors');
assert.ok(!richEnrich.includes('main_interface.info.work_orders.conditions') &&
          richEnrich.includes('world->manager_orders.all'),
          'suspended worker must read simulation-owned orders, not render-owned UI vectors');

assert.ok(screen.includes('main_interface.info.work_orders.conditions') &&
          screen.includes('suggested_item_condition'),
          'render callback must retain native work-order suggestion evidence');
assert.ok(screen.includes('using SuggestionPtrs') &&
          screen.includes('reinterpret_cast<const SuggestionPtrs*>') &&
          /for \(const df::manager_order_condition_item\* c : suggestions\)[\s\S]*if \(c\)/.test(screen),
          'known df-structures value/pointer mismatch needs a null-guarded native pointer view');

const suspended = between(cpp, 'bool suspended_enrich_rich_record(', '// Serialize a record');
assert.ok(suspended.includes('DFHack::ConditionalCoreSuspender suspend') &&
          suspended.includes('enrich_rich_record_seh'),
          'unit/order copy must happen under conditional core suspension');
assert.ok(!suspended.includes('runOnRenderThread') && !suspended.includes('capture_state_mutex'),
          'core-suspended enrichment must never wait on render or invert the capture mutex');
assert.ok(!cpp.includes('render_parked'),
          'recorder must not park render before requesting the core (live deadlock regression)');

for (const token of ['\\"ui_tick\\"', '\\"unit_status_texpos\\"', '\\"work_order\\"']) {
  assert.ok(cpp.includes(token), `rich corpus schema must serialize ${token}`);
}
assert.ok(cpp.includes('{\\"v\\":3,\\"t_ms\\"'), 'new records must use schema v3');
assert.ok(cpp.includes('{\\"v\\":3,\\"kind\\":\\"manifest\\"'),
          'new session manifests must use schema v3');
assert.ok(cpp.includes('\\"gps_top_in_use\\"'),
          'v2 records must serialize the explicit top-overlay state');
assert.match(screen, /out\.gps_top_in_use = top != 0/,
             'the serialized top-overlay state must come from graphic.top_in_use');
for (const name of ['requested_items', 'suggestions', 'existing']) {
  assert.ok(cpp.includes(`emit_filters("${name}"`), `rich corpus schema must serialize ${name}`);
}
assert.ok(cpp.includes('\\"kind\\":\\"manifest\\"'), 'each session needs a provenance manifest');
assert.ok(cpp.includes('session size limit reached'), 'sessions need a hard size cap');
assert.ok(cpp.includes('write/flush FAILED'), 'write failures must stop the recorder');
assert.ok(cpp.includes('started_ms % 1000'), 'same-second sessions need collision-resistant names');
assert.ok(!cpp.includes('std::filesystem::u8path'), 'deprecated C++20 u8path must not return');
for (const counter of ['render_misses', 'enrichment_misses', 'state_only_attempts',
                       'state_only_records', 'render_stamp_mismatches']) {
  assert.ok(cpp.includes(`\\\"${counter}\\\"`), `status must expose ${counter}`);
  assert.ok(cpp.includes(`g_rec.${counter}.store(0)`), `${counter} must reset per session`);
}

for (const route of ['server.Get("/recorder/stop"', 'server.Get("/recorder/status"']) {
  const handler = between(cpp, route, '});');
  assert.ok(handler.includes('std::lock_guard<std::mutex> lock(g_rec.control)'),
            `${route} must lock non-atomic recorder config before status_json`);
}

assert.match(header, /hash-gating BEFORE suspension/);
assert.match(cmake, /src\/flight_recorder\.cpp/);
assert.match(cmake, /src\/flight_recorder_v3\.cpp/);
assert.match(http, /register_flight_recorder_routes\(server\)/);
assert.match(http, /stop_flight_recorder\(\)/);

for (const token of ['kExecutableSha256', 'kDfStructuresCommit', 'kSlicePlanId',
                     'enabled_slices_json', 'serialize_slices']) {
  assert.ok(cpp.includes(`recorder_v3::${token}`), `v3 manifest/frame path must use ${token}`);
}
assert.ok(cpp.includes('validate_rich_record_on_render_thread') &&
          cpp.includes('recorder_v3::route_equal(candidate.v3, validation.v3)'),
          'rich joins must perform a second render stamp and stable-id comparison');
assert.match(loop, /if \(!changed\)[\s\S]*suspended_enrich_rich_record/,
             'state_hz=0 and unchanged route state must return before core enrichment');
assert.ok(cpp.includes('state_hz > 0 && (!g_rec.rich || !qualification)'),
          'state-only sampling must be restricted to rich qualification mode');
for (const forbidden of ['current_custom_category_token', 'interface_button', 'press_button',
                         'filtered_button', 'world->jobs']) {
  assert.ok(!v3.includes(forbidden), `v3 helper must not touch unsafe/unbounded ${forbidden}`);
}
assert.ok(v3.includes('view_sheets.viewing_bldid') && !v3.includes('viewing_bldid >= 0 ?'),
          'building sheets must use direct viewing_bldid without active_id fallback');
assert.ok(v3.includes('general_ref_type::CONTAINED_IN_ITEM') &&
          v3.includes('general_ref_type::UNIT_HOLDER') &&
          v3.includes('general_ref_type::BUILDING_HOLDER'),
          'item holder refs must use the reviewed semantic allowlist');
assert.ok(v3.includes('direct_identity_unavailable'),
          'index/vector-only place selections must fail closed');
const placeCapture = between(v3, 'void capture_place(', 'void capture_building(');
const locationDetailsBranch = placeCapture.indexOf('if (location_details)');
const locationSelectorBranch = placeCapture.indexOf('else if (location_selector)');
const zoneBranch = placeCapture.indexOf('else if (zone)');
assert.ok(locationDetailsBranch >= 0 && locationSelectorBranch > locationDetailsBranch &&
          zoneBranch > locationSelectorBranch,
          'location modals must take precedence over their underlying zone focus');
assert.ok(placeCapture.includes('ui.location_details.open') &&
          placeCapture.includes('ui.location_selector.open'),
          'location modal focus must agree with exact df-structures open state');
assert.match(placeCapture, /if \(!ui\.location_details\.selected_ab\)[\s\S]*direct_identity_unavailable/,
             'Location Details must fail closed when its direct abstract-building identity is absent');
assert.ok(v3.includes('fnv_string(hash, state.place.place_kind)'),
          'the typed place kind must participate in the route stamp');

console.log(`flight recorder contract: PASS (${gpsNames.length} GPS texture planes, ${vpNames.length} viewport planes, v3 two-stamp bounded slices wired)`);
