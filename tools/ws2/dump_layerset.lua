-- dump_layerset.lua: dump DF's PARSED dwarf graphics layer sets + palettes (read-only).
-- Run:  dfhack-run lua -f tools/ws2/dump_layerset.lua [out.json]
-- Output ~2.2MB JSON (gitignored); full layers only for role=DEFAULT sets.
-- (W-E scout 2026-07-07; input for bake_unit.py.)
local json = require('json')
local args = {...}
local OUT = args[1] or "dwarf_layerset.json"   -- relative to the DF working directory

local craw
for _, cr in ipairs(df.global.world.raws.creatures.all) do
    if cr.creature_id == 'DWARF' then craw = cr break end
end
assert(craw, "no DWARF")

local function colortok(ci)
    local ok, v = pcall(function() return df.global.world.raws.descriptors.colors[ci].id end)
    return ok and v or ci
end

local function vec(v, f)
    local t = {}
    for i = 0, #v - 1 do t[#t+1] = f and f(v[i]) or v[i] end
    return t
end

local out = { layer_sets = {} }
for si, ls in ipairs(craw.graphics.graphics_layer_set) do
    local e = {
        idx = si,
        role = df.creature_graphics_role[ls.role],
        prof = df.profession[ls.prof],
        el = ls.el, sl = ls.sl,
        portrait = ls.flags.portrait,
        template = ls.layer_set_template_token,
        palettes = {},
        layers = {},
    }
    for _, pp in ipairs(ls.palette_page) do
        table.insert(e.palettes, {
            token = pp.token, file = tostring(pp.filename), dir = tostring(pp.graphics_dir),
            default_row = pp.default_row, n_rows = #pp.row, row_width = pp.row_width,
            color_token = vec(pp.color_token, function(s) return s.value end),
            color_row = vec(pp.color_row),
        })
    end
    -- only dump full layers for the adult DEFAULT set (role DEFAULT, prof NONE) + summarize others
    local full = (df.creature_graphics_role[ls.role] == 'DEFAULT')
    e.n_layers = #ls.graphics_layer
    if full then
        for li, L in ipairs(ls.graphics_layer) do
            local r = {
                i = li, token = L.token,
                tex = { {L.texpos[0][0], L.texpos[0][1]}, {L.texpos[1][0], L.texpos[1][1]}, {L.texpos[2][0], L.texpos[2][1]} },
                order = L.pcg_layering,
                group = L.layer_group,
                offx = L.offset_x, offy = L.offset_y,
            }
            if L.flags.whole ~= 0 then
                r.flags = { child = L.flags.child, not_child = L.flags.not_child, ghost = L.flags.ghost,
                            item_pal = L.flags.use_standard_item_palette, suppressed = L.flags.suppressed_by_load_errors }
            end
            if #L.required_caste > 0 then r.req_caste = vec(L.required_caste) end
            if #L.required_profession > 0 then r.req_prof = vec(L.required_profession, function(p) return df.profession[p] end) end
            if #L.required_syn_class > 0 then r.req_syn = vec(L.required_syn_class, function(s) return s.value end) end
            if #L.random_part_condition_string > 0 then
                r.rand_part = { str = vec(L.random_part_condition_string, function(s) return s.value end),
                                idx = vec(L.random_part_condition_index), max = vec(L.random_part_condition_max) }
            end
            if L.haul_min_count ~= -1 or L.haul_max_count ~= -1 then r.haul = { L.haul_min_count, L.haul_max_count } end
            if L.body_size_min ~= 0 and L.body_size_min ~= -1 then r.body_size_min = L.body_size_min end
            if #L.use_palette_index > 0 then
                r.use_palette = { idx = vec(L.use_palette_index), row = vec(L.use_palette_row) }
            end
            if L.use_color_palette_token ~= "" then r.color_palette_token = L.use_color_palette_token end
            if L.use_standard_nex_body_palette_row ~= -1 then r.nex_body_row = L.use_standard_nex_body_palette_row end
            if L.use_standard_beast_palette_row ~= -1 then r.beast_row = L.use_standard_beast_palette_row end
            if #L.required_item > 0 then
                r.req_item = {}
                for _, it in ipairs(L.required_item) do
                    table.insert(r.req_item, {
                        caste = vec(it.check_caste), bp = vec(it.check_bp),
                        item_type = df.item_type[it.item_type], subtype = vec(it.item_subtype),
                        wield = it.flags.wield, any_held = it.flags.any_held, any_hauled = it.flags.any_hauled,
                        qual = { it.min_qual, it.max_qual }, dam = { it.min_dam_level, it.max_dam_level },
                    })
                end
            end
            if #L.forbidden_item > 0 then
                r.forb_item = {}
                for _, it in ipairs(L.forbidden_item) do
                    table.insert(r.forb_item, {
                        bp = vec(it.check_bp), item_type = df.item_type[it.item_type], subtype = vec(it.item_subtype),
                        wield = it.flags.wield,
                    })
                end
            end
            if #L.dye_color_index > 0 then r.dye_color = vec(L.dye_color_index, colortok) end
            if L.mat then r.mat = { subcat1 = vec(L.mat.subcat1), subcat2 = vec(L.mat.subcat2) } end
            if #L.tl_condition > 0 then
                r.tl = {}
                for _, tc in ipairs(L.tl_condition) do
                    local t = {
                        caste = vec(tc.check_caste), bp = vec(tc.check_bp), tl = vec(tc.check_tl),
                        shape = vec(tc.required_shape, function(s) return df.tissue_style_type[s] end),
                        not_shaped = tc.flags.requires_not_shaped,
                        len = { tc.min_length, tc.max_length }, dens = { tc.min_density, tc.max_density },
                        colors = vec(tc.color_index, colortok),
                    }
                    if #tc.swap > 0 then
                        t.swap = {}
                        for _, sw in ipairs(tc.swap) do
                            table.insert(t.swap, { cond = df.creature_graphics_tissue_layer_swap_condition_type[sw.swap_condition],
                                                   lim = sw.swap_condition_lim,
                                                   tex = { {sw.texpos[0][0], sw.texpos[0][1]}, {sw.texpos[1][0], sw.texpos[1][1]}, {sw.texpos[2][0], sw.texpos[2][1]} } })
                        end
                    end
                    table.insert(r.tl, t)
                end
            end
            if #L.bp_condition > 0 then
                r.bp = {}
                for _, bc in ipairs(L.bp_condition) do
                    table.insert(r.bp, { group = bc.layer_group, caste = vec(bc.check_caste), bp = vec(bc.check_bp),
                                         mod = vec(bc.modifier, function(m) return df.appearance_modifier_type[m] end),
                                         mmin = vec(bc.modifier_min), mmax = vec(bc.modifier_max),
                                         present = bc.flags.present, missing = bc.flags.missing, scarred = bc.flags.scarred })
                end
            end
            table.insert(e.layers, r)
        end
    end
    table.insert(out.layer_sets, e)
