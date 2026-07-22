-- ---------------------------------------------------------------------------
-- Burial / memorial flows (Phase 5)
-- ---------------------------------------------------------------------------

function vec_has_ptr(vec, ptr)
    if not vec or not ptr then return false end
    for _, v in ipairs(vec) do if v == ptr then return true end end
    return false
end

function get_built_coffin(id)
    local b = df.building.find(tonumber(id) or -1)
    if not b or not df.building_coffinst:is_instance(b) then return nil, 'building is not a coffin' end
    local ok_built, built = pcall(function() return b:getBuildStage() >= b:getMaxBuildStage() end)
    if not ok_built or not built then return nil, 'coffin is not built' end
    return b, ''
end

function tomb_for_coffin(coffin)
    if not coffin then return nil end
    for _, z in ipairs(coffin.relations or {}) do
        if z and df.building_civzonest:is_instance(z) and z.type == df.civzone_type.Tomb then return z end
    end
    local other = df.global.world and df.global.world.buildings and df.global.world.buildings.other
    for _, z in ipairs((other and other.ZONE_TOMB) or {}) do
        if z and vec_has_ptr(z.contained_buildings, coffin) then return z end
    end
    return nil
end

function link_coffin_tomb(coffin, tomb)
    if not coffin or not tomb then return end
    if not vec_has_ptr(tomb.contained_buildings, coffin) then tomb.contained_buildings:insert('#', coffin) end
    if not vec_has_ptr(coffin.relations, tomb) then coffin.relations:insert('#', tomb) end
end

function ensure_tomb_for_coffin(coffin)
    local tomb = tomb_for_coffin(coffin)
    if tomb then return tomb, '' end
    local id, err = create_zone(coffin.x1, coffin.y1, coffin.x1, coffin.y1, coffin.z, 'tomb')
    if not id or id < 0 then return nil, err or 'could not create tomb zone' end
    tomb = df.building.find(id)
    if not tomb or not df.building_civzonest:is_instance(tomb) or tomb.type ~= df.civzone_type.Tomb then
        return nil, 'created zone was not a tomb'
    end
    link_coffin_tomb(coffin, tomb)
    return tomb, ''
end

function unit_display_name(unit)
    if not unit then return '' end
    local ok, name = pcall(dfhack.units.getReadableName, unit)
    if ok and name and #name > 0 then return name end
    ok, name = pcall(dfhack.units.getRaceName, unit)
    if ok and name and #name > 0 then return name end
    return 'Unit ' .. tostring(unit.id)
end

function clear_tomb_owner(tomb)
    if not tomb then return end
    local old = df.unit.find(tomb.assigned_unit_id or -1)
    if old and old.owned_buildings then
        for i = #old.owned_buildings - 1, 0, -1 do
            if old.owned_buildings[i] == tomb then old.owned_buildings:erase(i) end
        end
    end
    tomb.assigned_unit_id = -1
    tomb.owner_unit_cached_index = -1
    tomb.retained_owner = -1
end

function burial_coffin_info(id)
    local coffin, err = get_built_coffin(id)
    if not coffin then return '{"ok":false,"error":' .. json_string(err) .. '}\n' end
    local tomb = tomb_for_coffin(coffin)
    local owner = tomb and df.unit.find(tomb.assigned_unit_id or -1) or nil
    local tname = tomb and building_label(tomb) or ''
    return '{"ok":true,"isCoffin":true,"built":true' ..
        ',"id":' .. tostring(coffin.id) ..
        ',"name":' .. json_string(building_label(coffin)) ..
        ',"tombId":' .. tostring(tomb and tomb.id or -1) ..
        ',"tombName":' .. json_string(tname) ..
        ',"owner":{"id":' .. tostring(owner and owner.id or -1) .. ',"name":' .. json_string(unit_display_name(owner)) .. '}' ..
        ',"tomb":{"citizens":' .. json_bool(tomb and not tomb.zone_settings.tomb.flags.no_citizens) ..
        ',"pets":' .. json_bool(tomb and not tomb.zone_settings.tomb.flags.no_pets) .. '}}\n'
end

