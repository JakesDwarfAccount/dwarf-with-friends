// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// The recorder-v3 contract lives in tools/ground_truth, a private dev tool not in the public repo.
if (!existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ground_truth', 'recorder_v3_contract.mjs'))) {
  console.log('SKIP flight_recorder_v3_qualification_test.mjs: tools/ground_truth is absent (kept in the private archive, not the public repo).');
  process.exit(0);
}
const {loadRecorderV3Plan} = await import('../ground_truth/recorder_v3_contract.mjs');
const {gradeV3Qualification} = await import('./flight_recorder_v3_qualification.mjs');

const plan = loadRecorderV3Plan();
const manifest = {
  v: 3, kind: 'manifest', format: 'dwf-flight-recorder-jsonl', build: 'fixture-v3',
  df_version: 'v0.53.15 win64 STEAM', started_ms: 1, mode: 'rich', vp: false, hz: 10,
  executable_sha256: plan.build.executableSha256,
  df_structures_commit: plan.build.dfStructuresCommit,
  slice_plan_id: plan.planId,
  enabled_slices: plan.oneRestartSliceIds.map(id => ({id, version: 1})), state_hz: 2,
};

function clone(value) { return structuredClone(value); }
function gap(id, status = 'not_applicable', reason = 'not_applicable') {
  return {id, version: 1, status, reason, identity: {}, payload: {}};
}
function frame(index, focus, overrides = {}) {
  const stamp = BigInt(index + 1).toString(16).toUpperCase().padStart(16, '0');
  const uiHash = BigInt(index + 100).toString(16).toUpperCase().padStart(16, '0');
  const route = {id: 'route_context.v1', version: 1, status: 'ok', identity: {
    focus: [focus], surface_families: overrides.families ?? [], ui_hash: uiHash, route_stamp: stamp,
  }, payload: {primary_kind: overrides.primaryKind ?? 'fixture'}};
  const slices = plan.oneRestartSliceIds.map(id => id === route.id ? route : gap(id));
  for (const replacement of overrides.slices ?? []) {
    const position = slices.findIndex(slice => slice.id === replacement.id);
    slices[position] = replacement;
  }
  return {v: 3, focus: [focus], ui_hash: uiHash, route_stamp: stamp, slices};
}
function ok(id, identity, payload = {}) { return {id, version: 1, status: 'ok', identity, payload}; }

const records = [];
records.push(frame(records.length, 'dwarfmode/ViewSheets/UNIT/Overview', {families: ['unit_sheets'], slices: [
  gap('unit_selected.v1', 'busy', 'core_busy'),
]}));
for (const tab of [0, 1]) records.push(frame(records.length,
  `dwarfmode/ViewSheets/UNIT/${tab ? 'Items' : 'Overview'}`, {families: ['unit_sheets'], slices: [
    ok('unit_selected.v1', {unit_id: 42, active_sheet: 0, active_sub_tab: tab},
      {inventory: tab ? [{item_id: 7}] : [], skills: [{id: 1, rating: 5}]}),
  ]}));
