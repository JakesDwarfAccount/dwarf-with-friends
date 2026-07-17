-- b285_exec_tests.lua -- executes the B285 wave-2 condition write path against fixture orders.
-- Appended after dwf.lua by b285_condition_editor_lua_exec_test.py. TAP-ish output.
-- SPDX-License-Identifier: AGPL-3.0-only

local M = MODULE_ENV
local t, fails = 0, 0
local function check(name, ok, extra)
  t = t + 1
  if ok then print(('ok %d - %s'):format(t, name))
  else
    fails = fails + 1
    print(('not ok %d - %s%s'):format(t, name, extra ~= nil and (' -- ' .. tostring(extra)) or ''))
  end
end

-- fixture: the oracle's barrel order + one unrelated order
local order = { id = 285, job_type = df.job_type.MakeBarrel, amount_total = 10, amount_left = 10,
  item_conditions = dfvec(), order_conditions = dfvec() }
local other = { id = 12, job_type = df.job_type.ConstructBed,
  item_conditions = dfvec(), order_conditions = dfvec() }
df.global.world.manager_orders.all = dfvec({ order, other })

-- ---- ADD round-trip -------------------------------------------------------------------------
local ok, msg = M.add_item_condition(285, 'LessThan', 10, 'BARREL', '', 'empty')
check('add: validated write accepted', ok, msg)
check('add: entry landed on the order', #order.item_conditions == 1)
local c = order.item_conditions[0]
check('add: fields carry DF semantics (compare/value/type/subtype/mat sentinels)',
  c.compare_type == df.logic_condition_type.LessThan and c.compare_val == 10 and
  c.item_type == df.item_type.BARREL and c.item_subtype == -1 and
  c.mat_type == -1 and c.mat_index == -1)
check('add: no-init-value sentinels forced to -1 (metal_ore/has_tool_use/dye_color/min_dimension/reaction_id)',
  c.metal_ore == -1 and c.has_tool_use == -1 and c.dye_color == -1 and
  c.min_dimension == -1 and c.reaction_id == -1)
check('add: the native `empty` bit set through the validated adjective path',
  c.flags1.empty == true)
local ok2, msg2 = M.add_item_condition(285, 'LessThan', 10, 'BARREL', '', 'empty')
check('add: exact duplicate is a no-op with a clear message',
  ok2 == true and msg2 == 'condition already exists' and #order.item_conditions == 1)

-- ---- serializer round-trip: the merged read view renders what the editor wrote ---------------
local json = M.conditions_json(order)
check('serializer: exact native sentence for the write (lowercase item label, oracle wording)',
  json:find('Amount of empty barrels available is less than 10', 1, true) ~= nil)
check('serializer: adjective key round-trips as `empty`',
  json:find('"adjective":"empty"', 1, true) ~= nil)
check('serializer: no satisfaction invented (DF conditions view is not open on this fixture)',
  json:find('"satisfied":null', 1, true) ~= nil)

-- ---- EDIT in place ----------------------------------------------------------------------------
local before = order.item_conditions[0]
ok, msg = M.edit_item_condition(285, 0, 'GreaterThan', 5, 'WOOD', '420:12', 'wood')
check('edit: validated in-place write accepted', ok, msg)
check('edit: SAME entry object mutated (identity preserved, no remove+add)',
  order.item_conditions[0] == before and #order.item_conditions == 1)
check('edit: fields rewritten to the new full state',
  before.compare_type == df.logic_condition_type.GreaterThan and before.compare_val == 5 and
  before.item_type == df.item_type.WOOD and before.mat_type == 420 and before.mat_index == 12)
check('edit: old adjective bit cleared, new one set',
  before.flags1.empty == false and before.flags3.wood == true)
check('edit: subtype reset when the item type changed', before.item_subtype == -1)

-- ---- malformed writes REFUSED, with the reason named (both add and edit) ----------------------
local cases = {
  { 'comparison NONE (the -1 sentinel)', { 'NONE', 5, 'BARREL', '', '' }, 'bad comparison' },
  { 'unknown comparison', { 'Sometimes', 5, 'BARREL', '', '' }, 'bad comparison' },
  { 'unknown item type', { 'AtLeast', 5, 'ADAMANTINE_SOCKS', '', '' }, 'bad item type' },
  { 'malformed material pair', { 'AtLeast', 5, 'BARREL', 'oak', '' }, 'bad material' },
  { 'well-formed but NONEXISTENT material', { 'AtLeast', 5, 'BARREL', '999:999', '' }, 'bad material' },
  { 'unknown adjective', { 'AtLeast', 5, 'BARREL', '', 'shiny' }, 'bad adjective' },
  { 'non-numeric value', { 'AtLeast', 'lots', 'BARREL', '', '' }, 'bad value' },
}
for _, case in ipairs(cases) do
  local a = case[2]
  local okA, errA = M.add_item_condition(285, a[1], a[2], a[3], a[4], a[5])
  check('add refuses ' .. case[1],
    okA == false and tostring(errA):find(case[3], 1, true) ~= nil, errA)
  local okE, errE = M.edit_item_condition(285, 0, a[1], a[2], a[3], a[4], a[5])
  check('edit refuses ' .. case[1],
    okE == false and tostring(errE):find(case[3], 1, true) ~= nil, errE)
end
check('refused calls wrote NOTHING (vector length and entry state unchanged)',
  #order.item_conditions == 1 and before.compare_val == 5 and
  before.item_type == df.item_type.WOOD and before.mat_type == 420)
ok, msg = M.edit_item_condition(285, 7, 'AtLeast', 1, 'BARREL', '', '')
check('edit refuses a bad condition index',
  ok == false and tostring(msg):find('bad condition index', 1, true) ~= nil, msg)
ok, msg = M.edit_item_condition(9999, 0, 'AtLeast', 1, 'BARREL', '', '')
check('edit refuses an unknown order', ok == false, msg)

-- ---- REMOVE -----------------------------------------------------------------------------------
ok, msg = M.remove_condition(285, 'item', 0)
check('remove: erases the entry', ok == true and #order.item_conditions == 0, msg)
ok, msg = M.remove_condition(285, 'item', 0)
check('remove refuses a bad index',
  ok == false and tostring(msg):find('bad condition index', 1, true) ~= nil, msg)

-- ---- order-condition (dependency) add ----------------------------------------------------------
ok, msg = M.add_order_condition(285, 12, 'Completed')
check('order-condition: dependency added', ok == true and #order.order_conditions == 1, msg)
check('order-condition: fields written',
  order.order_conditions[0].order_id == 12 and
  order.order_conditions[0].condition == df.workquota_order_condition_type.Completed)
ok, msg = M.add_order_condition(285, 285, 'Completed')
check('order-condition: self-dependency refused', ok == false, msg)
ok, msg = M.add_order_condition(285, 12, 'WheneverConvenient')
check('order-condition: bad condition type refused', ok == false, msg)

-- ---- suggestions gate ---------------------------------------------------------------------------
local sj = M.suggested_conditions(285)
local n_labels = select(2, sj:gsub('"label"', ''))
check('suggestions: barrel order fails closed instead of serving an observed special case',
  n_labels == 0 and sj:find('"suggestions":[]', 1, true) ~= nil and
  sj:find('"deferred":true', 1, true) ~= nil, sj)
check('suggestions: deferred result is explicitly non-authoritative',
  sj:find('"authoritative":false', 1, true) ~= nil and
  sj:find('oracle-pinned', 1, true) == nil)
local sj2 = M.suggested_conditions(12)
check('suggestions: every other order uses the same empty deferred contract',
  sj2:find('"suggestions":[]', 1, true) ~= nil and
  sj2:find('"deferred":true', 1, true) ~= nil, sj2)

if fails > 0 then error(('B285_EXEC: %d of %d checks FAILED'):format(fails, t), 0) end
print(('B285_EXEC ALL PASS (%d checks)'):format(t))