function burial_coffin_action(id, action)
    local coffin, err = get_built_coffin(id)
    if not coffin then return false, err end
    action = tostring(action or '')
    local tomb = tomb_for_coffin(coffin)
    if action == 'ensure-tomb' or action == 'any-citizen' or action == 'citizens-on' or
            action == 'citizens-off' or action == 'pets-on' or action == 'pets-off' then
        tomb, err = ensure_tomb_for_coffin(coffin)
        if not tomb then return false, err end
    else
        return false, 'unknown coffin action'
    end
    if action == 'any-citizen' then
        clear_tomb_owner(tomb)
        tomb.zone_settings.tomb.flags.no_citizens = false
        tomb.zone_settings.tomb.flags.no_pets = true
    elseif action == 'citizens-on' then tomb.zone_settings.tomb.flags.no_citizens = false
    elseif action == 'citizens-off' then tomb.zone_settings.tomb.flags.no_citizens = true
    elseif action == 'pets-on' then tomb.zone_settings.tomb.flags.no_pets = false
    elseif action == 'pets-off' then tomb.zone_settings.tomb.flags.no_pets = true
    end
    link_coffin_tomb(coffin, tomb)
    return true, ''
end

function has_memorial_slab_or_order(hfid)
    local world = df.global.world
    if not world then return false end
    for _, o in ipairs(world.manager_orders.all) do
        if o and o.job_type == df.job_type.EngraveSlab and o.specdata.hist_figure_id == hfid then
            return true, 'memorial slab order already exists'
        end
    end
    for _, slab in ipairs(world.items.other.SLAB) do
        if slab and df.item_slabst:is_instance(slab) and
                slab.engraving_type == df.slab_engraving_type.Memorial and slab.topic == hfid then
            return true, 'memorial slab already engraved'
        end
    end
    return false, ''
end

function queue_memorial_slab(unit_id)
    local world = df.global.world
    if not world then return false, 'world unavailable' end
    local unit = df.unit.find(tonumber(unit_id) or -1)
    if not unit then return false, 'unit not found' end
    local alive = false
    pcall(function() alive = dfhack.units.isAlive(unit) end)
    if alive then return false, 'cannot memorialize a living unit' end
    local own = false
    pcall(function() own = dfhack.units.isOwnGroup(unit) end)
    if not own then return false, 'unit is not from this fortress' end
    local hfid = unit.hist_figure_id or -1
    if hfid < 0 then return false, 'unit has no historical figure id' end
    local exists, why = has_memorial_slab_or_order(hfid)
    if exists then return false, why end

    local order = df.manager_order:new()
    order.id = world.manager_orders.manager_order_next_id
    world.manager_orders.manager_order_next_id = world.manager_orders.manager_order_next_id + 1
    order.job_type = df.job_type.EngraveSlab
    order.specdata.hist_figure_id = hfid
    order.amount_left = 1
    order.amount_total = 1
    order.frequency = df.workquota_frequency_type.OneTime
    world.manager_orders.all:insert('#', order)
    return true, 'memorial slab order queued'
end

-- Workshops/furnaces that can receive workshop-specific manager orders.
function order_workshops()
    local ok, result = pcall(function()
    local rows, seen = {}, {}
    local function add_vec(vec, kind)
        if not vec then return end
        for i = 0, #vec - 1 do
            local b = vec[i]
            if b and b.id and not seen[b.id] then
                seen[b.id] = true
                table.insert(rows, {
                    id = b.id,
                    label = building_label(b),
                    kind = kind,
                    x = b.centerx or b.x1 or 0,
                    y = b.centery or b.y1 or 0,
                    z = b.z or 0,
                })
            end
        end
    end
    local other = df.global.world and df.global.world.buildings and df.global.world.buildings.other
    if other then
        add_vec(other.WORKSHOP_ANY, 'Workshop')
        add_vec(other.FURNACE_ANY, 'Furnace')
    end
    table.sort(rows, function(a, b)
        if a.label == b.label then return a.id < b.id end
        return a.label < b.label
    end)
    local out = {}
    for _, b in ipairs(rows) do
        table.insert(out, '{"id":' .. tostring(b.id) ..
            ',"label":' .. json_string(b.label) ..
            ',"kind":' .. json_string(b.kind) ..
            ',"x":' .. tostring(b.x) ..
            ',"y":' .. tostring(b.y) ..
            ',"z":' .. tostring(b.z) .. '}')
    end
    return '{"ok":true,"workshops":[' .. table.concat(out, ',') .. ']}\n'
    end)
    if ok and result then return result end
    return '{"ok":false,"workshops":[],"error":' .. json_string(result) .. '}\n'
