-- dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
-- Copyright (C) 2026 Gabriel Rios
-- Copyright (C) 2026 Jake Taplin
--
-- This program is free software: you can redistribute it and/or modify
-- it under the terms of the GNU Affero General Public License as published by
-- the Free Software Foundation, version 3 of the License.
--
-- This program is distributed in the hope that it will be useful,
-- but WITHOUT ANY WARRANTY; without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
-- GNU Affero General Public License for more details.
--
-- You should have received a copy of the GNU Affero General Public License
-- along with this program.  If not, see <https://www.gnu.org/licenses/>.
--
-- Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
-- Full license: see LICENSE. Third-party credits: see NOTICE.
--
-- SPDX-License-Identifier: AGPL-3.0-only

-- Companion Lua module for the dwf plugin.
--
-- The C++ side handles HTTP + premium frame capture; the more intricate game-state
-- mutations (creating stockpiles, placing buildings with materials) go through DFHack's
-- tested high-level APIs here, which is far less error-prone than replicating the
-- raws-dependent logic in C++. Called from C++ via Lua::CallLuaModuleFunction.

local _ENV = mkmodule('plugins.dwf')

-- Maps the browser's preset names to DFHack's shipped stockpile library presets
-- (data/stockpiles/*.dfstock). "all" accepts everything; cat_* accept one category.
local STOCKPILE_PRESETS = {
    all = 'all', everything = 'all',
    food = 'cat_food', stone = 'cat_stone', wood = 'cat_wood',
    furniture = 'cat_furniture', finished = 'cat_finished_goods',
    bars = 'cat_bars_blocks', gems = 'cat_gems', cloth = 'cat_cloth',
    leather = 'cat_leather', ammo = 'cat_ammo', armor = 'cat_armor',
    weapons = 'cat_weapons', animals = 'cat_animals', corpses = 'cat_corpses',
    refuse = 'cat_refuse', coins = 'cat_coins', sheets = 'cat_sheets',
}

function get_stockpile(id)
    local b = df.building.find(id)
    if b and b:getType() == df.building_type.Stockpile then return b end
    return nil
end

-- B231 (hauling depth) -----------------------------------------------------------------------
-- A HAULING STOP'S "DESIRED ITEMS" FILTER IS A STOCKPILE'S FILTER.
--
-- df::hauling_stop.settings is declared `<compound type-name='stockpile_settings' name='settings'/>`
-- (df.hauling.xml:42) -- the *identical* struct df::building_stockpilest carries. DFHack leans on
-- that identity directly: plugins/stockpiles/stockpiles.cpp:126 get_stop_settings() hands a route
-- stop's `settings` to the very same serializer it uses for stockpiles, so `stockpiles export/
-- import --route <id>,<stop>` and `--stockpile <id>` share one code path.
--
-- Every function in the SP_CATEGORIES machinery below touches its subject through exactly one
-- expression: `target.settings...` (see sp_stone_vec, sp_group_get/set, and the `.settings.flags`
-- reads). None of them calls a building method. So a hauling stop is a drop-in subject, and the
-- whole 17-category item filter -- every stone, every meat, every quality band -- works on a stop
-- with NO second implementation. That is the entire reason this resolver exists rather than a
-- parallel copy of the editor.
function get_hauling_stop(route_id, stop_id)
    local route = df.hauling_route.find(tonumber(route_id) or -1)
    if not route then return nil, 'route not found' end
    for _, stop in ipairs(route.stops) do
        if stop.id == tonumber(stop_id) then return stop, '' end
    end
    return nil, 'stop not found'
end

-- Change what a stockpile accepts: 'none' clears it; otherwise apply a category preset.
-- mode can be 'set' (replace), 'enable', or 'disable'. Returns (ok, err).
function stockpile_set_preset(id, preset, mode)
    local b = get_stockpile(id)
    if not b then return false, 'not a stockpile' end
    preset = tostring(preset or 'all'):lower()
    if preset == 'none' then
        b.settings.flags.whole = 0
        return true, ''
    end
    mode = tostring(mode or 'set'):lower()
    if mode ~= 'set' and mode ~= 'enable' and mode ~= 'disable' then
        mode = 'set'
    end
    local lib = STOCKPILE_PRESETS[preset] or preset
    local ok, err = pcall(function()
        require('plugins.stockpiles').import_settings(lib, {id = id, mode = mode})
    end)
    if not ok then return false, tostring(err) end
    sp_normalize_enabled_categories(b)
    return true, ''
end

-- ===== Custom stockpile item editor (DF-style: category -> sub-groups -> per-item toggles) =====
-- A category has a group flag + one or more sub-groups (DF's middle column). Each group maps to the
-- exact stockpile_settings field that native DF and DFHack's StockpileSerializer use. Some groups are
-- raw vectors (e.g. finished_goods.mats indexed by inorganic raws), while others are fixed arrays or
-- scalar bool fields (usable/unusable, dyed/undyed). Keep this table data-driven so adding another
-- native middle-column group is a local change.
function sp_stone_allowed(inorg)
    local f = inorg.flags
    local soil = f.SOIL and not f.AQUIFER
    local mf = inorg.material.flags
    return soil or (mf.IS_STONE and not mf.NO_STONE_STOCKPILE)
end
function sp_is_ore(inorg)
    local ok, n = pcall(function() return #inorg.metal_ore.mat_index end)
    return ok and n and n > 0
end
function sp_is_soil(inorg) return inorg.flags.SOIL and not inorg.flags.AQUIFER end
function sp_stone_name(m)
    local ok, s = pcall(function() return m.material.state_name.Solid end)
    if ok and s and #s > 0 then return s end
    return m.id
end
function sp_stone_vec(b) return b.settings.stone.mats end
function sp_inorganics() return df.global.world.raws.inorganics.all end
function sp_any(v) return v ~= nil end
function sp_bool(v) return v == true or v == 1 or tostring(v) == 'true' or tostring(v) == '1' end
function sp_ensure_vec(vec, n) while #vec < n do vec:insert('#', 0) end end
local SP_QUALITIES
function sp_title_token(s)
    s = tostring(s or '')
    s = s:gsub('_', ' '):gsub('(%l)(%u)', '%1 %2'):lower()
    return (s:gsub('^%l', string.upper))
end
function sp_material_name(m)
    if not m then return '' end
    local ok, s = pcall(function() return m.material.state_name.Solid end)
    if ok and s and #s > 0 then return s end
    return sp_title_token(m.id or '')
end
function sp_itemdef_name(d)
    if not d then return '' end
    return tostring((d.name_plural and #d.name_plural > 0 and d.name_plural) or
        (d.name and #d.name > 0 and d.name) or d.id or '')
end
function sp_creature_name(c)
    if not c then return '' end
    local ok, s = pcall(function() return c.name[1] end)
    if ok and s and #s > 0 then return s end
    ok, s = pcall(function() return c.name[0] end)
    if ok and s and #s > 0 then return s end
    return sp_title_token(c.creature_id or c.id or '')
end
function sp_color_name(c)
    if not c then return '' end
    return tostring((c.name and #c.name > 0 and c.name) or c.id or '')
end
function sp_enum_list(entries)
    local t = {n = 0}
    for _, e in ipairs(entries) do
        local idx = tonumber(e[1])
        if idx and idx >= 0 then
            t[idx] = {name = e[2], token = e[3] or e[2]}
            if idx + 1 > t.n then t.n = idx + 1 end
        end
    end
    return t
end
function sp_collection_count(raws)
    if type(raws) == 'table' and raws.n then return raws.n end
    return #raws
end
function sp_collection_get(raws, idx) return raws[idx] end
function sp_entry_name(e) return e and e.name or '' end
function sp_bool_entries(entries)
    local list = {n = #entries}
    for i, e in ipairs(entries) do list[i - 1] = e end
    return list
end
function sp_bool_group(key, label, entries)
    local list = sp_bool_entries(entries)
    return {
        key = key, label = label,
        raws = function() return list end,
        include = sp_any,
        name = sp_entry_name,
        get = function(b, i) return list[i].get(b) end,
        set = function(b, i, on) list[i].set(b, on) end,
    }
end
function sp_vec_group(key, label, vec, raws, include, name, fixed)
    return {
        key = key, label = label, vec = vec, raws = raws,
        include = include or sp_any, name = name or sp_entry_name, fixed = fixed,
    }
end
function sp_inorganic_group(key, label, vec, include)
    return sp_vec_group(key, label, vec, sp_inorganics, include, sp_material_name)
end
function sp_quality_group(key, label, vec)
    return sp_vec_group(key, label, vec, function() return SP_QUALITIES end, sp_any, sp_entry_name, true)
end
function sp_color_group(vec)
    return sp_vec_group('color', 'Color', vec, function() return df.global.world.raws.descriptors.colors end, sp_any, sp_color_name)
end
-- B141: species-qualified label for a PlantGrowth organic-table entry. The entry's
-- MATERIAL state name is the generic growth-class word shared by every species
-- ("leaf", "fruit", "bud"), which is why the custom food editor showed those repeated
-- 95 times. Native DF labels these rows with the growth's own raws name ("apple leaf",
-- "alder pollen catkin"): the growth on the host plant whose item material matches the
-- entry. Same growth-identity mechanism as interaction.cpp's B123 hover fix and
-- wire_v1.cpp classify_growth, done from the material side (matinfo.decode gives the
-- host plant; scan plant.growths for the one whose mat_type/mat_index equal the
-- entry's). df vectors are 0-based -- index loop, never ipairs. Returns nil when no
-- growth matches (caller falls back to the old state-name label, so odd non-growth
-- rows like "frozen egg yolk" keep their current text rather than breaking).
function sp_plant_growth_name(mat_type, mat_index)
    local ok, name = pcall(function()
        local info = dfhack.matinfo.decode(mat_type, mat_index)
        local plant = info and info.plant
        if not plant then return nil end
        for i = 0, #plant.growths - 1 do
            local gr = plant.growths[i]
            if gr and gr.mat_type == mat_type and gr.mat_index == mat_index
                    and gr.name and #gr.name > 0 then
                return gr.name
            end
        end
        return nil
    end)
    if ok then return name end
    return nil
end
-- B141 (same mechanism, sibling cells): Seed and Plants entries also carry only the
-- generic template state name ("seed" x152, "plant" x221 in the live world) -- native
-- labels them from the plant raws: the plant's own seed name ([SEED:plump helmet
-- spawn:...] -> seed_singular) and the plant's name. Creature-material oddballs in
-- these tables have no info.plant and keep their current fallback label.
function sp_plant_seed_or_plant_name(cat, mat_type, mat_index)
    local ok, name = pcall(function()
        local info = dfhack.matinfo.decode(mat_type, mat_index)
        local plant = info and info.plant
        if not plant then return nil end
        if cat == df.organic_mat_category.Seed then
            local s = plant.seed_singular
            if s and #s > 0 then return s end
        end
        local n = plant.name
        if n and #n > 0 then return n end
        return nil
    end)
    if ok then return name end
    return nil
end
-- B149 (sibling of B141, creature side): Meat / Glob / Animal-liquid entries also carry
-- only the material template word ("muscle" x1127, "tallow" x1127 in the live world) --
-- native labels them creature-qualified: [meat-name prefix + " "] + creature prefix +
-- " " + (meat-name singular if set, else the material state name). "aardvark meat"
-- (MUSCLE), "aardvark fat" (FAT: no meat_name), "prepared koala brain" (BRAIN carries
-- the "prepared" prefix). Slot order live-probed 2026-07-10: meat_name[0]=singular,
-- [1]=plural, [2]=prefix (KOALA BRAIN: [0]="brain" [2]="prepared"; MUSCLE: [0]="meat"
-- [2]=""). NOTE dumpmats.cpp/raw-token order is prefix:singular:plural -- DF reorders
-- on parse; trust the probe, not the token. Emitted lowercase like the raws; the client
-- capitalizes the first letter (spDisplayName), same as the B141 plant labels. Returns
-- nil for non-creature rows (caller keeps the old fallback label, like the plant helpers).
function sp_creature_material_name(mat_type, mat_index)
    local ok, name = pcall(function()
        local info = dfhack.matinfo.decode(mat_type, mat_index)
        if not (info and info.creature) then return nil end
        local m = info.material
        local creature = m.prefix
        if not creature or #creature == 0 then return nil end
        local base = m.meat_name[0]
        if not base or #base == 0 then base = m.state_name.Solid end
        if not base or #base == 0 then return nil end
        local label = creature .. ' ' .. base
        local pre = m.meat_name[2]
        if pre and #pre > 0 then label = pre .. ' ' .. label end
        return label
    end)
    if ok then return name end
    return nil
end
-- B153 (drink/liquid state naming). DF stores a material's FROZEN name in
-- state_name.Solid ("frozen mead", "frozen bumblebee mead", "frozen milk") and
-- its stored-liquid name in state_name.Liquid ("mead", "bumblebee mead", "milk").
-- A drink/liquid stockpile row is labelled natively by the LIQUID name; the
-- generic sp_organic_material_name fallback reads .Solid (right for solids like
-- cheese/stone, wrong for drinks). `qualify` = creature-prefix the label like the
-- B149 meat formula (milk -> "aardvark milk"); drinks pass qualify=false because
-- their species is already inside the liquid name and their prefix is empty.
-- Falls back Liquid -> Solid -> nil so a material with no liquid name degrades to
-- the caller's existing fallback instead of dropping the row. Emitted lowercase;
-- the client capitalizes the first letter (spDisplayName), like the other labels.
function sp_liquid_material_name(mat_type, mat_index, qualify)
    local ok, name = pcall(function()
        local info = dfhack.matinfo.decode(mat_type, mat_index)
        if not info then return nil end
        local m = info.material
        local base = m.state_name.Liquid
        if not base or #base == 0 then base = m.state_name.Solid end
        if not base or #base == 0 then return nil end
        if qualify and info.creature then
            local pre = m.prefix
            if pre and #pre > 0 then return pre .. ' ' .. base end
        end
        return base
    end)
    if ok and name and #name > 0 then return name end
    return nil
end
function sp_organic_material_name(cat, mat_type, mat_index)
    if cat == df.organic_mat_category.PlantGrowth then
        local growth = sp_plant_growth_name(mat_type, mat_index)
        if growth and #growth > 0 then return growth end
    end
    if cat == df.organic_mat_category.Seed or cat == df.organic_mat_category.Plants then
        local pn = sp_plant_seed_or_plant_name(cat, mat_type, mat_index)
        if pn and #pn > 0 then return pn end
    end
    -- B153: drink & liquid tables display the LIQUID state name, not the frozen
    -- SOLID name. A stored drink/liquid ("bumblebee mead", "dwarven wine",
    -- "milk", "lye") is labelled natively by state_name.Liquid; the generic
    -- fallback below reads state_name.Solid, which for these materials is the
    -- frozen form ("frozen bumblebee mead"). Drinks embed the species in their
    -- liquid name and carry an empty prefix (probed with B150) -> emit the bare
    -- liquid name. CreatureLiquid milk carries a creature prefix, so it keeps the
    -- B149 creature qualifier but on the LIQUID base ("aardvark milk").
    if cat == df.organic_mat_category.PlantDrink or
       cat == df.organic_mat_category.CreatureDrink or
       cat == df.organic_mat_category.PlantLiquid or
       cat == df.organic_mat_category.MiscLiquid then
        local ln = sp_liquid_material_name(mat_type, mat_index, false)
        if ln and #ln > 0 then return ln end
    end
    if cat == df.organic_mat_category.CreatureLiquid then
        local ln = sp_liquid_material_name(mat_type, mat_index, true)
        if ln and #ln > 0 then return ln end
    end
    -- B150 extends B149's formula to the remaining creature-material tables
    -- (live-probed 2026-07-10): Leather 812/812 rows covered ("toad leather"),
    -- Silk 31/41 (the 10 divine "flowing fabric" rows keep their fallback),
    -- Yarn 8/8 ("sheep wool", "troll fur"), Parchment 811/812 (the one
    -- PREFIX:NONE row keeps its already-distinct "vellum" fallback). Audited
    -- and deliberately NOT in the prefix formula: CreatureDrink / CreatureCheese
    -- / Pressed -- their creature rows carry empty prefixes so the formula is a
    -- dead no-op. NOTE (B153 correction): a drink's SPECIES-qualified name
    -- ("bumblebee mead") lives in state_name.LIQUID, not .Solid (= "frozen
    -- bumblebee mead"); drinks and CreatureLiquid milk are handled above by the
    -- B153 liquid branch, not here. CreaturePowder / Paste / Paper / Plant* /
    -- MetalThread hold no creature rows at all.
    if cat == df.organic_mat_category.Meat or cat == df.organic_mat_category.Glob or
       cat == df.organic_mat_category.Leather or cat == df.organic_mat_category.Silk or
       cat == df.organic_mat_category.Yarn or cat == df.organic_mat_category.Parchment then
        local cn = sp_creature_material_name(mat_type, mat_index)
        if cn and #cn > 0 then return cn end
    end
    if cat == df.organic_mat_category.Fish or
       cat == df.organic_mat_category.UnpreparedFish or
       cat == df.organic_mat_category.Eggs then
        local cr = df.global.world.raws.creatures.all[mat_type]
        local caste = cr and cr.caste and cr.caste[mat_index] or nil
        local ok, s = pcall(function() return caste.caste_name[0] end)
        if ok and s and #s > 0 then return s end
        ok, s = pcall(function() return caste.caste_name[1] end)
        if ok and s and #s > 0 then return s end
        return sp_creature_name(cr)
    end
    local ok, info = pcall(dfhack.matinfo.decode, mat_type, mat_index)
    if ok and info then
        local okn, name = pcall(function() return info.material.state_name.Solid end)
        if okn and name and #name > 0 then return name end
        okn, name = pcall(function() return info:toString() end)
        if okn and name and #name > 0 then return name end
    end
    return ('material %s:%s'):format(tostring(mat_type), tostring(mat_index))
end
local SP_ORGANIC_RAW_CACHE = {}
function sp_organic_raws(cat)
    cat = tonumber(cat)
    if not cat then return {n = 0} end
    if SP_ORGANIC_RAW_CACHE[cat] then return SP_ORGANIC_RAW_CACHE[cat] end
    local mt = df.global.world.raws.mat_table
    local types = mt.organic_types[cat]
    local indexes = mt.organic_indexes[cat]
    local n = types and #types or 0
    local list = {n = n}
    for i = 0, n - 1 do
        list[i] = {
            name = sp_organic_material_name(cat, types[i], indexes[i]),
            mat_type = types[i],
            mat_index = indexes[i],
        }
    end
    SP_ORGANIC_RAW_CACHE[cat] = list
    return list
end
function sp_organic_group(key, label, vec, cat)
    return sp_vec_group(key, label, vec, function() return sp_organic_raws(cat) end, sp_any, sp_entry_name)
end
function sp_metal(m)
    return m and m.material and m.material.flags and m.material.flags.IS_METAL
end
function sp_metal_or_stone(m)
    return m and m.material and m.material.flags and (m.material.flags.IS_METAL or m.material.flags.IS_STONE)
end
function sp_gem(m)
    return m and m.material and m.material.flags and m.material.flags.IS_GEM
end
function sp_finished_mat(m)
    return m and m.material and m.material.flags and
        (m.material.flags.IS_GEM or m.material.flags.IS_METAL or m.material.flags.IS_STONE)
end
function sp_builtin_material_name(m)
    local ok, name = pcall(function() return m.state_name.Solid end)
    if ok and name and #name > 0 then return name end
    return 'other material'
end

SP_QUALITIES = sp_enum_list({
    {0, 'Ordinary'}, {1, 'Well-crafted'}, {2, 'Finely-crafted'}, {3, 'Superior'},
    {4, 'Exceptional'}, {5, 'Masterful'}, {6, 'Artifact'},
})
local SP_OTHER_MATS_FURNITURE = sp_enum_list({
    {0, 'Wood'}, {1, 'Plant cloth'}, {2, 'Bone'}, {3, 'Tooth'}, {4, 'Horn'},
    {5, 'Pearl'}, {6, 'Shell'}, {7, 'Leather'}, {8, 'Silk'}, {9, 'Amber'},
    {10, 'Coral'}, {11, 'Green glass'}, {12, 'Clear glass'}, {13, 'Crystal glass'}, {14, 'Yarn'},
})
local SP_OTHER_MATS_FINISHED = sp_enum_list({
    {0, 'Wood'}, {1, 'Plant cloth'}, {2, 'Bone'}, {3, 'Tooth'}, {4, 'Horn'},
    {5, 'Pearl'}, {6, 'Shell'}, {7, 'Leather'}, {8, 'Silk'}, {9, 'Amber'},
    {10, 'Coral'}, {11, 'Green glass'}, {12, 'Clear glass'}, {13, 'Crystal glass'}, {14, 'Yarn'}, {15, 'Wax'},
})
local SP_OTHER_MATS_WEAPON_ARMOR = sp_enum_list({
    {0, 'Wood'}, {1, 'Plant cloth'}, {2, 'Bone'}, {3, 'Shell'}, {4, 'Leather'},
    {5, 'Silk'}, {6, 'Green glass'}, {7, 'Clear glass'}, {8, 'Crystal glass'}, {9, 'Yarn'},
})
local SP_BAR_OTHER_MATS = sp_enum_list({
    {0, 'Coal'}, {1, 'Potash'}, {2, 'Ash'}, {3, 'Pearlash'}, {4, 'Soap'},
})
local SP_BLOCK_OTHER_MATS = sp_enum_list({
    {0, 'Green glass'}, {1, 'Clear glass'}, {2, 'Crystal glass'}, {3, 'Wood'},
})
local SP_AMMO_OTHER_MATS = sp_enum_list({{0, 'Wood'}, {1, 'Bone'}})
local SP_FINISHED_TYPES = sp_enum_list({
    {10, 'Chains'}, {11, 'Flasks'}, {12, 'Goblets'}, {13, 'Musical instruments'}, {14, 'Toys'},
    {25, 'Armor'}, {26, 'Shoes'}, {28, 'Helms'}, {29, 'Gloves'}, {36, 'Figurines'},
    {37, 'Amulets'}, {38, 'Scepters'}, {40, 'Crowns'}, {41, 'Rings'}, {42, 'Earrings'},
    {43, 'Bracelets'}, {44, 'Large gems'}, {59, 'Totems'}, {60, 'Pants'}, {61, 'Backpacks'},
    {62, 'Quivers'}, {82, 'Splints'}, {83, 'Crutches'}, {86, 'Tools'}, {89, 'Books'},
})
local SP_FURNITURE_TYPES = sp_enum_list({
    {0, 'Floodgates'}, {1, 'Hatch covers'}, {2, 'Grates'}, {3, 'Doors'}, {4, 'Catapult parts'},
    {5, 'Ballista parts'}, {6, 'Trap components'}, {7, 'Beds'}, {8, 'Traction benches'}, {9, 'Windows'},
    {10, 'Chairs'}, {11, 'Tables'}, {12, 'Coffins'}, {13, 'Statues'}, {14, 'Slabs'},
    {15, 'Querns'}, {16, 'Millstones'}, {17, 'Armor stands'}, {18, 'Weapon racks'}, {19, 'Cabinets'},
    {20, 'Anvils'}, {21, 'Buckets'}, {22, 'Bins'}, {23, 'Boxes'}, {24, 'Bags'},
    {25, 'Siege ammo'}, {26, 'Barrels'}, {27, 'Ballista arrowheads'}, {28, 'Pipe sections'},
    {29, 'Large pots'}, {30, 'Minecarts'}, {31, 'Wheelbarrows'}, {32, 'Other large tools'},
    {33, 'Sand bags'}, {34, 'Bolt thrower parts'},
})
local SP_REFUSE_TYPES = sp_enum_list({
    {23, 'Corpses'}, {46, 'Body parts'}, {47, 'Vermin remains'}, {55, 'Tanned hides'},
})

local SP_CATEGORIES = {
    ammo = {
        label = 'Ammo', flag = 'ammo',
        groups = {
            sp_vec_group('type', 'Ammo type', function(b) return b.settings.ammo.type end,
                function() return df.global.world.raws.itemdefs.ammo end, sp_any, sp_itemdef_name),
            sp_inorganic_group('mats', 'Metal', function(b) return b.settings.ammo.mats end, sp_metal),
            sp_vec_group('other', 'Other materials', function(b) return b.settings.ammo.other_mats end,
                function() return SP_AMMO_OTHER_MATS end),
            sp_quality_group('core', 'Core quality', function(b) return b.settings.ammo.quality_core end),
            sp_quality_group('total', 'Total quality', function(b) return b.settings.ammo.quality_total end),
        },
    },
    animals = {
        label = 'Animals', flag = 'animals',
        groups = {
            sp_bool_group('empty', 'Empty cages/traps', {
                {name='Empty cages', get=function(b) return b.settings.animals.empty_cages end,
                    set=function(b, on) b.settings.animals.empty_cages = sp_bool(on) end},
                {name='Empty animal traps', get=function(b) return b.settings.animals.empty_traps end,
                    set=function(b, on) b.settings.animals.empty_traps = sp_bool(on) end},
            }),
            sp_vec_group('creatures', 'Creatures', function(b) return b.settings.animals.enabled end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
        },
    },
    armor = {
        label = 'Armor', flag = 'armor',
        groups = {
            sp_vec_group('body', 'Body', function(b) return b.settings.armor.body end,
                function() return df.global.world.raws.itemdefs.armor end, sp_any, sp_itemdef_name),
            sp_vec_group('head', 'Head', function(b) return b.settings.armor.head end,
                function() return df.global.world.raws.itemdefs.helms end, sp_any, sp_itemdef_name),
            sp_vec_group('feet', 'Feet', function(b) return b.settings.armor.feet end,
                function() return df.global.world.raws.itemdefs.shoes end, sp_any, sp_itemdef_name),
            sp_vec_group('hands', 'Hands', function(b) return b.settings.armor.hands end,
                function() return df.global.world.raws.itemdefs.gloves end, sp_any, sp_itemdef_name),
            sp_vec_group('legs', 'Legs', function(b) return b.settings.armor.legs end,
                function() return df.global.world.raws.itemdefs.pants end, sp_any, sp_itemdef_name),
            sp_vec_group('shield', 'Shield', function(b) return b.settings.armor.shield end,
                function() return df.global.world.raws.itemdefs.shields end, sp_any, sp_itemdef_name),
            sp_inorganic_group('mats', 'Metal', function(b) return b.settings.armor.mats end, sp_metal),
            sp_vec_group('other', 'Other materials', function(b) return b.settings.armor.other_mats end,
                function() return SP_OTHER_MATS_WEAPON_ARMOR end),
            sp_quality_group('core', 'Core quality', function(b) return b.settings.armor.quality_core end),
            sp_quality_group('total', 'Total quality', function(b) return b.settings.armor.quality_total end),
            sp_color_group(function(b) return b.settings.armor.color end),
            sp_bool_group('use', 'Usability', {
                {name='Usable armor', get=function(b) return b.settings.armor.usable end,
                    set=function(b, on) b.settings.armor.usable = sp_bool(on) end},
                {name='Unusable armor', get=function(b) return b.settings.armor.unusable end,
                    set=function(b, on) b.settings.armor.unusable = sp_bool(on) end},
            }),
            sp_bool_group('dye', 'Dye', {
                {name='Dyed', get=function(b) return b.settings.armor.dyed end,
                    set=function(b, on) b.settings.armor.dyed = sp_bool(on) end},
                {name='Undyed', get=function(b) return b.settings.armor.undyed end,
                    set=function(b, on) b.settings.armor.undyed = sp_bool(on) end},
            }),
        },
    },
    bars = {
        label = 'Bars/blocks', flag = 'bars_blocks',
        groups = {
            sp_inorganic_group('bars_mats', 'Metal bars', function(b) return b.settings.bars_blocks.bars_mats end, sp_metal),
            sp_vec_group('bars_other', 'Other bars', function(b) return b.settings.bars_blocks.bars_other_mats end,
                function() return SP_BAR_OTHER_MATS end),
            sp_inorganic_group('blocks_mats', 'Metal/stone blocks', function(b) return b.settings.bars_blocks.blocks_mats end, sp_metal_or_stone),
            sp_vec_group('blocks_other', 'Other blocks', function(b) return b.settings.bars_blocks.blocks_other_mats end,
                function() return SP_BLOCK_OTHER_MATS end),
        },
    },
    cloth = {
        label = 'Cloth', flag = 'cloth',
        groups = {
            sp_organic_group('thread_silk', 'Silk thread', function(b) return b.settings.cloth.thread_silk end, df.organic_mat_category.Silk),
            sp_organic_group('thread_plant', 'Plant thread', function(b) return b.settings.cloth.thread_plant end, df.organic_mat_category.PlantFiber),
            sp_organic_group('thread_yarn', 'Yarn thread', function(b) return b.settings.cloth.thread_yarn end, df.organic_mat_category.Yarn),
            sp_organic_group('thread_metal', 'Metal thread', function(b) return b.settings.cloth.thread_metal end, df.organic_mat_category.MetalThread),
            sp_organic_group('cloth_silk', 'Silk cloth', function(b) return b.settings.cloth.cloth_silk end, df.organic_mat_category.Silk),
            sp_organic_group('cloth_plant', 'Plant cloth', function(b) return b.settings.cloth.cloth_plant end, df.organic_mat_category.PlantFiber),
            sp_organic_group('cloth_yarn', 'Yarn cloth', function(b) return b.settings.cloth.cloth_yarn end, df.organic_mat_category.Yarn),
            sp_organic_group('cloth_metal', 'Metal cloth', function(b) return b.settings.cloth.cloth_metal end, df.organic_mat_category.MetalThread),
            sp_color_group(function(b) return b.settings.cloth.color end),
            sp_bool_group('dye', 'Dye', {
                {name='Dyed', get=function(b) return b.settings.cloth.dyed end,
                    set=function(b, on) b.settings.cloth.dyed = sp_bool(on) end},
                {name='Undyed', get=function(b) return b.settings.cloth.undyed end,
                    set=function(b, on) b.settings.cloth.undyed = sp_bool(on) end},
            }),
        },
    },
    coins = {
        label = 'Coins', flag = 'coins',
        groups = {
            sp_inorganic_group('mats', 'Material', function(b) return b.settings.coins.mats end, sp_any),
        },
    },
    corpses = {
        label = 'Corpses', flag = 'corpses',
        groups = {
            sp_vec_group('creatures', 'Creatures', function(b) return b.settings.corpses.corpses end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
        },
    },
    finished = {
        label = 'Finished goods', flag = 'finished_goods',
        groups = {
            sp_vec_group('type', 'Type', function(b) return b.settings.finished_goods.type end,
                function() return SP_FINISHED_TYPES end),
            sp_inorganic_group('mats', 'Metal/stone/gem', function(b) return b.settings.finished_goods.mats end, sp_finished_mat),
            sp_vec_group('other', 'Other materials', function(b) return b.settings.finished_goods.other_mats end,
                function() return SP_OTHER_MATS_FINISHED end),
            sp_quality_group('core', 'Core quality', function(b) return b.settings.finished_goods.quality_core end),
            sp_quality_group('total', 'Total quality', function(b) return b.settings.finished_goods.quality_total end),
            sp_color_group(function(b) return b.settings.finished_goods.color end),
            sp_bool_group('dye', 'Dye', {
                {name='Dyed', get=function(b) return b.settings.finished_goods.dyed end,
                    set=function(b, on) b.settings.finished_goods.dyed = sp_bool(on) end},
                {name='Undyed', get=function(b) return b.settings.finished_goods.undyed end,
                    set=function(b, on) b.settings.finished_goods.undyed = sp_bool(on) end},
            }),
        },
    },
    food = {
        label = 'Food', flag = 'food',
        groups = {
            sp_bool_group('prepared', 'Prepared meals', {
                {name='Prepared meals', get=function(b) return b.settings.food.prepared_meals end,
                    set=function(b, on) b.settings.food.prepared_meals = sp_bool(on) end},
            }),
            sp_organic_group('meat', 'Meat', function(b) return b.settings.food.meat end, df.organic_mat_category.Meat),
            sp_organic_group('fish', 'Prepared fish', function(b) return b.settings.food.fish end, df.organic_mat_category.Fish),
            sp_organic_group('unprepared_fish', 'Unprepared fish', function(b) return b.settings.food.unprepared_fish end, df.organic_mat_category.UnpreparedFish),
            sp_organic_group('egg', 'Eggs', function(b) return b.settings.food.egg end, df.organic_mat_category.Eggs),
            sp_organic_group('plants', 'Plants', function(b) return b.settings.food.plants end, df.organic_mat_category.Plants),
            sp_organic_group('drink_plant', 'Plant drinks', function(b) return b.settings.food.drink_plant end, df.organic_mat_category.PlantDrink),
            sp_organic_group('drink_animal', 'Animal drinks', function(b) return b.settings.food.drink_animal end, df.organic_mat_category.CreatureDrink),
            sp_organic_group('cheese_plant', 'Plant cheese', function(b) return b.settings.food.cheese_plant end, df.organic_mat_category.PlantCheese),
            sp_organic_group('cheese_animal', 'Animal cheese', function(b) return b.settings.food.cheese_animal end, df.organic_mat_category.CreatureCheese),
            sp_organic_group('seeds', 'Seeds', function(b) return b.settings.food.seeds end, df.organic_mat_category.Seed),
            sp_organic_group('leaves', 'Leaves / growths', function(b) return b.settings.food.leaves end, df.organic_mat_category.PlantGrowth),
            sp_organic_group('powder_plant', 'Plant powder', function(b) return b.settings.food.powder_plant end, df.organic_mat_category.PlantPowder),
            sp_organic_group('powder_creature', 'Animal powder', function(b) return b.settings.food.powder_creature end, df.organic_mat_category.CreaturePowder),
            sp_organic_group('glob', 'Glob', function(b) return b.settings.food.glob end, df.organic_mat_category.Glob),
            sp_organic_group('glob_paste', 'Paste', function(b) return b.settings.food.glob_paste end, df.organic_mat_category.Paste),
            sp_organic_group('glob_pressed', 'Pressed', function(b) return b.settings.food.glob_pressed end, df.organic_mat_category.Pressed),
            sp_organic_group('liquid_plant', 'Plant liquid', function(b) return b.settings.food.liquid_plant end, df.organic_mat_category.PlantLiquid),
            sp_organic_group('liquid_animal', 'Animal liquid', function(b) return b.settings.food.liquid_animal end, df.organic_mat_category.CreatureLiquid),
            sp_organic_group('liquid_misc', 'Misc liquid', function(b) return b.settings.food.liquid_misc end, df.organic_mat_category.MiscLiquid),
        },
    },
    furniture = {
        label = 'Furniture/siege ammo', flag = 'furniture',
        groups = {
            sp_vec_group('type', 'Type', function(b) return b.settings.furniture.type end,
                function() return SP_FURNITURE_TYPES end),
            sp_inorganic_group('mats', 'Metal/stone', function(b) return b.settings.furniture.mats end, sp_metal_or_stone),
            sp_vec_group('other', 'Other materials', function(b) return b.settings.furniture.other_mats end,
                function() return SP_OTHER_MATS_FURNITURE end),
            sp_quality_group('core', 'Core quality', function(b) return b.settings.furniture.quality_core end),
            sp_quality_group('total', 'Total quality', function(b) return b.settings.furniture.quality_total end),
        },
    },
    gems = {
        label = 'Gems', flag = 'gems',
        groups = {
            sp_inorganic_group('rough_mats', 'Rough gems', function(b) return b.settings.gems.rough_mats end, sp_gem),
            sp_inorganic_group('cut_mats', 'Cut gems', function(b) return b.settings.gems.cut_mats end, sp_gem),
            sp_vec_group('rough_other', 'Other rough materials',
                function(b) return b.settings.gems.rough_other_mats end,
                function() return df.global.world.raws.mat_table.builtin end,
                sp_any, sp_builtin_material_name),
            sp_vec_group('cut_other', 'Other cut materials',
                function(b) return b.settings.gems.cut_other_mats end,
                function() return df.global.world.raws.mat_table.builtin end,
                sp_any, sp_builtin_material_name),
        },
    },
    leather = {
        label = 'Leather', flag = 'leather',
        groups = {
            sp_organic_group('mats', 'Leather', function(b) return b.settings.leather.mats end, df.organic_mat_category.Leather),
            sp_color_group(function(b) return b.settings.leather.color end),
            sp_bool_group('dye', 'Dye', {
                {name='Dyed', get=function(b) return b.settings.leather.dyed end,
                    set=function(b, on) b.settings.leather.dyed = sp_bool(on) end},
                {name='Undyed', get=function(b) return b.settings.leather.undyed end,
                    set=function(b, on) b.settings.leather.undyed = sp_bool(on) end},
            }),
        },
    },
    refuse = {
        label = 'Refuse', flag = 'refuse',
        groups = {
            sp_vec_group('type', 'Type', function(b) return b.settings.refuse.type end,
                function() return SP_REFUSE_TYPES end),
            sp_vec_group('corpses', 'Corpses', function(b) return b.settings.refuse.corpses end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('body_parts', 'Body parts', function(b) return b.settings.refuse.body_parts end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('skulls', 'Skulls', function(b) return b.settings.refuse.skulls end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('bones', 'Bones', function(b) return b.settings.refuse.bones end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('hair', 'Hair/wool', function(b) return b.settings.refuse.hair end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('shells', 'Shells', function(b) return b.settings.refuse.shells end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('teeth', 'Teeth', function(b) return b.settings.refuse.teeth end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_vec_group('horns', 'Horns', function(b) return b.settings.refuse.horns end,
                function() return df.global.world.raws.creatures.all end, sp_any, sp_creature_name),
            sp_bool_group('hide', 'Raw hides', {
                {name='Fresh raw hide', get=function(b) return b.settings.refuse.fresh_raw_hide end,
                    set=function(b, on) b.settings.refuse.fresh_raw_hide = sp_bool(on) end},
                {name='Rotten raw hide', get=function(b) return b.settings.refuse.rotten_raw_hide end,
                    set=function(b, on) b.settings.refuse.rotten_raw_hide = sp_bool(on) end},
            }),
        },
    },
    sheets = {
        label = 'Sheets', flag = 'sheet',
        groups = {
            sp_organic_group('paper', 'Paper', function(b) return b.settings.sheet.paper end, df.organic_mat_category.Paper),
            sp_organic_group('parchment', 'Parchment', function(b) return b.settings.sheet.parchment end, df.organic_mat_category.Parchment),
        },
    },
    weapons = {
        label = 'Weapons/trap comps', flag = 'weapons',
        groups = {
            sp_vec_group('weapon_type', 'Weapons', function(b) return b.settings.weapons.weapon_type end,
                function() return df.global.world.raws.itemdefs.weapons end, sp_any, sp_itemdef_name),
            sp_vec_group('trapcomp_type', 'Trap components', function(b) return b.settings.weapons.trapcomp_type end,
                function() return df.global.world.raws.itemdefs.trapcomps end, sp_any, sp_itemdef_name),
            sp_inorganic_group('mats', 'Metal/stone', function(b) return b.settings.weapons.mats end, sp_metal_or_stone),
            sp_vec_group('other', 'Other materials', function(b) return b.settings.weapons.other_mats end,
                function() return SP_OTHER_MATS_WEAPON_ARMOR end),
            sp_quality_group('core', 'Core quality', function(b) return b.settings.weapons.quality_core end),
            sp_quality_group('total', 'Total quality', function(b) return b.settings.weapons.quality_total end),
            sp_bool_group('use', 'Usability', {
                {name='Usable weapons', get=function(b) return b.settings.weapons.usable end,
                    set=function(b, on) b.settings.weapons.usable = sp_bool(on) end},
                {name='Unusable weapons', get=function(b) return b.settings.weapons.unusable end,
                    set=function(b, on) b.settings.weapons.unusable = sp_bool(on) end},
            }),
        },
    },
    wood = {
        label = 'Wood', flag = 'wood',
        groups = {
            sp_vec_group('trees', 'Trees', function(b) return b.settings.wood.mats end,
                function() return df.global.world.raws.plants.all end,
                function(p) return p.flags and p.flags.TREE end,
                function(p) return p.name end),
        },
    },
    stone = {
        label = 'Stone', flag = 'stone',
        groups = {
            { key = 'ores',  label = 'Metal ores',  vec = sp_stone_vec, raws = sp_inorganics,
              include = function(i) return sp_stone_allowed(i) and sp_is_ore(i) end,  name = sp_stone_name },
            { key = 'other', label = 'Other stone', vec = sp_stone_vec, raws = sp_inorganics,
              include = function(i) return sp_stone_allowed(i) and not sp_is_ore(i) and not sp_is_soil(i) end, name = sp_stone_name },
            { key = 'soil',  label = 'Soil / clay', vec = sp_stone_vec, raws = sp_inorganics,
              include = function(i) return sp_is_soil(i) end, name = sp_stone_name },
        },
    },
}

function sp_group_count(g) return sp_collection_count(g.raws()) end
function sp_group_item(g, idx) return sp_collection_get(g.raws(), idx) end
function sp_group_get(g, b, idx)
    if g.get then return sp_bool(g.get(b, idx)) end
    local vec = g.vec(b)
    if not g.fixed then sp_ensure_vec(vec, sp_group_count(g)) end
    if g.fixed or idx < #vec then return sp_bool(vec[idx]) end
    return false
end
function sp_group_set(g, b, idx, on)
    if g.set then g.set(b, idx, on); return end
    local vec = g.vec(b)
    if not g.fixed then sp_ensure_vec(vec, sp_group_count(g)) end
    vec[idx] = sp_bool(on) and 1 or 0
end

-- DF's item-matching code assumes every vector in an enabled category has been initialized,
-- even when only one of the category's groups is selected. Enabling (for example) metal bars
-- while leaving the sibling "other blocks" vector empty produces a native null dereference as
-- soon as hauling considers a wooden block. Grow missing sibling entries as disabled before the
-- category flag becomes visible to DF. Existing choices are never overwritten.
function sp_ensure_category_vectors(b, spec)
    local changed = false
    for _, g in ipairs(spec.groups) do
        if g.vec and not g.fixed then
            local vec = g.vec(b)
            local before = #vec
            sp_ensure_vec(vec, sp_group_count(g))
            if #vec ~= before then changed = true end
        end
    end
    return changed
end

function sp_normalize_enabled_categories(b)
    local changed = 0
    for _, spec in pairs(SP_CATEGORIES) do
        if b.settings.flags[spec.flag] and sp_ensure_category_vectors(b, spec) then
            changed = changed + 1
        end
    end
    return changed
end

-- Resolve (category, group key) -> spec, group. Defaults to the first group if blank/unknown.
function sp_find_group(cat, group)
    local spec = SP_CATEGORIES[tostring(cat or '')]
    if not spec then return nil, nil end
    for _, g in ipairs(spec.groups) do
        if g.key == tostring(group or '') then return spec, g end
    end
    return spec, spec.groups[1]
end

-- (stockpile_cat_groups + stockpile_item_list build JSON, so they're defined later after
--  json_string/json_bool are in scope.)

-- The editor primitives, expressed against ANY settings-holder `b` (a df::building_stockpilest or
-- a df::hauling_stop -- see get_hauling_stop's banner). They only ever touch `b.settings`.
function sp_toggle_item_on(b, cat, group, idx, on)
    local spec, g = sp_find_group(cat, group)
    if not g then return false, 'category not editable' end
    idx = tonumber(idx)
    if not idx or idx < 0 then return false, 'bad index' end
    local ok, err = pcall(function()
        if sp_bool(on) then sp_ensure_category_vectors(b, spec) end
        sp_group_set(g, b, idx, on)
        if sp_bool(on) then b.settings.flags[spec.flag] = true end
    end)
    if not ok then return false, tostring(err) end
    return true, ''
end

function sp_toggle_all_on(b, cat, group, on)
    local spec, g = sp_find_group(cat, group)
    if not g then return false, 'category not editable' end
    local want = sp_bool(on)
    local ok, err = pcall(function()
        if want then sp_ensure_category_vectors(b, spec) end
        for i = 0, sp_group_count(g) - 1 do
            local r = sp_group_item(g, i)
            if r and g.include(r, i) then sp_group_set(g, b, i, want) end
        end
        if want then b.settings.flags[spec.flag] = true end
    end)
    if not ok then return false, tostring(err) end
    return true, ''
end

function stockpile_toggle_item(id, cat, group, idx, on)
    local b = get_stockpile(id)
    if not b then return false, 'not a stockpile' end
    return sp_toggle_item_on(b, cat, group, idx, on)
end

function stockpile_toggle_all(id, cat, group, on)
    local b = get_stockpile(id)
    if not b then return false, 'not a stockpile' end
    return sp_toggle_all_on(b, cat, group, on)
end

-- ---- B231: the same editor, pointed at a hauling stop's desired-items filter ----------------
function hauling_stop_toggle_item(route_id, stop_id, cat, group, idx, on)
    local stop, err = get_hauling_stop(route_id, stop_id)
    if not stop then return false, err end
    return sp_toggle_item_on(stop, cat, group, idx, on)
end

function hauling_stop_toggle_all(route_id, stop_id, cat, group, on)
    local stop, err = get_hauling_stop(route_id, stop_id)
    if not stop then return false, err end
    return sp_toggle_all_on(stop, cat, group, on)
end

-- One-shot recovery for saves created before the sibling-vector guard above. This is deliberately
-- conservative: it only grows missing vectors in categories that are already enabled and fills
-- new entries with false. It covers all three places a save embeds df::stockpile_settings:
-- ordinary stockpiles, minecart hauling stops, and the fort-wide custom-stockpile buffer at
-- plotinfo.stockpile.custom_settings (that one IS a settings object, so it gets a thin
-- {settings = ...} adapter to look like a holder).
function repair_incomplete_stockpile_settings()
    local holders, categories = 0, 0
    local function repair(holder)
        local changed = sp_normalize_enabled_categories(holder)
        if changed > 0 then
            holders = holders + 1
            categories = categories + changed
        end
    end

    local world = df.global.world
    if world then
        for _, bld in ipairs(world.buildings.all) do
            if df.building_stockpilest:is_instance(bld) then repair(bld) end
        end
    end
    local plotinfo = df.global.plotinfo
    if plotinfo then
        for _, route in ipairs(plotinfo.hauling.routes) do
            for _, stop in ipairs(route.stops) do repair(stop) end
        end
        local custom = plotinfo.stockpile and plotinfo.stockpile.custom_settings
        if custom then repair({settings = custom}) end
    end
    return holders, categories
end

-- Preset ('stone', 'food', 'none', ...) on a stop. This one does NOT hand-write anything: DFHack's
-- stockpiles plugin already exposes a native route-stop importer, and its Lua front door takes the
-- route/stop pair directly -- plugins/lua/stockpiles.lua:124 import_settings(name, opts) dispatches
-- to stockpiles_route_import(fname, opts.route_id, opts.stop_id, mode, filters) whenever opts
-- carries a route_id. Preferring that over field-poking is the whole point of the DFHack-API rule.
function hauling_stop_set_preset(route_id, stop_id, preset, mode)
    local stop, err = get_hauling_stop(route_id, stop_id)
    if not stop then return false, err end
    preset = tostring(preset or 'all'):lower()
    if preset == 'none' then
        stop.settings.flags.whole = 0
        return true, ''
    end
    mode = tostring(mode or 'set'):lower()
    if mode ~= 'set' and mode ~= 'enable' and mode ~= 'disable' then mode = 'set' end
    local lib = STOCKPILE_PRESETS[preset] or preset
    local ok2, err2 = pcall(function()
        require('plugins.stockpiles').import_settings(
            lib, {route_id = tonumber(route_id), stop_id = tonumber(stop_id), mode = mode})
    end)
    if not ok2 then return false, tostring(err2) end
    sp_normalize_enabled_categories(stop)
    return true, ''
end

-- Create a stockpile over the inclusive world-tile rectangle (x1,y1)-(x2,y2) on z and
-- apply a category preset. Returns (id, ''). On failure returns (-1, errmsg).
function create_stockpile(x1, y1, x2, y2, z, preset)
    local lx, hx = math.min(x1, x2), math.max(x1, x2)
    local ly, hy = math.min(y1, y2), math.max(y1, y2)
    local ok, bld, err = pcall(dfhack.buildings.constructBuilding, {
        type = df.building_type.Stockpile,
        abstract = true,
        pos = {x = lx, y = ly, z = z},
        width = hx - lx + 1,
        height = hy - ly + 1,
    })
    if not ok then return -1, tostring(bld) end       -- bld is the error on pcall failure
    if not bld then return -1, tostring(err or 'could not place stockpile') end

    -- Configure which items it accepts, using DFHack's tested preset import.
    -- B137: preset 'none' = native new-pile semantics. Steam DF places a stockpile INERT
    -- ("Click an icon to set stockpile type.") and dwarves haul nothing until the player
    -- picks what it stores. A fresh abstract stockpile's settings are already all-off
    -- (zero-initialized), so 'none' simply skips the preset import instead of falling
    -- through to 'all' (the old fallback made new piles instantly accept EVERYTHING and
    -- fill with hauled goods before the player finished configuring -- B137's report).
    local want = tostring(preset or 'all'):lower()
    if want ~= 'none' then
        local libname = STOCKPILE_PRESETS[want] or 'all'
        local imported, import_err = pcall(function()
            require('plugins.stockpiles').import_settings(libname, {id = bld.id, mode = 'enable'})
        end)
        if not imported then
            pcall(dfhack.buildings.deconstruct, bld)
            return -1, tostring(import_err)
        end
        sp_normalize_enabled_categories(bld)
    end
    return bld.id, ''
end