records.push(frame(records.length, 'dwarfmode/Stocks', {families: ['stocks_items'], slices: [
  ok('stock_item_selected.v1', {surface: 'stocks', item_id: null, stock_category: 1},
    {filter_active: false, filter_nonempty: false}),
]}));
records.push(frame(records.length, 'dwarfmode/ViewSheets/ITEM', {families: ['stocks_items'], slices: [
  ok('stock_item_selected.v1', {surface: 'item', item_id: 77, stock_category: 1},
    {type: 1, subtype: 2, holder_refs: [], contained_item_ids: []}),
]}));
records.push(frame(records.length, 'dwarfmode/Zone', {families: ['zones_locations'], slices: [
  ok('place_selected.v1', {place_kind: 'zone', building_id: 10, site_id: null, location_id: null},
    {assigned_unit_ids: [], assigned_squad_ids: []}),
]}));
records.push(frame(records.length, 'dwarfmode/LocationDetails', {families: ['zones_locations'], slices: [
  ok('place_selected.v1', {place_kind: 'location', building_id: null, site_id: 15, location_id: 20},
    {location_type: 2}),
]}));
for (const [viewTab, tabName] of [[0, 'Tasks'], [1, 'Workers']]) records.push(frame(records.length,
  `dwarfmode/ViewSheets/BUILDING/Workshop/Still/${tabName}`, {
  families: ['buildings_workshops'], slices: [
    ok('building_selected.v1', {building_id: 30, building_type: 1,
      picker_stage: 0, selected_job_id: null},
    {view_tab: viewTab, job_ids: [], contained_item_ids: []}),
  ],
}));
records.push(frame(records.length, 'dwarfmode/Squads/Default', {families: ['squads'], slices: [
  ok('squad_ui.v1', {mode: 0, squad_id: null, schedule_month: null, schedule_routine: null},
    {selected_identity_complete: false, viewing_squad_index: 0}),
]}));
records.push(frame(records.length, 'dwarfmode/Squads/Equipment/Default', {families: ['squads'], slices: [
  ok('squad_ui.v1', {mode: 0, squad_id: null, schedule_month: null, schedule_routine: null},
    {selected_identity_complete: false, viewing_squad_index: 0}),
]}));
records.push(frame(records.length, 'dwarfmode/Squads/Schedule', {families: ['squads'], slices: [
  ok('squad_ui.v1', {mode: 3, squad_id: 40, schedule_month: 1, schedule_routine: 2},
    {selected_identity_complete: true}),
]}));
records.push(frame(records.length, 'world/CIVILIZATIONS', {families: ['world'], slices: [
  ok('world_ui.v1', {focus: ['world/CIVILIZATIONS'], viewscreen_type: 'viewscreen_worldst',
    tab: 1, selected_index: null},
    {selection_kind: 'civilization', selection_id: null, identity_complete: false}),
]}));
records.push(frame(records.length, 'world/NEWS', {families: ['world'], slices: [
  ok('world_ui.v1', {focus: ['world/NEWS'], viewscreen_type: 'viewscreen_worldst',
    tab: 4, selected_index: null},
    {selection_kind: 'news', selection_id: null, identity_complete: false}),
]}));
for (const [family, focus] of [
  ['designation', 'dwarfmode/Designate/DIG_DIG'], ['build', 'dwarfmode/Building'],
  ['zone', 'dwarfmode/Zone'], ['stockpile', 'dwarfmode/Stockpile'],
  ['burrow', 'dwarfmode/Burrow'], ['hauling', 'dwarfmode/Hauling'],
]) {
  records.push(frame(records.length, focus, {families: ['palettes_controls'], slices: [
    ok('control_palette.v1', {tool_family: family, mode: 0, stage: 0}, {}),
  ]}));
}
records.push(frame(records.length, 'dwarfmode/Default', {families: ['unmatched']}));

const passing = {manifest, records};
const report = gradeV3Qualification(passing, plan);
assert.equal(report.result, 'PASS');
assert.deepEqual(Object.keys(report.okBySlice), plan.oneRestartSliceIds);
assert.ok(Object.values(report.okBySlice).every(count => count > 0), 'all eight P0 slices have ok coverage');
assert.equal(report.recoveredBusy, 1, 'a busy gap is accepted only after later recovery');

const missingP0 = clone(passing);
for (const record of missingP0.records) {
  const index = record.slices.findIndex(slice => slice.id === 'world_ui.v1');
  if (record.slices[index].status === 'ok') record.slices[index] = gap('world_ui.v1');
}
assert.throws(() => gradeV3Qualification(missingP0, plan), /P0 slices without an ok occurrence: world_ui\.v1/);

const faulted = clone(passing);
faulted.records[0].slices[2] = gap('stock_item_selected.v1', 'fault', 'seh_fault');
assert.throws(() => gradeV3Qualification(faulted, plan), /fault\/cap evidence/);

const capped = clone(passing);
capped.records[0].slices[2] = gap('stock_item_selected.v1', 'unsupported', 'cap_exceeded');
assert.throws(() => gradeV3Qualification(capped, plan), /fault\/cap evidence/);

const unrecovered = clone(passing);
unrecovered.records.at(-1).slices[1] = gap('unit_selected.v1', 'busy', 'core_busy');
assert.throws(() => gradeV3Qualification(unrecovered, plan), /busy slice never recovered later/);

const duplicate = clone(passing);
duplicate.records[0].slices[2] = clone(duplicate.records[0].slices[1]);
assert.throws(() => gradeV3Qualification(duplicate, plan), /duplicate slice id/);

const unknownStatus = clone(passing);
unknownStatus.records[0].slices[1].status = 'maybe';
assert.throws(() => gradeV3Qualification(unknownStatus, plan), /unknown status maybe/);

const unknownField = clone(passing);
const unitOk = unknownField.records.find(record =>
  record.slices.some(slice => slice.id === 'unit_selected.v1' && slice.status === 'ok'));
