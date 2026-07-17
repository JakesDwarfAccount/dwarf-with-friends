-- scout_units.lua: W-E appearance read-path scout (read-only).
-- Dumps unit texpos slots + full appearance for dwarves to JSON.
-- Run:  dfhack-run lua -f tools/ws2/scout_units.lua [out.json]
-- (W-E scout 2026-07-07; also the data source for bake_unit.py and gate_unitsprites.)
local json = require('json')
local args = {...}
local OUT = args[1] or "scout_units.json"   -- relative to the DF working directory

local function racetok(race)
    local cr = df.global.world.raws.creatures.all[race]
    return cr and cr.creature_id or ("race" .. race)
end

local out = {
    window = { x = df.global.window_x, y = df.global.window_y, z = df.global.window_z },
    gps = { dimx = df.global.gps.dimx, dimy = df.global.gps.dimy,
            viewport_w = df.global.gps.main_viewport and df.global.gps.main_viewport.dim_x or -1,
            viewport_h = df.global.gps.main_viewport and df.global.gps.main_viewport.dim_y or -1 },
    all_units = {},
    dwarves = {},
}

-- pass 1: every active unit's texpos state (the composite-cache census)
for _, u in ipairs(df.global.world.units.active) do
    local rec = {
        id = u.id, x = u.pos.x, y = u.pos.y, z = u.pos.z,
        race = racetok(u.race), caste = u.caste,
        prof = df.profession[u.profession],
        tex = { {u.texpos[0][0], u.texpos[0][1]}, {u.texpos[1][0], u.texpos[1][1]}, {u.texpos[2][0], u.texpos[2][1]} },
        in_use = { {u.texpos_currently_in_use[0][0], u.texpos_currently_in_use[0][1]},
                   {u.texpos_currently_in_use[1][0], u.texpos_currently_in_use[1][1]},
                   {u.texpos_currently_in_use[2][0], u.texpos_currently_in_use[2][1]} },
        sheet_icon = u.sheet_icon_texpos,
        portrait = u.portrait_texpos,
        tex_refresh = u.flags4.any_texture_must_be_refreshed,
        ambush = u.flags1.hidden_in_ambush,
        on_ground = u.flags1.on_ground,
        caged = u.flags1.caged,
    }
    table.insert(out.all_units, rec)
end

-- pass 2: full appearance for up to 6 dwarves (prefer camera z)
local wz = df.global.window_z
local picked = {}
for _, u in ipairs(df.global.world.units.active) do
    if racetok(u.race) == 'DWARF' and not u.flags1.inactive and u.pos.z == wz and #picked < 6 then
        table.insert(picked, u)
    end
end