end

-- DIAG (crash hunt): flush-guaranteed file tracer. Open/write/close per line so the
-- line is durably on disk BEFORE the next operation runs -> the last line in the file
-- is unambiguously the last thing that executed before a hard crash.
--
-- Single debug gate, DEFAULT OFF. Every DIAG trace in this file (order_material, workshop_info,
-- add_task, create_shop_order, shop_tasks, DUMP-JOB) routes through wtrace(), so this one flag
-- silences the whole family. Unguarded, wtrace does a printerr + open/append/close file write
-- PER order row PER panel refresh -- render-thread frame cost + stderr.log/dwf-wshop-trace.log
-- churn. The crash these traces were hunting is root-caused & fixed elsewhere (stockpile UI-cache
-- UAF, dump-proven 2026-07-16), so they are dormant instrumentation: flip DWF_DIAG to true only
-- when actively bisecting a NEW workshop/order crash.
DWF_DIAG = false
function wtrace(msg)
    if not DWF_DIAG then return end
    -- ALWAYS printerr (known to flush per-line in practice) so a trace exists even if file I/O
    -- is unavailable in DFHack's sandbox. The whole file attempt is wrapped in pcall so it can
    -- NEVER raise an error onto the render thread (a raised error here would itself crash).
    dfhack.printerr('dwf-wshop: ' .. tostring(msg))
    pcall(function()
        -- W1: was an absolute path into the ORIGINAL author's DF install ('C:/DaMain/...'), so on
        -- every other machine io.open returned nil and this tracer silently wrote nothing at all.
        -- DFHack's working directory IS the DF root (the plugin's own config files live there by
        -- the same rule), so a bare filename lands in the right place on anybody's install.
        local f = io.open('dwf-wshop-trace.log', 'a')
        if f and type(f) == 'userdata' then
            f:write(tostring(msg) .. '\n')
            f:close()
        end
    end)
end

-- Strip DFHack's "unknown material" placeholder so labels match DF's native UI, which simply omits
-- the material until a reagent is chosen ("Make bed", not "Make unknown material bed").
function strip_unknown_material(name)
    if not name then return name end
    name = name:gsub('%s+of unknown material', '')   -- "X of unknown material"
    name = name:gsub('unknown material%s+', '')       -- "unknown material X"
    name = name:gsub('%s+', ' '):gsub('^%s+', ''):gsub('%s+$', '')
    return name
end

-- Friendly display name for a manager order.
function order_label(o)
    local ok, name = pcall(dfhack.job.getManagerOrderName, o)
    if ok and name and #name > 0 then return strip_unknown_material(name) end
    if o.job_type == df.job_type.CustomReaction and o.reaction_name and #o.reaction_name > 0 then
        return o.reaction_name
    end
    local jt = df.job_type[o.job_type]
    if not jt then return 'Job #' .. tostring(o.job_type) end
    -- "ConstructBed" -> "Construct Bed"
    return (jt:gsub('(%l)(%u)', '%1 %2'))
end

function order_material(o)
    if not o.mat_type or o.mat_type < 0 then return '' end
    wtrace('order_material: decode mat_type=' .. tostring(o.mat_type) ..
        ' mat_index=' .. tostring(o.mat_index))   -- DIAG (crash hunt): remove once localized
    local ok, mi = pcall(dfhack.matinfo.decode, o.mat_type, o.mat_index)
    if ok and mi then
        wtrace('order_material: toString')   -- DIAG
        local ok2, tok = pcall(function() return mi:toString() end)
        if ok2 and tok then return tok end
    end
    return ''
end

function item_type_label(it)
    if it == nil or it < 0 then return 'items' end
    local name = df.item_type[it]
    if not name then return 'item#' .. it end
    return ITEM_LABEL[name] or (name:lower():gsub('_', ' '))
