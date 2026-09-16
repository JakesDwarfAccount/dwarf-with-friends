-- ---------------------------------------------------------------------------
-- Browser build menu + placement

-- Top-level build-menu categories, in DF's own vertical order.
local BUILD_CATEGORIES = {
    {id='workshops', label='Workshops'},
    {id='furniture', label='Furniture'},
    {id='doors', label='Doors/hatches'},
    {id='constructions', label='Constructions'},
    {id='machines', label='Machines/fluids'},
    {id='cages', label='Cages/restraints'},
    {id='traps', label='Traps'},
    {id='military', label='Military'},
    {id='trade', label='Trade depot'},
}

-- Workshops flyout subgroups; an item with no opts.group is a direct Workshops entry.
local WORKSHOP_GROUPS = {
    {id='clothing', label='Clothing and leather'},
    {id='farming', label='Farming'},
    {id='furnaces', label='Furnaces'},
}

function json_string(s)
    s = tostring(s or '')
    -- DF strings are CP437 and may carry control bytes; unconverted, the browser's JSON.parse
    -- throws and the panel shows no data at all.
    local ok, u = pcall(dfhack.df2utf, s)
    if ok and type(u) == 'string' then s = u end
    s = s:gsub('\\', '\\\\'):gsub('"', '\\"')
         :gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')
         :gsub('[%z\1-\8\11\12\14-\31\127]', function(c) return string.format('\\u%04x', c:byte()) end)
    return '"' .. s .. '"'
end

function json_bool(v)
    return v and 'true' or 'false'
end

