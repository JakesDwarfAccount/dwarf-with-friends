// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

import {loadRecorderV3Plan, validateV3Manifest,
  validateV3Record} from '../ground_truth/recorder_v3_contract.mjs';

function fail(message) { throw new Error(message); }
function okSlices(records, id) {
  return records.flatMap((record, ordinal) => record.slices
    .filter(slice => slice.id === id && slice.status === 'ok')
    .map(slice => ({...slice, ordinal, record})));
}
function distinct(values) { return new Set(values.map(value => JSON.stringify(value))).size; }
function recordHasFocus(item, selector) {
  return item.record.focus.some(focus => focus === selector || focus.startsWith(`${selector}/`));
}

export function gradeV3Qualification(session, plan = loadRecorderV3Plan()) {
  const enabled = validateV3Manifest(session.manifest, plan);
  if (!Array.isArray(session.records) || !session.records.length) fail('qualification has no records');
  session.records.forEach(record => validateV3Record(record, session.manifest, plan));

  const required = plan.oneRestartSliceIds;
  const enabledIds = enabled.map(slice => slice.id);
  if (JSON.stringify(enabledIds) !== JSON.stringify(required)) {
    fail(`qualification must enable all P0 slices in plan order expected=${required.join(',')}`);
  }
  const all = session.records.flatMap((record, ordinal) => record.slices.map(slice => ({slice, ordinal})));
  const fatal = all.filter(({slice}) => slice.status === 'fault' || slice.reason === 'cap_exceeded');
  if (fatal.length) fail(`qualification has fault/cap evidence: ${fatal.map(item => item.slice.id).join(',')}`);
  for (const {slice, ordinal} of all.filter(item => item.slice.status === 'busy')) {
    const recovered = all.some(item => item.ordinal > ordinal && item.slice.id === slice.id &&
      item.slice.status === 'ok');
    if (!recovered) fail(`busy slice never recovered later: ${slice.id} at record ${ordinal}`);
  }
  const missing = required.filter(id => !okSlices(session.records, id).length);
  if (missing.length) fail(`P0 slices without an ok occurrence: ${missing.join(',')}`);

  const units = okSlices(session.records, 'unit_selected.v1');
  const stableUnitTabs = units.some(left => units.some(right =>
    left.identity.unit_id === right.identity.unit_id &&
    (left.identity.active_sheet !== right.identity.active_sheet ||
      left.identity.active_sub_tab !== right.identity.active_sub_tab)));
  if (!stableUnitTabs) fail('unit route did not prove one stable unit identity across tabs');

  const stocks = okSlices(session.records, 'stock_item_selected.v1');
  if (!stocks.some(item => item.identity.item_id === null)) fail('stocks route lacks category-only null item identity');
  if (!stocks.some(item => Number.isInteger(item.identity.item_id))) fail('stocks route lacks a resolved item identity');

  const places = okSlices(session.records, 'place_selected.v1');
  if (!places.some(item => Number.isInteger(item.identity.building_id)) ||
      !places.some(item => Number.isInteger(item.identity.site_id) &&
        Number.isInteger(item.identity.location_id)))
    fail('place route did not capture both building identity and site-local location identity');

  const buildings = okSlices(session.records, 'building_selected.v1');
  const buildingTabs = new Map();
  for (const item of buildings) {
    if (!Number.isInteger(item.identity.building_id) || !Number.isInteger(item.payload.view_tab)) continue;
    if (!buildingTabs.has(item.identity.building_id)) buildingTabs.set(item.identity.building_id, new Set());
    buildingTabs.get(item.identity.building_id).add(JSON.stringify(item.payload.view_tab));
  }
  if (![...buildingTabs.values()].some(tabs => tabs.size >= 2)) {
    fail('building route did not prove view-tab changes for one building identity');
  }

  const squads = okSlices(session.records, 'squad_ui.v1');
  if (!squads.some(item => recordHasFocus(item, 'dwarfmode/Squads/Default') &&
      item.payload.selected_identity_complete === false && item.identity.squad_id === null)) {
    fail('squad route lacks an honest index-only incomplete identity');
  }
  if (!squads.some(item => recordHasFocus(item, 'dwarfmode/Squads/Equipment'))) {
    fail('squad route lacks the equipment view');
  }
  if (!squads.some(item =>
      (recordHasFocus(item, 'dwarfmode/Squads/Schedule') ||
        recordHasFocus(item, 'dwarfmode/Squads/EditingSchedule')) &&
      item.payload.selected_identity_complete === true && Number.isInteger(item.identity.squad_id) &&
      Number.isInteger(item.identity.schedule_month) && Number.isInteger(item.identity.schedule_routine))) {
    fail('squad route lacks a complete direct schedule identity with numeric month/routine');
  }

  const world = okSlices(session.records, 'world_ui.v1');
  for (const [tab, focus] of [[1, 'world/CIVILIZATIONS'], [4, 'world/NEWS']]) {
    if (!world.some(item => recordHasFocus(item, focus) && item.identity.tab === tab &&
        item.payload.identity_complete === false && item.payload.selection_id == null)) {
      fail(`world route lacks honest incomplete ${focus} tab evidence`);
    }
  }

  const palettes = okSlices(session.records, 'control_palette.v1');
  const expectedPalettes = new Map([
    ['designation', 'dwarfmode/Designate'], ['build', 'dwarfmode/Building'],
    ['zone', 'dwarfmode/Zone'], ['stockpile', 'dwarfmode/Stockpile'],
    ['burrow', 'dwarfmode/Burrow'], ['hauling', 'dwarfmode/Hauling'],
  ]);
  const paletteEvidence = [];
  for (const [family, focus] of expectedPalettes) {
    const item = palettes.find(candidate => candidate.identity.tool_family === family &&
      recordHasFocus(candidate, focus));
    if (!item) fail(`palette route lacks ${family} family evidence at ${focus}`);
    paletteEvidence.push(item);
  }
  if (distinct(paletteEvidence.map(item => item.record.route_stamp)) !== expectedPalettes.size) {
    fail('palette route needs six distinct route stamps');
  }
  const lastPaletteOrdinal = Math.max(...paletteEvidence.map(item => item.ordinal));
  const returnedToDefault = okSlices(session.records, 'route_context.v1').some(item =>
    item.ordinal > lastPaletteOrdinal && recordHasFocus(item, 'dwarfmode/Default'));
  if (!returnedToDefault) fail('palette route did not return to dwarfmode/Default');

  return {
    result: 'PASS', records: session.records.length, enabledSlices: enabledIds,
    okBySlice: Object.fromEntries(required.map(id => [id, okSlices(session.records, id).length])),
    nonOkGaps: all.filter(item => item.slice.status !== 'ok').length,
    recoveredBusy: all.filter(item => item.slice.status === 'busy').length,
    qualificationRoutes: plan.qualificationWave.map(route => route.id),
  };
}

function parseFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) fail('session needs a manifest and at least one frame');
  return {manifest: JSON.parse(lines[0]), records: lines.slice(1).map(line => JSON.parse(line))};
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tools/harness/flight_recorder_v3_qualification.mjs SESSION.jsonl');
    process.exitCode = 2;
    return;
  }
  try {
    const report = gradeV3Qualification(parseFile(path.resolve(file)));
    console.log(`flight recorder v3 qualification: PASS records=${report.records} gaps=${report.nonOkGaps}`);
  } catch (error) {
    console.error(`flight recorder v3 qualification: FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