end

local COMPARE_LABEL = {
    [df.logic_condition_type.AtLeast] = '>=',
    [df.logic_condition_type.AtMost] = '<=',
    [df.logic_condition_type.GreaterThan] = '>',
    [df.logic_condition_type.LessThan] = '<',
    [df.logic_condition_type.Exactly] = '=',
    [df.logic_condition_type.Not] = '!=',
}

-- Curated "adjective"/property filters for a stock condition (DF's "Adj"). key -> {flags group,
-- bit, label}. Setting the bit makes the condition only count items with that property.
local CONDITION_ADJECTIVES = {
    metal        = {'flags3', 'metal',        'metal'},
    wood         = {'flags3', 'wood',         'wooden'},
    stone        = {'flags3', 'stone',        'stone'},
    hard         = {'flags3', 'hard',         'hard'},
    edged        = {'flags3', 'edged',        'edged'},
    fire_safe    = {'flags2', 'fire_safe',    'fire-safe'},
    magma_safe   = {'flags2', 'magma_safe',   'magma-safe'},
    non_economic = {'flags2', 'non_economic', 'non-economic'},
    sharpenable  = {'flags1', 'sharpenable',  'sharpenable'},
    cookable     = {'flags1', 'cookable',     'cookable'},
    millable     = {'flags1', 'millable',     'millable'},
    dyeable      = {'flags2', 'dyeable',      'dyeable'},
}

-- Friendly adjective(s) already set on a condition, for display (e.g. "fire-safe metal").
function condition_adjective_label(c)
    local words = {}
    -- `empty` is the native barrel/bin/bucket condition shown by B285. It is a real
    -- job_item_flags1 bit, deliberately kept OUT of CONDITION_ADJECTIVES (this display loop
    -- special-cases it); the wave-2 write path accepts it explicitly via
    -- resolve_condition_adjectives.
    local ok_empty, empty = pcall(function() return c.flags1.empty end)
    if ok_empty and empty then table.insert(words, 'empty') end
    for _, spec in pairs(CONDITION_ADJECTIVES) do
        local ok, on = pcall(function() return c[spec[1]][spec[2]] end)
        if ok and on then table.insert(words, spec[3]) end
    end
    table.sort(words)
    return table.concat(words, ' ')
end

function condition_adjective_key(c)
    local keys = {}
    local ok_empty, empty = pcall(function() return c.flags1.empty end)
    if ok_empty and empty then table.insert(keys, 'empty') end
    for key, spec in pairs(CONDITION_ADJECTIVES) do
        local ok, on = pcall(function() return c[spec[1]][spec[2]] end)
        if ok and on then table.insert(keys, key) end
    end
    table.sort(keys)
    return table.concat(keys, ',')
end

function item_condition_label(c)
    local target = item_type_label(c.item_type)
    if c.mat_type and c.mat_type >= 0 then
        local ok, mi = pcall(dfhack.matinfo.decode, c.mat_type, c.mat_index)
        if ok and mi then
            local ok2, s = pcall(function() return mi:toString() end)
            if ok2 and s then target = s .. ' ' .. target end
        end
    end
    local adj = condition_adjective_label(c)
    if adj ~= '' then target = adj .. ' ' .. target end
    local cmp = COMPARE_LABEL[c.compare_type] or '?'
    return ('%s %s %d'):format(target, cmp, c.compare_val or 0)
end

-- Native comparison prose directly attested in WO-CONDITIONS-native.png. Other operators stay in
-- the compact enum-symbol form until an oracle pins their words; do not "complete" this by taste.
local COMPARE_DESCRIPTION = {
    [df.logic_condition_type.GreaterThan] = 'greater than',
    [df.logic_condition_type.LessThan] = 'less than',
}