unitOk.slices.find(slice => slice.id === 'unit_selected.v1').payload.secret_extra = 1;
assert.throws(() => gradeV3Qualification(unknownField, plan), /unknown fields secret_extra/);

const privacyLeak = clone(passing);
privacyLeak.records[1].slices[1].payload.inventory = [{password: 'do-not-record'}];
assert.throws(() => gradeV3Qualification(privacyLeak, plan), /forbidden state field password/);

const nonOkPayload = clone(passing);
nonOkPayload.records[0].slices[1].payload.inventory = [];
assert.throws(() => gradeV3Qualification(nonOkPayload, plan), /non-ok payload must be empty/);

const missingReason = clone(passing);
delete missingReason.records[0].slices[1].reason;
assert.throws(() => gradeV3Qualification(missingReason, plan), /missing fields reason/);

const routeMismatch = clone(passing);
routeMismatch.records[0].slices[0].identity.route_stamp = 'AAAAAAAAAAAAAAAA';
assert.throws(() => gradeV3Qualification(routeMismatch, plan), /route hashes differ/);

const manifestExtra = clone(passing);
manifestExtra.manifest.unreviewed = true;
assert.throws(() => gradeV3Qualification(manifestExtra, plan), /unknown fields unreviewed/);

const manifestDuplicate = clone(passing);
manifestDuplicate.manifest.enabled_slices[2] = clone(manifestDuplicate.manifest.enabled_slices[1]);
assert.throws(() => gradeV3Qualification(manifestDuplicate, plan), /duplicate enabled slice id/);

const manifestOrder = clone(passing);
[manifestOrder.manifest.enabled_slices[1], manifestOrder.manifest.enabled_slices[2]] =
  [manifestOrder.manifest.enabled_slices[2], manifestOrder.manifest.enabled_slices[1]];
assert.throws(() => gradeV3Qualification(manifestOrder, plan), /not in plan order/);

const unstableUnit = clone(passing);
const unitRecords = unstableUnit.records.filter(record =>
  record.slices.some(slice => slice.id === 'unit_selected.v1' && slice.status === 'ok'));
unitRecords[1].slices[1].identity.unit_id = 43;
assert.throws(() => gradeV3Qualification(unstableUnit, plan), /stable unit identity across tabs/);

const unchangedBuildingTab = clone(passing);
for (const record of unchangedBuildingTab.records) {
  const slice = record.slices.find(candidate =>
    candidate.id === 'building_selected.v1' && candidate.status === 'ok');
  if (slice) slice.payload.view_tab = 0;
}
assert.throws(() => gradeV3Qualification(unchangedBuildingTab, plan), /view-tab changes/);

const missingEquipment = clone(passing);
missingEquipment.records = missingEquipment.records.filter(record =>
  !record.focus.some(focus => focus.startsWith('dwarfmode/Squads/Equipment')));
assert.throws(() => gradeV3Qualification(missingEquipment, plan), /lacks the equipment view/);

const nonNumericSchedule = clone(passing);
const schedule = nonNumericSchedule.records.find(record =>
  record.focus.some(focus => focus.startsWith('dwarfmode/Squads/Schedule')))
  .slices.find(slice => slice.id === 'squad_ui.v1');
schedule.identity.schedule_month = null;
assert.throws(() => gradeV3Qualification(nonNumericSchedule, plan), /numeric month\/routine/);

const missingNews = clone(passing);
missingNews.records = missingNews.records.filter(record =>
  !record.focus.some(focus => focus === 'world/NEWS'));
assert.throws(() => gradeV3Qualification(missingNews, plan), /world\/NEWS tab evidence/);

const wrongPaletteFamily = clone(passing);
const designation = wrongPaletteFamily.records.find(record =>
  record.focus.some(focus => focus.startsWith('dwarfmode/Designate')))
  .slices.find(slice => slice.id === 'control_palette.v1');
designation.identity.tool_family = 'dig';
assert.throws(() => gradeV3Qualification(wrongPaletteFamily, plan), /lacks designation family evidence/);

const noDefaultReturn = clone(passing);
noDefaultReturn.records.pop();
assert.throws(() => gradeV3Qualification(noDefaultReturn, plan), /did not return to dwarfmode\/Default/);

console.log('flight recorder v3 qualification: PASS (all 8 P0 slices, route assertions, gaps/recovery, schema/status/privacy failures)');