for _, u in ipairs(picked) do
    local craw = df.global.world.raws.creatures.all[u.race]
    local caste = craw.caste[u.caste]
    local d = {
        id = u.id, name = dfhack.units.getReadableName(u),
        pos = { x = u.pos.x, y = u.pos.y, z = u.pos.z },
        caste_id = caste.caste_id,
        profession = df.profession[u.profession],
        profession2 = df.profession[u.profession2],
        custom_profession = u.custom_profession,
        squad_id = u.military.squad_id,
        civ_id = u.civ_id,
        tex = { {u.texpos[0][0], u.texpos[0][1]}, {u.texpos[1][0], u.texpos[1][1]}, {u.texpos[2][0], u.texpos[2][1]} },
        sheet_icon = u.sheet_icon_texpos,
    }
    -- colors: appearance.colors[i] -> caste.color_modifiers[i].pattern_index[v] -> pattern -> color tokens
    d.colors = {}
    for i = 0, #u.appearance.colors - 1 do
        local sel = u.appearance.colors[i]
        local cm = caste.color_modifiers[i]
        local e = { index = i, selected = sel, part = cm.part }
        local ok2 = pcall(function()
            local pid = cm.pattern_index[sel]
            e.pattern_id = pid
            local pat = df.global.world.raws.descriptors.patterns[pid]
            e.pattern_token = pat.id
            e.color_tokens = {}
            for _, cidx in ipairs(pat.colors) do
                table.insert(e.color_tokens, df.global.world.raws.descriptors.colors[cidx].id)
            end
        end)
        if not ok2 then e.decode_err = true end
        table.insert(d.colors, e)
    end
    -- tissue styling
    d.tissue = {}
    for i = 0, #u.appearance.tissue_style - 1 do
        local e = { index = i, style = df.tissue_style_type[u.appearance.tissue_style[i]] }
        pcall(function() e.style_civ = u.appearance.tissue_style_civ_id[i] end)
        pcall(function() e.style_id = u.appearance.tissue_style_id[i] end)
        pcall(function() e.style_type = u.appearance.tissue_style_type[i] end)
        pcall(function() e.length = u.appearance.tissue_length[i] end)
        table.insert(d.tissue, e)
    end
    -- caste-level tissue style raw tokens (decode aid)
    d.caste_tissue_styles = {}
    pcall(function()
        for _, ts in ipairs(caste.tissue_styles) do
            table.insert(d.caste_tissue_styles, { token = ts.token, id = ts.id })
        end
    end)
    -- body/bp appearance modifiers
    d.body_modifiers = {}
    pcall(function()
        for i = 0, #u.appearance.body_modifiers - 1 do
            table.insert(d.body_modifiers, u.appearance.body_modifiers[i])
        end
    end)
    d.size_modifier = nil
    pcall(function() d.size_modifier = u.appearance.size_modifier end)
    -- genes
    d.genes = { appearance = {}, colors = {} }
    pcall(function()
        for i = 0, #u.appearance.genes.appearance - 1 do
            table.insert(d.genes.appearance, u.appearance.genes.appearance[i])
        end
        for i = 0, #u.appearance.genes.colors - 1 do
            table.insert(d.genes.colors, u.appearance.genes.colors[i])
        end
    end)
    -- inventory
    d.inventory = {}
    for _, it in ipairs(u.inventory) do
        local item = it.item
        local e = {
            mode = df.inv_item_role_type[it.mode],
            body_part_id = it.body_part_id,
            item_id = item.id,
            item_type = df.item_type[item:getType()],
        }
        pcall(function()
            e.subtype_token = item.subtype.id
        end)
        pcall(function()
            local mi = dfhack.matinfo.decode(item)
            e.mat = mi:getToken()
            e.mat_color = mi.material.state_color.Solid
            e.mat_color_token = df.global.world.raws.descriptors.colors[mi.material.state_color.Solid].id
        end)
        pcall(function() e.wear = item.wear end)
        pcall(function() e.quality = item.quality end)
        -- dye: improvements with dye material
        pcall(function()
            for _, imp in ipairs(item.improvements) do
                if df.itemimprovement_threadst:is_instance(imp) then
                    e.dyed_mat_type = imp.mat_type
                    e.dyed_mat_index = imp.mat_index
                end
            end
        end)
        table.insert(d.inventory, e)
    end
    -- body part names for the inventory body_part_id decode
    d.body_parts = {}
    pcall(function()
        for i, bp in ipairs(caste.body_info.body_parts) do
            table.insert(d.body_parts, { idx = i, token = bp.token, category = bp.category })
        end
    end)
    -- syndromes
    d.syndromes = {}
    pcall(function()
        for _, su in ipairs(u.syndromes.active) do
            local syn = df.global.world.raws.syndromes.all[su.type]
            local classes = {}
            for _, c in ipairs(syn.syn_class) do table.insert(classes, c.value) end
            table.insert(d.syndromes, { type = su.type, classes = classes })
        end
    end)
    table.insert(out.dwarves, d)
end

-- pass 3: DWARF creature graphics structure census
local craw = nil
for _, cr in ipairs(df.global.world.raws.creatures.all) do
    if cr.creature_id == 'DWARF' then craw = cr break end
end
if craw then
    out.dwarf_graphics = { layer_sets = {} }
    for _, ls in ipairs(craw.graphics.graphics_layer_set) do
        local e = {
            role = df.creature_graphics_role[ls.role],
            prof = df.profession[ls.prof],
            portrait = ls.flags.portrait,
            n_layers = #ls.graphics_layer,
            n_palettes = #ls.palette_page,
            template = ls.layer_set_template_token,
            palettes = {},
        }
        for _, pp in ipairs(ls.palette_page) do
            table.insert(e.palettes, { token = pp.token, file = tostring(pp.filename),
                                       default_row = pp.default_row, rows = #pp.row, row_width = pp.row_width,
                                       n_color_tokens = #pp.color_token })
        end
        table.insert(out.dwarf_graphics.layer_sets, e)
    end
end

local f = io.open(OUT, "w")
f:write(json.encode(out))
f:close()
print("wrote " .. OUT .. "  units=" .. #out.all_units .. " dwarves=" .. #out.dwarves)