function item_condition_description(c)
    local target = item_type_label(c.item_type)
    -- B285 wave-2 parity fix: the oracle prints "Amount of empty barrels...", but ITEM_LABEL
    -- capitalises ("Barrels") and the final first-char lowering below cannot reach it once an
    -- adjective/material is prepended ("empty Barrels" stayed capital-B). Lowercase the item
    -- label itself before composing.
    if #target > 0 then target = target:sub(1, 1):lower() .. target:sub(2) end
    if c.mat_type and c.mat_type >= 0 then
        local ok, mi = pcall(dfhack.matinfo.decode, c.mat_type, c.mat_index)
        if ok and mi then
            local ok2, s = pcall(function() return mi:toString() end)
            if ok2 and s and #s > 0 then target = s .. ' ' .. target end
        end
    end
    local adj = condition_adjective_label(c)
    if adj ~= '' then target = adj .. ' ' .. target end
    if #target > 0 then target = target:sub(1, 1):lower() .. target:sub(2) end
    local comparison = COMPARE_DESCRIPTION[c.compare_type]
    if not comparison then return item_condition_label(c) end
    return ('Amount of %s available is %s %d'):format(target, comparison, c.compare_val or 0)
end

local ORDER_COND_LABEL = {
    [df.workquota_order_condition_type.Activated] = 'is activated',
    [df.workquota_order_condition_type.Completed] = 'is completed',
}

function order_condition_label(c)
    return ('after #%d %s'):format(c.order_id, ORDER_COND_LABEL[c.condition] or '?')
end

-- DF does not expose the numeric "available" count or a callable manager-condition evaluator
-- through df-structures. It does expose the exact per-row result that DF calculated for the native
-- conditions view. Only publish that result while the view is open for this same order; stale bits
-- from another/closed view must never be presented as current truth.
function condition_satisfaction_vectors(o)
    local ok, item_results, order_results = pcall(function()
        local conditions = df.global.game.main_interface.info.work_orders.conditions
        if not conditions or not conditions.open or not conditions.wq or conditions.wq.id ~= o.id then
            return nil, nil
        end
        return conditions.item_condition_satisfied, conditions.order_condition_satisfied
    end)
    if not ok then return nil, nil end
    return item_results, order_results
end

function json_nullable_bool(v)
    if v == nil then return 'null' end
    return json_bool(v)
end

function condition_contains_json(c)
    local out = {}
    if c.contains then
        for i = 0, #c.contains - 1 do out[#out + 1] = tostring(c.contains[i]) end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function conditions_json(o)
    local items = {}
    local item_results, order_results = condition_satisfaction_vectors(o)
    local item_conditions = o.item_conditions
    if item_conditions then
        for i = 0, #item_conditions - 1 do
            local c = item_conditions[i]
            if c then
                local ok, label = pcall(item_condition_label, c)
                local ok_desc, description = pcall(item_condition_description, c)
                local satisfied = nil
                if item_results and i < #item_results then
                    satisfied = item_results[i] and true or false
                end
                table.insert(items, '{"idx":' .. i ..
                    ',"label":' .. json_string(ok and label or 'condition') ..
                    ',"description":' .. json_string(ok_desc and description or (ok and label or 'condition')) ..
                    ',"item":' .. json_string(df.item_type[c.item_type] or '') ..
                    ',"itemSubtype":' .. tostring(c.item_subtype or -1) ..
                    ',"compare":' .. json_string(df.logic_condition_type[c.compare_type] or '') ..
                    ',"value":' .. tostring(c.compare_val or 0) ..
                    ',"adjective":' .. json_string(condition_adjective_key(c)) ..
                    ',"material":' .. json_string((c.mat_type and c.mat_type >= 0) and (tostring(c.mat_type) .. ':' .. tostring(c.mat_index)) or '') ..
                    ',"matType":' .. tostring(c.mat_type or -1) ..
                    ',"matIndex":' .. tostring(c.mat_index or -1) ..
                    ',"flags1":' .. tostring(c.flags1.whole) ..
                    ',"flags2":' .. tostring(c.flags2.whole) ..
                    ',"flags3":' .. tostring(c.flags3.whole) ..
                    ',"flags4":' .. tostring(c.flags4 or 0) ..
                    ',"flags5":' .. tostring(c.flags5 or 0) ..
                    ',"reactionClass":' .. json_string(c.reaction_class or '') ..
                    ',"reactionProduct":' .. json_string(c.has_material_reaction_product or '') ..
                    ',"metalOre":' .. tostring(c.metal_ore or -1) ..
                    ',"minDimension":' .. tostring(c.min_dimension or -1) ..
                    ',"contains":' .. condition_contains_json(c) ..
                    ',"reactionId":' .. tostring(c.reaction_id or -1) ..
                    ',"toolUse":' .. json_string(df.tool_uses[c.has_tool_use] or '') ..
                    ',"dyeColor":' .. tostring(c.dye_color or -1) ..
                    ',"satisfied":' .. json_nullable_bool(satisfied) ..
                    ',"satisfactionSource":' .. (satisfied == nil and 'null' or json_string('df-ui')) .. '}')
            end
        end
    end
    local ords = {}
    local order_conditions = o.order_conditions
    if order_conditions then
        for i = 0, #order_conditions - 1 do
            local c = order_conditions[i]
            if c then
                local ok, label = pcall(order_condition_label, c)
                local satisfied = nil
                if order_results and i < #order_results then
                    satisfied = order_results[i] and true or false
                end
                table.insert(ords, '{"idx":' .. i ..
                    ',"label":' .. json_string(ok and label or 'dependency') ..
                    ',"other":' .. tostring(c.order_id or -1) ..
                    ',"type":' .. json_string(df.workquota_order_condition_type[c.condition] or '') ..
                    ',"satisfied":' .. json_nullable_bool(satisfied) ..
                    ',"satisfactionSource":' .. (satisfied == nil and 'null' or json_string('df-ui')) .. '}')
            end
        end
    end
    return '"itemConditions":[' .. table.concat(items, ',') ..
        '],"orderConditions":[' .. table.concat(ords, ',') .. ']'