function stockpile_cat_groups(cat)
    local spec = SP_CATEGORIES[tostring(cat or '')]
    if not spec then return '{"ok":false,"groups":[]}\n' end
    local out = {}
    for _, g in ipairs(spec.groups) do
        out[#out + 1] = '{"key":' .. json_string(g.key) .. ',"label":' .. json_string(g.label) .. '}'
    end
    return '{"ok":true,"label":' .. json_string(spec.label) .. ',"groups":[' .. table.concat(out, ',') .. ']}\n'
end

function stockpile_item_list(id, cat, group)
    local b = get_stockpile(id)
    if not b then return '{"ok":false,"items":[]}\n' end
    return sp_item_list_on(b, cat, group)
end

function hauling_stop_item_list(route_id, stop_id, cat, group)
    local stop, err = get_hauling_stop(route_id, stop_id)
    if not stop then return '{"ok":false,"items":[],"error":' .. json_string(err) .. '}\n' end
    return sp_item_list_on(stop, cat, group)
end

function sp_item_list_on(b, cat, group)
    local spec, g = sp_find_group(cat, group)
    if not g then return '{"ok":false,"error":"category not editable yet","items":[]}\n' end
    local ok, res = pcall(function()
        local items = {}
        for i = 0, sp_group_count(g) - 1 do
            local r = sp_group_item(g, i)
            if r and g.include(r, i) then
                local on = sp_group_get(g, b, i)
                items[#items + 1] = '{"idx":' .. i .. ',"name":' .. json_string(tostring(g.name(r))) ..
                    ',"on":' .. json_bool(on) .. '}'
            end
        end
        return '{"ok":true,"items":[' .. table.concat(items, ',') .. ']}\n'
    end)
    if ok and res then return res end
    return '{"ok":false,"items":[],"error":' .. json_string(tostring(res)) .. '}\n'
end

-- Snapshot reads must use sp_group_peek: sp_group_get grows short DF vectors, which would
-- make opening the editor mutate the save.
local SP_SNAPSHOT_CATS = {
    'ammo', 'animals', 'armor', 'bars', 'cloth', 'coins', 'finished', 'food', 'furniture',
    'gems', 'leather', 'corpses', 'refuse', 'sheets', 'stone', 'weapons', 'wood',
}

local function sp_group_peek(g, b, idx)
    if g.get then return sp_bool(g.get(b, idx)) end
    local vec = g.vec(b)
    if g.fixed or idx < #vec then return sp_bool(vec[idx]) end
    return false
end

function stockpile_settings_snapshot(id)
    local b = get_stockpile(id)
    if not b then return '{"ok":false,"error":"not a stockpile","categories":[]}\n' end
    return sp_settings_snapshot_on(b)
end

function hauling_stop_settings_snapshot(route_id, stop_id)
    local stop, err = get_hauling_stop(route_id, stop_id)
    if not stop then
        return '{"ok":false,"categories":[],"error":' .. json_string(err) .. '}\n'
    end
    return sp_settings_snapshot_on(stop)
end

function sp_settings_snapshot_on(b)
    local ok, res = pcall(function()
        local cats = {}
        for _, key in ipairs(SP_SNAPSHOT_CATS) do
            local spec = SP_CATEGORIES[key]
            if spec then
                local groups = {}
                for _, g in ipairs(spec.groups) do
                    local on, total = 0, 0
                    for i = 0, sp_group_count(g) - 1 do
                        local raw = sp_group_item(g, i)
                        if raw and g.include(raw, i) then
                            total = total + 1
                            if sp_group_peek(g, b, i) then on = on + 1 end
                        end
                    end
                    groups[#groups + 1] = '{"key":' .. json_string(g.key) ..
                        ',"label":' .. json_string(g.label) .. ',"on":' .. on ..
                        ',"total":' .. total .. '}'
                end
                cats[#cats + 1] = '{"key":' .. json_string(key) ..
                    ',"label":' .. json_string(spec.label) ..
                    ',"enabled":' .. json_bool(sp_bool(b.settings.flags[spec.flag])) ..
                    ',"groups":[' .. table.concat(groups, ',') .. ']}'
            end
        end
        return '{"ok":true,"categories":[' .. table.concat(cats, ',') .. ']}\n'
    end)
    if ok and res then return res end
    return '{"ok":false,"categories":[],"error":' .. json_string(tostring(res)) .. '}\n'
end

function token_for(btype, subtype, custom)
    return ('%d:%d:%d'):format(tonumber(btype) or -1, tonumber(subtype) or -1, tonumber(custom) or -1)
end

function parse_token(token)
    local t, s, c = tostring(token or ''):match('^(-?%d+):(-?%d+):(-?%d+)$')
    if not t then return nil end
    return tonumber(t), tonumber(s), tonumber(c)
end

function direction_options(kind)
    if kind == 'axis' then
        return {
            {label='E-W', value=0},
            {label='N-S', value=1},
        }
    elseif kind == 'bridge' then
        return {
            {label='Retract', value=-1},
            {label='West', value=0},
            {label='East', value=1},
            {label='North', value=2},
            {label='South', value=3},
        }
    elseif kind == 'pump' then
        return {
            {label='From N', value=df.screw_pump_direction.FromNorth},
            {label='From E', value=df.screw_pump_direction.FromEast},
            {label='From S', value=df.screw_pump_direction.FromSouth},
            {label='From W', value=df.screw_pump_direction.FromWest},
        }
    elseif kind == 'siege8' then
        -- Values are the native button INDEX (0-7), stored as buildreq.direction.
        return {
            {label='N',  value=0},
            {label='NE', value=1},
            {label='E',  value=2},
            {label='SE', value=3},
            {label='S',  value=4},
            {label='SW', value=5},
            {label='W',  value=6},
            {label='NW', value=7},
        }
    end
    return {
        {label='N', value=0},
        {label='E', value=1},
        {label='S', value=2},
        {label='W', value=3},
    }
end

function requirements_for(filters)
    -- Never call plugins.buildingplan from here: its nested CallLuaModuleFunction can overflow
    -- dwf's render-thread stack and hard-crash DF. constructBuilding needs no buildingplan.
    local out = {}
    for _, filter in ipairs(filters or {}) do
        local desc = (filter and filter.name and #tostring(filter.name) > 0)
            and tostring(filter.name) or 'Material'
        table.insert(out, {label=desc, quantity=(filter and filter.quantity) or 1})
    end
    return out
end

-- dfhack.buildings.getCorrectSize returns the real footprint in w/h even when flexible is
-- false; trusting w/h only when flexible makes every fixed workshop report 1x1.
function correct_size(width, height, btype, subtype, custom, direction)
    local ok, flexible, adjusted_w, adjusted_h = pcall(
        dfhack.buildings.getCorrectSize,
        width or 1, height or 1, btype, subtype or -1, custom or -1, direction or 0)
    if ok and adjusted_w and adjusted_h and adjusted_w > 0 and adjusted_h > 0 then
        return adjusted_w, adjusted_h, flexible and true or false
    end
    return width or 1, height or 1, true
end

function item_to_json(item)
    local parts = {
        '"token":' .. json_string(item.token),
        '"label":' .. json_string(item.label),
        '"category":' .. json_string(item.category),
        -- '' = a direct Workshops entry; only meaningful when category == 'workshops'.
        '"group":' .. json_string(item.group or ''),
        '"type":' .. tostring(item.type),
        '"subtype":' .. tostring(item.subtype or -1),
        '"custom":' .. tostring(item.custom or -1),
        '"area":' .. json_bool(item.area),
        '"direction":' .. json_bool(item.direction),
        '"directionKind":' .. json_string(item.direction_kind or ''),
        '"hollow":' .. json_bool(item.hollow),
        '"pressure":' .. json_bool(item.pressure),
        '"trackStop":' .. json_bool(item.track_stop),
        '"weaponCount":' .. json_bool(item.weapon_count),
        '"speed":' .. json_bool(item.speed),
        '"customRaw":' .. json_bool(item.custom_raw),
        '"size":{"w":' .. tostring(item.size_w or 1) .. ',"h":' .. tostring(item.size_h or 1) .. '}',
        '"limit":{"w":' .. tostring(item.limit_w or 1) .. ',"h":' .. tostring(item.limit_h or 1) .. '}',
    }

    local dir = direction_options(item.direction_kind)
    local dir_parts = {}
    if item.direction then
        for _, opt in ipairs(dir) do
            table.insert(dir_parts, '{"label":' .. json_string(opt.label) .. ',"value":' .. tostring(opt.value) .. '}')
        end
    end
    table.insert(parts, '"directions":[' .. table.concat(dir_parts, ',') .. ']')

    local req_parts = {}
    for _, req in ipairs(item.requirements or {}) do
        table.insert(req_parts, '{"label":' .. json_string(req.label) ..
            ',"quantity":' .. tostring(req.quantity or 1) .. '}')
    end
    table.insert(parts, '"requirements":[' .. table.concat(req_parts, ',') .. ']')

    return '{' .. table.concat(parts, ',') .. '}'
end

function category_to_json(cat, count, groups_json)
    return '{"id":' .. json_string(cat.id) ..
        ',"label":' .. json_string(cat.label) ..
        ',"count":' .. tostring(count or 0) ..
        (groups_json and (',"groups":[' .. groups_json .. ']') or '') .. '}'
end

function add_build_item(items, category, label, btype, subtype, custom, opts)
    if btype == nil then return end
    subtype = subtype or -1
    custom = custom or -1
    opts = opts or {}
    if btype == df.building_type.Construction and subtype == df.construction_type.TrackNSEW then
        return
    end
    local ok_filters, filters = pcall(dfhack.buildings.getFiltersByType, {}, btype, subtype, custom)
    if not ok_filters or filters == nil then
        return
    end
    -- Same render-thread crash: never call buildingplan.isPlannableBuilding here either.

    local size_w, size_h = correct_size(1, 1, btype, subtype, custom, opts.default_direction or 0)
    local item = {
        category=category,
        group=opts.group or '',
        label=label,
        type=btype,
        subtype=subtype,
        custom=custom,
        token=token_for(btype, subtype, custom),
        area=opts.area or false,
        direction=opts.direction or false,
        direction_kind=opts.direction_kind or '',
        hollow=opts.hollow or false,
        pressure=opts.pressure or false,
        track_stop=opts.track_stop or false,
        weapon_count=opts.weapon_count or false,
        speed=opts.speed or false,
        custom_raw=opts.custom_raw or false,
        size_w=size_w,
        size_h=size_h,
        limit_w=opts.limit_w or size_w or 1,
        limit_h=opts.limit_h or size_h or 1,
        requirements=requirements_for(filters),
    }
    table.insert(items, item)
end

function add_native_build_items(items)
    local bt = df.building_type
    local wt = df.workshop_type
    local ft = df.furnace_type
    local tt = df.trap_type
    local st = df.siegeengine_type
    local ct = df.construction_type

    add_build_item(items, 'furniture', 'Chair / Throne', bt.Chair)
    add_build_item(items, 'furniture', 'Bed', bt.Bed)
    add_build_item(items, 'furniture', 'Table', bt.Table)
    add_build_item(items, 'furniture', 'Coffin', bt.Coffin)
    add_build_item(items, 'furniture', 'Cabinet', bt.Cabinet)
    add_build_item(items, 'furniture', 'Statue', bt.Statue)
    add_build_item(items, 'furniture', 'Slab', bt.Slab)
    add_build_item(items, 'furniture', 'Glass window', bt.WindowGlass)
    add_build_item(items, 'furniture', 'Gem window', bt.WindowGem)
    add_build_item(items, 'furniture', 'Box / Chest', bt.Box)
    add_build_item(items, 'furniture', 'Bookcase', bt.Bookcase)
    add_build_item(items, 'furniture', 'Display furniture', bt.DisplayFurniture)
    add_build_item(items, 'furniture', 'Offering place', bt.OfferingPlace)
    add_build_item(items, 'furniture', 'Stationary instrument', bt.Instrument)
    add_build_item(items, 'furniture', 'Weapon rack', bt.Weaponrack)
    add_build_item(items, 'furniture', 'Armor stand', bt.Armorstand)
    add_build_item(items, 'furniture', 'Traction bench', bt.TractionBench)

    add_build_item(items, 'doors', 'Door', bt.Door)
    add_build_item(items, 'doors', 'Hatch cover', bt.Hatch)
    add_build_item(items, 'doors', 'Wall grate', bt.GrateWall)
    add_build_item(items, 'doors', 'Floor grate', bt.GrateFloor)
    add_build_item(items, 'doors', 'Vertical bars', bt.BarsVertical)
    add_build_item(items, 'doors', 'Floor bars', bt.BarsFloor)

    add_build_item(items, 'workshops', 'Carpenter', bt.Workshop, wt.Carpenters)
    add_build_item(items, 'workshops', 'Stoneworker', bt.Workshop, wt.Masons)
    add_build_item(items, 'workshops', 'Crafts', bt.Workshop, wt.Craftsdwarfs)
    add_build_item(items, 'workshops', 'Jeweler', bt.Workshop, wt.Jewelers)
    add_build_item(items, 'workshops', 'Metalsmith', bt.Workshop, wt.MetalsmithsForge)
    add_build_item(items, 'workshops', 'Magma forge', bt.Workshop, wt.MagmaForge)
    add_build_item(items, 'workshops', 'Bowyer', bt.Workshop, wt.Bowyers)
    add_build_item(items, 'workshops', 'Mechanic', bt.Workshop, wt.Mechanics)
    add_build_item(items, 'workshops', 'Siege', bt.Workshop, wt.Siege)
    add_build_item(items, 'workshops', 'Ashery', bt.Workshop, wt.Ashery)

    -- Workshops > Clothing and leather subgroup.
    add_build_item(items, 'workshops', 'Leather works', bt.Workshop, wt.Leatherworks, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Tanner', bt.Workshop, wt.Tanners, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Clothier', bt.Workshop, wt.Clothiers, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Dyer', bt.Workshop, wt.Dyers, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Loom', bt.Workshop, wt.Loom, -1, {group='clothing'})

    -- Workshops > Farming subgroup.
    add_build_item(items, 'workshops', 'Farmer', bt.Workshop, wt.Farmers, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Butcher', bt.Workshop, wt.Butchers, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Fishery', bt.Workshop, wt.Fishery, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Still', bt.Workshop, wt.Still, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Quern', bt.Workshop, wt.Quern, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Millstone', bt.Workshop, wt.Millstone, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Kennel', bt.Workshop, wt.Kennels, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Kitchen', bt.Workshop, wt.Kitchen, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Farm plot', bt.FarmPlot, -1, -1, {area=true, limit_w=31, limit_h=31, group='farming'})
    add_build_item(items, 'workshops', 'Nest box', bt.NestBox, -1, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Hive', bt.Hive, -1, -1, {group='farming'})

    -- Workshops > Furnaces subgroup.
    add_build_item(items, 'workshops', 'Wood furnace', bt.Furnace, ft.WoodFurnace, -1, {group='furnaces'})
    add_build_item(items, 'workshops', 'Smelter', bt.Furnace, ft.Smelter, -1, {group='furnaces'})
    add_build_item(items, 'workshops', 'Glass furnace', bt.Furnace, ft.GlassFurnace, -1, {group='furnaces'})
    add_build_item(items, 'workshops', 'Kiln', bt.Furnace, ft.Kiln, -1, {group='furnaces'})
    add_build_item(items, 'workshops', 'Magma smelter', bt.Furnace, ft.MagmaSmelter, -1, {group='furnaces'})
    add_build_item(items, 'workshops', 'Magma glass furnace', bt.Furnace, ft.MagmaGlassFurnace, -1, {group='furnaces'})
    add_build_item(items, 'workshops', 'Magma kiln', bt.Furnace, ft.MagmaKiln, -1, {group='furnaces'})

    add_build_item(items, 'constructions', 'Wall', bt.Construction, ct.Wall, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Floor', bt.Construction, ct.Floor, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Ramp', bt.Construction, ct.Ramp, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Up stair', bt.Construction, ct.UpStair, -1, {area=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Down stair', bt.Construction, ct.DownStair, -1, {area=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Up/down stair', bt.Construction, ct.UpDownStair, -1, {area=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Fortification', bt.Construction, ct.Fortification, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Reinforced wall', bt.Construction, ct.ReinforcedWall, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Dirt road', bt.RoadDirt, -1, -1, {area=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Paved road', bt.RoadPaved, -1, -1, {area=true, limit_w=31, limit_h=31})

    add_build_item(items, 'machines', 'Screw pump', bt.ScrewPump, -1, -1, {direction=true, direction_kind='pump'})
    add_build_item(items, 'machines', 'Gear assembly', bt.GearAssembly)
    add_build_item(items, 'machines', 'Horizontal axle', bt.AxleHorizontal, -1, -1, {area=true, direction=true, direction_kind='axis', limit_w=31, limit_h=31})
    add_build_item(items, 'machines', 'Vertical axle', bt.AxleVertical)
    add_build_item(items, 'machines', 'Water wheel', bt.WaterWheel, -1, -1, {direction=true})
    add_build_item(items, 'machines', 'Windmill', bt.Windmill)
    add_build_item(items, 'machines', 'Rollers', bt.Rollers, -1, -1, {area=true, direction=true, speed=true, limit_w=31, limit_h=31})
    add_build_item(items, 'machines', 'Support', bt.Support)
    add_build_item(items, 'machines', 'Well', bt.Well)
    add_build_item(items, 'machines', 'Bridge', bt.Bridge, -1, -1, {area=true, direction=true, direction_kind='bridge', limit_w=31, limit_h=31})
    add_build_item(items, 'machines', 'Floodgate', bt.Floodgate)

    add_build_item(items, 'cages', 'Cage', bt.Cage)
    add_build_item(items, 'cages', 'Chain / Rope', bt.Chain)

    add_build_item(items, 'traps', 'Lever', bt.Trap, tt.Lever)
    add_build_item(items, 'traps', 'Pressure plate', bt.Trap, tt.PressurePlate, -1, {pressure=true})
    add_build_item(items, 'traps', 'Cage trap', bt.Trap, tt.CageTrap)
    add_build_item(items, 'traps', 'Stone-fall trap', bt.Trap, tt.StoneFallTrap)
    add_build_item(items, 'traps', 'Weapon trap', bt.Trap, tt.WeaponTrap, -1, {weapon_count=true})
    add_build_item(items, 'traps', 'Track stop', bt.Trap, tt.TrackStop, -1, {direction=true, track_stop=true})
    add_build_item(items, 'traps', 'Animal trap', bt.AnimalTrap)
    add_build_item(items, 'traps', 'Upright spear / spike', bt.Weapon, -1, -1, {weapon_count=true})

    add_build_item(items, 'military', 'Catapult', bt.SiegeEngine, st.Catapult, -1, {direction=true, direction_kind='siege8'})
    add_build_item(items, 'military', 'Ballista', bt.SiegeEngine, st.Ballista, -1, {direction=true, direction_kind='siege8'})
    add_build_item(items, 'military', 'Bolt thrower', bt.SiegeEngine, st.BoltThrower, -1, {direction=true, direction_kind='siege8'})
    add_build_item(items, 'military', 'Archery target', bt.ArcheryTarget)

    add_build_item(items, 'trade', 'Trade depot', bt.TradeDepot)

    local track_names = {
        {ct.TrackN, 'Track N'}, {ct.TrackS, 'Track S'}, {ct.TrackE, 'Track E'}, {ct.TrackW, 'Track W'},
        {ct.TrackNS, 'Track N-S'}, {ct.TrackNE, 'Track N-E'}, {ct.TrackNW, 'Track N-W'},
        {ct.TrackSE, 'Track S-E'}, {ct.TrackSW, 'Track S-W'}, {ct.TrackEW, 'Track E-W'},
        {ct.TrackNSE, 'Track N-S-E'}, {ct.TrackNSW, 'Track N-S-W'},
        {ct.TrackNEW, 'Track N-E-W'}, {ct.TrackSEW, 'Track S-E-W'},
        {ct.TrackRampN, 'Track ramp N'}, {ct.TrackRampS, 'Track ramp S'},
        {ct.TrackRampE, 'Track ramp E'}, {ct.TrackRampW, 'Track ramp W'},
        {ct.TrackRampNS, 'Track ramp N-S'}, {ct.TrackRampNE, 'Track ramp N-E'},
        {ct.TrackRampNW, 'Track ramp N-W'}, {ct.TrackRampSE, 'Track ramp S-E'},
        {ct.TrackRampSW, 'Track ramp S-W'}, {ct.TrackRampEW, 'Track ramp E-W'},
        {ct.TrackRampNSE, 'Track ramp N-S-E'}, {ct.TrackRampNSW, 'Track ramp N-S-W'},
        {ct.TrackRampNEW, 'Track ramp N-E-W'}, {ct.TrackRampSEW, 'Track ramp S-E-W'},
        {ct.TrackRampNSEW, 'Track ramp N-S-E-W'},
    }
    for _, t in ipairs(track_names) do
        add_build_item(items, 'constructions', t[2], bt.Construction, t[1], -1, {area=true, hollow=false, limit_w=31, limit_h=31})
    end
end

function add_custom_build_items(items)
    local world = df.global.world
    if not world or not world.raws or not world.raws.buildings then return end
    for _, def in ipairs(world.raws.buildings.workshops or {}) do
        if def then
            add_build_item(items, 'workshops',
                (def.name and #def.name > 0) and def.name or def.code or 'Custom workshop',
                df.building_type.Workshop, df.workshop_type.Custom, def.id,
                {custom_raw=true})
        end
    end
    for _, def in ipairs(world.raws.buildings.furnaces or {}) do
        if def then
            add_build_item(items, 'workshops',
                (def.name and #def.name > 0) and def.name or def.code or 'Custom furnace',
                df.building_type.Furnace, df.furnace_type.Custom, def.id,
                {custom_raw=true, group='furnaces'})
        end
    end
end

function building_catalog()
    -- Runs on dwf's render thread: an escaping Lua error overflows its small stack and
    -- hard-crashes DF, so every step is pcall-guarded and a partial catalog is returned.
    local items = {}
    local ok1, e1 = pcall(add_native_build_items, items)
    if not ok1 then dfhack.printerr('dwf building_catalog: native items failed: ' .. tostring(e1)) end
    local ok2, e2 = pcall(add_custom_build_items, items)
    if not ok2 then dfhack.printerr('dwf building_catalog: custom items failed: ' .. tostring(e2)) end

    dwf_pcall('lua.building-catalog.sort', table.sort, items, function(a, b)
        local ac = tostring(a and a.category or '')
        local bc = tostring(b and b.category or '')
        if ac ~= bc then return ac < bc end
        return tostring(a and a.label or '') < tostring(b and b.label or '')
    end)

    local counts = {}
    local group_counts = {}
    for _, item in ipairs(items) do
        if item and item.category then
            counts[item.category] = (counts[item.category] or 0) + 1
            if item.category == 'workshops' and item.group and item.group ~= '' then
                group_counts[item.group] = (group_counts[item.group] or 0) + 1
            end
        end
    end

    local cat_json = {}
    for _, cat in ipairs(BUILD_CATEGORIES) do
        if (counts[cat.id] or 0) > 0 then
            local groups_json = nil
            if cat.id == 'workshops' then
                local gparts = {}
                for _, g in ipairs(WORKSHOP_GROUPS) do
                    if (group_counts[g.id] or 0) > 0 then
                        table.insert(gparts, '{"id":' .. json_string(g.id) ..
                            ',"label":' .. json_string(g.label) ..
                            ',"count":' .. tostring(group_counts[g.id]) .. '}')
                    end
                end
                groups_json = table.concat(gparts, ',')
            end
            local okc, j = pcall(category_to_json, cat, counts[cat.id], groups_json)
            if okc and j then table.insert(cat_json, j) end
        end
    end

    local item_json = {}
    for _, item in ipairs(items) do
        local oki, j = pcall(item_to_json, item)
        if oki and j then table.insert(item_json, j) end
    end

    return '{"ok":true,"categories":[' .. table.concat(cat_json, ',') ..
        '],"items":[' .. table.concat(item_json, ',') .. ']}\n'
end

function parse_options(raw)
    local out = {}
    for k, v in tostring(raw or ''):gmatch('([%w_]+)=([^;]*)') do
        out[k] = v
    end
    return out
end

function opt_num(opts, key, default)
    local n = tonumber(opts[key])
    if n == nil then return default end
    return n
end

function opt_bool(opts, key, default)
    if opts[key] == nil then return default end
    return tonumber(opts[key]) ~= 0
end

function clamp(value, lo, hi)
    if value < lo then return lo end
    if value > hi then return hi end
    return value
end

function map_bounds(x1, y1, x2, y2, z)
    local world = df.global.world
    if not world or not world.map then return nil, 'map unavailable' end
    local lx, hx = math.min(x1, x2), math.max(x1, x2)
    local ly, hy = math.min(y1, y2), math.max(y1, y2)
    lx = clamp(lx, 0, world.map.x_count - 1)
    hx = clamp(hx, 0, world.map.x_count - 1)
    ly = clamp(ly, 0, world.map.y_count - 1)
    hy = clamp(hy, 0, world.map.y_count - 1)
    z = clamp(z, 0, world.map.z_count - 1)
    return {x1=lx, y1=ly, x2=hx, y2=hy, z=z}
end

function is_construction(btype)
    return btype == df.building_type.Construction
end

function is_variable_area(btype)
    return btype == df.building_type.Bridge
        or btype == df.building_type.FarmPlot
        or btype == df.building_type.RoadPaved
        or btype == df.building_type.RoadDirt
        or btype == df.building_type.AxleHorizontal
        or btype == df.building_type.Rollers
end

function is_pressure_plate(btype, subtype)
    return btype == df.building_type.Trap
        and subtype == df.trap_type.PressurePlate
end

function is_weapon_trap(btype, subtype)
    return btype == df.building_type.Trap
        and subtype == df.trap_type.WeaponTrap
end

function is_spike_trap(btype)
    return btype == df.building_type.Weapon
end

function is_track_stop(btype, subtype)
    return btype == df.building_type.Trap
        and subtype == df.trap_type.TrackStop
end

function tile_is_construction(pos)
    local tt = dfhack.maps.getTileType(pos)
    if not tt then return false end
    if df.tiletype.attrs[tt].material ~= df.tiletype_material.CONSTRUCTION then
        return false
    end
    local construction = df.construction.find(pos)
    return construction and not construction.flags.top_of_wall
end

local ONE_BY_ONE = xy2pos(1, 1)

function can_place_construction(reconstruct, pos)
    return dfhack.buildings.checkFreeTiles(pos, ONE_BY_ONE)
        and (reconstruct or not tile_is_construction(pos))
end

function is_interior(bounds, x, y)
    return x ~= bounds.x1 and x ~= bounds.x2 and y ~= bounds.y1 and y ~= bounds.y2
end

-- ===== Build-material selection (DF-style "pick the specific material") =====

-- purpose: 'available' also requires job-claimability; 'presence' and 'condition-material'
-- deliberately keep forbidden and in-use fort items.
function is_fort_stock_item(item, purpose)
    if not item then return false end
    local outer = item
    for _ = 1, 32 do
        local f = outer.flags
        if f.hostile or f.trader or f.garbage_collect or f.removed then return false end
        if purpose == 'available' and
           (f.forbid or f.dump or f.in_job or f.construction or f.in_building or f.encased
            or f.owned or f.artifact or f.spider_web or f.on_fire or f.rotten or f.murder) then
            return false
        end
        local ok, container = pcall(dfhack.items.getContainer, outer)
        if not ok or not container or container == outer then break end
        outer = container
    end
    if outer.flags.in_inventory and not outer.flags.in_job then
        local ok, holder = pcall(dfhack.items.getHolderUnit, outer)
        if not ok or not holder or not dfhack.units.isCitizen(holder) then return false end
        if purpose == 'available' then return false end
    end
    return true
end

function item_buildable(item)
    return is_fort_stock_item(item, 'available')
end

-- A construction filter pins nothing but flags: item_type, item_subtype, mat_type and
-- mat_index are all -1, so a matcher ignoring flags1/flags2/flags3 accepts every fort item.

-- The item classes DF searches for a flags2.building_material job_item.
BUILDMAT_ITEM_TYPES = nil
function buildmat_item_types()
    if not BUILDMAT_ITEM_TYPES then
        BUILDMAT_ITEM_TYPES = {
            [df.item_type.BLOCKS] = 'Blocks',
            [df.item_type.BOULDER] = 'Rock',
            [df.item_type.WOOD] = 'Wood',
            [df.item_type.BAR] = 'Bars',
        }
    end
    return BUILDMAT_ITEM_TYPES
end

function filter_wants_buildmat(filter)
    return not not (filter and filter.flags2 and filter.flags2.building_material)
end

function mat_is_metal(mt, mi)
    local ok, info = pcall(dfhack.matinfo.decode, mt, mi)
    if not ok or not info or not info.material then return false end
    local okf, metal = pcall(function() return info.material.flags.IS_METAL end)
    return okf and metal == true
end

-- job_item_flags1.empty / flags2.lye_milk_free: reject containers that hold something.
function item_has_contents(item)
    local ok, gref = pcall(dfhack.items.getGeneralRef, item, df.general_ref_type.CONTAINS_ITEM)
    return ok and gref ~= nil
end

function item_matches_filter(filter, item)
    if not item then return false end
    if filter.item_type ~= nil and filter.item_type >= 0 and item:getType() ~= filter.item_type then
        return false
    end
    if filter.item_subtype ~= nil and filter.item_subtype >= 0 and item:getSubtype() ~= filter.item_subtype then
        return false
    end

    if filter_wants_buildmat(filter) then
        if not buildmat_item_types()[item:getType()] then return false end
        local ok, buildmat = pcall(function() return item:isBuildMat() end)
        if not ok or not buildmat then return false end
    end

    if filter.flags3 ~= nil and filter.flags3.metal
       and not mat_is_metal(item:getMaterial(), item:getMaterialIndex()) then
        return false
    end

    if (filter.flags1 ~= nil and filter.flags1.empty)
       or (filter.flags2 ~= nil and filter.flags2.lye_milk_free) then
        if item_has_contents(item) then return false end
    end

    if filter.metal_ore ~= nil and filter.metal_ore >= 0 then
        local ok, ore = pcall(function() return item:isMetalOre(filter.metal_ore) end)
        if not ok or not ore then return false end
    end

    if filter.has_tool_use ~= nil and filter.has_tool_use > df.tool_uses.NONE then
        local ok, use = pcall(function() return item:hasToolUse(filter.has_tool_use) end)
        if not ok or not use then return false end
    end

    if filter.mat_type ~= nil and filter.mat_type >= 0 then
        if item:getMaterial() ~= filter.mat_type then return false end
        if filter.mat_index ~= nil and filter.mat_index >= 0 and item:getMaterialIndex() ~= filter.mat_index then
            return false
        end
    end
    return true
end

function material_groups_for_filter(filter)
    local items_vec = df.global.world.items.other.IN_PLAY
    local groups, order = {}, {}
    for ii = 0, #items_vec - 1 do
        local item = items_vec[ii]
        if item_buildable(item) and item_matches_filter(filter, item) then
            local it, ist = item:getType(), item:getSubtype()
            local mt, mi = item:getMaterial(), item:getMaterialIndex()
            local key = tostring(it) .. ':' .. tostring(ist) .. ':' .. tostring(mt) .. ':' .. tostring(mi)
            local g = groups[key]
            if not g then
                local nm = ''
                local okm, info = pcall(dfhack.matinfo.decode, mt, mi)
                if okm and info then
                    local oks, s = pcall(function() return info:toString() end)
                    if oks and s then nm = s end
                end
                g = { item_type = it, item_subtype = ist, mat_type = mt, mat_index = mi,
                      name = nm, count = 0, class_name = buildmat_item_types()[it] or
                          (df.item_type[it] and tostring(df.item_type[it])) or 'Item' }
                groups[key] = g
                table.insert(order, key)
            end
            g.count = g.count + (item.stack_size or 1)
        end
    end
    local function label_of(k)
        local g = groups[k]
        return ((g.name ~= '' and g.name) or 'material') .. ' ' .. (g.class_name or '')
    end
    table.sort(order, function(a, b) return label_of(a) < label_of(b) end)
    return groups, order
end

function build_materials(token)
    local btype, subtype, custom = parse_token(token)
    if not btype then return '{"ok":false,"error":"bad building token"}\n' end
    local ok_f, filters = pcall(dfhack.buildings.getFiltersByType, {}, btype, subtype, custom)
    if not ok_f or not filters then return '{"ok":false,"error":"no filters"}\n' end

    local req_json = {}
    for fi, filter in ipairs(filters) do
        local pinned = (filter.mat_type ~= nil and filter.mat_type >= 0)   -- material fixed by raws
        local groups, order = material_groups_for_filter(filter)
        local mats = {}
        for _, key in ipairs(order) do
            local g = groups[key]
            table.insert(mats, '{"itemType":' .. tostring(g.item_type) ..
                ',"itemSubtype":' .. tostring(g.item_subtype) ..
                ',"matType":' .. tostring(g.mat_type) ..
                ',"matIndex":' .. tostring(g.mat_index) ..
                ',"className":' .. json_string(g.class_name or 'Item') ..
                ',"name":' .. json_string((g.name ~= '' and g.name) or ('material ' .. key)) ..
                ',"count":' .. tostring(g.count) .. '}')
        end
        table.insert(req_json, '{"index":' .. tostring(fi - 1) ..
            ',"label":' .. json_string((filter.name and #tostring(filter.name) > 0) and tostring(filter.name) or 'Material') ..
            ',"quantity":' .. tostring(filter.quantity or 1) ..
            ',"pinned":' .. json_bool(pinned) ..
            ',"materials":[' .. table.concat(mats, ',') .. ']}')
    end
    return '{"ok":true,"multiWeapon":' .. json_bool(is_weapon_trap(btype, subtype)) ..
        ',"requirements":[' .. table.concat(req_json, ',') .. ']}\n'
end

-- Buildings where DF asks the player to pick a specific finished item after placement.
local SPECIFIC_ITEM_BUILDINGS = {
    [df.building_type.Chair] = true, [df.building_type.Bed] = true,
    [df.building_type.Table] = true, [df.building_type.Coffin] = true,
    [df.building_type.Cabinet] = true, [df.building_type.Statue] = true,
    [df.building_type.Slab] = true, [df.building_type.WindowGlass] = true,
    [df.building_type.WindowGem] = true, [df.building_type.Box] = true,
    [df.building_type.Bookcase] = true, [df.building_type.DisplayFurniture] = true,
    [df.building_type.OfferingPlace] = true, [df.building_type.Instrument] = true,
    [df.building_type.Weaponrack] = true, [df.building_type.Armorstand] = true,
    [df.building_type.TractionBench] = true, [df.building_type.Door] = true,
    [df.building_type.Hatch] = true, [df.building_type.GrateWall] = true,
    [df.building_type.GrateFloor] = true, [df.building_type.BarsVertical] = true,
    [df.building_type.BarsFloor] = true, [df.building_type.Floodgate] = true,
    [df.building_type.Cage] = true, [df.building_type.Chain] = true,
    [df.building_type.NestBox] = true, [df.building_type.Hive] = true,
    [df.building_type.ArcheryTarget] = true,
}

function needs_specific_item_prompt(btype)
    return SPECIFIC_ITEM_BUILDINGS[btype] == true
end

function place_candidates(token, x, y, z)
    local btype, subtype, custom = parse_token(token)
    if not btype or not needs_specific_item_prompt(btype) then
        return '{"ok":true,"specificItem":false,"candidates":[]}\n'
    end
    local ok_f, filters = pcall(dfhack.buildings.getFiltersByType, {}, btype, subtype, custom)
    if not ok_f or not filters or #filters ~= 1 or (filters[1].quantity or 1) ~= 1 then
        return '{"ok":true,"specificItem":false,"candidates":[]}\n'
    end
    local candidates = {}
    for ii = 0, #df.global.world.items.other.IN_PLAY - 1 do
        local item = df.global.world.items.other.IN_PLAY[ii]
        if item_buildable(item) and item_matches_filter(filters[1], item) then
            local material = tostring(item:getMaterial()) .. ':' .. tostring(item:getMaterialIndex())
            local ok_m, info = pcall(dfhack.matinfo.decode, item:getMaterial(), item:getMaterialIndex())
            if ok_m and info then
                local ok_s, name = pcall(function() return info:toString() end)
                if ok_s and name and #tostring(name) > 0 then material = tostring(name) end
            end
            local quality = -1
            dwf_probe('lua.probe.item-quality', function() quality = item:getQuality() end)
            table.insert(candidates, {id=item.id, material=material, quality=quality})
        end
    end
    table.sort(candidates, function(a, b) return a.id < b.id end)
    local out = {}
    for _, candidate in ipairs(candidates) do
        table.insert(out, '{"id":' .. tostring(candidate.id)
            .. ',"material":' .. json_string(candidate.material)
            .. ',"quality":' .. tostring(candidate.quality) .. '}')
    end
    return '{"ok":true,"specificItem":true,"candidates":[' .. table.concat(out, ',') .. ']}\n'
end

-- Pinning a material must also clear flags2.non_economic: an economic stone plus non_economic
-- is an unsatisfiable job_item that DF accepts and no dwarf can ever fill.
function apply_chosen_materials(filters, opts, skip_index)
    for i, filter in ipairs(filters or {}) do
        local index = i - 1
        local sel = index ~= skip_index and opts['mat' .. index] or nil
        if sel then
            local it, mt, mi = tostring(sel):match('^(-?%d+):(-?%d+):(-?%d+)$')
            if not it then
                mt, mi = tostring(sel):match('^(-?%d+):(-?%d+)$')   -- legacy 2-part pick
            end
            if mt then
                filter.mat_type = tonumber(mt)
                filter.mat_index = tonumber(mi)
                if filter.mat_index and filter.mat_index >= 0 and filter.flags2 then
                    filter.flags2.non_economic = false
                end
                if it then
                    local itn = tonumber(it)
                    if itn and itn >= 0 then filter.item_type = itn end
                end
            end
        end
    end
end

function parse_weapon_selections(raw)
    raw = tostring(raw or '')
    if raw == '' or #raw > 320 or raw:match('^,') or raw:match(',$') or raw:match(',,') then
        return nil, 'invalid weapons'
    end
    local selections = {}
    local remaining = 10
    local tuple_count = 0
    for tuple in raw:gmatch('[^,]+') do
        tuple_count = tuple_count + 1
        if tuple_count > 10 then return nil, 'invalid weapons' end
        local it, ist, mt, mi, qty = tuple:match('^(%d+):(%d+):(%d+):(%d+):(%d+)$')
        if not it then return nil, 'invalid weapons' end
        for _, field in ipairs({it, ist, mt, mi, qty}) do
            if #field > 1 and field:sub(1, 1) == '0' then return nil, 'invalid weapons' end
        end
        it, ist, mt, mi, qty = tonumber(it), tonumber(ist), tonumber(mt), tonumber(mi), tonumber(qty)
        if not it or not ist or not mt or not mi or not qty or it > 32767 or ist > 32767
           or mt > 32767 or mi > 2147483647 or qty < 1 or qty > 10 then
            return nil, 'invalid weapons'
        end
        local take = math.min(qty, remaining)
        if take > 0 then
            selections[#selections + 1] = {
                item_type=it, item_subtype=ist, mat_type=mt, mat_index=mi, quantity=take}
            remaining = remaining - take
        end
    end
    if #selections == 0 then return nil, 'invalid weapons' end
    return selections
end

function apply_weapon_selections(filters, btype, subtype, custom, opts)
    if opts.weapons == nil then return filters end
    if not is_weapon_trap(btype, subtype) then return nil, 'weapons require a weapon trap' end
    local selections, err = parse_weapon_selections(opts.weapons)
    if not selections then return nil, err end

    local weapon_filter = filters[2]
    if not weapon_filter then return nil, 'weapon trap has no weapon filter' end
    local available = material_groups_for_filter(weapon_filter)
    for _, selection in ipairs(selections) do
        local key = tostring(selection.item_type) .. ':' .. tostring(selection.item_subtype) .. ':'
            .. tostring(selection.mat_type) .. ':' .. tostring(selection.mat_index)
        local group = available[key]
        if not group or group.count < selection.quantity then
            return nil, 'weapon selection unavailable'
        end
        group.count = group.count - selection.quantity
    end

    local out = {filters[1]}
    for _, selection in ipairs(selections) do
        local fresh = dfhack.buildings.getFiltersByType({}, btype, subtype, custom)
        local filter = fresh and fresh[2]
        if not filter then return nil, 'weapon trap has no weapon filter' end
        filter.item_type = selection.item_type
        filter.item_subtype = selection.item_subtype
        filter.mat_type = selection.mat_type
        filter.mat_index = selection.mat_index
        filter.quantity = selection.quantity
        if filter.flags2 then filter.flags2.non_economic = false end
        out[#out + 1] = filter
    end
    return out
end

function resolve_closest_materials(opts, btype, subtype, custom, cx, cy, cz)
    local need = false
    for k, v in pairs(opts) do
        if v == 'closest' and tostring(k):match('^mat%d+$') then need = true; break end
    end
    if not need then return end
    local ok_f, filters = pcall(dfhack.buildings.getFiltersByType, {}, btype, subtype, custom)
    if not ok_f or not filters then return end
    local items_vec = df.global.world.items.other.IN_PLAY
    for fi, filter in ipairs(filters) do
        local key = 'mat' .. (fi - 1)
        if opts[key] == 'closest' then
            local best, bestd
            for ii = 0, #items_vec - 1 do
                local item = items_vec[ii]
                if item_buildable(item) and item_matches_filter(filter, item) then
                    local p = item.pos
                    if p then
                        local dx, dy, dz = (p.x or 0) - cx, (p.y or 0) - cy, (p.z or 0) - cz
                        local d = dx * dx + dy * dy + dz * dz * 16   -- weight z so another floor is "far"
                        if not bestd or d < bestd then bestd = d; best = item end
                    end
                end
            end
            opts[key] = best and (tostring(best:getType()) .. ':' .. tostring(best:getMaterial())
                .. ':' .. tostring(best:getMaterialIndex())) or nil
        end
    end
end

function filters_for_building(btype, subtype, custom, opts, apply_material_picks)
    local filters = dfhack.buildings.getFiltersByType({}, btype, subtype, custom)
    if not filters then return nil end
    if is_pressure_plate(btype, subtype) and filters[1] then
        local quantity = 0
        if opt_bool(opts, 'plate_units', true) then quantity = quantity + 1 end
        if opt_bool(opts, 'plate_water', false) then quantity = quantity + 1 end
        if opt_bool(opts, 'plate_magma', false) then quantity = quantity + 1 end
        if opt_bool(opts, 'plate_track', false) then quantity = quantity + 1 end
        filters[1].quantity = math.max(1, quantity)
    elseif is_weapon_trap(btype, subtype) and filters[2] then
        filters[2].quantity = clamp(opt_num(opts, 'weapon_count', 1), 1, 10)
    elseif is_spike_trap(btype) and filters[1] then
        filters[1].quantity = clamp(opt_num(opts, 'weapon_count', 1), 1, 10)
    end
    if apply_material_picks ~= false then
        apply_chosen_materials(filters, opts,
            opts.weapons ~= nil and is_weapon_trap(btype, subtype) and 1 or nil)
    end
    return apply_weapon_selections(filters, btype, subtype, custom, opts)
end

-- Every building_trapst carries both plate_info and track_stop_info whatever its trap_type,
-- so gate on the subtype: a field-presence check writes plate options into a cage trap.
function apply_building_options(bld, btype, subtype, direction, opts)
    if not bld then return end
    if btype == df.building_type.SiegeEngine then
        bld.facing = direction
        bld.resting_orientation = direction
    elseif btype == df.building_type.Rollers then
        bld.speed = clamp(opt_num(opts, 'speed', 50000), 1000, 100000)
    elseif is_track_stop(btype, subtype) then
        local ts = bld.track_stop_info
        ts.friction = clamp(opt_num(opts, 'friction', 50000), 0, 50000)
        ts.track_flags.use_dump = opt_bool(opts, 'track_dump', false)
        ts.dump_x_shift = clamp(opt_num(opts, 'dump_x', 0), -1, 1)
        ts.dump_y_shift = clamp(opt_num(opts, 'dump_y', 0), -1, 1)
    elseif is_pressure_plate(btype, subtype) then
        local p = bld.plate_info
        p.flags.units = opt_bool(opts, 'plate_units', true)
        p.flags.water = opt_bool(opts, 'plate_water', false)
        p.flags.magma = opt_bool(opts, 'plate_magma', false)
        p.flags.citizens = opt_bool(opts, 'plate_citizens', false)
        p.flags.resets = opt_bool(opts, 'plate_resets', true)
        p.flags.track = opt_bool(opts, 'plate_track', false)
        p.unit_min = clamp(opt_num(opts, 'unit_min', 1), 0, 1000000)
        p.unit_max = clamp(opt_num(opts, 'unit_max', 1000000), 0, 1000000)
        p.water_min = clamp(opt_num(opts, 'water_min', 1), 0, 7)
        p.water_max = clamp(opt_num(opts, 'water_max', 7), 0, 7)
        p.magma_min = clamp(opt_num(opts, 'magma_min', 1), 0, 7)
        p.magma_max = clamp(opt_num(opts, 'magma_max', 7), 0, 7)
        p.track_min = clamp(opt_num(opts, 'track_min', 1), 0, 1000000)
        p.track_max = clamp(opt_num(opts, 'track_max', 1000000), 0, 1000000)
    end
end

function plan_buildings(blds)
    local ok_bp, buildingplan = pcall(require, 'plugins.buildingplan')
    if not ok_bp then return false, 'buildingplan plugin unavailable' end
    for _, bld in ipairs(blds) do
        buildingplan.addPlannedBuilding(bld)
    end
    buildingplan.scheduleCycle()
    return true, ''
end

function place_one(pos, btype, subtype, custom, width, height, direction, opts, full_rectangle, selected_item_id)
    local filters, filter_err = filters_for_building(btype, subtype, custom, opts,
        not (selected_item_id and selected_item_id >= 0))
    if not filters then return nil, filter_err or 'building has no material filter' end
    local fields = {}
    if btype == df.building_type.SiegeEngine then
        fields.facing = direction
        fields.resting_orientation = direction
    end
    local info = {
        pos=pos, type=btype, subtype=subtype, custom=custom,
        width=width, height=height, direction=direction,
        fields=fields, full_rectangle=full_rectangle}
    if selected_item_id and selected_item_id >= 0 then
        if not needs_specific_item_prompt(btype) or #filters ~= 1 or (filters[1].quantity or 1) ~= 1 then
            return nil, 'this building does not accept a specific item'
        end
        local selected_item = df.item.find(selected_item_id)
        if not item_buildable(selected_item) or not item_matches_filter(filters[1], selected_item) then
            return nil, 'selected item is no longer available for this building'
        end
        info.items = {selected_item}
    else
        info.filters = filters
    end
    local bld, err = dfhack.buildings.constructBuilding(info)
    if not bld then return nil, tostring(err or 'could not place building') end
    -- constructBuilding has already committed the building, so an option-write failure must
    -- never be reported as a failed placement.
    local ok_opts, opt_err = pcall(apply_building_options, bld, btype, subtype, direction, opts)
    if ok_opts then return bld, '' end
    bp_dbg('apply_building_options failed on id=' .. tostring(bld.id) .. ': ' .. tostring(opt_err))
    return bld, '', short_reason(opt_err)
end

function bp_dbg(msg)
    dwf_probe('lua.probe.build-place-log', function()
        local f = io.open('dwf.log', 'a')
        if not f then return end
        f:write('LUA build-place: ' .. tostring(msg) .. '\n')
        f:close()
    end)
end

function building_invariant_snapshot(bld)
    if not bld then return '{"missing":true}' end

    local world_linked = false
    for _, candidate in ipairs(df.global.world.buildings.all) do
        if candidate == bld then world_linked = true; break end
    end

    local stage = -1
    local max_stage = -1
    dwf_probe('lua.probe.build-stage', function() stage = bld:getBuildStage() end)
    dwf_probe('lua.probe.build-max-stage', function() max_stage = bld:getMaxBuildStage() end)

    local center_occupancy = -1
    dwf_pcall('lua.placement.occupancy-audit', function()
        local block = dfhack.maps.getTileBlock(bld.centerx, bld.centery, bld.z)
        if block then
            center_occupancy = block.occupancy[bld.centerx % 16][bld.centery % 16].building
        end
    end)

    local jobs = {}
    for _, job in ipairs(bld.jobs) do
        local holder_id = -1
        local holder = dfhack.job.getGeneralRef(job, df.general_ref_type.BUILDING_HOLDER)
        if holder then holder_id = holder.building_id end
        local filters = {}
        for _, filter in ipairs(job.job_items.elements) do
            filters[#filters + 1] = '{"itemType":' .. tostring(filter.item_type)
                .. ',"itemSubtype":' .. tostring(filter.item_subtype)
                .. ',"matType":' .. tostring(filter.mat_type)
                .. ',"matIndex":' .. tostring(filter.mat_index)
                .. ',"quantity":' .. tostring(filter.quantity)
                .. ',"vectorId":' .. tostring(filter.vector_id)
                .. ',"flags1":' .. tostring(filter.flags1.whole)
                .. ',"flags2":' .. tostring(filter.flags2.whole)
                .. ',"flags3":' .. tostring(filter.flags3.whole) .. '}'
        end
        jobs[#jobs + 1] = '{"id":' .. tostring(job.id)
            .. ',"type":' .. tostring(job.job_type)
            .. ',"listLinked":' .. json_bool(job.list_link ~= nil)
            .. ',"holderId":' .. tostring(holder_id)
            .. ',"filterCount":' .. tostring(#job.job_items.elements)
            .. ',"filters":[' .. table.concat(filters, ',') .. ']'
            .. ',"attachedItemCount":' .. tostring(#job.items)
            .. ',"flags":' .. tostring(job.flags.whole) .. '}'
    end

    local contained = {}
    local contained_items = nil
    dwf_probe('lua.probe.contained-items', function() contained_items = bld.contained_items end)
    if contained_items then
        for _, link in ipairs(contained_items) do
            local item = link and link.item or nil
            local holder_id = -1
            if item then
                local holder = dfhack.items.getGeneralRef(item, df.general_ref_type.BUILDING_HOLDER)
                if holder then holder_id = holder.building_id end
            end
            local refs = {}
            if item then
                for _, ref in ipairs(item.general_refs) do
                    local ref_type = ref:getType()
                    local target_id = -1
                    if ref_type == df.general_ref_type.BUILDING_HOLDER then
                        target_id = ref.building_id
                    elseif ref_type == df.general_ref_type.CONTAINS_UNIT then
                        target_id = ref.unit_id
                    elseif ref_type == df.general_ref_type.CONTAINS_ITEM then
                        target_id = ref.item_id
                    end
                    refs[#refs + 1] = '{"type":' .. tostring(ref_type)
                        .. ',"targetId":' .. tostring(target_id) .. '}'
                end
            end
            contained[#contained + 1] = '{"itemId":' .. tostring(item and item.id or -1)
                .. ',"itemType":' .. tostring(item and item:getType() or -1)
                .. ',"useMode":' .. tostring(link and link.use_mode or -1)
                .. ',"inBuilding":' .. json_bool(item and item.flags.in_building or false)
                .. ',"itemFlags":' .. tostring(item and item.flags.whole or 0)
                .. ',"holderId":' .. tostring(holder_id)
                .. ',"refs":[' .. table.concat(refs, ',') .. ']}'
        end
    end

    local has_design = false
    dwf_probe('lua.probe.building-design', function() has_design = bld.design ~= nil end)
    local cage_json = 'null'
    if df.building_cagest:is_instance(bld) then
        local unit_ids = {}
        for _, id in ipairs(bld.assigned_units) do unit_ids[#unit_ids + 1] = tostring(id) end
        local item_ids = {}
        for _, id in ipairs(bld.assigned_items) do item_ids[#item_ids + 1] = tostring(id) end
        cage_json = '{"assignedUnits":' .. tostring(#bld.assigned_units)
            .. ',"assignedUnitIds":[' .. table.concat(unit_ids, ',') .. ']'
            .. ',"assignedItems":' .. tostring(#bld.assigned_items)
            .. ',"assignedItemIds":[' .. table.concat(item_ids, ',') .. ']'
            .. ',"flags":' .. tostring(bld.cage_flags.whole)
            .. ',"fillTimer":' .. tostring(bld.fill_timer) .. '}'
    end

    return '{"id":' .. tostring(bld.id)
        .. ',"type":' .. tostring(bld:getType())
        .. ',"subtype":' .. tostring(bld:getSubtype())
        .. ',"custom":' .. tostring(bld:getCustomType())
        .. ',"bounds":[' .. tostring(bld.x1) .. ',' .. tostring(bld.y1) .. ','
            .. tostring(bld.x2) .. ',' .. tostring(bld.y2) .. ',' .. tostring(bld.z) .. ']'
        .. ',"center":[' .. tostring(bld.centerx) .. ',' .. tostring(bld.centery) .. ']'
        .. ',"worldLinked":' .. json_bool(world_linked)
        .. ',"stage":' .. tostring(stage)
        .. ',"maxStage":' .. tostring(max_stage)
        .. ',"matType":' .. tostring(bld.mat_type)
        .. ',"matIndex":' .. tostring(bld.mat_index)
        .. ',"flags":' .. tostring(bld.flags.whole)
        .. ',"centerOccupancy":' .. tostring(center_occupancy)
        .. ',"hasDesign":' .. json_bool(has_design)
        .. ',"jobs":[' .. table.concat(jobs, ',') .. ']'
        .. ',"containedItems":[' .. table.concat(contained, ',') .. ']'
        .. ',"cage":' .. cage_json .. '}'
end

function building_invariant_snapshot_by_id(id)
    local numeric_id = tonumber(id) or -1
    local bld = df.building.find(numeric_id)
    if not bld then return '{"missing":true,"id":' .. tostring(numeric_id) .. '}' end
    return building_invariant_snapshot(bld)
end

function place_building(x1, y1, x2, y2, z, token, direction, options, selected_item_id)
    bp_dbg('enter token=' .. tostring(token))
    local btype, subtype, custom = parse_token(token)
    if not btype then return 0, -1, 'bad building token' end
    if btype == df.building_type.Stockpile or btype == df.building_type.Civzone then
        return 0, -1, 'use the dedicated stockpile/zone tools'
    end
    if btype == df.building_type.Construction and subtype == df.construction_type.TrackNSEW then
        return 0, -1, 'that track piece cannot be planned'
    end
    direction = tonumber(direction) or 0
    if btype == df.building_type.Bridge then
        direction = clamp(direction, -1, 3)
    else
        direction = clamp(direction, 0, 3)
    end
    local opts = parse_options(options)
    selected_item_id = tonumber(selected_item_id) or -1
    local bounds, err = map_bounds(x1, y1, x2, y2, z)
    if not bounds then return 0, -1, err end
    dwf_pcall('lua.placement.closest-materials', resolve_closest_materials,
        opts, btype, subtype, custom,
        math.floor((bounds.x1 + bounds.x2) / 2), math.floor((bounds.y1 + bounds.y2) / 2), bounds.z)

    local blds = {}
    local opt_warnings = {}
    if selected_item_id >= 0 and (is_construction(btype) or is_variable_area(btype)) then
        return 0, -1, 'specific item selection requires a single-item building'
    end
    if is_construction(btype) then
        local volume = (bounds.x2 - bounds.x1 + 1) * (bounds.y2 - bounds.y1 + 1)
        local reconstruct = volume == 1
        local ok_bp, buildingplan = pcall(require, 'plugins.buildingplan')
        if ok_bp and buildingplan.getGlobalSettings then
            local ok_settings, settings = pcall(buildingplan.getGlobalSettings)
            if ok_settings and settings and settings.reconstruct then reconstruct = true end
        end
        local hollow = opt_bool(opts, 'hollow', false)
        for y = bounds.y1, bounds.y2 do
            for x = bounds.x1, bounds.x2 do
                if not (hollow and is_interior(bounds, x, y)) then
                    local pos = xyz2pos(x, y, bounds.z)
                    if can_place_construction(reconstruct, pos) then
                        local bld, _, opt_warn = place_one(pos, btype, subtype, custom, 1, 1,
                            direction, opts, false)
                        if bld then table.insert(blds, bld) end
                        if opt_warn then opt_warnings[#opt_warnings + 1] = opt_warn end
                    end
                end
            end
        end
    elseif is_variable_area(btype) then
        local lx, ly = bounds.x1, bounds.y1
        local width = bounds.x2 - bounds.x1 + 1
        local height = bounds.y2 - bounds.y1 + 1
        width = math.min(width, 31)
        height = math.min(height, 31)
        if btype == df.building_type.AxleHorizontal then
            if direction == 1 then width = 1 else height = 1 end
        elseif btype == df.building_type.Rollers then
            if direction == 1 or direction == 3 then height = 1 else width = 1 end
        end
        local bld, place_err, opt_warn = place_one(xyz2pos(lx, ly, bounds.z), btype, subtype, custom,
            width, height, direction, opts, true)
        if bld then table.insert(blds, bld) else return 0, -1, place_err end
        if opt_warn then opt_warnings[#opt_warnings + 1] = opt_warn end
    else
        local center_x = math.floor((bounds.x1 + bounds.x2) / 2)
        local center_y = math.floor((bounds.y1 + bounds.y2) / 2)
        local width, height = correct_size(1, 1, btype, subtype, custom, direction)
        local sx = center_x - math.floor(width / 2)
        local sy = center_y - math.floor(height / 2)
        if btype == df.building_type.ScrewPump then
            if direction == df.screw_pump_direction.FromSouth then
                sy = sy + 1
            elseif direction == df.screw_pump_direction.FromEast then
                sx = sx + 1
            end
        end
        bp_dbg('single: calling place_one at ' .. sx .. ',' .. sy)
        local bld, place_err, opt_warn = place_one(xyz2pos(sx, sy, bounds.z), btype, subtype, custom,
            width, height, direction, opts, false, selected_item_id)
        bp_dbg('single: place_one returned bld=' .. tostring(bld ~= nil))
        if bld then table.insert(blds, bld) else return 0, -1, place_err end
        if opt_warn then opt_warnings[#opt_warnings + 1] = opt_warn end
    end

    if #blds == 0 then return 0, -1, 'no valid tiles for building placement' end
    -- Never call buildingplan.addPlannedBuilding here: its nested Lua call deadlocks under
    -- run_on_render_thread_sync and hangs the game.
    bp_dbg('placed ' .. #blds .. ' building(s) id=' .. tostring(blds[1].id) .. ' (buildingplan skipped)')
    local ids = {}
    local audits = {}
    for _, b in ipairs(blds) do
        ids[#ids + 1] = b.id
        -- Diagnostics must never turn a successful DFHack construction into an HTTP failure.
        local ok_audit, audit = pcall(building_invariant_snapshot, b)
        if ok_audit then
            audits[#audits + 1] = audit
        else
            audits[#audits + 1] = '{"id":' .. tostring(b.id)
                .. ',"auditError":' .. json_string(tostring(audit)) .. '}'
        end
    end
    if #opt_warnings > 0 then
        local quoted = {}
        for _, w in ipairs(opt_warnings) do quoted[#quoted + 1] = json_string(w) end
        audits[#audits + 1] = '{"optionWarnings":[' .. table.concat(quoted, ',') .. ']}'
    end
    return #blds, blds[1].id, '', ids, '[' .. table.concat(audits, ',') .. ']'
end

-- Browser zone names -> df.civzone_type (fortress activity zones).
local ZONE_TYPES = {
    meeting = 'MeetingHall', pen = 'Pen', pond = 'Pond', water = 'WaterSource',
    fishing = 'FishingArea', sand = 'SandCollection', clay = 'ClayCollection',
    dump = 'Dump', gather = 'PlantGathering', training = 'AnimalTraining',
    dungeon = 'Dungeon', bedroom = 'Bedroom', dining = 'DiningHall',
    office = 'Office', dormitory = 'Dormitory', barracks = 'Barracks',
    archery = 'ArcheryRange', tomb = 'Tomb',
}

function create_zone(x1, y1, x2, y2, z, zonetype)
    local lx, hx = math.min(x1, x2), math.max(x1, x2)
    local ly, hy = math.min(y1, y2), math.max(y1, y2)
    local tname = ZONE_TYPES[tostring(zonetype or 'meeting'):lower()] or 'MeetingHall'
    local subtype = df.civzone_type[tname]
    if not subtype then return -1, 'unknown zone type' end
    local ok, bld, err = pcall(dfhack.buildings.constructBuilding, {
        type = df.building_type.Civzone,
        subtype = subtype,
        abstract = true,
        pos = {x = lx, y = ly, z = z},
        width = hx - lx + 1,
        height = hy - ly + 1,
    })
    if not ok then return -1, tostring(bld) end       -- bld is the error on pcall failure
    if not bld then return -1, tostring(err or 'could not place zone') end
    bld.spec_sub_flag.active = true
    if subtype == df.civzone_type.Pen then
        bld.zone_settings.pen.flags.check_occupants = true
    elseif subtype == df.civzone_type.Pond then
        bld.zone_settings.pond.flag.check_occupants = true
    elseif subtype == df.civzone_type.PlantGathering then
        bld.zone_settings.gather.flags.pick_trees = true
        bld.zone_settings.gather.flags.pick_shrubs = true
        bld.zone_settings.gather.flags.gather_fallen = true
    elseif subtype == df.civzone_type.ArcheryRange then
        bld.zone_settings.archery.dir_x = 1
        bld.zone_settings.archery.dir_y = 0
    elseif subtype == df.civzone_type.Tomb then
        -- DF defaults: citizens can claim tombs automatically, pets cannot unless enabled.
        bld.zone_settings.tomb.flags.no_pets = true
        bld.zone_settings.tomb.flags.no_citizens = false
    end
    return bld.id, ''
end

-- Zone locations: taverns, temples, libraries, guildhalls, hospitals.

local LOCATION_TYPES = {
    tavern = {
        label = 'Inn/Tavern',
        klass = df.abstract_building_inn_tavernst,
        name_type = df.language_name_type.FoodStore,
        apply = function(loc)
            loc.contents.desired_goblets = 10
            loc.contents.desired_instruments = 5
            loc.contents.need_more.goblets = true
            loc.contents.need_more.instruments = true
        end,
    },
    temple = {
        label = 'Temple',
        klass = df.abstract_building_templest,
        name_type = df.language_name_type.Temple,
        apply = function(loc)
            loc.deity_type = df.religious_practice_type.RELIGION_ENID
            loc.deity_data.Religion = -1
            loc.contents.desired_instruments = 5
            loc.contents.need_more.instruments = true
        end,
    },
    library = {
        label = 'Library',
        klass = df.abstract_building_libraryst,
        name_type = df.language_name_type.Library,
        apply = function(loc)
            loc.contents.desired_paper = 10
            loc.contents.need_more.paper = true
        end,
    },
    guildhall = {
        label = 'Guildhall',
        klass = df.abstract_building_guildhallst,
        name_type = df.language_name_type.Guildhall,
        apply = function(loc)
            loc.contents.profession = df.profession.NONE
        end,
    },
    hospital = {
        label = 'Hospital',
        klass = df.abstract_building_hospitalst,
        name_type = df.language_name_type.Hospital,
        apply = function(loc)
            loc.contents.desired_splints = 5
            loc.contents.desired_thread = 75000
            loc.contents.desired_cloth = 50000
            loc.contents.desired_crutches = 5
            loc.contents.desired_powder = 750
            loc.contents.desired_buckets = 2
            loc.contents.desired_soap = 750
            loc.contents.need_more.splints = true
            loc.contents.need_more.thread = true
            loc.contents.need_more.cloth = true
            loc.contents.need_more.crutches = true
            loc.contents.need_more.powder = true
            loc.contents.need_more.buckets = true
            loc.contents.need_more.soap = true
        end,
    },
}

local LOCATION_CREATE_ORDER = {'tavern', 'temple', 'library', 'guildhall', 'hospital'}

function zone_allows_location(zone)
    return zone and (zone.type == df.civzone_type.MeetingHall
        or zone.type == df.civzone_type.DiningHall
        or zone.type == df.civzone_type.Bedroom)
end

function get_civzone(zone_id)
    local zone = df.building.find(tonumber(zone_id) or -1)
    if not zone or not df.building_civzonest:is_instance(zone) then return nil end
    return zone
end

function vector_contains(vec, value)
    for _, v in ipairs(vec or {}) do
        if v == value then return true end
    end
    return false
end

function erase_value(vec, value)
    if not vec then return end
    for i = #vec - 1, 0, -1 do
        if vec[i] == value then vec:erase(i) end
    end
end

function find_location(site, location_id)
    if not site then return nil end
    for _, loc in ipairs(site.buildings) do
        if loc.id == location_id then return loc end
    end
    return nil
end

function location_kind(loc)
    if df.abstract_building_inn_tavernst:is_instance(loc) then return 'tavern' end
    if df.abstract_building_templest:is_instance(loc) then return 'temple' end
    if df.abstract_building_libraryst:is_instance(loc) then return 'library' end
    if df.abstract_building_guildhallst:is_instance(loc) then return 'guildhall' end
    if df.abstract_building_hospitalst:is_instance(loc) then return 'hospital' end
    return 'other'
end

function location_label(loc)
    local kind = location_kind(loc)
    return (LOCATION_TYPES[kind] and LOCATION_TYPES[kind].label) or tostring(df.abstract_building_type[loc:getType()] or 'Location')
end

function location_name(loc)
    local ok, name = pcall(dfhack.translation.translateName, loc.name, true)
    if ok and name and #name > 0 then return name end
    return location_label(loc)
end

function generated_location_name(name_type)
    local name = {
        type = name_type,
        has_name = true,
        words = {resize = false},
        parts_of_speech = {resize = false, FirstAdjective = df.part_of_speech.Adjective},
    }
    local ok, word_table = pcall(function()
        return df.global.world.raws.language.word_table[0][35]
    end)
    if ok and word_table and #word_table.words.Adjectives > 0 and #word_table.words.TheX > 0 then
        name.words.FirstAdjective = word_table.words.Adjectives[math.random(0, #word_table.words.Adjectives - 1)]
        name.words.TheX = word_table.words.TheX[math.random(0, #word_table.words.TheX - 1)]
    else
        name.first_name = 'New location'
    end
    return name
end

function current_site()
    local ok, site = pcall(dfhack.world.getCurrentSite)
    if ok then return site end
    return nil
end

function site_owner_id(site)
    if not site then return -1 end
    for _, entity_site_link in ipairs(site.entity_links) do
        local he = df.historical_entity.find(entity_site_link.entity_id)
        if he and he.type == df.historical_entity_type.SiteGovernment then
            return he.id
        end
    end
    return site.cur_owner_id or -1
end

function set_location_flags(loc)
    loc.flags.VISITORS_ALLOWED = true
    loc.flags.NON_CITIZENS_ALLOWED = true
    loc.flags.MEMBERS_ONLY = false
end

function create_location(site, kind)
    local meta = LOCATION_TYPES[kind]
    if not site or not meta then return nil, 'unknown location type' end
    local loc_id = site.next_building_id
    site.buildings:insert('#', {
        new = meta.klass,
        id = loc_id,
        site_id = site.id,
        site_owner_id = site_owner_id(site),
        pos = {x = site.pos.x, y = site.pos.y},
        name = generated_location_name(meta.name_type),
    })
    site.next_building_id = site.next_building_id + 1
    local loc = site.buildings[#site.buildings - 1]
    set_location_flags(loc)
    if meta.apply then meta.apply(loc) end
    return loc, ''
end

function detach_zone_location(zone)
    if zone.site_id ~= -1 and zone.location_id ~= -1 then
        local old_site = df.world_site.find(zone.site_id)
        local old_loc = find_location(old_site, zone.location_id)
        local contents = old_loc and old_loc:getContents()
        if contents then erase_value(contents.building_ids, zone.id) end
    end
    zone.site_id = -1
    zone.location_id = -1
end

function attach_zone_location(zone, site, loc)
    detach_zone_location(zone)
    zone.site_id = site.id
    zone.location_id = loc.id
    local contents = loc:getContents()
    if contents and not vector_contains(contents.building_ids, zone.id) then
        contents.building_ids:insert('#', zone.id)
    end
    zone:uncategorize()
    zone:categorize(true)
end

-- Occupation display labels; a slot with histfig_id and unit_id both -1 is open.
local OCCUPATION_LABELS = {
    [df.occupation_type.TAVERN_KEEPER] = 'Tavern Keeper',
    [df.occupation_type.PERFORMER]     = 'Performer',
    [df.occupation_type.SCHOLAR]       = 'Scholar',
    [df.occupation_type.MERCENARY]     = 'Mercenary',
    [df.occupation_type.MONSTER_SLAYER]= 'Monster Slayer',
    [df.occupation_type.SCRIBE]        = 'Scribe',
    [df.occupation_type.DOCTOR]        = 'Doctor',
    [df.occupation_type.DIAGNOSTICIAN] = 'Diagnostician',
    [df.occupation_type.SURGEON]       = 'Surgeon',
    [df.occupation_type.BONE_DOCTOR]   = 'Bone Doctor',
}

function occupation_label(occ_type)
    return OCCUPATION_LABELS[occ_type] or tostring(df.occupation_type[occ_type] or 'Occupation')
end

function occupation_holder_name(occ)
    if occ.unit_id and occ.unit_id ~= -1 then
        local unit = df.unit.find(occ.unit_id)
        if unit then
            local ok, name = pcall(dfhack.units.getReadableName, unit)
            if ok and name and #name > 0 then return name end
        end
    end
    if occ.histfig_id and occ.histfig_id ~= -1 then
        local hf = df.historical_figure.find(occ.histfig_id)
        if hf then
            local ok, name = pcall(dfhack.translation.translateName, hf.name, true)
            if ok and name and #name > 0 then return name end
        end
    end
    return ''
end

function location_restriction(loc)
    if loc.flags.MEMBERS_ONLY then return 'members' end
    if loc.flags.VISITORS_ALLOWED and loc.flags.NON_CITIZENS_ALLOWED then return 'visitors' end
    if loc.flags.NON_CITIZENS_ALLOWED then return 'residents' end
    return 'citizens'
end

function occupations_json(loc)
    local out = {}
    for _, occ in ipairs(loc.occupations) do
        out[#out + 1] = '{"type":' .. json_string(occupation_label(occ.type)) ..
            ',"holder":' .. json_string(occupation_holder_name(occ)) ..
            ',"assigned":' .. json_bool(occ.histfig_id ~= -1 or occ.unit_id ~= -1) .. '}'
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function location_dedication(loc)
    if df.abstract_building_guildhallst:is_instance(loc) then
        local prof = loc.contents.profession
        if prof and prof ~= df.profession.NONE then
            local ok, label = pcall(function() return tostring(df.profession[prof]) end)
            if ok and label and #label > 0 then return label end
        end
    end
    return ''
end

function location_to_json(loc, current_id)
    local contents = loc:getContents()
    local zones = contents and contents.building_ids or {}
    return '{' ..
        '"id":' .. tostring(loc.id) ..
        ',"kind":' .. json_string(location_kind(loc)) ..
        ',"label":' .. json_string(location_label(loc)) ..
        ',"name":' .. json_string(location_name(loc)) ..
        ',"current":' .. json_bool(loc.id == current_id) ..
        ',"zoneCount":' .. tostring(#zones) ..
        ',"restriction":' .. json_string(location_restriction(loc)) ..
        ',"dedication":' .. json_string(location_dedication(loc)) ..
        ',"occupations":' .. occupations_json(loc) ..
        '}'
end

function zone_locations_json(zone_id)
    local zone = get_civzone(zone_id)
    if not zone then return '', 'zone not found' end
    if not zone_allows_location(zone) then return '', 'zone does not accept locations' end
    local site = current_site()
    if not site then return '', 'current site unavailable' end
    local ok_name, zone_name = pcall(dfhack.buildings.getName, zone)
    if not ok_name then zone_name = '' end
    local zone_type = tostring(df.civzone_type[zone.type] or zone.type)
    local locs = {}
    for _, loc in ipairs(site.buildings) do
        local kind = location_kind(loc)
        if LOCATION_TYPES[kind] then
            table.insert(locs, location_to_json(loc, zone.location_id))
        end
    end
    local create = {}
    for _, kind in ipairs(LOCATION_CREATE_ORDER) do
        table.insert(create, '{"kind":' .. json_string(kind) ..
            ',"label":' .. json_string(LOCATION_TYPES[kind].label) .. '}')
    end
    return '{"id":' .. tostring(zone.id) ..
        ',"type":' .. json_string(zone_type) ..
        ',"name":' .. json_string(zone_name or '') ..
        ',"locationId":' .. tostring(zone.location_id or -1) ..
        ',"locations":[' .. table.concat(locs, ',') .. ']' ..
        ',"createTypes":[' .. table.concat(create, ',') .. ']}' , ''
end

function zone_location_action(zone_id, action, kind, location_id)
    local zone = get_civzone(zone_id)
    if not zone then return false, 'zone not found' end
    if not zone_allows_location(zone) then return false, 'zone does not accept locations' end
    local site = current_site()
    if not site then return false, 'current site unavailable' end
    action = tostring(action or '')
    if action == 'clear' then
        detach_zone_location(zone)
        zone:uncategorize()
        zone:categorize(true)
        return true, ''
    elseif action == 'assign' then
        local loc = find_location(site, tonumber(location_id) or -1)
        if not loc then return false, 'location not found' end
        attach_zone_location(zone, site, loc)
        return true, ''
    elseif action == 'create' then
        local loc, err = create_location(site, tostring(kind or ''))
        if not loc then return false, err end
        attach_zone_location(zone, site, loc)
        return true, ''
    elseif action == 'restrict' then
        local loc = find_location(site, tonumber(location_id) or zone.location_id or -1)
        if not loc then return false, 'location not found' end
        local mode = tostring(kind or '')
        if mode == 'everyone' then
            loc.flags.VISITORS_ALLOWED = true
            loc.flags.NON_CITIZENS_ALLOWED = true
            loc.flags.MEMBERS_ONLY = false
        elseif mode == 'citizens' then
            loc.flags.VISITORS_ALLOWED = false
            loc.flags.NON_CITIZENS_ALLOWED = false
            loc.flags.MEMBERS_ONLY = false
        elseif mode == 'members' then
            loc.flags.MEMBERS_ONLY = true
        else
            return false, 'unknown restriction mode'
        end
        return true, ''
    elseif action == 'rename' then
        local loc = find_location(site, tonumber(location_id) or zone.location_id or -1)
        if not loc then return false, 'location not found' end
        local newname = tostring(kind or '')
        if #newname == 0 then return false, 'empty name' end
        local name = loc.name
        name.has_name = true
        name.first_name = newname
        -- Clear the generated word slots so translateName renders just the custom first_name.
        for i = 0, 6 do name.words[i] = -1 end
        return true, ''
    elseif action == 'retire' then
        local loc = find_location(site, tonumber(location_id) or zone.location_id or -1)
        if not loc then return false, 'location not found' end
        if zone.location_id == loc.id then detach_zone_location(zone) end
        local assigned = 0
        for _, occ in ipairs(loc.occupations) do
            if occ.histfig_id ~= -1 then assigned = assigned + 1 end
        end
        local zones = 0
        local contents = loc:getContents()
        if contents then
            for _, zid in ipairs(contents.building_ids) do
                if df.building.find(zid) then zones = zones + 1 end
            end
        end
        if assigned + zones > 0 then
            return false, 'location in use (unassign occupations / detach zones first)'
        end
        loc.flags.DOES_NOT_EXIST = true
        local all = df.global.world.occupations.all
        for i = #all - 1, 0, -1 do
            local occ = all[i]
            if occ.site_id == loc.site_id and occ.location_id == loc.id then
                all:erase(i)
            end
        end
        return true, ''
    end
    return false, 'unknown location action'
end

-- The one living-citizen predicate for Lua assignment lists: isCitizen alone still passes
-- retained corpses and ghosts out of world.units.active.
function is_living_citizen(unit)
    if not unit then return false end
    local ok, result = pcall(function()
        return dfhack.units.isCitizen(unit, true)
            and dfhack.units.isActive(unit)
            and not dfhack.units.isDead(unit)
            and not dfhack.units.isGhost(unit)
    end)
    return ok and result or false
end

-- Occupation types each location kind offers; verified=false blocks creating a new slot of it.
local OCCUPATION_SLOTS = {
    tavern = {
        {type = df.occupation_type.TAVERN_KEEPER, verified = true},
        {type = df.occupation_type.PERFORMER,     verified = true},
    },
    library = {
        {type = df.occupation_type.SCHOLAR, verified = true},
        {type = df.occupation_type.SCRIBE,  verified = true},
    },
    hospital = {
        {type = df.occupation_type.DOCTOR,         verified = true},
        {type = df.occupation_type.DIAGNOSTICIAN,  verified = true},
        {type = df.occupation_type.SURGEON,        verified = true},
        {type = df.occupation_type.BONE_DOCTOR,    verified = true},
    },
    temple = {
        {type = df.occupation_type.PERFORMER, verified = true},
    },
    guildhall = {},   -- DF admits no occupation type on a guildhall.
}

-- Guard: allow assigning into slot types not verified for the location kind.
local LOCATION_ALLOW_UNVERIFIED_SLOTS = false

-- Guard: rental_roomst.world_x/y/z has an unpinned coordinate space, so room writes stay off.
local LOCATION_ALLOW_ROOM_WRITES = false

function occupation_type_key(occ_type)
    local ok, key = pcall(function() return tostring(df.occupation_type[occ_type]) end)
    if ok and key and #key > 0 then return key end
    return tostring(occ_type)
end

function location_zone_records(loc)
    local zones = {}
    local contents = loc:getContents()
    if not contents then return zones end
    for _, zid in ipairs(contents.building_ids) do
        local z = df.building.find(zid)
        if z and df.building_civzonest:is_instance(z) then
            local ok_name, zname = pcall(dfhack.buildings.getName, z)
            table.insert(zones, {
                id = z.id,
                name = (ok_name and zname) or '',
                type = tostring(df.civzone_type[z.type] or z.type),
                x1 = z.x1, x2 = z.x2, y1 = z.y1, y2 = z.y2, z = z.z,
            })
        end
    end
    return zones
end

function unit_in_zone_record(unit, rec)
    local p = unit.pos
    return p.z == rec.z and p.x >= rec.x1 and p.x <= rec.x2 and p.y >= rec.y1 and p.y <= rec.y2
end

function location_occupancy(loc, zones)
    local out = {inside = 0, citizens = 0, residents = 0, visitors = 0, others = 0, names = {}}
    local units = df.global.world and df.global.world.units and df.global.world.units.active
    if not units or #zones == 0 then return out end
    for _, unit in ipairs(units) do
        dwf_probe('lua.probe.location-occupancy', function()
            if dfhack.units.isDead(unit) or not dfhack.units.isActive(unit) then return end
            local hit = false
            for _, rec in ipairs(zones) do
                if unit_in_zone_record(unit, rec) then hit = true break end
            end
            if not hit then return end
            out.inside = out.inside + 1
            if is_living_citizen(unit) then
                out.citizens = out.citizens + 1
            elseif dfhack.units.isResident(unit, true) then
                out.residents = out.residents + 1
            elseif dfhack.units.isVisiting(unit) then
                out.visitors = out.visitors + 1
            else
                out.others = out.others + 1
            end
            if #out.names < 24 then
                local name = dwf_probe('lua.probe.unit-readable-name', dfhack.units.getReadableName, unit)
                table.insert(out.names, name or ('Unit ' .. tostring(unit.id)))
            end
        end)
    end
    return out
end

-- A vacant row has id == -1; assigning to it creates the occupation.
function location_occupation_rows(loc, kind)
    local rows = {}
    local seen = {}
    for _, occ in ipairs(loc.occupations) do
        local key = occupation_type_key(occ.type)
        local profession_color = -1
        if (occ.unit_id or -1) >= 0 then
            local unit = df.unit.find(occ.unit_id)
            local ok_color, color = pcall(dfhack.units.getProfessionColor, unit)
            profession_color = (ok_color and color) or -1
        end
        seen[occ.type] = (seen[occ.type] or 0) + 1
        table.insert(rows, {
            id = occ.id,
            typeKey = key,
            label = occupation_label(occ.type),
            unitId = occ.unit_id,
            histfigId = occ.histfig_id,
            holder = occupation_holder_name(occ),
            professionColor = profession_color,
            assigned = (occ.histfig_id ~= -1 or occ.unit_id ~= -1),
            verified = true,
        })
    end
    for _, slot in ipairs(OCCUPATION_SLOTS[kind] or {}) do
        if not seen[slot.type] then
            table.insert(rows, {
                id = -1,
                typeKey = occupation_type_key(slot.type),
                label = occupation_label(slot.type),
                unitId = -1,
                histfigId = -1,
                holder = '',
                professionColor = -1,
                assigned = false,
                verified = slot.verified,
            })
        end
    end
    return rows
end

function occupation_row_json(row)
    return '{"id":' .. tostring(row.id) ..
        ',"typeKey":' .. json_string(row.typeKey) ..
        ',"label":' .. json_string(row.label) ..
        ',"unitId":' .. tostring(row.unitId) ..
        ',"histfigId":' .. tostring(row.histfigId) ..
        ',"holder":' .. json_string(row.holder) ..
        ',"professionColor":' .. tostring(row.professionColor or -1) ..
        ',"assigned":' .. json_bool(row.assigned) ..
        ',"verified":' .. json_bool(row.verified) .. '}'
end

function histfig_display_name(hf_id)
    local hf = df.historical_figure.find(hf_id or -1)
    if not hf then return '' end
    local ok, name = pcall(dfhack.translation.translateName, hf.name, true)
    if ok and name and #name > 0 then return name end
    return 'Figure ' .. tostring(hf_id)
end

function entity_display_name(entity_id)
    local he = df.historical_entity.find(entity_id or -1)
    if not he then return '' end
    local ok, name = pcall(dfhack.translation.translateName, he.name, true)
    if ok and name and #name > 0 then return name end
    return 'Group ' .. tostring(entity_id)
end

function temple_deity_options()
    local deities, religions = {}, {}
    local units = df.global.world and df.global.world.units and df.global.world.units.active or {}
    for _, unit in ipairs(units) do
        if is_living_citizen(unit) and (unit.hist_figure_id or -1) >= 0 then
            local hf = df.historical_figure.find(unit.hist_figure_id)
            if hf then
                for _, link in ipairs(hf.histfig_links) do
                    if df.histfig_hf_link_deityst:is_instance(link) and link.target_hf >= 0 then
                        deities[link.target_hf] = (deities[link.target_hf] or 0) + 1
                    end
                end
                for _, link in ipairs(hf.entity_links) do
                    local he = df.historical_entity.find(link.entity_id or -1)
                    if he and he.type == df.historical_entity_type.Religion then
                        religions[he.id] = (religions[he.id] or 0) + 1
                    end
                end
            end
        end
    end
    local out = {}
    for hf_id, count in pairs(deities) do
        table.insert(out, {mode = 'hf', id = hf_id, name = histfig_display_name(hf_id), count = count})
    end
    for ent_id, count in pairs(religions) do
        table.insert(out, {mode = 'religion', id = ent_id, name = entity_display_name(ent_id), count = count})
    end
    table.sort(out, function(a, b)
        if a.count ~= b.count then return a.count > b.count end
        return a.name < b.name
    end)
    return out
end

function temple_json(loc)
    if not df.abstract_building_templest:is_instance(loc) then return 'null' end
    local mode, id, name = 'none', -1, ''
    if loc.deity_type == df.religious_practice_type.WORSHIP_HFID then
        mode, id = 'hf', loc.deity_data.Deity
        name = histfig_display_name(id)
    elseif loc.deity_type == df.religious_practice_type.RELIGION_ENID then
        mode, id = 'religion', loc.deity_data.Religion
        name = entity_display_name(id)
    end
    local opts = {}
    for _, o in ipairs(temple_deity_options()) do
        table.insert(opts, '{"mode":' .. json_string(o.mode) ..
            ',"id":' .. tostring(o.id) ..
            ',"name":' .. json_string(o.name) ..
            ',"worshippers":' .. tostring(o.count) ..
            ',"current":' .. json_bool(o.mode == mode and o.id == id) .. '}')
    end
    return '{"mode":' .. json_string(mode) ..
        ',"id":' .. tostring(id) ..
        ',"name":' .. json_string(name) ..
        ',"dedicated":' .. json_bool(mode ~= 'none') ..
        ',"options":[' .. table.concat(opts, ',') .. ']}'
end

function guild_options()
    local by_entity = {}
    local units = df.global.world and df.global.world.units and df.global.world.units.active or {}
    for _, unit in ipairs(units) do
        if is_living_citizen(unit) and (unit.hist_figure_id or -1) >= 0 then
            local hf = df.historical_figure.find(unit.hist_figure_id)
            if hf then
                for _, link in ipairs(hf.entity_links) do
                    local he = df.historical_entity.find(link.entity_id or -1)
                    if he and he.type == df.historical_entity_type.Guild then
                        by_entity[he.id] = (by_entity[he.id] or 0) + 1
                    end
                end
            end
        end
    end
    local out = {}
    for ent_id, members in pairs(by_entity) do
        local he = df.historical_entity.find(ent_id)
        local prof = df.profession.NONE
        if he and #he.guild_professions > 0 then prof = he.guild_professions[0].profession end
        if prof ~= df.profession.NONE then
            table.insert(out, {
                profession = prof,
                key = tostring(df.profession[prof]),
                name = entity_display_name(ent_id),
                members = members,
            })
        end
    end
    table.sort(out, function(a, b)
        if a.members ~= b.members then return a.members > b.members end
        return a.key < b.key
    end)
    return out
end

function guild_json(loc)
    if not df.abstract_building_guildhallst:is_instance(loc) then return 'null' end
    local prof = loc.contents.profession
    local key = (prof and prof ~= df.profession.NONE) and tostring(df.profession[prof]) or ''
    local opts = {}
    for _, o in ipairs(guild_options()) do
        table.insert(opts, '{"key":' .. json_string(o.key) ..
            ',"name":' .. json_string(o.name) ..
            ',"members":' .. tostring(o.members) ..
            ',"current":' .. json_bool(o.key == key) .. '}')
    end
    return '{"key":' .. json_string(key) ..
        ',"dedicated":' .. json_bool(#key > 0) ..
        ',"options":[' .. table.concat(opts, ',') .. ']}'
end

function rooms_json(loc)
    if not df.abstract_building_inn_tavernst:is_instance(loc) then return 'null' end
    -- service_orderst.room_ab_local_id indexes rental_roomst.id, not a zone or building id.
    local rentals = {}
    for _, occ in ipairs(loc.occupations) do
        for _, so in ipairs(occ.service_order) do
            if so.type == df.service_order_type.ROOM_RENTAL or
               so.type == df.service_order_type.EXTEND_ROOM_RENTAL then
                rentals[so.room_ab_local_id] = so
            end
        end
    end
    local rows = {}
    for _, room in ipairs(loc.room_info) do
        local zone = df.building.find(room.civzone or -1)
        local ok_name, zname = pcall(function() return zone and dfhack.buildings.getName(zone) or '' end)
        local so = rentals[room.id]
        local renter, renter_profession_color, owed, ends = '', -1, 0, -1
        if so then
            if (so.customer_unid or -1) >= 0 then
                local u = df.unit.find(so.customer_unid)
                local ok_u, un = pcall(function() return u and dfhack.units.getReadableName(u) or '' end)
                renter = (ok_u and un) or ''
                local ok_color, color = pcall(dfhack.units.getProfessionColor, u)
                renter_profession_color = (ok_color and color) or -1
            end
            if #renter == 0 and (so.customer_hfid or -1) >= 0 then
                renter = histfig_display_name(so.customer_hfid)
            end
            owed = so.money_owed or 0
            ends = so.end_year or -1
        end
        table.insert(rows, '{"id":' .. tostring(room.id) ..
            ',"label":' .. json_string(room.location or '') ..
            ',"civzoneId":' .. tostring(room.civzone or -1) ..
            ',"zoneName":' .. json_string((ok_name and zname) or '') ..
            ',"x":' .. tostring(room.world_x or 0) ..
            ',"y":' .. tostring(room.world_y or 0) ..
            ',"z":' .. tostring(room.world_z or 0) ..
            ',"rented":' .. json_bool(so ~= nil) ..
            ',"renter":' .. json_string(renter) ..
            ',"renterProfessionColor":' .. tostring(renter_profession_color) ..
            ',"owed":' .. tostring(owed) ..
            ',"endYear":' .. tostring(ends) .. '}')
    end
    return '{"canWrite":' .. json_bool(LOCATION_ALLOW_ROOM_WRITES) ..
        ',"rooms":[' .. table.concat(rows, ',') .. ']}'
end

-- entity_position_assignment.ab_id is the abstract building the position serves.
function location_positions_json(loc)
    local fort = fort_entity()
    if not fort then return '[]' end
    local rows = {}
    for _, a in ipairs(fort.positions.assignments) do
        if a and (a.ab_id or -1) == loc.id then
            local pname = ''
            local holder_profession_color = -1
            for _, p in ipairs(fort.positions.own) do
                if p.id == a.position_id then pname = p.name[0] or '' break end
            end
            if (a.histfig or -1) >= 0 then
                local units = df.global.world and df.global.world.units and df.global.world.units.active or {}
                for _, unit in ipairs(units) do
                    if unit and unit.hist_figure_id == a.histfig then
                        local ok_color, color = pcall(dfhack.units.getProfessionColor, unit)
                        holder_profession_color = (ok_color and color) or -1
                        break
                    end
                end
            end
            table.insert(rows, '{"assignmentId":' .. tostring(a.id) ..
                ',"positionId":' .. tostring(a.position_id) ..
                ',"name":' .. json_string(pname) ..
                ',"holder":' .. json_string(histfig_display_name(a.histfig)) ..
                ',"professionColor":' .. tostring(holder_profession_color) ..
                ',"vacant":' .. json_bool((a.histfig or -1) < 0) .. '}')
        end
    end
    return '[' .. table.concat(rows, ',') .. ']'
end

-- Assignment candidates must also be adult and sane: is_living_citizen deliberately keeps
-- children and the insane, and without this narrowing children are offered as hospital staff.
local function is_occupation_candidate(unit)
    if not is_living_citizen(unit) then return false end
    local ok, result = pcall(function()
        return dfhack.units.isAdult(unit) and dfhack.units.isSane(unit)
    end)
    return ok and result or false
end

function location_candidates_json(loc)
    local rows = {}
    local units = df.global.world and df.global.world.units and df.global.world.units.active or {}
    local holders = {}
    for _, occ in ipairs(loc.occupations) do
        if (occ.unit_id or -1) >= 0 then holders[occ.unit_id] = occupation_label(occ.type) end
    end
    for _, unit in ipairs(units) do
        if is_occupation_candidate(unit) and (unit.hist_figure_id or -1) >= 0 then
            local ok_name, name = pcall(dfhack.units.getReadableName, unit)
            local ok_prof, prof = pcall(dfhack.units.getProfessionName, unit)
            local ok_color, profession_color = pcall(dfhack.units.getProfessionColor, unit)
            table.insert(rows, '{"unitId":' .. tostring(unit.id) ..
                ',"name":' .. json_string((ok_name and name) or ('Unit ' .. tostring(unit.id))) ..
                ',"profession":' .. json_string((ok_prof and prof) or '') ..
                ',"professionColor":' .. tostring((ok_color and profession_color) or -1) ..
                ',"heldOccupation":' .. json_string(holders[unit.id] or '') .. '}')
        end
    end
    return '[' .. table.concat(rows, ',') .. ']'
end

function location_probe_json(loc)
    local occs = {}
    for _, occ in ipairs(loc.occupations) do
        local links = {}
        local hf = df.historical_figure.find(occ.histfig_id or -1)
        if hf then
            for _, l in ipairs(hf.entity_links) do
                if df.histfig_entity_link_occupationst:is_instance(l) then
                    table.insert(links, '{"kind":"entity","entityId":' .. tostring(l.entity_id) ..
                        ',"vecIdx":' .. tostring(l.entity_vector_idx) ..
                        ',"strength":' .. tostring(l.link_strength) ..
                        ',"occupationId":' .. tostring(l.occupation_id) ..
                        ',"startYear":' .. tostring(l.start_year) .. '}')
                end
            end
            for _, l in ipairs(hf.site_links) do
                if df.histfig_site_link_occupationst:is_instance(l) then
                    table.insert(links, '{"kind":"site","site":' .. tostring(l.site) ..
                        ',"subId":' .. tostring(l.sub_id) ..
                        ',"entity":' .. tostring(l.entity) ..
                        ',"occupationId":' .. tostring(l.occupation_id) .. '}')
                end
            end
        end
        table.insert(occs, '{"id":' .. tostring(occ.id) ..
            ',"type":' .. json_string(occupation_type_key(occ.type)) ..
            ',"unitId":' .. tostring(occ.unit_id) ..
            ',"histfigId":' .. tostring(occ.histfig_id) ..
            ',"locationId":' .. tostring(occ.location_id) ..
            ',"siteId":' .. tostring(occ.site_id) ..
            ',"groupId":' .. tostring(occ.group_id) ..
            ',"serviceOrders":' .. tostring(#occ.service_order) ..
            ',"nextServiceOrderId":' .. tostring(occ.next_service_order_id) ..
            ',"hfLinks":[' .. table.concat(links, ',') .. ']}')
    end
    local next_id = -1
    local ok_next = pcall(function() next_id = df.global.occupation_next_id end)
    return '{"occupationNextId":' .. tostring(ok_next and next_id or -1) ..
        ',"globalOccupations":' .. tostring(#df.global.world.occupations.all) ..
        ',"occupations":[' .. table.concat(occs, ',') .. ']}'
end

function location_detail_json(location_id)
    local site = current_site()
    if not site then return '', 'current site unavailable' end
    local loc = find_location(site, tonumber(location_id) or -1)
    if not loc then return '', 'location not found' end
    local kind = location_kind(loc)
    local contents = loc:getContents()
    local zones = location_zone_records(loc)
    local occ = location_occupancy(loc, zones)
    local zone_json = {}
    for _, z in ipairs(zones) do
        table.insert(zone_json, '{"id":' .. tostring(z.id) ..
            ',"name":' .. json_string(z.name) ..
            ',"type":' .. json_string(z.type) .. '}')
    end
    local occ_json = {}
    for _, row in ipairs(location_occupation_rows(loc, kind)) do
        table.insert(occ_json, occupation_row_json(row))
    end
    local names = {}
    for _, n in ipairs(occ.names) do table.insert(names, json_string(n)) end
    return '{"id":' .. tostring(loc.id) ..
        ',"kind":' .. json_string(kind) ..
        ',"label":' .. json_string(location_label(loc)) ..
        ',"name":' .. json_string(location_name(loc)) ..
        ',"restriction":' .. json_string(location_restriction(loc)) ..
        ',"tier":' .. (contents and tostring(contents.location_tier) or 'null') ..
        ',"value":' .. (contents and tostring(contents.location_value) or 'null') ..
        ',"zones":[' .. table.concat(zone_json, ',') .. ']' ..
        ',"occupancy":{"inside":' .. tostring(occ.inside) ..
            ',"citizens":' .. tostring(occ.citizens) ..
            ',"residents":' .. tostring(occ.residents) ..
            ',"visitors":' .. tostring(occ.visitors) ..
            ',"others":' .. tostring(occ.others) ..
            ',"inhabitants":' .. tostring(#loc.inhabitants) ..
            ',"names":[' .. table.concat(names, ',') .. ']}' ..
        ',"occupations":[' .. table.concat(occ_json, ',') .. ']' ..
        ',"allowNewSlots":' .. json_bool(LOCATION_ALLOW_UNVERIFIED_SLOTS) ..
        ',"temple":' .. temple_json(loc) ..
        ',"guild":' .. guild_json(loc) ..
        ',"rooms":' .. rooms_json(loc) ..
        ',"positions":' .. location_positions_json(loc) ..
        ',"candidates":' .. location_candidates_json(loc) ..
        ',"probe":' .. location_probe_json(loc) .. '}', ''
end

function find_location_occupation(loc, occ_id, type_key)
    for _, occ in ipairs(loc.occupations) do
        if occ_id >= 0 and occ.id == occ_id then return occ end
    end
    if occ_id >= 0 then return nil end
    for _, occ in ipairs(loc.occupations) do
        if occupation_type_key(occ.type) == type_key then return occ end
    end
    return nil
end

function occupation_slot_verified(kind, occ_type)
    for _, slot in ipairs(OCCUPATION_SLOTS[kind] or {}) do
        if slot.type == occ_type then return slot.verified end
    end
    return nil
end

-- Unlink the old holder's histfig_entity_link_occupationst before relinking, or both sides drift.
function unlink_occupation_holder(hf_id, occupation_id)
    local hf = df.historical_figure.find(hf_id or -1)
    if not hf then return end
    for i = #hf.entity_links - 1, 0, -1 do
        local l = hf.entity_links[i]
        if df.histfig_entity_link_occupationst:is_instance(l) and l.occupation_id == occupation_id then
            hf.entity_links:erase(i)
        end
    end
end

function link_occupation_holder(hf, entity_id, occupation_id)
    for _, l in ipairs(hf.entity_links) do
        if df.histfig_entity_link_occupationst:is_instance(l) and l.occupation_id == occupation_id then
            return
        end
    end
    -- Never synthesise a histfig_site_link_occupationst here: its sub_id cannot be derived, and a
    -- half-formed link is a corrupt record where a missing one is merely inert.
    hf.entity_links:insert('#', {
        new = df.histfig_entity_link_occupationst,
        entity_id = entity_id,
        entity_vector_idx = -1,
        link_strength = 100,
        occupation_id = occupation_id,
        start_year = df.global.cur_year,
    })
end

function location_occupation_assign(loc, kind, occ_id, type_key, unit_id)
    local site = current_site()
    local fort = fort_entity()
    if not site then return false, 'current site unavailable' end
    if not fort then return false, 'fort entity unavailable' end

    local occ = find_location_occupation(loc, occ_id, type_key)

    if unit_id < 0 then
        if not occ then return false, 'no such occupation slot' end
        if (occ.histfig_id or -1) >= 0 then
            unlink_occupation_holder(occ.histfig_id, occ.id)
        end
        occ.unit_id = -1
        occ.histfig_id = -1
        return true, ''
    end

    local unit = df.unit.find(unit_id)
    if not unit then return false, 'unit not found' end
    if not is_living_citizen(unit) then return false, 'unit is not an assignable living citizen' end
    if (unit.hist_figure_id or -1) < 0 then return false, 'unit has no historical figure' end

    if not occ then
        local occ_type = df.occupation_type[type_key]
        if occ_type == nil then return false, 'unknown occupation type' end
        local verified = occupation_slot_verified(kind, occ_type)
        if verified == nil then
            return false, 'that location kind does not offer this occupation'
        end
        if not verified and not LOCATION_ALLOW_UNVERIFIED_SLOTS then
            return false, 'this slot is not verified for this location kind (guarded -- see B229 probe #3)'
        end
        local new_id = df.global.occupation_next_id
        df.global.occupation_next_id = new_id + 1
        df.global.world.occupations.all:insert('#', {
            new = df.occupation,
            id = new_id,
            type = occ_type,
            histfig_id = -1,
            unit_id = -1,
            location_id = loc.id,
            site_id = site.id,
            group_id = fort.id,
            next_service_order_id = 0,
        })
        occ = df.global.world.occupations.all[#df.global.world.occupations.all - 1]
        loc.occupations:insert('#', occ)
    end

    if (occ.histfig_id or -1) >= 0 and occ.histfig_id ~= unit.hist_figure_id then
        unlink_occupation_holder(occ.histfig_id, occ.id)
    end
    occ.unit_id = unit.id
    occ.histfig_id = unit.hist_figure_id
    local hf = df.historical_figure.find(unit.hist_figure_id)
    if hf then link_occupation_holder(hf, fort.id, occ.id) end
    return true, ''
end

function location_set_deity(loc, spec)
    if not df.abstract_building_templest:is_instance(loc) then return false, 'not a temple' end
    if loc.deity_type ~= df.religious_practice_type.NONE then
        return false, 'temple is already dedicated (native offers no re-dedication -- retire and re-create)'
    end
    local mode, id = string.match(tostring(spec or ''), '^(%a+):(-?%d+)$')
    id = tonumber(id or -1) or -1
    if mode == 'hf' then
        if not df.historical_figure.find(id) then return false, 'unknown deity' end
        loc.deity_type = df.religious_practice_type.WORSHIP_HFID
        loc.deity_data.Deity = id
        return true, ''
    elseif mode == 'religion' then
        local he = df.historical_entity.find(id)
        if not he or he.type ~= df.historical_entity_type.Religion then return false, 'unknown religion' end
        loc.deity_type = df.religious_practice_type.RELIGION_ENID
        loc.deity_data.Religion = id
        return true, ''
    end
    return false, 'bad deity spec (expected hf:<id> or religion:<id>)'
end

function location_set_guild(loc, prof_key)
    if not df.abstract_building_guildhallst:is_instance(loc) then return false, 'not a guildhall' end
    if loc.contents.profession ~= df.profession.NONE then
        return false, 'guildhall is already dedicated (retire and re-create to change it)'
    end
    local prof = df.profession[tostring(prof_key or '')]
    if prof == nil or prof == df.profession.NONE then return false, 'unknown craft guild' end
    local allowed = false
    for _, o in ipairs(guild_options()) do
        if o.profession == prof then allowed = true break end
    end
    if not allowed then return false, 'no guild of that craft exists in this fort' end
    loc.contents.profession = prof
    return true, ''
end

-- location_id is a LOCATION id, not a zone id; kind carries the action payload
-- ('<OCCUPATION_TYPE>' or 'id:<n>' | 'hf:<id>'/'religion:<id>' | '<PROFESSION>').
function location_action(location_id, action, kind, unit_id)
    local site = current_site()
    if not site then return false, 'current site unavailable' end
    local loc = find_location(site, tonumber(location_id) or -1)
    if not loc then return false, 'location not found' end
    action = tostring(action or '')
    kind = tostring(kind or '')
    unit_id = tonumber(unit_id) or -1
    if action == 'occupation-assign' then
        local occ_id, type_key = -1, kind
        local explicit = string.match(kind, '^id:(%d+)$')
        if explicit then occ_id, type_key = tonumber(explicit), '' end
        return location_occupation_assign(loc, location_kind(loc), occ_id, type_key, unit_id)
    elseif action == 'deity' then
        return location_set_deity(loc, kind)
    elseif action == 'guild' then
        return location_set_guild(loc, kind)
    elseif action == 'room-add' or action == 'room-remove' then
        if not LOCATION_ALLOW_ROOM_WRITES then
            return false, 'rented-room writes are guarded (B229 probe #4: pin rental_roomst.world_x/y/z)'
        end
        return false, 'rented-room writes not implemented'
    end
    return false, 'unknown location action'
end

-- Work orders (the Manager): list / create / import presets / cancel / adjust.

-- order_catalog() is defined below, next to order_catalog_by_shop.

-- Item types a stock condition can be written against.
local CONDITION_TARGETS = {
    {label='Drinks', item='DRINK'}, {label='Prepared meals', item='FOOD'},
    {label='Plants', item='PLANT'}, {label='Seeds', item='SEEDS'},
    {label='Meat', item='MEAT'}, {label='Fish', item='FISH'}, {label='Cheese', item='CHEESE'},
    {label='Eggs', item='EGG'}, {label='Logs', item='WOOD'}, {label='Bars', item='BAR'},
    {label='Blocks', item='BLOCKS'}, {label='Stones', item='BOULDER'}, {label='Rough gems', item='ROUGH'},
    {label='Cloth', item='CLOTH'}, {label='Thread', item='THREAD'}, {label='Leather', item='SKIN_TANNED'},
    {label='Beds', item='BED'}, {label='Doors', item='DOOR'}, {label='Tables', item='TABLE'},
    {label='Chairs', item='CHAIR'}, {label='Cabinets', item='CABINET'}, {label='Chests', item='BOX'},
    {label='Coffins', item='COFFIN'}, {label='Statues', item='STATUE'}, {label='Barrels', item='BARREL'},
    {label='Bins', item='BIN'}, {label='Buckets', item='BUCKET'}, {label='Bags', item='BAG'},
    {label='Pots / tools', item='TOOL'}, {label='Crafts', item='CRAFTS'}, {label='Mechanisms', item='TRAPPARTS'},
    {label='Weapons', item='WEAPON'}, {label='Body armor', item='ARMOR'}, {label='Shields', item='SHIELD'},
    {label='Helms', item='HELM'}, {label='Gloves', item='GLOVES'}, {label='Shoes', item='SHOES'},
    {label='Trousers', item='PANTS'}, {label='Ammo', item='AMMO'}, {label='Cages', item='CAGE'},
    {label='Totems', item='TOTEM'}, {label='Goblets', item='GOBLET'}, {label='Toys', item='TOY'},
    {label='Splints', item='SPLINT'}, {label='Crutches', item='CRUTCH'}, {label='Anvils', item='ANVIL'},
    {label='Soap', item='GLOB'},
}

-- item enum name -> friendly label (for condition display)
local ITEM_LABEL = {}
for _, t in ipairs(CONDITION_TARGETS) do ITEM_LABEL[t.item] = t.label end

function reaction_exists(code)
    local ok, found = pcall(function()
        local world = df.global.world
        local reactions = world and world.raws and world.raws.reactions and world.raws.reactions.reactions
        if not reactions then return false end
        for i = 0, #reactions - 1 do
            local rx = reactions[i]
            if rx and rx.code == code then return true end
        end
        return false
    end)
    return ok and found or false
end

-- Shops for the work-order picker: {buildingType, subtypeEnumName, label, icon}.
local SHOP_CATALOG_SPECS = {
    {'Workshop', 'Carpenters',      "Carpenter's Workshop",  'workshop_carpenter'},
    {'Workshop', 'Masons',          "Mason's Workshop",      'workshop_mason'},
    {'Workshop', 'Craftsdwarfs',    "Craftsdwarf's Workshop",'workshop_crafts'},
    {'Workshop', 'MetalsmithsForge',"Metalsmith's Forge",    'workshop_metalsmith'},
    {'Workshop', 'MagmaForge',      "Magma Forge",           'workshop_metalsmith'},
    {'Workshop', 'Jewelers',        "Jeweler's Workshop",    'workshop_jeweler'},
    {'Workshop', 'Bowyers',         "Bowyer's Workshop",     'workshop_bowyer'},
    {'Workshop', 'Mechanics',       "Mechanic's Workshop",   'workshop_mechanic'},
    {'Workshop', 'Siege',           "Siege Workshop",        'workshop_siege'},
    {'Workshop', 'Ashery',          "Ashery",                'workshop_ashery'},
    {'Workshop', 'Leatherworks',    "Leather Works",         'workshop_leather'},
    {'Workshop', 'Loom',            "Loom",                  'workshop_loom'},
    {'Workshop', 'Clothiers',       "Clothier's Shop",       'workshop_clothes'},
    {'Workshop', 'Dyers',           "Dyer's Shop",           'workshop_dyer'},
    {'Workshop', 'Still',           "Still",                 'workshop_still'},
    {'Workshop', 'Kitchen',         "Kitchen",               'workshop_kitchen'},
    {'Workshop', 'Butchers',        "Butcher's Shop",        'workshop_butcher'},
    {'Workshop', 'Tanners',         "Tanner's Shop",         'workshop_tanner'},
    {'Workshop', 'Fishery',         "Fishery",               'workshop_fishery'},
    {'Workshop', 'Farmers',         "Farmer's Workshop",     'workshop_farmer'},
    {'Workshop', 'Quern',           "Quern",                 'workshop_quern'},
    {'Workshop', 'Millstone',       "Millstone",             'workshop_millstone'},
    {'Workshop', 'Kennels',         "Kennels",               'workshop_kennel'},
    {'Furnace',  'Smelter',         "Smelter",               'furnace_smelter'},
    {'Furnace',  'MagmaSmelter',    "Magma Smelter",         'furnace_smelter'},
    {'Furnace',  'GlassFurnace',    "Glass Furnace",         'furnace_glass'},
    {'Furnace',  'MagmaGlassFurnace',"Magma Glass Furnace",  'furnace_glass'},
    {'Furnace',  'Kiln',            "Kiln",                  'furnace_kiln'},
    {'Furnace',  'MagmaKiln',       "Magma Kiln",            'furnace_kiln'},
    {'Furnace',  'WoodFurnace',     "Wood Furnace",          'furnace_wood'},
}

-- order_catalog_by_shop() is defined below, after the shop job tables it depends on.

function condition_targets()
    local items = {}
    for _, t in ipairs(CONDITION_TARGETS) do
        if df.item_type[t.item] ~= nil then
            table.insert(items, '{"item":' .. json_string(t.item) ..
                ',"label":' .. json_string(t.label) .. '}')
        end
    end
    return '{"ok":true,"targets":[' .. table.concat(items, ',') .. ']}\n'
end

function building_label(b)
    if not b then return '' end
    local ok, name = pcall(dfhack.buildings.getName, b)
    if ok and name and #name > 0 then return name end
    local btype = b:getType()
    if btype == df.building_type.Workshop then
        return pretty_enum_name(df.workshop_type[b.type], 'Workshop')
    elseif btype == df.building_type.Furnace then
        return pretty_enum_name(df.furnace_type[b.type], 'Furnace')
    end
    return pretty_enum_name(df.building_type[btype], 'Building')
end
