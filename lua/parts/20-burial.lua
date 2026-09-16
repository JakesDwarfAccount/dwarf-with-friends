-- ---------------------------------------------------------------------------
-- Burial / memorial flows

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
    dwf_probe('lua.probe.unit-alive', function() alive = dfhack.units.isAlive(unit) end)
    if alive then return false, 'cannot memorialize a living unit' end
    local own = false
    dwf_probe('lua.probe.unit-own-group', function() own = dfhack.units.isOwnGroup(unit) end)
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

-- Debug gate for every wtrace() below; ON costs a file open/write/close per row per refresh.
DWF_DIAG = false
function wtrace(msg)
    if not DWF_DIAG then return end
    dfhack.printerr('dwf-wshop: ' .. tostring(msg))
    dwf_probe('lua.probe.wshop-trace-log', function()
        -- A BARE filename only: DFHack's working directory is the DF root, and an absolute path
        -- silently writes nothing on any machine but the one it was typed on.
        local f = io.open('dwf-wshop-trace.log', 'a')
        if f and type(f) == 'userdata' then
            f:write(tostring(msg) .. '\n')
            f:close()
        end
    end)
end

function strip_unknown_material(name)
    if not name then return name end
    name = name:gsub('%s+of unknown material', '')   -- "X of unknown material"
    name = name:gsub('unknown material%s+', '')       -- "unknown material X"
    name = name:gsub('%s+', ' '):gsub('^%s+', ''):gsub('%s+$', '')
    return name
end

function order_label(o)
    local ok, name = pcall(dfhack.job.getManagerOrderName, o)
    if ok and type(name) == 'string' and #name > 0
       and not name:lower():find('unknown material', 1, true) then
        local normalized = strip_unknown_material(name)
        if normalized and #normalized > 0 then return normalized end
    end
    if o.job_type == df.job_type.CustomReaction and o.reaction_name and #o.reaction_name > 0 then
        return o.reaction_name
    end
    local jt = df.job_type[o.job_type]
    if not jt then return 'Job #' .. tostring(o.job_type) end
    return pretty_enum_name(jt)
end

function order_material(o)
    if not o.mat_type or o.mat_type < 0 then return '' end
    wtrace('order_material: decode mat_type=' .. tostring(o.mat_type) ..
        ' mat_index=' .. tostring(o.mat_index))
    local ok, mi = pcall(dfhack.matinfo.decode, o.mat_type, o.mat_index)
    if ok and mi then
        wtrace('order_material: toString')
        local ok2, tok = pcall(function() return mi:toString() end)
        if ok2 and tok then return tok end
    end
    return ''
end

function item_type_label(it)
    if it == nil or it < 0 then return 'items' end
    local name = df.item_type[it]
    if not name then return 'item#' .. it end
    return ITEM_LABEL[name] or pretty_enum_name(name):lower()
end

local COMPARE_LABEL = {
    [df.logic_condition_type.AtLeast] = '>=',
    [df.logic_condition_type.AtMost] = '<=',
    [df.logic_condition_type.GreaterThan] = '>',
    [df.logic_condition_type.LessThan] = '<',
    [df.logic_condition_type.Exactly] = '=',
    [df.logic_condition_type.Not] = '!=',
}

-- Condition property filters (DF's "Adj"): key -> {flags group, bit, label}.
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

function condition_adjective_label(c)
    local words = {}
    -- 'empty' is a real job_item_flags1 bit, deliberately outside CONDITION_ADJECTIVES.
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

-- Comparison prose native is known to use; other operators stay in enum-symbol form.
local COMPARE_DESCRIPTION = {
    [df.logic_condition_type.GreaterThan] = 'greater than',
    [df.logic_condition_type.LessThan] = 'less than',
}

function item_condition_description(c)
    local target = item_type_label(c.item_type)
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

-- DF exposes no callable condition evaluator, only the native conditions view's own per-row
-- result. Publish it only while that view is open for THIS order, never a stale reading.
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

-- DF will not coordinate work orders without a MANAGE_PRODUCTION noble.
function has_manager()
    local ok, result = pcall(function()
        local ent = df.historical_entity.find(df.global.plotinfo.group_id)
        return ent and #ent.assignments_by_type.MANAGE_PRODUCTION > 0
    end)
    return (ok and result) and true or false
end

-- Must count exactly what src/hud.cpp is_counted_citizen counts (isCitizen or isResident,
-- minus corpses and ghosts); a disagreement makes two panels show different forts.
function fort_population()
    local ok, count = pcall(function()
        local n = 0
        local units = df.global.world and df.global.world.units and df.global.world.units.active or {}
        for _, unit in ipairs(units) do
            if unit and dfhack.units.isActive(unit)
                and not dfhack.units.isDead(unit)
                and not dfhack.units.isGhost(unit)
                and (dfhack.units.isCitizen(unit, true) or dfhack.units.isResident(unit, true)) then
                n = n + 1
            end
        end
        return n
    end)
    return (ok and count) or 0
end

function now_json()
    local ok, year = pcall(function() return df.global.cur_year end)
    local ok_tick, tick = pcall(function() return df.global.cur_year_tick end)
    return '{"year":' .. tostring((ok and year) or 0) ..
        ',"tick":' .. tostring((ok_tick and tick) or 0) .. '}'
end

function list_orders()
    local mgr = has_manager()
    local pop = fort_population()
    local now = now_json()
    local ok, result = pcall(function()
    local out = {}
    local head = '{"ok":true,"hasManager":' .. json_bool(mgr) ..
        ',"population":' .. tostring(pop) .. ',"now":' .. now
    local world = df.global.world
    local all = world and world.manager_orders and world.manager_orders.all
    if not all then return head .. ',"orders":[]}\n' end
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
            -- finished_year / finished_year_tick: when DF next looks at this order; -1 = never dated.
            '"finishYear":' .. tostring(o.finished_year or -1),
            '"finishYearTick":' .. tostring(o.finished_year_tick or -1),
            ok_cond and cond_json or '"itemConditions":[],"orderConditions":[]',
        }
        table.insert(out, '{' .. table.concat(parts, ',') .. '}')
        end
    end
    return head .. ',"orders":[' .. table.concat(out, ',') .. ']}\n'
    end)
    if ok and result then return result end
    return '{"ok":false,"hasManager":' .. json_bool(mgr) ..
        ',"population":' .. tostring(pop) .. ',"now":' .. now ..
        ',"orders":[],"error":' .. json_string(result) .. '}\n'
end