end

-- List current manager orders as JSON (with conditions + workshop limits).
-- Is a manager (MANAGE_PRODUCTION noble) assigned to the fort? DF won't coordinate work orders
-- without one. Canonical check (see DFHack gui/extended-status): the fort entity's
-- assignments_by_type.MANAGE_PRODUCTION list is non-empty.
function has_manager()
    local ok, result = pcall(function()
        local ent = df.historical_entity.find(df.global.plotinfo.group_id)
        return ent and #ent.assignments_by_type.MANAGE_PRODUCTION > 0
    end)
    return (ok and result) and true or false
end

function list_orders()
    local mgr = has_manager()
    local ok, result = pcall(function()
    local out = {}
    local world = df.global.world
    local all = world and world.manager_orders and world.manager_orders.all
    if not all then return '{"ok":true,"hasManager":' .. json_bool(mgr) .. ',"orders":[]}\n' end
    for pos = 0, #all - 1 do
        local o = all[pos]
        if o then
        local ok_cond, cond_json = pcall(conditions_json, o)
        local parts = {
            '"id":' .. tostring(o.id),
            '"pos":' .. tostring(pos),
            '"job":' .. json_string(order_label(o)),
            '"item":' .. json_string((o.item_type and o.item_type >= 0 and df.item_type[o.item_type]) or ''),
            '"material":' .. json_string(order_material(o)),
            '"amountLeft":' .. tostring(o.amount_left),
            '"amountTotal":' .. tostring(o.amount_total),
            '"frequency":' .. json_string(df.workquota_frequency_type[o.frequency] or 'OneTime'),
            '"workshopId":' .. tostring(o.workshop_id or -1),
            '"workshopName":' .. json_string(building_label(df.building.find(o.workshop_id or -1))),
            '"maxWorkshops":' .. tostring(o.max_workshops or 0),
            '"active":' .. json_bool(o.status.active),
            '"validated":' .. json_bool(o.status.validated),
            ok_cond and cond_json or '"itemConditions":[],"orderConditions":[]',
        }
        table.insert(out, '{' .. table.concat(parts, ',') .. '}')
        end
    end
    return '{"ok":true,"hasManager":' .. json_bool(mgr) .. ',"orders":[' .. table.concat(out, ',') .. ']}\n'
    end)
    if ok and result then return result end
    return '{"ok":false,"hasManager":' .. json_bool(mgr) .. ',"orders":[],"error":' .. json_string(result) .. '}\n'
end