end

-- also: unit-side inputs for the miner test unit (dye colors resolved)
local u = df.unit.find(5505)
if u then
    out.miner_extra = { random_appearance_number = nil, inv = {} }
    pcall(function() out.miner_extra.random_appearance_number = u.enemy.random_appearance_number end)
    pcall(function() out.miner_extra.random_appearance_number2 = u.random_appearance_number end)
    for _, it in ipairs(u.inventory) do
        local item = it.item
        local e2 = { id = item.id, type = df.item_type[item:getType()] }
        pcall(function() e2.subtype = item.subtype.id end)
        pcall(function()
            -- effective dye color
            for _, imp in ipairs(item.improvements) do
                if df.itemimprovement_threadst:is_instance(imp) then
                    local mi = dfhack.matinfo.decode(imp.mat_type, imp.mat_index)
                    e2.dye_mat = mi:getToken()
                    e2.dye_color = colortok(mi.material.powder_dye)
                end
            end
        end)
        pcall(function()
            local mi = dfhack.matinfo.decode(item)
            e2.mat = mi:getToken()
            e2.mat_color = colortok(mi.material.state_color.Solid)
            e2.mat_flags_wood = mi.material.flags.WOOD or false
        end)
        table.insert(out.miner_extra.inv, e2)
    end
end

local f = io.open(OUT, "w")
f:write(json.encode(out))
f:close()
print("wrote " .. OUT)
for _, e in ipairs(out.layer_sets) do
    print(string.format("set %d role=%s prof=%s layers=%d palettes=%d portrait=%s",
        e.idx, e.role, e.prof, e.n_layers, #e.palettes, tostring(e.portrait)))
end
