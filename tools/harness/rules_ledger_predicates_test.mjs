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
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';

import {
    chooserSelection,
    eligible,
    graphicsNeedSelection,
    textModeChooserSelection,
} from '../../docs/reference/rules-ledger/predicates/0001-status-thresholds.mjs';
import {
    COMPARE,
    EMPTY_FLAG,
    sameItemFilter,
    visibleSuggestions,
} from '../../docs/reference/rules-ledger/predicates/0002-work-order-suggestions.mjs';
import {
    workOrderConditionStatus,
} from '../../docs/reference/rules-ledger/predicates/0003-work-order-condition-status-colors.mjs';
import {
    engravingPanelSurface,
} from '../../docs/reference/rules-ledger/predicates/0004-engraved-floor-native-wall-wording.mjs';

// Rule 0001: graphics selection and text-mode chooser windows are distinct routes.
const needs = { hunger_timer: 50000, thirst_timer: 25000, sleepiness_timer: 57600 };
assert.deepEqual(eligible(needs), ['hungry', 'drowsy', 'thirsty']);
assert.equal(textModeChooserSelection(needs, 199), 'hungry');
assert.equal(textModeChooserSelection(needs, 200), null);
assert.equal(textModeChooserSelection(needs, 300), 'drowsy');
assert.equal(textModeChooserSelection(needs, 500), 'thirsty');
assert.equal(chooserSelection(needs, 199), 'hungry', 'compatibility alias remains text-mode only');
assert.equal(graphicsNeedSelection(needs), 'thirsty', 'graphics needs prioritize thirst');
assert.equal(graphicsNeedSelection({ hunger_timer: 50000, sleepiness_timer: 57600 }), 'hungry');
assert.equal(graphicsNeedSelection({ sleepiness_timer: 57600 }), 'drowsy');
assert.equal(graphicsNeedSelection(needs, { higherPriorityIndicator: 1 }), null);
assert.deepEqual(eligible({ hunger_timer: 49999, thirst_timer: 24999, sleepiness_timer: 57599 }), []);

// Rule 0002: empty-container variant, product/input directions, and add-control suppression.
const suggestions = visibleSuggestions({
    products: [{ item_type: 'BARREL', mat_index: 7, contains: [1] }],
    required_inputs: [{ item_type: 0 }],
});
assert.deepEqual(
    suggestions.map(value => [value.compare_type, value.compare_val, value.flags1]),
    [
        [COMPARE.LessThan, 10, EMPTY_FLAG],
        [COMPARE.LessThan, 10, 0],
        [COMPARE.GreaterThan, 10, 0],
    ],
);
assert(sameItemFilter(
    { item_type: 17, mat_index: 7, contains: [1], compare_val: 10 },
    { item_type: 17, mat_index: 7, contains: [999], compare_val: 500 },
));
assert(!sameItemFilter(
    { item_type: 17, mat_index: 7 },
    { item_type: 17, mat_index: 8 },
));
const suppressed = visibleSuggestions({
    products: [{ item_type: 'BARREL', mat_index: 7, contains: [1] }],
    existing: [{ item_type: 17, mat_index: 7, contains: [999], compare_val: 500 }],
});
assert.equal(suppressed.length, 2, 'matching rows remain visible');
assert.equal(suppressed[0].flags1, EMPTY_FLAG);
assert.equal(suppressed[0].add_available, true);
assert.equal(suppressed[1].flags1, 0);
assert.equal(suppressed[1].add_available, false, 'matching existing condition removes only add control');

// Rule 0003: cached satisfaction chooses the exact native text attributes.
assert.deepEqual(workOrderConditionStatus(true), {
    text: 'Satisfied for next check', foreground: 2, background: 0, bright: true,
});
assert.deepEqual(workOrderConditionStatus(false), {
    text: 'Not satisfied for next check', foreground: 4, background: 0, bright: true,
});

// Rule 0004: physical surface and native simple-prose wording are independent facts.
assert.deepEqual(engravingPanelSurface(true), {
    surface: 'floor', proseSurface: 'wall', opening: 'Engraved on the wall is ',
});
assert.deepEqual(engravingPanelSurface(false), {
    surface: 'wall', proseSurface: 'wall', opening: 'Engraved on the wall is ',
});

console.log('rules ledger predicates: 20 assertions passed');
