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
        pcall(function()
            require('plugins.stockpiles').import_settings(libname, {id = bld.id, mode = 'enable'})
        end)
    end
    return bld.id, ''
end

-- ---------------------------------------------------------------------------
-- Browser build menu + placement
-- ---------------------------------------------------------------------------

-- WD-15: live DF build menu = 9 real top-level categories (ui-truth 06-build.png), replacing
-- the invented 12-bucket taxonomy this used to ship (audit §3: farming/furnaces/clothing/siege/
-- track weren't real top categories -- furnaces/clothing/farming nest INSIDE Workshops, siege
-- engines are Military, track pieces are Constructions). Order matches the live capture's
-- vertical icon list.
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

-- Nested subgroups inside the Workshops flyout (06b-build-workshops.png): Clothing and
-- leather / Farming / Furnaces, in the capture's order. An item with category='workshops' and
-- no opts.group is a DIRECT entry (Ashery, Bowyer, Carpenter, Crafts, Jeweler, Magma forge,
-- Mechanic, Metalsmith, Screw Press, Siege, Soap Maker's Workshop, Stoneworker -- the custom
-- Screw Press / Soap Maker's Workshop raws land here too via add_custom_build_items below).
local WORKSHOP_GROUPS = {
    {id='clothing', label='Clothing and leather'},
    {id='farming', label='Farming'},
    {id='furnaces', label='Furnaces'},
}

function json_string(s)
    s = tostring(s or '')
    -- DF strings are CP437. A raw high byte (>=0x80, e.g. the i/o in dwarf names like "Atir"/"Onul",
    -- or special material names) is NOT valid UTF-8, and a raw control char (<0x20) is illegal in a
    -- JSON string -- either one makes the browser's JSON.parse() throw, which surfaces as
    -- "Workshop data unavailable" even though the Lua built the response fine. Convert to UTF-8 and
    -- escape every control char so the JSON is always valid regardless of item/job/worker names.
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

-- Sub-groups (DF's middle column) for a stockpile category. Defined here (not with the other
-- stockpile fns) so json_string/json_bool above are already in scope.
function stockpile_cat_groups(cat)
    local spec = SP_CATEGORIES[tostring(cat or '')]
    if not spec then return '{"ok":false,"groups":[]}\n' end
    local out = {}
    for _, g in ipairs(spec.groups) do
        out[#out + 1] = '{"key":' .. json_string(g.key) .. ',"label":' .. json_string(g.label) .. '}'
    end
    return '{"ok":true,"label":' .. json_string(spec.label) .. ',"groups":[' .. table.concat(out, ',') .. ']}\n'
end

-- The items of a category's sub-group with their on/off state.
function stockpile_item_list(id, cat, group)
    local b = get_stockpile(id)
    if not b then return '{"ok":false,"items":[]}\n' end
    return sp_item_list_on(b, cat, group)
end

-- B231: same list, for a hauling stop's desired-items filter.
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

-- One read-only opening snapshot for the three-column stockpile settings editor. The old client
-- fetched every subgroup serially and repainted after each response, visibly filling the window
-- from top to bottom. Keep this genuinely read-only: sp_group_get() extends short DF vectors as a
-- convenience for writes, so the snapshot uses a non-growing peek instead.
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

-- B231: the opening snapshot for a hauling stop's desired-items editor. Identical shape to the
-- stockpile one, because it IS the stockpile one -- the stop's `settings` is a stockpile_settings.
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
    end
    return {
        {label='N', value=0},
        {label='E', value=1},
        {label='S', value=2},
        {label='W', value=3},
    }
end

function requirements_for(filters)
    -- NOTE: deliberately does NOT call into plugins.buildingplan. buildingplan.get_desc makes a
    -- nested CallLuaModuleFunction that misbehaves from dwf's render-thread context and can
    -- raise a luaL_argerror whose error-message formatting overflows the render thread's tiny
    -- stack and HARD-CRASHES the game (intermittent build-menu crash). dwf places buildings
    -- via constructBuilding directly, so we don't need buildingplan here. Use the filter's own name.
    local out = {}
    for _, filter in ipairs(filters or {}) do
        local desc = (filter and filter.name and #tostring(filter.name) > 0)
            and tostring(filter.name) or 'Material'
        table.insert(out, {label=desc, quantity=(filter and filter.quantity) or 1})
    end
    return out
end

-- B10: dfhack.buildings.getCorrectSize returns (flexible, w, h, cx, cy). `flexible` means the
-- building is drag-RESIZABLE (farm plot, stockpile, bridge, road) -- for those it echoes the
-- requested w/h; for FIXED-size buildings (every workshop = 3x3, trade depot = 5x5, windmill,
-- siege engine, ...) it returns flexible=FALSE but sets w/h to the REAL fixed footprint. The old
-- code only trusted w/h when flexible was true, so every fixed workshop reported 1x1 -- which is
-- why the placement hover only ever showed a single green tile. Always use the returned w/h (the
-- authoritative footprint); the client's drawBuildPreview then renders the whole footprint.
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
        -- WD-15: which Workshops subgroup this item nests under ('' = direct entry; only
        -- meaningful when category=='workshops').
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
    -- NOTE: do NOT call buildingplan.isPlannableBuilding here. Its nested CallLuaModuleFunction
    -- from dwf's render-thread context can raise an error that overflows the render thread's
    -- stack and HARD-CRASHES the game (intermittent build-menu crash). dwf places via
    -- constructBuilding directly, so the plannable filter isn't needed -- getFiltersByType above
    -- already establishes the building can be built.

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
    -- WD-15: re-bucketed out of the old invented "farming" catch-all (audit §3: "Archery
    -- target/Armor stand/Weapon rack/Traction bench -> DF: MILITARY/FURNITURE"). Weapon rack
    -- and armor stand are Furniture in live DF (armory rooms are furnished, not a
    -- Military-only fixture); traction bench is hospital furniture. Only the archery target
    -- (below, Military) is a genuinely military-mode building. Confirmed against DF community
    -- reference (dwarffortresswiki.org Weapon_rack / Armor_stand pages: "both items are found
    -- in the Furniture category"), not a live screenshot -- flagged here rather than
    -- guessed blind.
    add_build_item(items, 'furniture', 'Weapon rack', bt.Weaponrack)
    add_build_item(items, 'furniture', 'Armor stand', bt.Armorstand)
    add_build_item(items, 'furniture', 'Traction bench', bt.TractionBench)

    -- WD-15: Doors/hatches -- a real top-level category on its own (06-build.png), not
    -- lumped into "furniture" anymore. Floodgate moves OUT to Machines/fluids below (spec
    -- 0.1.3 correction), not kept here.
    add_build_item(items, 'doors', 'Door', bt.Door)
    add_build_item(items, 'doors', 'Hatch cover', bt.Hatch)
    add_build_item(items, 'doors', 'Wall grate', bt.GrateWall)
    add_build_item(items, 'doors', 'Floor grate', bt.GrateFloor)
    add_build_item(items, 'doors', 'Vertical bars', bt.BarsVertical)
    add_build_item(items, 'doors', 'Floor bars', bt.BarsFloor)

    -- WD-15: Workshops direct entries (06b-build-workshops.png alphabetical list: Ashery,
    -- Bowyer, Carpenter, Crafts, Jeweler, Magma forge, Mechanic, Metalsmith, Screw Press,
    -- Siege, Soap Maker's Workshop, Stoneworker). Screw Press / Soap Maker's Workshop are
    -- custom raws and arrive via add_custom_build_items below (also direct, no group).
    add_build_item(items, 'workshops', 'Carpenter', bt.Workshop, wt.Carpenters)
    add_build_item(items, 'workshops', 'Mason / Stoneworker', bt.Workshop, wt.Masons)
    add_build_item(items, 'workshops', 'Craftsdwarf', bt.Workshop, wt.Craftsdwarfs)
    add_build_item(items, 'workshops', 'Jeweler', bt.Workshop, wt.Jewelers)
    add_build_item(items, 'workshops', 'Metalsmith forge', bt.Workshop, wt.MetalsmithsForge)
    add_build_item(items, 'workshops', 'Magma forge', bt.Workshop, wt.MagmaForge)
    add_build_item(items, 'workshops', 'Bowyer', bt.Workshop, wt.Bowyers)
    add_build_item(items, 'workshops', 'Mechanic', bt.Workshop, wt.Mechanics)
    add_build_item(items, 'workshops', 'Siege', bt.Workshop, wt.Siege)
    add_build_item(items, 'workshops', 'Ashery', bt.Workshop, wt.Ashery)

    -- WD-15: Workshops > Clothing and leather subgroup.
    add_build_item(items, 'workshops', 'Leather works', bt.Workshop, wt.Leatherworks, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Tanner', bt.Workshop, wt.Tanners, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Clothier', bt.Workshop, wt.Clothiers, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Dyer', bt.Workshop, wt.Dyers, -1, {group='clothing'})
    add_build_item(items, 'workshops', 'Loom', bt.Workshop, wt.Loom, -1, {group='clothing'})

    -- WD-15: Workshops > Farming subgroup.
    add_build_item(items, 'workshops', 'Farmer', bt.Workshop, wt.Farmers, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Butcher', bt.Workshop, wt.Butchers, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Fishery', bt.Workshop, wt.Fishery, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Still', bt.Workshop, wt.Still, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Quern', bt.Workshop, wt.Quern, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Millstone', bt.Workshop, wt.Millstone, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Kennel', bt.Workshop, wt.Kennels, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Kitchen', bt.Workshop, wt.Kitchen, -1, {group='farming'})
    -- Farm plot / Nest box / Hive move here from the old invented "farming" top category --
    -- confirmed live at Build > Workshops > Farming (dwarffortresswiki.org Nest_box: "b -> o ->
    -- f -> n"; Hive beekeeping-industry page: "built from the Workshops FARMING tab"), a
    -- documented keybind path rather than a live screenshot (same chrome-only caveat as above).
    add_build_item(items, 'workshops', 'Farm plot', bt.FarmPlot, -1, -1, {area=true, limit_w=31, limit_h=31, group='farming'})
    add_build_item(items, 'workshops', 'Nest box', bt.NestBox, -1, -1, {group='farming'})
    add_build_item(items, 'workshops', 'Hive', bt.Hive, -1, -1, {group='farming'})

    -- WD-15: Workshops > Furnaces subgroup (was the invented top-level "furnaces" category).
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
    add_build_item(items, 'constructions', 'Up stair', bt.Construction, ct.UpStair, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Down stair', bt.Construction, ct.DownStair, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Up/down stair', bt.Construction, ct.UpDownStair, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Fortification', bt.Construction, ct.Fortification, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    add_build_item(items, 'constructions', 'Reinforced wall', bt.Construction, ct.ReinforcedWall, -1, {area=true, hollow=true, limit_w=31, limit_h=31})
    -- WD-15: roads move here from the old invented "trade" category (audit §3 correction).
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
    -- WD-15: floodgate moves here from the old invented "furniture" category (spec 0.1.3
    -- correction -- it's a fluid-control gate, grouped with pumps/wheels/bridges).
    add_build_item(items, 'machines', 'Floodgate', bt.Floodgate)

    -- WD-15: Cages/restraints -- a real top-level category (was lumped into "furniture").
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

    -- WD-15: siege engines fold into the real Military category (was its own invented
    -- top-level "siege" bucket) -- confirmed: "catapult, ballista and bolt thrower... classified
    -- as siege engines in the military category of the build menu" (community reference).
    add_build_item(items, 'military', 'Catapult', bt.SiegeEngine, st.Catapult, -1, {direction=true})
    add_build_item(items, 'military', 'Ballista', bt.SiegeEngine, st.Ballista, -1, {direction=true})
    add_build_item(items, 'military', 'Bolt thrower', bt.SiegeEngine, st.BoltThrower, -1, {direction=true})
    -- Archery target moves here from the old invented "farming" category -- confirmed:
    -- dwarffortresswiki.org Archery_target: "build (b, A)... places archery targets under the
    -- Military category of the build menu".
    add_build_item(items, 'military', 'Archery target', bt.ArcheryTarget)

    -- WD-15: Trade depot only -- roads moved to Constructions above (audit §3 correction).
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
    -- WD-15: constructed Track pieces fold into Constructions per DF's real menu
    -- ("Constructions incl. all 20+ track pieces", audit §3) -- the catalog-gap item's other
    -- half (these pieces existing at all) was already landed by an earlier chunk; this pass
    -- just re-homes them out of the invented top-level 'track' bucket.
    for _, t in ipairs(track_names) do
        add_build_item(items, 'constructions', t[2], bt.Construction, t[1], -1, {area=true, hollow=false, limit_w=31, limit_h=31})
    end
end

function add_custom_build_items(items)
    -- WD-15 catalog gap (audit §3): SCREW_PRESS / SOAP_MAKER are raw-defined custom workshops
    -- (no native workshop_type entry exists for either -- confirmed against
    -- library/include/df/workshop_type.h), not hardcoded types, so they were never actually
    -- missing from THIS generic loop -- they arrive automatically as direct Workshops entries
    -- (group='') below, matching 06b-build-workshops.png's captured list. Custom furnaces (if
    -- any raws define one) nest into the Furnaces subgroup instead.
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
    -- Every step is pcall-guarded: this runs on dwf's RENDER THREAD, and if a Lua error
    -- escaped to DFHack's SafeCall the traceback it builds overflows the render thread's small
    -- stack and HARD-CRASHES the game (observed: intermittent crash opening the build menu). So we
    -- catch errors here and return a (possibly partial) catalog instead -- never crash.
    local items = {}
    local ok1, e1 = pcall(add_native_build_items, items)
    if not ok1 then dfhack.printerr('dwf building_catalog: native items failed: ' .. tostring(e1)) end
    local ok2, e2 = pcall(add_custom_build_items, items)
    if not ok2 then dfhack.printerr('dwf building_catalog: custom items failed: ' .. tostring(e2)) end

    pcall(table.sort, items, function(a, b)
        if a.category ~= b.category then return tostring(a.category) < tostring(b.category) end
        return tostring(a.label) < tostring(b.label)
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
                -- WD-15: tell the client which Workshops subgroups exist (label + count) so it
                -- can render the flyout's nested folders (06b-build-workshops.png) without
                -- hardcoding subgroup labels client-side.
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

-- B297: one ownership gate for every Lua item enumeration. C++ has the same purpose enum in
-- src/fort_stock.h; keeping the language boundary explicit avoids a CoreSuspender-hostile Lua call
-- per C++ item while still preventing per-surface flag copies. `available` adds job-claimability;
-- `presence` and `condition-material` intentionally retain forbidden/in-use fort items because
-- those native surfaces describe existence, not immediate claimability.
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

-- Fast screen for whether an item can be used as a construction material right now. DF still
-- validates reachability/stockpile at build time; this is just to build the picker list + counts.
function item_buildable(item)
    return is_fort_stock_item(item, 'available')
end

-- ===== B243/B244: construction material filters =====
--
-- GROUND TRUTH (taken from DF/DFHack, not invented here):
--
--   * Every construction -- and every other "building material" building (Bridge, RoadPaved,
--     TradeDepot, Support, ArcheryTarget, TrackStop) -- uses ONE job_item whose only meaningful
--     field is flags2.building_material:
--         dfhack/library/lua/dfhack/buildings.lua, get_inputs_by_type():
--             [df.building_type.Construction] -> { { flags2={ building_material=true,
--                                                             non_economic=true } } }
--         (ReinforcedWall additionally takes 2x buildmat + one item_type=BAR with flags3.metal.)
--     Its item_type, item_subtype, mat_type and mat_index are ALL -1
--     (buildings.input_filter_defaults, same file).
--     DF itself builds the identical filter: dfhack/library/modules/Constructions.cpp:98-104
--     (designateNew: flags2.bits.building_material = true; non_economic when mat_index < 0).
--
--   * What DF accepts for such a filter is decided by the item's own is_buildmat vmethod
--     (df-structures df.item.xml:584 <vmethod name='isBuildMat'>), and by the four item vectors
--     DF searches:
--         dfhack/plugins/buildingplan/buildingplan.cpp:437-450, getVectorIds():
--             if (job_item->flags2.bits.building_material) { BLOCKS; BOULDER; WOOD; BAR; }
--         dfhack/plugins/buildingplan/buildingplan_cycle.cpp:148, matchesFilters():
--             if (jitem->flags2.bits.building_material && !item->isBuildMat()) return false;
--     DFHack's own gui/advfort.lua:703 uses that exact guard. So: blocks, boulders (rock), logs
--     (wood) and bars -- and nothing else.
--
-- THE DEFECT (why plants showed up as floor material): the old item_matches_filter() below
-- compared ONLY item_type / item_subtype / mat_type / mat_index -- every one of which is -1 on a
-- construction filter. All four gates were therefore skipped and the function returned true for
-- EVERY unforbidden item in world.items.other.IN_PLAY. It never filtered by item class at all, so
-- the chooser grouped the whole fort's inventory by material: plants, food, corpses, clothing.
-- flags1/flags2/flags3 -- the fields that carry the ENTIRE meaning of a construction filter --
-- were simply never read.

-- The accepted item classes for a flags2.building_material job_item, from getVectorIds() above.
-- Kept as a named table so the fixture test can pin it (and assert PLANT is not in it).
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

-- material_flags.IS_METAL (df-structures df.d_basics.xml:4279); gates job_item.flags3.metal,
-- which is how ReinforcedWall asks for a METAL bar rather than any bar.
function mat_is_metal(mt, mi)
    local ok, info = pcall(dfhack.matinfo.decode, mt, mi)
    if not ok or not info or not info.material then return false end
    local okf, metal = pcall(function() return info.material.flags.IS_METAL end)
    return okf and metal == true
end

-- job_item_flags1.empty / flags2.lye_milk_free: reject containers that hold something.
-- Mirrors buildingplan_cycle.cpp matchesFilters() (CONTAINS_ITEM general ref).
function item_has_contents(item)
    local ok, gref = pcall(dfhack.items.getGeneralRef, item, df.general_ref_type.CONTAINS_ITEM)
    return ok and gref ~= nil
end

-- Does an item satisfy a building's job_item filter? This mirrors DFHack's authoritative
-- matchesFilters() (plugins/buildingplan/buildingplan_cycle.cpp:139-190). mat_type < 0 means
-- "any material", which is exactly what the chooser wants to enumerate.
function item_matches_filter(filter, item)
    if not item then return false end
    if filter.item_type ~= nil and filter.item_type >= 0 and item:getType() ~= filter.item_type then
        return false
    end
    if filter.item_subtype ~= nil and filter.item_subtype >= 0 and item:getSubtype() ~= filter.item_subtype then
        return false
    end

    -- B243/B244: the gate that was missing entirely. Two independent checks, exactly as
    -- buildingplan composes them: DF's own is_buildmat vmethod, AND the four item classes
    -- getVectorIds() searches for a building_material filter. A plant fails both.
    if filter_wants_buildmat(filter) then
        if not buildmat_item_types()[item:getType()] then return false end
        local ok, buildmat = pcall(function() return item:isBuildMat() end)
        if not ok or not buildmat then return false end
    end

    -- flags3.metal: ReinforcedWall's bar reagent (buildings.lua get_inputs_by_type()).
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

-- List the AVAILABLE materials (grouped, with on-hand counts) for each requirement of a building,
-- so the browser can offer DF-style material selection. Read-only; runs under CoreSuspender.
function build_materials(token)
    local btype, subtype, custom = parse_token(token)
    if not btype then return '{"ok":false,"error":"bad building token"}\n' end
    local ok_f, filters = pcall(dfhack.buildings.getFiltersByType, {}, btype, subtype, custom)
    if not ok_f or not filters then return '{"ok":false,"error":"no filters"}\n' end

    local items_vec = df.global.world.items.other.IN_PLAY
    local req_json = {}
    for fi, filter in ipairs(filters) do
        local pinned = (filter.mat_type ~= nil and filter.mat_type >= 0)   -- material fixed by raws
        local groups, order = {}, {}
        for ii = 0, #items_vec - 1 do
            local item = items_vec[ii]
            if item_buildable(item) and item_matches_filter(filter, item) then
                -- B244: group by ITEM CLASS as well as material. "Granite" the boulder and
                -- "granite blocks" are different builds in DF (and different job_items -- one is
                -- item_type BOULDER, the other BLOCKS); collapsing them onto the material alone
                -- meant the player could never actually choose "rock vs blocks vs wood vs bars",
                -- which is precisely what B244 asks for.
                local it = item:getType()
                local mt, mi = item:getMaterial(), item:getMaterialIndex()
                local key = tostring(it) .. ':' .. tostring(mt) .. ':' .. tostring(mi)
                local g = groups[key]
                if not g then
                    local nm = ''
                    local okm, info = pcall(dfhack.matinfo.decode, mt, mi)
                    if okm and info then
                        local oks, s = pcall(function() return info:toString() end)
                        if oks and s then nm = s end
                    end
                    g = { item_type = it, mat_type = mt, mat_index = mi, name = nm, count = 0,
                          class_name = buildmat_item_types()[it] or
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
        local mats = {}
        for _, key in ipairs(order) do
            local g = groups[key]
            table.insert(mats, '{"itemType":' .. tostring(g.item_type) ..
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
    return '{"ok":true,"requirements":[' .. table.concat(req_json, ',') .. ']}\n'
end

-- Finished objects that DF asks the player to choose after selecting the placement tile.
-- Only single, quantity-one requirements use this path; component buildings keep filters.
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

-- Read-only picker data. No selected id preserves the legacy generic filter path.
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
            pcall(function() quality = item:getQuality() end)
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

-- Apply the browser's per-requirement material picks onto the building's filters, so
-- constructBuilding restricts each reagent to the chosen material.
--
-- Pick grammar (B244 extends it, backward-compatibly):
--     "itemType:matType:matIndex"   -- new: pins the item class too (rock / blocks / wood / bars)
--     "matType:matIndex"            -- legacy: material only, any class (still accepted)
--
-- WRITE-PATH BUG (B243/B244), fixed here: a construction/depot/bridge filter carries
-- flags2.non_economic = true (buildings.lua get_inputs_by_type; DF's own
-- Constructions.cpp:102-103 sets it only "if (mat_index < 0)"). non_economic is a MATERIAL
-- predicate -- MaterialInfo::getMatchBits, Materials.cpp:529:
--     TEST(non_economic, !inorganic || !(plotinfo && vector_get(plotinfo->economic_stone, index)))
-- -- so it is FALSE for any stone the fort has flagged economic. The old code pinned mat_type /
-- mat_index and left non_economic set, producing a job_item that demands "this exact economic
-- stone AND not-an-economic-stone": unsatisfiable. The job is queued, DF accepts it, and no
-- dwarf can ever fill it -- the building just sits there forever. DFHack clears the flag for
-- exactly this reason the moment a material is pinned (buildings.lua augment_input():
--     if rv.mat_index and safe_index(rv, 'flags2', 'non_economic') then
--         rv.flags2.non_economic = false
--     end
-- ) but that runs inside getFiltersByType, i.e. BEFORE our pick exists, so it never fired for us.
function apply_chosen_materials(filters, opts)
    for i, filter in ipairs(filters or {}) do
        local sel = opts['mat' .. (i - 1)]
        if sel then
            local it, mt, mi = tostring(sel):match('^(-?%d+):(-?%d+):(-?%d+)$')
            if not it then
                mt, mi = tostring(sel):match('^(-?%d+):(-?%d+)$')   -- legacy 2-part pick
            end
            if mt then
                filter.mat_type = tonumber(mt)
                filter.mat_index = tonumber(mi)
                -- Mirror DFHack's augment_input(): a pinned material overrides non_economic.
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

-- DF-style "use closest material": for any requirement set to "closest", pick the matching on-hand
-- item nearest the placement (cx,cy,cz) and rewrite opts.matN to that item's specific material so
-- the normal apply_chosen_materials path uses it. Done once per placement (cheap enough).
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
            -- Resolve to a concrete item class + material, or drop the pick (-> "any") if nothing
            -- is reachable. B244: emit the 3-part pick so the closest BOULDER doesn't get
            -- silently widened to "any granite item" by apply_chosen_materials.
            opts[key] = best and (tostring(best:getType()) .. ':' .. tostring(best:getMaterial())
                .. ':' .. tostring(best:getMaterialIndex())) or nil
        end
    end
end

function filters_for_building(btype, subtype, custom, opts)
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
    apply_chosen_materials(filters, opts)   -- DF-style per-requirement material selection
    return filters
end

function apply_building_options(bld, btype, subtype, direction, opts)
    if not bld then return end
    if btype == df.building_type.SiegeEngine then
        bld.facing = direction
        bld.resting_orientation = direction
    end
    for k in pairs(bld) do
        if k == 'track_stop_info' then
            bld.track_stop_info.friction = clamp(opt_num(opts, 'friction', 50000), 0, 50000)
            bld.track_stop_info.track_flags.bits.use_dump = opt_bool(opts, 'track_dump', false)
            bld.track_stop_info.dump_x_shift = clamp(opt_num(opts, 'dump_x', 0), -1, 1)
            bld.track_stop_info.dump_y_shift = clamp(opt_num(opts, 'dump_y', 0), -1, 1)
        elseif k == 'speed' then
            bld.speed = clamp(opt_num(opts, 'speed', 50000), 1000, 100000)
        elseif k == 'plate_info' then
            local p = bld.plate_info
            p.flags.bits.units = opt_bool(opts, 'plate_units', true)
            p.flags.bits.water = opt_bool(opts, 'plate_water', false)
            p.flags.bits.magma = opt_bool(opts, 'plate_magma', false)
            p.flags.bits.track = opt_bool(opts, 'plate_track', false)
            p.flags.bits.citizens = opt_bool(opts, 'plate_citizens', false)
            p.flags.bits.resets = opt_bool(opts, 'plate_resets', true)
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
    local filters = filters_for_building(btype, subtype, custom, opts)
    if not filters then return nil, 'building has no material filter' end
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
    apply_building_options(bld, btype, subtype, direction, opts)
    return bld, ''
end

-- Build placement diagnostics are intentionally request-scoped (never per-frame). Keep the
-- lightweight step markers for hang localization; the structured snapshot returned to C++ is
-- written through diagnostics_log(), which serializes concurrent writers.
function bp_dbg(msg)
    pcall(function()
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
    pcall(function() stage = bld:getBuildStage() end)
    pcall(function() max_stage = bld:getMaxBuildStage() end)

    local center_occupancy = -1
    pcall(function()
        local block = dfhack.maps.getTileBlock(bld.centerx, bld.centery, bld.z)
        if block then
            center_occupancy = block.occupancy[bld.centerx % 16][bld.centery % 16].bits.building
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
    pcall(function() contained_items = bld.contained_items end)
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
    pcall(function() has_design = bld.design ~= nil end)
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
    -- Resolve any "closest material" picks against the placement center before constructing.
    pcall(resolve_closest_materials, opts, btype, subtype, custom,
        math.floor((bounds.x1 + bounds.x2) / 2), math.floor((bounds.y1 + bounds.y2) / 2), bounds.z)

    local blds = {}
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
                        local bld = place_one(pos, btype, subtype, custom, 1, 1, direction, opts, false)
                        if bld then table.insert(blds, bld) end
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
        local bld, place_err = place_one(xyz2pos(lx, ly, bounds.z), btype, subtype, custom,
            width, height, direction, opts, true)
        if bld then table.insert(blds, bld) else return 0, -1, place_err end
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
        local bld, place_err = place_one(xyz2pos(sx, sy, bounds.z), btype, subtype, custom,
            width, height, direction, opts, false, selected_item_id)
        bp_dbg('single: place_one returned bld=' .. tostring(bld ~= nil))
        if bld then table.insert(blds, bld) else return 0, -1, place_err end
    end

    if #blds == 0 then return 0, -1, 'no valid tiles for building placement' end
    -- Do NOT register with buildingplan here. buildingplan.addPlannedBuilding -> get_item_filters
    -- -> get_job_items makes a NESTED Lua call (get_job_item) the first time a given building type
    -- is placed (to warm its per-type cache). That nested CallLuaModuleFunction DEADLOCKS when run
    -- from our render-thread run_on_render_thread_sync context -- which is exactly why placing a
    -- not-yet-cached furniture type hung the game. constructBuilding above already created the
    -- building with its material filters, so it builds normally with on-hand materials (just not as
    -- a deferred "planned" building). See dwf-building-hang memory for the deferred-onupdate
    -- alternative that would restore buildingplan if we want it later.
    bp_dbg('placed ' .. #blds .. ' building(s) id=' .. tostring(blds[1].id) .. ' (buildingplan skipped)')
    -- WP-C: return EVERY created building id (4th value, a table) so the caller can attribute all
    -- tiles of a multi-tile placement, not just the first. Older callers that only read 3 values
    -- ignore it. Mirrors create_order's created-id-table return.
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

-- Create an activity zone over the inclusive world-tile rectangle (x1,y1)-(x2,y2) on z.
-- Same abstract-building path as stockpiles. Returns (id, ''). On failure (-1, errmsg).
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

-- ---------------------------------------------------------------------------
-- Zone locations: taverns, temples, libraries, guildhalls, hospitals.
-- Mirrored from DFHack quickfort's location creation path so we create real
-- abstract_building records and attach the civzone through contents.building_ids.
-- ---------------------------------------------------------------------------

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

-- Location staffing/details reads. Occupations live on both loc.occupations and the
-- global world.occupations.all registry; each carries type + the assigned unit/histfig
-- (histfig_id/unit_id == -1 means the slot is open, exactly like native's Location Details).
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

-- Native's four access settings map to the abstract_building flags. Keep all four states distinct;
-- collapsing the middle two is how a real resident-only setting became a made-up citizen state.
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

-- Guildhalls carry their dedicated guild in contents.profession; a generic guildhall is NONE.
-- (Temple deity resolution is deliberately omitted -- see closeout gap note.)
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
        -- Set the access policy on the target location (default: the zone's current location).
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
        -- Detach the zone in context first (mirrors the panel flow), then enforce the same
        -- guard native uses: refuse while occupations are still assigned or other zones remain
        -- attached. Retiring == flags.DOES_NOT_EXIST + purge the location's occupation slots from
        -- the global registry (DFHack zone.lua's retire recipe). The record is left in
        -- site.buildings for the engine to reap, exactly as vanilla does.
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

-- ---------------------------------------------------------------------------
-- B229 -- Location depth: occupant counts, occupation assignment, temple-deity
-- and craft-guild pickers, rented rooms.
--
-- STRUCTURES (df-structures, library/xml/df.abstract_building.xml + df.occupation.xml):
--
--   abstract_building (class, per-site, site.buildings; id is site-local)
--     .occupations           stl-vector<occupation*>   -- the location's staff slots
--     .inhabitants           stl-vector<abstract_building_hf_linkst>
--     .flags                 abstract_building_flags   -- VISITORS_ALLOWED / MEMBERS_ONLY / ...
--     :getContents()         abstract_building_contents (location_infost)
--                              .location_tier / .location_value / .building_ids (attached civzones)
--                              .profession   -- the craft guild a GUILDHALL serves (v0.47+)
--
--   abstract_building_templest  .deity_type (religious_practice_type: NONE/WORSHIP_HFID/RELIGION_ENID)
--                               .deity_data (union: .Deity = histfig id | .Religion = entity id)
--   abstract_building_inn_tavernst  .room_info stl-vector<rental_roomst>, .next_room_info_id
--   rental_roomst  {id, location (string), civzone (building id), world_x/world_y/world_z}
--
--   occupation (world.occupations.all, global id from df.global.occupation_next_id)
--     {id, type (occupation_type), histfig_id, unit_id, location_id (= abstract_building.id),
--      site_id, group_id (= the fort historical_entity), service_order stl-vector<service_orderst>,
--      next_service_order_id}
--   service_orderst {local_id, type (service_order_type: DRINK/ROOM_RENTAL/EXTEND_ROOM_RENTAL),
--      customer_hfid, customer_unid, money_owed, room_ab_local_id (-> rental_roomst.id),
--      start_year, end_year, ...}
--
--   The three cross-linked structs the census flags are exactly:
--     abstract_building_inn_tavernst.room_info[] (rental_roomst)
--       <-> occupation.service_order[] (service_orderst.room_ab_local_id == rental_roomst.id)
--       <-> building_civzonest (rental_roomst.civzone)
--
--   Assignment mirrors DF's own two-sided link (same shape as the noble path in
--   src/fort_admin.cpp do_noble_assign): the occupation carries unit_id + histfig_id, and the
--   historical figure carries a histfig_entity_link_occupationst back to it.
-- ---------------------------------------------------------------------------

-- B229/B214: the ONE living-citizen predicate for every Lua assignment list. Same semantics as
-- the C++ twin (src/fort_admin.cpp is_assignable_citizen, src/labor.cpp is_assignable_citizen):
-- isCitizen alone still passes retained corpses and ghosts out of world.units.active.
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

-- Which occupation types each location kind offers.
--   verified=true  -- the slot is proven for this location kind by code we can point at:
--                     the four hospital roles are read straight off a hospital abstract_building
--                     by DFHack itself (scripts/internal/notify/notifications.lua
--                     has_functional_hospital), and tavern keeper/performer + scholar/scribe are
--                     the enum's own names for those location kinds (occupation_type).
--   verified=false -- plausible but NOT established from structures/DFHack. Creating a *new*
--                     occupation object of an unverified type is refused (see LOCATION_ALLOW_
--                     UNVERIFIED_SLOTS); an unverified slot that already EXISTS (DF made it, e.g.
--                     a mercenary petition) is still listed and still assignable, because that
--                     write only touches fields DF already filled in.
local OCCUPATION_SLOTS = {
    tavern = {
        {type = df.occupation_type.TAVERN_KEEPER, verified = true},
        {type = df.occupation_type.PERFORMER,     verified = true},
        {type = df.occupation_type.MERCENARY,     verified = false},
        {type = df.occupation_type.MONSTER_SLAYER,verified = false},
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
        {type = df.occupation_type.PERFORMER, verified = false},
    },
    guildhall = {},
}

-- GUARD (B229). Flip to true only after live-probe #3 confirms DF accepts these slots on these
-- location kinds. Assignment into slots DF itself created is unaffected by this flag.
local LOCATION_ALLOW_UNVERIFIED_SLOTS = false

-- GUARD (B229). Creating a rental_roomst by hand needs the coordinate space of world_x/world_y/
-- world_z ("abs_room_x") pinned against a natively-rented room -- site-relative vs region-absolute
-- is not decidable from df-structures. Reads are always on; the write stays off until probe #4.
local LOCATION_ALLOW_ROOM_WRITES = false

function occupation_type_key(occ_type)
    local ok, key = pcall(function() return tostring(df.occupation_type[occ_type]) end)
    if ok and key and #key > 0 then return key end
    return tostring(occ_type)
end

function fort_entity()
    local plotinfo = df.global.plotinfo
    if not plotinfo then return nil end
    return df.historical_entity.find(plotinfo.group_id or -1)
end

-- Every civzone attached to the location, with its footprint, so the client can list them and so
-- occupant counting has a region to test against.
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

-- Occupant counts (census gap #1). "Inside now" is a live footprint test against the location's
-- civzones -- the same thing native's location screen means by the people in your tavern. Split
-- the way DF splits them, because a tavern full of visitors is a different fact from a tavern full
-- of citizens.
function location_occupancy(loc, zones)
    local out = {inside = 0, citizens = 0, residents = 0, visitors = 0, others = 0, names = {}}
    local units = df.global.world and df.global.world.units and df.global.world.units.active
    if not units or #zones == 0 then return out end
    for _, unit in ipairs(units) do
        local ok = pcall(function()
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
                local ok_name, name = pcall(dfhack.units.getReadableName, unit)
                table.insert(out.names, ok_name and name or ('Unit ' .. tostring(unit.id)))
            end
        end)
        -- A unit whose predicates blow up (a half-loaded corpse, a mid-transform creature) is
        -- skipped, not fatal: a count that is one short beats a panel that fails to open.
        local _ = ok
    end
    return out
end

-- Occupation rows = the slots DF already created for this location (with holders) MERGED with the
-- vacant slots its kind offers. A vacant row has id == -1: assigning to it creates the occupation.
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

-- Temple-deity picker options (census gap #3). Native only offers what the fort actually worships,
-- so we derive the same list from the citizens: a deity is a histfig_hf_link_deityst on a citizen's
-- historical figure (target_hf = the deity, link_strength = how devout); a religion is a
-- historical_entity of type Religion that a citizen is linked to. Count of worshippers is the sort
-- key and is shown, because "3 dwarves worship Armok" is what makes the choice.
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

-- Craft-guild picker options (census gap #3). A guild is a historical_entity of type Guild whose
-- guild_professions[0].profession is the craft it promotes (entity_focusst, v0.47+); native's
-- location_list_interfacest.valid_craft_guild_type is that same profession list. Members = fort
-- citizens linked to that guild entity.
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

-- Rented rooms (census gap #4) -- the three-struct join, read side.
-- room_info[] (rental_roomst) x occupation.service_order[] (service_orderst) x civzone.
function rooms_json(loc)
    if not df.abstract_building_inn_tavernst:is_instance(loc) then return 'null' end
    -- Index every ROOM_RENTAL/EXTEND service order the location's occupations are carrying, by the
    -- room it points at (service_orderst.room_ab_local_id == rental_roomst.id -- "not zone or ab id,
    -- something local to ab", per df-structures).
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

-- Appointed positions bound to THIS location: entity_position_assignment.ab_id is the abstract
-- building the position serves (temple priests, guild representatives). Read-only here -- the
-- write already exists and is tested at src/fort_admin.cpp /noble-assign.
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

-- The living-citizen candidate list for an occupation (B214: no corpses, no ghosts).
function location_candidates_json(loc)
    local rows = {}
    local units = df.global.world and df.global.world.units and df.global.world.units.active or {}
    local holders = {}
    for _, occ in ipairs(loc.occupations) do
        if (occ.unit_id or -1) >= 0 then holders[occ.unit_id] = occupation_label(occ.type) end
    end
    for _, unit in ipairs(units) do
        if is_living_citizen(unit) and (unit.hist_figure_id or -1) >= 0 then
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

-- PROBE (B229). Raw field dump of every occupation on this location plus the holder's histfig
-- links, so a maintainer can stage a native assignment in DF and read back EXACTLY what the
-- game wrote (link_strength, start_year, histfig_site_link sub_id, room coordinate space). This is
-- the read that turns probes #1/#2/#4 into a single command; it never writes.
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

-- Find an occupation on this location: by global id when the client sends one (an existing slot),
-- else the first slot of that type (a vacant catalogue row sends id -1 + typeKey).
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

-- Drop the histfig_entity_link_occupationst tying an old holder to this occupation (mirrors
-- src/fort_admin.cpp unlink_position_holder -- unlink before relink, both sides stay consistent).
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
    -- start_year + link_strength are the same two fields the noble path fills (fort_admin.cpp);
    -- link_strength=100 is that path's proven value. We deliberately do NOT synthesise a
    -- histfig_site_link_occupationst: its `sub_id` is "from XML" in df-structures and we cannot
    -- spell it from the structures alone. A missing descriptive link is inert; a half-formed one
    -- is a corrupt record. Probe #2 pins it.
    hf.entity_links:insert('#', {
        new = df.histfig_entity_link_occupationst,
        entity_id = entity_id,
        entity_vector_idx = -1,
        link_strength = 100,
        occupation_id = occupation_id,
        start_year = df.global.cur_year,
    })
end

-- Assignment (census gap #2 -- the one that makes taverns/temples/libraries non-decorative).
-- unit_id < 0 vacates the slot. Assigning to a slot DF never created allocates the occupation with
-- the game's OWN id counter (df.global.occupation_next_id, a real symbol -- see symbols.xml
-- global-address occupation_next_id) and registers it in both vectors DF keeps it in.
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
            -- GUARDED: see LOCATION_ALLOW_UNVERIFIED_SLOTS.
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

-- Temple dedication (census gap #3). Native picks the deity when the temple is CREATED and offers
-- no re-dedication, so we allow the write only while the temple is still generic -- that keeps us
-- inside the game's own rules rather than inventing an operation DF does not have.
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

-- Guildhall dedication (census gap #3). Single field: abstract_building_contents.profession, which
-- is exactly what native's location_list_interfacest.selected_craft_guild resolves to. Same
-- create-time-only rule as the temple.
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

-- id = LOCATION id (not a zone id). kind carries the action's payload:
--   occupation-assign  kind='<OCCUPATION_TYPE>' or 'id:<occupationId>', unit = unit id (-1 vacates)
--   deity              kind='hf:<histfigId>' | 'religion:<entityId>'
--   guild              kind='<PROFESSION>'
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
        -- GUARDED: see LOCATION_ALLOW_ROOM_WRITES. rental_roomst.world_x/y/z ("abs_room_x") has an
        -- undetermined coordinate space; a room written at the wrong origin is a room the tavern
        -- keeper can rent out but nobody can find.
        if not LOCATION_ALLOW_ROOM_WRITES then
            return false, 'rented-room writes are guarded (B229 probe #4: pin rental_roomst.world_x/y/z)'
        end
        return false, 'rented-room writes not implemented'
    end
    return false, 'unknown location action'
end

-- ---------------------------------------------------------------------------
-- Work orders (the Manager): list / create / import presets / cancel / adjust
--
-- Creation goes through DFHack's tested `workorder` script (reqscript), which
-- handles the raws-dependent defaults; preset import reuses the `orders` command.
-- We never hand-roll manager_order objects -- far less crash-prone.
-- ---------------------------------------------------------------------------

-- B261: the fort-wide "add a work order" catalog is NO LONGER a hand-maintained second list.
-- It DERIVES from the exact same per-shop job projection the by-shop picker uses
-- (order_spec_entries / order_entries_for_defs), so a job that is orderable comes from ONE source
-- and the two surfaces cannot drift. See order_catalog() below (defined next to
-- order_catalog_by_shop, after the shop job tables it depends on).

-- Item types a stock condition can be written against (mirrors DF's condition picker).
-- condition_targets() filters out any not present in this build's df.item_type.
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

-- order_catalog() is defined LOWER in the file next to order_catalog_by_shop (B261): it derives
-- from the shared per-shop projection, so it must come after the forge/craft job tables and
-- order_entries_for_defs. reaction_exists (above) is kept -- create_order still validates a raw
-- reaction code with it.

-- Workshops/furnaces for the DF-style "new work order" picker (grouped by station, with the
-- icon key matching the web's building_icons sheet). {buildingType, subtypeEnumName, label, icon}.
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

-- order_catalog_by_shop() is defined LOWER in the file (B22/B21 rework), after the forge/craft
-- job tables (FORGE_STATIC, EXTRA_SHOP_JOBS, dynamic_shop_jobs) it now depends on. It stays a
-- global function served at /order-catalog-shops, so its definition-order does not matter.

-- The item types you can write a condition against.
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

function pretty_enum_name(name, fallback)
    name = tostring(name or fallback or '')
    if #name == 0 then return tostring(fallback or '') end
    return (name:gsub('_', ' '):gsub('(%l)(%u)', '%1 %2'))
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

-- ---------------------------------------------------------------------------
-- Workshop/furnace panels
-- ---------------------------------------------------------------------------

function get_shop(id)
    local b = df.building.find(tonumber(id) or -1)
    if not b then return nil end
    if df.building_workshopst:is_instance(b) or df.building_furnacest:is_instance(b) then
        return b
    end
    return nil
end

function shop_kind(b)
    if df.building_workshopst:is_instance(b) then return 'Workshop' end
    if df.building_furnacest:is_instance(b) then return 'Furnace' end
    return 'Building'
end

function shop_subtype_key(b)
    if df.building_workshopst:is_instance(b) then
        return df.workshop_type[b.type] or ''
    elseif df.building_furnacest:is_instance(b) then
        return df.furnace_type[b.type] or ''
    end
    return ''
end

function job_label(job)
    local ok, name = pcall(dfhack.job.getName, job)
    if ok and name and #name > 0 then return strip_unknown_material(name) end
    if job.job_type == df.job_type.CustomReaction and job.reaction_name and #job.reaction_name > 0 then
        return job.reaction_name
    end
    return pretty_enum_name(df.job_type[job.job_type], 'Job')
end

function worker_label(job)
    local ok, unit = pcall(dfhack.job.getWorker, job)
    if ok and unit then
        local ok_name, name = pcall(dfhack.units.getReadableName, unit)
        return ok_name and name or ('Unit ' .. tostring(unit.id))
    end
    return ''
end

-- B01: dfhack.workshops.getJobs has NO entry for the Craftsdwarf's Workshop (and several other
-- shops), so the common hardcoded jobs DF's own add-task UI shows (make rock/wood/bone/shell
-- crafts, mug, toy, totem...) never appear -- the list is instead flooded with the raws'
-- procedurally generated instrument reactions ("assemble akith", "make shosel bow", ...), which
-- is exactly the "bunch of insane item names" the owner reported. Supplement the missing common jobs
-- here so the list mirrors the Steam client's craftsdwarf flow. Reagent filters + naming follow
-- DF's own conventions (verified live: material_category drives the "<material> crafts" caption;
-- mat_type=0 gives the "rock ..." caption which has no material_category bit).
local STONE_REAGENT = { item_type = df.item_type.BOULDER, vector_id = df.job_item_vector_id.BOULDER, mat_type = 0, flags3 = { hard = true } }
local WOOD_REAGENT  = { item_type = df.item_type.WOOD, vector_id = df.job_item_vector_id.WOOD }
function craft_job(name, jt, matcat, reagent)
    local jf = { job_type = jt }
    if matcat == 'stone' then jf.mat_type = 0            -- no 'stone' material_category bit exists
    elseif matcat then jf.material_category = matcat end
    return { name = name, job_fields = jf, items = { reagent } }
end
-- B257/B258/B259/B264 -- the shops dfhack.workshops.getJobs has NO hardcoded entry for at all.
-- getJobs' table (dfhack/library/lua/dfhack/workshops.lua) simply omits Farmers, Quern and Ashery, so
-- those shops served ONLY their raws reactions: the farmer's showed 2 rows out of 9, the quern was
-- missing `Mill plants` (the building's entire purpose), and the ashery showed only milk-of-lime.
-- Rows + labels + order below are VERBATIM from the native captures.
--
-- REAGENTS: these are DF's own hardcoded jobs and DF resolves their target itself (the milkable
-- animal, the shearable animal, the plants in a stockpile). We therefore ship them with NO job_item
-- filter -- exactly the convention dfhack's own table uses for `catch live land animal` /
-- `collect sand` / `collect clay`, and exactly what the captures corroborate: EVERY one of these rows
-- renders WHITE in native even in a bare force-spawned fort with no ash, no lye and no animals, while
-- every RED row in every capture is a raws REACTION (which does carry checkable reagents). Inventing
-- a reagent filter here would both mis-red the row and risk queueing a job DF cannot satisfy.
local function plain_job(name, jt)
    return { name = name, job_fields = { job_type = df.job_type[jt] }, items = {} }
end
-- D2: an Encrust row = <a gem item> + <the thing being encrusted>. The TARGET half is dfhack's own
-- model (workshops.lua:96-110): job_item_flags1 `improvable` + one of ammo / finished_goods /
-- furniture. The GEM half follows the job type, using the flags df.d_basics.xml documents for exactly
-- this: flags1.glass = "check for material flag IS_GLASS", flags3.stone = ANY_STONE_MATERIAL. The gem
-- variant keeps dfhack's long-proven bare-SMALLGEM filter. NOTE: no capture can show a reagent filter,
-- so the two NEW gem pins are flag-derived, NOT capture-verified -- see the Jewelers comment.
local ENCRUST_GEM = {
    EncrustWithGems   = { item_type = df.item_type.SMALLGEM },
    EncrustWithGlass  = { item_type = df.item_type.SMALLGEM, flags1 = { glass = true } },
    EncrustWithStones = { item_type = df.item_type.SMALLGEM, flags3 = { stone = true } },
}
local function encrust_job(name, jt, target)
    local target_flags = { improvable = true }
    target_flags[target] = true
    return { name = name, label_locked = true,
             job_fields = { job_type = df.job_type[jt] },
             items = { ENCRUST_GEM[jt], { flags1 = target_flags } } }
end
-- Keyed by df.workshop_type / df.furnace_type name (see shop_subtype_key).
local EXTRA_SHOP_JOBS = {
    -- B257: WS-FARMERS-native.png. 9 native rows; `Make sheet from plant` + `Process plant to bag`
    -- are the two raws reactions getJobs already supplied (and both are RED). These are the other 7.
    Farmers = {
        plain_job('Make cheese',              'MakeCheese'),
        plain_job('Milk animal',              'MilkCreature'),
        plain_job('Process plants',           'ProcessPlants'),
        plain_job('Process plants (barrel)',  'ProcessPlantsBarrel'),
        plain_job('Process plants (vial)',    'ProcessPlantsVial'),
        plain_job('Shear animal',             'ShearCreature'),
        plain_job('Spin thread',              'SpinThread'),
    },
    -- B258: WS-QUERN-native.png. `Mash plant into slurry` + `Mill seeds/nuts to paste` are reactions
    -- (MAKE_SLURRY_FROM_PLANT / MILL_SEEDS_NUTS_TO_PASTE, both attached to QUERN + MILLSTONE in DF's
    -- reaction_other.txt) and already arrived. `Mill plants` is a JOB and was simply absent.
    Quern = {
        plain_job('Mill plants', 'MillPlants'),
    },
    -- B259: WS-ASHERY-native.png. `Make milk of lime` is the reaction (RED). The other three are jobs.
    Ashery = {
        plain_job('Make lye',              'MakeLye'),
        plain_job('Make potash from ash',  'MakePotashFromAsh'),
        plain_job('Make potash from lye',  'MakePotashFromLye'),
    },
    -- D9 (second parity review). WS-MASONS-native-1of2.png row 1 is `Engrave memorial slab (opens
    -- menu)`; rows 2-20 are the nineteen `Make rock <x>` leaves. We served 19 of 20: THE ROW DID NOT
    -- EXIST. D7b added the `(opens menu)` suffix in shop_tasks for a def with job_type == EngraveSlab,
    -- but no source ever produced one -- dfhack's workshops.lua Masons table has `construct slab`
    -- (ConstructSlab: the BLANK slab, native's `Make rock slab`, still row 16) and no engrave job, and
    -- the mason's dynamic arm emits MakeTool rows only. So the suffix code was dead and the row was
    -- simply missing. The def is the missing piece; everything downstream of it already existed
    -- (add_workshop_task has carried the EngraveSlab unit_id path since Phase 5).
    --
    -- The reagent is a BLANK SLAB, not a boulder -- DF engraves an existing slab item. label_locked
    -- because the label is transcribed off the capture, and it is withheld from both order surfaces by
    -- ORDER_EXCLUDED_JOBS (an EngraveSlab order needs a specific dead historical figure).
    --
    -- NOT DONE, SAY IT PLAINLY: the row is served and marked `(opens menu)`, and the server already
    -- emits the dead-unit list (`taskSelectionUnits`) + `needsUnitSelection` -- but NOTHING IN web/
    -- CONSUMES EITHER, so clicking the row cannot yet open the picker. We have no capture of that
    -- submenu, and this project does not ship guessed UI. The owner can still queue a memorial slab today
    -- from the dead unit's own info panel (the "Slab" button -> /memorial-slab), which is our own
    -- superset shortcut and works.
    Masons = {
        { name = 'Engrave memorial slab', label_locked = true,
          job_fields = { job_type = df.job_type.EngraveSlab },
          items = { { item_type = df.item_type.SLAB } } },
    },
    -- D2 (parity review). WS-JEWELERS-native.png shows TWELVE rows. We shipped six, and the comment
    -- that justified the omission was factually WRONG: it claimed the six missing encrust rows
    -- "differ ONLY by a job_item filter". They differ by JOB TYPE --
    --   EncrustWithGems   (df.job.xml:541)  "with cut gems"
    --   EncrustWithGlass  (df.job.xml:546)  "with cut glass"
    --   EncrustWithStones (df.job.xml:895)  "with polished stones"
    -- and the ammo / finished-goods / furniture split is dfhack's OWN model (workshops.lua:96-110):
    -- second reagent = job_item_flags1 {improvable + ammo|finished_goods|furniture}. All twelve rows
    -- are therefore derivable, and the shop is authored here in full (AUTHORED_SHOPS drops dfhack's
    -- four hardcoded jeweler defs so nothing is served twice).
    --
    -- LABELS are label_locked -- transcribed verbatim from the capture. The native probe cannot tell
    -- the three same-job_type rows apart (see native_flat_task_label), and native says "cut gems",
    -- not "gems".
    --
    -- THE ONE THING NOT SETTLED OFFLINE (say it plainly rather than overstate the wall): the GEM
    -- reagent of the glass/stone variants. `flags1.glass` is documented in df.d_basics.xml as "check
    -- for material flag IS_GLASS" and `flags3.stone` as ANY_STONE_MATERIAL, so both pins are
    -- flag-derived, not guessed -- but no capture can show a reagent filter, so they are NOT
    -- capture-verified. The gem rows keep dfhack's exact long-proven filter (a bare SMALLGEM).
    -- If a live probe ever shows DF pinning these differently, fix the three filters -- the ROWS and
    -- LABELS are oracle-pinned and stand either way.
    -- Written out ROW BY ROW, not generated from a loop, on purpose: every one of these twelve labels
    -- is greppable against WS-JEWELERS-native.png. `encrust_job` only carries the three reagents.
    Jewelers = {
        { name = 'Cut gems', label_locked = true, job_fields = { job_type = df.job_type.CutGems },
          items = { { item_type = df.item_type.ROUGH, flags1 = { unrotten = true } } } },
        plain_job('Cut raw glass into gems', 'CutGlass'),
        encrust_job('Encrust ammo with cut gems',                 'EncrustWithGems',   'ammo'),
        encrust_job('Encrust ammo with cut glass',                'EncrustWithGlass',  'ammo'),
        encrust_job('Encrust ammo with polished stones',          'EncrustWithStones', 'ammo'),
        encrust_job('Encrust finished goods with cut gems',       'EncrustWithGems',   'finished_goods'),
        encrust_job('Encrust finished goods with cut glass',      'EncrustWithGlass',  'finished_goods'),
        encrust_job('Encrust finished goods with polished stones','EncrustWithStones', 'finished_goods'),
        encrust_job('Encrust furniture with cut gems',            'EncrustWithGems',   'furniture'),
        encrust_job('Encrust furniture with cut glass',           'EncrustWithGlass',  'furniture'),
        encrust_job('Encrust furniture with polished stones',     'EncrustWithStones', 'furniture'),
        plain_job('Polish stones',           'PolishStones'),
    },
    -- WP-3: native wording -- DF capitalizes the leading verb ("Make rock crafts", not "make ...");
    -- the flatshop craftsdwarf_tree already renders native-cased, so these (work-order + flat-path
    -- fallback labels) are brought in line with it.
    Craftsdwarfs = {
        craft_job('Make rock crafts',      df.job_type.MakeCrafts, 'stone',   STONE_REAGENT),
        craft_job('Make wooden crafts',    df.job_type.MakeCrafts, 'wood',    WOOD_REAGENT),
        craft_job('Make bone crafts',      df.job_type.MakeCrafts, 'bone',    { flags1 = { unrotten = true }, flags2 = { bone = true } }),
        craft_job('Make shell crafts',     df.job_type.MakeCrafts, 'shell',   { flags1 = { unrotten = true }, flags2 = { shell = true } }),
        craft_job('Make ivory/tooth crafts', df.job_type.MakeCrafts, 'tooth', { flags1 = { unrotten = true }, flags2 = { ivory_tooth = true } }),
        craft_job('Make horn crafts',      df.job_type.MakeCrafts, 'horn',    { flags1 = { unrotten = true }, flags2 = { horn = true } }),
        craft_job('Make pearl crafts',     df.job_type.MakeCrafts, 'pearl',   { flags1 = { unrotten = true }, flags2 = { pearl = true } }),
        craft_job('Make leather crafts',   df.job_type.MakeCrafts, 'leather', { item_type = df.item_type.SKIN_TANNED, flags1 = { unrotten = true } }),
        craft_job('Make cloth crafts',     df.job_type.MakeCrafts, 'cloth',   { item_type = df.item_type.CLOTH }),
        craft_job('Make silk crafts',      df.job_type.MakeCrafts, 'silk',    { item_type = df.item_type.CLOTH, flags2 = { silk = true } }),
        -- D7c (parity review): `Make wooden toy` -- THE B255 INVENTED ROW -- lived here until 2026-07-14.
        -- WS-CRAFTSDWARF-WOOD-native-FULL.png is the COMPLETE wood list (it fits one screen) and has
        -- no toy of any kind. It was masked in the Tasks tab by the native craftsdwarf tree, but this
        -- table also feeds order_catalog_by_shop -- so the invented job was still LIVE on the work-order
        -- picker. Deleted. (`Make rock toy` is real: it IS in WS-CRAFTSDWARF-ROCK-native-2of2.png, and
        -- it lives in CD_ROCK_SEQ where the rock capture puts it.)
        -- Native names the goblet row `Make three rock mugs` (WS-CRAFTSDWARF-ROCK-native): MakeGoblet
        -- produces a stack of three, and the count word rides in the label.
        craft_job('Make three rock mugs',  df.job_type.MakeGoblet, 'stone',   STONE_REAGENT),
        craft_job('Make totem',            df.job_type.MakeTotem,  nil,       { flags1 = { unrotten = true }, flags2 = { totemable = true } }),
    },
}

-- AUTHORED SHOPS (parity review D1/D2). For these two, the capture is the whole list and we build it
-- ourselves, so dfhack's HARDCODED getJobs rows are dropped to avoid serving a row twice or serving a
-- row native never shows:
--   Jewelers -- getJobs' 4 rows are re-authored above (its labels say "gems", native says "cut gems").
--   Siege    -- getJobs' `assemble balista arrow` / `assemble tipped balista arrow` are a GENERIC pair
--               that native does not have at all: WS-SIEGE-native-{1,2}of2.png shows ONE row PER
--               MATERIAL and no "tipped" row anywhere. Its ballista/catapult parts rows are re-authored
--               with `Make bolt thrower parts` beside them (ConstructBoltThrowerParts, df.job.xml:1432).
-- RAWS REACTIONS attached to these shops still flow through untouched -- only dfhack's hand-written
-- job table is suppressed.
local AUTHORED_SHOPS = { Jewelers = true, Siege = true }
function getjobs_def_allowed(shop_key, def)
    if not AUTHORED_SHOPS[shop_key] then return true end
    local jf = (type(def) == 'table' and def.job_fields) or {}
    return jf.job_type == df.job_type.CustomReaction
end

-- B01-residue: forge / carpenter / bowyer / clothier common jobs. Unlike the Craftsdwarf (a fixed
-- EXTRA_SHOP_JOBS list), these shops list jobs derived from the fort ENTITY's permitted weapon /
-- armor / ammo / tool item defs (df's own menus are entity-scoped), so they must be
-- enumerated LIVE per fort. Reagent material follows the shop: a METAL bar at the two forges (job_item
-- flags3.metal = "any metal bar"), a WOOD log at the carpenter/bowyer, CLOTH at the clothier. Every raws / entity
-- read is nil- and bounds-guarded (a malformed entry is skipped, never crashing the interpreter -- the
-- MEMORY warns bounds-unsafe lua has crashed DF). Product item_type/item_subtype are carried in
-- job_fields and applied by add_workshop_task (below), exactly as DF sets a MakeWeapon/MakeArmor job.
local METALBAR_REAGENT = { item_type = df.item_type.BAR, flags3 = { metal = true } }
local WOODLOG_REAGENT  = { item_type = df.item_type.WOOD, vector_id = df.job_item_vector_id.WOOD }
local CLOTH_REAGENT    = { item_type = df.item_type.CLOTH }
local BONE_REAGENT     = { flags1 = { unrotten = true }, flags2 = { bone = true } }
local LEATHER_REAGENT  = { item_type = df.item_type.SKIN_TANNED, flags1 = { unrotten = true } }
-- The clothier works three DISTINCT materials and native gives each its own submenu (B266): the
-- cloth/silk/yarn split is a flags2 bit on the CLOTH item, exactly as the craftsdwarf's cd_reagent
-- does it. `cloth` (plant fibre) is the unflagged case.
local CLOTHIER_MATS = {
    { word = 'cloth', cat = 'cloth', reagent = { item_type = df.item_type.CLOTH } },
    { word = 'silk',  cat = 'silk',  reagent = { item_type = df.item_type.CLOTH, flags2 = { silk = true } } },
    { word = 'yarn',  cat = 'yarn',  reagent = { item_type = df.item_type.CLOTH, flags2 = { yarn = true } } },
}

-- Subtype-free metal jobs (job_type alone determines the product): furniture + goods DF's forge menu
-- groups under "Furniture" and the misc goods list. One metal bar each.
function forge_furn(name, jt, group, pri)
    return { name = name, group = group, pri = pri, job_fields = { job_type = jt }, items = { METALBAR_REAGENT } }
end
local FORGE_STATIC = {
    forge_furn('forge table',        df.job_type.ConstructTable,     'Furniture', 13),
    forge_furn('forge chair/throne', df.job_type.ConstructThrone,    'Furniture', 13),
    forge_furn('forge cabinet',      df.job_type.ConstructCabinet,   'Furniture', 13),
    forge_furn('forge coffin',       df.job_type.ConstructCoffin,    'Furniture', 13),
    forge_furn('forge door',         df.job_type.ConstructDoor,      'Furniture', 13),
    forge_furn('forge floodgate',    df.job_type.ConstructFloodgate, 'Furniture', 13),
    forge_furn('forge hatch cover',  df.job_type.ConstructHatchCover,'Furniture', 13),
    forge_furn('forge grate',        df.job_type.ConstructGrate,     'Furniture', 13),
    forge_furn('forge statue',       df.job_type.ConstructStatue,    'Furniture', 13),
    forge_furn('forge slab',         df.job_type.ConstructSlab,      'Furniture', 13),
    forge_furn('forge chain',        df.job_type.MakeChain,          'Goods',     14),
    forge_furn('forge flask',        df.job_type.MakeFlask,          'Goods',     14),
    forge_furn('forge goblet',       df.job_type.MakeGoblet,         'Goods',     14),
    forge_furn('forge cage',         df.job_type.MakeCage,           'Goods',     14),
    forge_furn('forge animal trap',  df.job_type.MakeAnimalTrap,     'Goods',     14),
    forge_furn('forge bucket',       df.job_type.MakeBucket,         'Goods',     14),
    forge_furn('forge pipe section', df.job_type.MakePipeSection,    'Goods',     14),
}

function fort_entity()
    local pi = df.global.plotinfo
    return (pi and pi.main and pi.main.fortress_entity) or nil
end

function itemdef_label(itemdef, fallback)
    if not itemdef then return fallback end
    local ok, nm = pcall(function() return itemdef.name end)
    if ok and type(nm) == 'string' and #nm > 0 then return nm end
    return fallback
end

-- Enumerate a fort-entity resource vector of int16 subtype indices into subtype job defs, resolving
-- each index against its raws itemdef vector. `filter(itemdef)` (optional) restricts by material class
-- (e.g. armorlevel). De-duplicates repeated indices. Fully bounds/nil-guarded.
-- `matcat` (optional) pins DF's organic material_category on the job (wood/bone/...) -- the same
-- discriminator craft_job uses; a metal job leaves it nil and lets the bar reagent decide.
-- `namer(itemdef)` (optional) composes the whole label when the native wording is not "<verb> <name>"
-- (bolts: "Make twenty-five wooden bolts" -- count word + plural).
function enum_entity_defs(defs, group, pri, verb, jt, item_type, idx_vec, raws_vec, reagent, filter, matcat, namer)
    if not idx_vec or not raws_vec then return end
    local seen = {}
    local n = pcall(function() return #idx_vec end) and #idx_vec or 0
    local rn = pcall(function() return #raws_vec end) and #raws_vec or 0
    for i = 0, n - 1 do
        local sub = idx_vec[i]
        if sub and sub >= 0 and sub < rn and not seen[sub] then
            seen[sub] = true
            local itemdef = raws_vec[sub]
            if itemdef and (not filter or filter(itemdef)) then
                local label
                if namer then
                    local ok, nm = pcall(namer, itemdef)
                    label = (ok and type(nm) == 'string' and #nm > 0) and nm or nil
                end
                label = label or (verb .. ' ' .. itemdef_label(itemdef, 'item ' .. tostring(sub)))
                local jf = { job_type = jt, item_type = item_type, item_subtype = sub }
                if matcat then jf.material_category = matcat end
                defs[#defs + 1] = {
                    name = label,
                    group = group, pri = pri,
                    job_fields = jf,
                    items = { reagent },
                }
            end
        end
    end
end

-- B255 -- WHERE AMMO IS ACTUALLY MADE. DF makes bolts at the CRAFTSDWARF'S WORKSHOP (wood, by a
-- wood crafter; bone, by a bone carver) and at the METALSMITH'S / MAGMA FORGE (metal, by a
-- weaponsmith). The BOWYER'S WORKSHOP makes CROSSBOWS ONLY -- it makes no ammo at all. Evidence:
--   * the native capture `tools/orchestrator/attachments/B255-1.png`: the Craftsdwarf's Workshop
--     task list contains "Make twenty-five wooden bolts".
--   * DFHack df-structures `library/xml/df.job.xml` (MakeAmmo): skill_wood=WOODCRAFT,
--     skill_stone=STONECRAFT, skill_metal=FORGE_WEAPON -- the woodcrafter/stonecrafter (craftsdwarf's
--     shop) and the weaponsmith (forge). No BOWYER skill appears on MakeAmmo anywhere.
--   * The forge's own capture-01 oracle already carries "Forge twenty-five <metal> bolts"
--     (ft_weapon_leaves) -- metal ammo at the forge was right all along.
-- The ammo rows on the bowyer were never captured: they were derived by hand (WP-3 marked them
-- `derived-not-captured`), and they were wrong.
--
-- Stack size rides in the native label. 25 per log and 25 per bar are capture-verified (B255-1.png /
-- capture 01). The BONE count (5 per bone) comes from the v53.15 wiki bolt page and is NOT
-- capture-verified -- it affects the LABEL only; DF itself decides the stack the job produces.
local AMMO_COUNT_WORD = { wood = 'twenty-five', bone = 'five' }
AMMO_COUNT_N = { wood = 25, bone = 5 }   -- chunk-global: the native tree's leaf `batch` uses it too
function ammo_shop_defs(defs, group, pri, adj, matcat, reagent)
    local e = fort_entity()
    local R = e and e.resources or nil
    local raws = df.global.world and df.global.world.raws or nil
    local IT = raws and raws.itemdefs or nil
    if not R or not IT then return end
    local word = AMMO_COUNT_WORD[matcat]
    local namer = function(d)
        local pl = d.name_plural
        if type(pl) ~= 'string' or #pl == 0 then pl = d.name end
        if type(pl) ~= 'string' or #pl == 0 then return nil end
        if word then return 'Make ' .. word .. ' ' .. adj .. ' ' .. pl end
        return 'Make ' .. adj .. ' ' .. pl
    end
    local before = #defs
    enum_entity_defs(defs, group, pri, 'Make ' .. adj, df.job_type.MakeAmmo, df.item_type.AMMO,
        R.ammo_type, IT.ammo, reagent, nil, matcat, namer)
    -- B284: the namer already composes the full native label with its material adjective baked in
    -- ("Make twenty-five wooden bolts" / "Make five bone bolts"). On the ORDER surface these defs pin
    -- a material_category, so expand_order_entries takes the mode='cat' branch and would re-apply the
    -- adjective via name_with_adj, printing "Make wooden twenty-five wooden bolts". label_locked is the
    -- existing "this label already names its material -- use it verbatim" flag (same rule the siege
    -- capture-locked rows use); it leaves the |cat:<matcat> key intact so create_order still resolves
    -- the right material. (cd_ammo_leaves reads def.name directly and ignores label_locked, so the
    -- craftsdwarf MENU tree is unaffected.)
    for i = before + 1, #defs do defs[i].label_locked = true end
end

-- The per-fort supplemental job list for a forge / carpenter / bowyer / clothier (nil for any
-- other shop). Accept either a live building or its subtype key so workshop_info and the fort-wide
-- catalog can share the exact same entity-derived source.
-- B260 THE TOOL SPLIT. `item_tool.txt`'s [FURNITURE] token is what separates the three shops that
-- all make MakeTool items, and it reproduces every one of the captures exactly:
--   FURNITURE + wood-capable -> CARPENTER  (altar, bookcase, pedestal, minecart, wheelbarrow, stepladder)
--   FURNITURE + HARD_MAT     -> MASON      (altar, bookcase, pedestal)
--   NOT FURNITURE, HARD_MAT  -> CRAFTSDWARF(jug, pot, hive, nest box, book binding, die, scroll rollers)
-- The old carpenter filter was "any tool without NO_DEFAULT_JOB", which put wooden jugs, pots, hives
-- and nest boxes on the carpenter -- WS-CARPENTERS-native-{1,2,3}of3.png shows none of them there.
-- `display case` is FURNITURE+HARD_MAT but NO_DEFAULT_JOB, so it is excluded from both the mason and
-- the carpenter tool blocks; the carpenter reaches it ONLY through the raws reaction
-- `MAKE WOODEN DISPLAY CASE`, which is exactly why native renders it RED "[Requires Window]".
local function tool_flag(d, name)
    local ok, v = pcall(function() return d.flags[name] end)
    return ok and v or false
end
local function tool_default(d) return not tool_flag(d, 'NO_DEFAULT_JOB') end
local function carpenter_tool(d)
    return tool_default(d) and tool_flag(d, 'FURNITURE') and
        (tool_flag(d, 'HARD_MAT') or tool_flag(d, 'WOOD_MAT'))
end
local function mason_tool(d)
    return tool_default(d) and tool_flag(d, 'FURNITURE') and tool_flag(d, 'HARD_MAT')
end
local function craftsdwarf_tool(d)
    return tool_default(d) and not tool_flag(d, 'FURNITURE') and tool_flag(d, 'HARD_MAT')
end
-- itemdef props flags (armor_general_flags): SOFT = cloth/silk/yarn clothing (clothier);
-- LEATHER = leather-capable (leatherworks). `socks` are SOFT-only, which is exactly why the native
-- leather list has no socks and the cloth list does.
local function armor_prop(d, name)
    local ok, v = pcall(function() return d.props.flags[name] end)
    return ok and v or false
end
-- D5 (parity review) -- THE WORLDGEN-ROLL HOLE, AND THE GATE THAT CLOSES IT.
--
-- The [SOFT] / [LEATHER] props flags are the right MECHANISM, but they are not sufficient. The dwarf
-- entity raws (`entity_default.txt`, [ENTITY:MOUNTAIN]) permit FOUR more soft/leather pieces that
-- pass both filters -- shirt, tunic, toga, loincloth -- and NO capture shows any of them:
-- WS-CLOTHIERS-native-{CLOTH,SILK,YARN} have 16 rows each with no shirt/tunic/toga/loincloth, and
-- WS-LEATHERWORKS-native-{1,2}of2 has 24 leaves with none either. We enumerate `entity.resources.*`
-- (the POST-WORLDGEN rolled vectors), which we cannot read offline, so there are two possibilities and
-- we cannot tell them apart without a live probe:
--   (a) the civ rolled those four OUT -> our enumeration already matches the captures exactly; or
--   (b) the rolled vectors DO contain them -> we would emit 4 invented rows at the leatherworks and
--       12 across the clothier submenus. That is precisely the B255 failure class this wave exists to
--       kill, and the previous pass marked these leaves "screenshot-verified" without disclosing it.
--
-- THE GATE: intersect the entity enumeration with the CAPTURED row set. An itemdef the captures never
-- show is dropped and COUNTED in `capture_absent_count`. This can only ever REMOVE a row native does
-- not show; it can never add one. It is deliberately keyed by the itemdef ID (raws-stable), and every
-- ID below was READ OFF the captures. If a future capture from another world shows one of these rows,
-- delete it from this list -- do not "fix" it by loosening the gate.
--
-- READ THE COUNTER TO SETTLE THE QUESTION (this is the whole point of it; it is not decoration):
--     dfhack-run lua "print(capture_absent_count)"      -- after opening a clothier or leatherworks
--
-- IT IS CUMULATIVE SINCE THE PLUGIN LOADED, and deliberately so -- it is NOT a per-open reading and
-- it is NOT a /diag field (an earlier comment claimed both). A per-open reset would be meaningless:
-- several players open shops concurrently, so whichever open you read last would clobber the answer.
-- The question it settles is "did this civ EVER roll one of the four?", which is a property of the
-- WORLD and never changes once seen -- so a monotonic counter is the right instrument, and any
-- non-zero value at any time is the answer.
-- 0  => the civ rolled these four OUT: case (a), the gate is a no-op, and we always matched.
-- >0 => the civ HAS them: case (b) was live, and this gate is the only reason we are not shipping
--       16 invented rows right now.
--
-- NOTE the asymmetry that makes this safe: the entity vectors remain the SOURCE (a civ that cannot
-- make robes still shows no robe row). The allow-list is only ever a ceiling.
local CAPTURE_ABSENT_CLOTHING = {
    ITEM_ARMOR_SHIRT = true,      -- SOFT+LEATHER, [ARMOR:...:COMMON] on the dwarf entity; in NO capture
    ITEM_ARMOR_TUNIC = true,      -- SOFT+LEATHER, COMMON;   in NO capture
    ITEM_ARMOR_TOGA = true,       -- SOFT+LEATHER, UNCOMMON; in NO capture
    ITEM_PANTS_LOINCLOTH = true,  -- SOFT+LEATHER, COMMON;   in NO capture
}
capture_absent_count = 0   -- chunk-global, cumulative since load; non-zero means (b) above is live
local function capture_shows(d)
    local id = nil
    pcall(function() id = d.id end)
    if type(id) == 'string' and CAPTURE_ABSENT_CLOTHING[id] then
        capture_absent_count = capture_absent_count + 1
        return false
    end
    return true
end
local function is_soft_clothing(d)    return armor_prop(d, 'SOFT') and capture_shows(d) end
local function is_leather_clothing(d) return armor_prop(d, 'LEATHER') and capture_shows(d) end
-- Native pairs the two-of-a-kind armor families: "Make pair of leather gloves / high boots".
local function pair_namer(verb, adj)
    return function(d)
        local pl = nil
        pcall(function() pl = d.name_plural end)
        if type(pl) ~= 'string' or #pl == 0 then pcall(function() pl = d.name end) end
        if type(pl) ~= 'string' or #pl == 0 then return nil end
        return verb .. ' pair of ' .. adj .. ' ' .. pl
    end
end
-- Trap components carry an ADJECTIVE that native splices before the material:
-- "Make enormous wooden corkscrew" / "Make menacing wooden spike" / "Make spiked wooden ball".
local function trapcomp_namer(adj_mat)
    return function(d)
        local a, nm = '', ''
        pcall(function() a = d.adjective or '' end)
        pcall(function() nm = d.name or '' end)
        if #nm == 0 then return nil end
        if #a > 0 then return 'Make ' .. a .. ' ' .. adj_mat .. ' ' .. nm end
        return 'Make ' .. adj_mat .. ' ' .. nm
    end
end
-- Pin "any rock" (mat 0 / index -1) onto defs added from index `from` on -- what DF's own rock jobs
-- carry, and what makes a queued mason task read "Make rock altar" rather than "unknown material".
local function pin_rock(defs, from)
    for i = from, #defs do
        local jf = defs[i] and defs[i].job_fields
        if jf then jf.mat_type = 0; jf.mat_index = -1 end
    end
end

function dynamic_shop_jobs(b)
    local key = type(b) == 'string' and b or shop_subtype_key(b)
    local is_forge    = (key == 'MetalsmithsForge' or key == 'MagmaForge')
    local is_carpenter= (key == 'Carpenters')
    local is_bowyer   = (key == 'Bowyers')
    local is_clothier = (key == 'Clothiers')
    local is_craftsdwarf = (key == 'Craftsdwarfs')
    local is_leatherworks = (key == 'Leatherworks')
    local is_mason    = (key == 'Masons')
    local is_siege    = (key == 'Siege')
    if not (is_forge or is_carpenter or is_bowyer or is_clothier or is_craftsdwarf
            or is_leatherworks or is_mason or is_siege) then return nil end
    local e = fort_entity()
    local R = e and e.resources or nil
    local raws = df.global.world and df.global.world.raws or nil
    local IT = raws and raws.itemdefs or nil
    if not R or not IT then return nil end
    local defs = {}

    if is_forge then
        -- Weapons (any metal), including diggers/picks (digger_type also indexes IT.weapons).
        enum_entity_defs(defs, 'Weapons', 10, 'forge', df.job_type.MakeWeapon, df.item_type.WEAPON, R.weapon_type, IT.weapons, METALBAR_REAGENT)
        enum_entity_defs(defs, 'Weapons', 10, 'forge', df.job_type.MakeWeapon, df.item_type.WEAPON, R.digger_type, IT.weapons, METALBAR_REAGENT)
        -- Metal ammo (bolts).
        enum_entity_defs(defs, 'Ammo',    11, 'forge', df.job_type.MakeAmmo,   df.item_type.AMMO,   R.ammo_type,   IT.ammo,   METALBAR_REAGENT)
        -- Metal armor: armorlevel >= 1 (armorlevel 0 pieces are clothing, made at the clothier).
        local metal_armor = function(d) local ok, l = pcall(function() return d.armorlevel end); return ok and l and l >= 1 end
        enum_entity_defs(defs, 'Armor', 12, 'forge', df.job_type.MakeArmor,  df.item_type.ARMOR,  R.armor_type,  IT.armor,   METALBAR_REAGENT, metal_armor)
        enum_entity_defs(defs, 'Armor', 12, 'forge', df.job_type.MakeHelm,   df.item_type.HELM,   R.helm_type,   IT.helms,   METALBAR_REAGENT, metal_armor)
        enum_entity_defs(defs, 'Armor', 12, 'forge', df.job_type.MakeGloves, df.item_type.GLOVES, R.gloves_type, IT.gloves,  METALBAR_REAGENT, metal_armor)
        enum_entity_defs(defs, 'Armor', 12, 'forge', df.job_type.MakeShoes,  df.item_type.SHOES,  R.shoes_type,  IT.shoes,   METALBAR_REAGENT, metal_armor)
        enum_entity_defs(defs, 'Armor', 12, 'forge', df.job_type.MakePants,  df.item_type.PANTS,  R.pants_type,  IT.pants,   METALBAR_REAGENT, metal_armor)
        enum_entity_defs(defs, 'Armor', 12, 'forge', df.job_type.MakeShield, df.item_type.SHIELD, R.shield_type, IT.shields, METALBAR_REAGENT)   -- shields carry no armorlevel; all metal-forgeable
        -- Tools in native's Other objects branch: permitted by the fort entity, material-compatible
        -- with hard forge metals, and not reaction-only. The same 13 vanilla defs are also wooden
        -- at the carpenter; material expansion happens later per order surface.
        local forge_tool = function(d)
            local ok, keep = pcall(function()
                return not d.flags.NO_DEFAULT_JOB and (d.flags.HARD_MAT or d.flags.METAL_MAT)
            end)
            return ok and keep
        end
        enum_entity_defs(defs, 'Tools', 13, 'forge', df.job_type.MakeTool,
            df.item_type.TOOL, R.tool_type, IT.tools, METALBAR_REAGENT, forge_tool)
        for _, j in ipairs(FORGE_STATIC) do defs[#defs + 1] = j end
    elseif is_carpenter then
        -- B260: WS-CARPENTERS-native-{1,2,3}of3.png. getJobs gives 21 rows; native has 36 leaves.
        -- FURNITURE tools only (see the tool-split block above) -- this REMOVES the wooden jug / pot /
        -- hive / nest box / die / scroll rollers / book binding rows we were wrongly offering.
        enum_entity_defs(defs, 'Tools', 13, 'Make wooden', df.job_type.MakeTool,
            df.item_type.TOOL, R.tool_type, IT.tools, WOODLOG_REAGENT, carpenter_tool, 'wood')
        -- shields + bucklers ("Make wooden shield" / "Make wooden buckler") -- absent entirely before.
        enum_entity_defs(defs, 'Armor', 12, 'Make wooden', df.job_type.MakeShield,
            df.item_type.SHIELD, R.shield_type, IT.shields, WOODLOG_REAGENT, nil, 'wood')
        -- training weapons. The TRAINING flag is exactly what keeps these OFF the forge (see
        -- ft_weapon_leaves, which skips it) -- the carpenter is the shop that makes them.
        local training = function(d) local ok, v = pcall(function() return d.flags.TRAINING end); return ok and v end
        enum_entity_defs(defs, 'Weapons', 10, 'Make wooden', df.job_type.MakeWeapon,
            df.item_type.WEAPON, R.weapon_type, IT.weapons, WOODLOG_REAGENT, training, 'wood')
        -- wood-capable trap components. item_trapcomp.txt's [WOOD] token selects exactly the three
        -- native shows (enormous corkscrew, menacing spike, spiked ball); the axe blade and serrated
        -- disc are METAL-only and native does NOT offer them here.
        if df.job_type.MakeTrapComponent then
            local wood_trapcomp = function(d) local ok, v = pcall(function() return d.flags.WOOD end); return ok and v end
            enum_entity_defs(defs, 'Trap components', 12, 'Make wooden', df.job_type.MakeTrapComponent,
                df.item_type.TRAPCOMP, R.trapcomp_type, IT.trapcomps, WOODLOG_REAGENT, wood_trapcomp,
                'wood', trapcomp_namer('wooden'))
        end
    elseif is_mason then
        -- WS-MASONS-native-{1,2}of2.png: getJobs' 16 Construct* rows are right, but native also has
        -- `Make rock altar / bookcase / pedestal` -- the FURNITURE + HARD_MAT tools. (getJobs models
        -- no MakeTool row for any shop.) Nothing else is missing; `construct chest` is what natively
        -- reads "Make rock coffer".
        local before = #defs
        enum_entity_defs(defs, 'Tools', 13, 'Make rock', df.job_type.MakeTool,
            df.item_type.TOOL, R.tool_type, IT.tools, STONE_REAGENT, mason_tool)
        pin_rock(defs, before + 1)
    elseif is_leatherworks then
        -- B260: WS-LEATHERWORKS-native-{1,2}of2.png. getJobs ships FIVE rows (bag, waterskin,
        -- backpack, quiver, sew image); native has 24 leaves. Everything below -- the entire armour
        -- and clothing line -- was missing. The gate is the itemdef's [LEATHER] props flag.
        enum_entity_defs(defs, 'Armor', 12, 'Make leather', df.job_type.MakeArmor,
            df.item_type.ARMOR, R.armor_type, IT.armor, LEATHER_REAGENT, is_leather_clothing, 'leather')
        enum_entity_defs(defs, 'Armor', 12, 'Make leather', df.job_type.MakeHelm,
            df.item_type.HELM, R.helm_type, IT.helms, LEATHER_REAGENT, is_leather_clothing, 'leather')
        enum_entity_defs(defs, 'Armor', 12, 'Make leather', df.job_type.MakePants,
            df.item_type.PANTS, R.pants_type, IT.pants, LEATHER_REAGENT, is_leather_clothing, 'leather')
        enum_entity_defs(defs, 'Armor', 12, 'Make leather', df.job_type.MakeGloves,
            df.item_type.GLOVES, R.gloves_type, IT.gloves, LEATHER_REAGENT, is_leather_clothing,
            'leather', pair_namer('Make', 'leather'))
        enum_entity_defs(defs, 'Armor', 12, 'Make leather', df.job_type.MakeShoes,
            df.item_type.SHOES, R.shoes_type, IT.shoes, LEATHER_REAGENT, is_leather_clothing,
            'leather', pair_namer('Make', 'leather'))
        enum_entity_defs(defs, 'Armor', 12, 'Make leather', df.job_type.MakeShield,
            df.item_type.SHIELD, R.shield_type, IT.shields, LEATHER_REAGENT, nil, 'leather')
    elseif is_siege then
        -- D1 (parity review). WS-SIEGE-native-{1,2}of2.png -- 21 rows, and we shipped dfhack's 4
        -- generic ones. Native:
        --   * `Assemble <material> ballista arrow`, ONE ROW PER MATERIAL. The capture's 18 are
        --     adamantine / bismuth bronze / bronze / copper / iron / silver / steel (the seven vanilla
        --     metals whose raws carry [ITEMS_AMMO] -- verified against inorganic_metal.txt), the ten
        --     worldgen-named divine metals (same flag, generated names, which is why they must be read
        --     from the live raws vector and not a list), and `wooden` (WOOD_TEMPLATE carries ITEMS_AMMO
        --     too, and DF offers wood as ONE generic row, not per tree species).
        --   * `Make bolt thrower parts` -- ConstructBoltThrowerParts, df.job.xml:1432. dfhack's table
        --     simply omits it; it is one plain_job away, exactly like the Quern's `Mill plants`.
        --   * `Make ballista parts` + `Make catapult parts` -- dfhack HAS these two (as ConstructBallista/
        --     CatapultParts); they are re-authored here so the whole shop comes from one place.
        --   * NO `assemble tipped ballista arrow` row. dfhack has one; native does not. AUTHORED_SHOPS
        --     drops it. The "tipped" distinction is not a row -- it is the MATERIAL: a metal ballista
        --     arrow IS the tipped one (wood shaft + a metal BALLISTAARROWHEAD), which is why the metal
        --     rows carry the arrowhead reagent and the wooden row does not.
        -- Per-material expansion is NOT new machinery: it is exactly forge_metals() at the forge, and the
        -- earlier claim that it is "NOT-VERIFIED offline" does not hold -- the metal NAMES come from the
        -- same raws vector the forge already trusts, and the capture confirms all seven vanilla names.
        -- Labels are label_locked: composed from the raws metal name + the itemdef's own name, which is
        -- what native prints, and which the job probe cannot reproduce from job_fields alone.
        local WOOD_ITEM = { item_type = df.item_type.WOOD }
        local n_sa = pcall(function() return #R.siegeammo_type end) and #R.siegeammo_type or 0
        local n_it = pcall(function() return #IT.siege_ammo end) and #IT.siege_ammo or 0
        for i = 0, n_sa - 1 do
            local sub = R.siegeammo_type[i]
            if sub and sub >= 0 and sub < n_it then
                local sdef = IT.siege_ammo[sub]
                local nm = nil
                pcall(function() nm = sdef.name end)
                if type(nm) == 'string' and #nm > 0 then
                    local jf_base = { job_type = df.job_type.AssembleSiegeAmmo,
                                      item_type = df.item_type.SIEGEAMMO, item_subtype = sub }
                    -- wooden: a plain wooden shaft, no head. material_category (not a pinned mat) --
                    -- DF offers "wooden", never "oaken"/"pine".
                    defs[#defs + 1] = {
                        name = 'Assemble wooden ' .. nm, label_locked = true,
                        group = 'Common', pri = 0,   -- ORDERING LAW: one alpha block, no buckets
                        job_fields = { job_type = jf_base.job_type, item_type = jf_base.item_type,
                                       item_subtype = sub, material_category = 'wood' },
                        items = { WOOD_ITEM },
                    }
                    -- one row per ammo-capable metal: wood shaft + a BALLISTAARROWHEAD of that metal.
                    for _, m in ipairs(ammo_metals()) do
                        defs[#defs + 1] = {
                            name = 'Assemble ' .. m.name .. ' ' .. nm, label_locked = true,
                            group = 'Common', pri = 0,
                            job_fields = { job_type = jf_base.job_type, item_type = jf_base.item_type,
                                           item_subtype = sub, mat_type = m.mt, mat_index = m.mi },
                            items = { WOOD_ITEM,
                                { item_type = df.item_type.BALLISTAARROWHEAD, mat_type = m.mt, mat_index = m.mi } },
                        }
                    end
                end
            end
        end
        defs[#defs + 1] = { name = 'Make ballista parts', label_locked = true, group = 'Common', pri = 0,
            job_fields = { job_type = df.job_type.ConstructBallistaParts }, items = { WOOD_ITEM } }
        defs[#defs + 1] = { name = 'Make bolt thrower parts', label_locked = true, group = 'Common', pri = 0,
            job_fields = { job_type = df.job_type.ConstructBoltThrowerParts }, items = { WOOD_ITEM } }
        defs[#defs + 1] = { name = 'Make catapult parts', label_locked = true, group = 'Common', pri = 0,
            job_fields = { job_type = df.job_type.ConstructCatapultParts }, items = { WOOD_ITEM } }
    elseif is_bowyer then
        -- B255: the bowyer makes RANGED WEAPONS ONLY (entity-permitted, ranged_ammo set), in BONE or
        -- WOOD -- "Make bone crossbow" / "Make wooden crossbow". NO AMMO (see the B255 block above);
        -- the old ammo row here is what put "make bolts" on a shop that cannot make them.
        -- Metal crossbows are forged at the two forges (already covered by the forge weapon leaves).
        local ranged = function(d) local ok, a = pcall(function() return d.ranged_ammo end); return ok and type(a) == 'string' and #a > 0 end
        enum_entity_defs(defs, 'Weapons', 10, 'Make bone',   df.job_type.MakeWeapon, df.item_type.WEAPON, R.weapon_type, IT.weapons, BONE_REAGENT,    ranged, 'bone')
        enum_entity_defs(defs, 'Weapons', 10, 'Make wooden', df.job_type.MakeWeapon, df.item_type.WEAPON, R.weapon_type, IT.weapons, WOODLOG_REAGENT, ranged, 'wood')
    elseif is_craftsdwarf then
        -- B255: bolts live HERE (wood + bone), not at the bowyer. Entity-derived so a modded ammo
        -- type (arrows, blowdarts) rides along exactly as DF's own entity-scoped menu does.
        ammo_shop_defs(defs, 'Ammo', 11, 'wooden', 'wood', WOODLOG_REAGENT)
        ammo_shop_defs(defs, 'Ammo', 11, 'bone',   'bone', BONE_REAGENT)
    elseif is_clothier then
        -- WS-CLOTHIERS-native-top.png + -CLOTH/-SILK/-YARN: the clothier's shape was wrong, not just
        -- its rows. Native's top level is THREE submenu rows (cloth / silk / yarn, each "(opens
        -- menu)"), and each submenu holds the SAME 16 rows in that material. We served one flat
        -- "sew <item>" list against a generic CLOTH reagent: no silk/yarn split at all, no bag, no
        -- rope, no Sew-image row, and a verb DF does not use.
        -- The row gate is the [SOFT] props flag (socks are SOFT-only -- which is exactly why they
        -- appear here and NOT in the leather list).
        for _, m in ipairs(CLOTHIER_MATS) do
            local V = 'Make ' .. m.word
            enum_entity_defs(defs, 'Clothing', 10, V, df.job_type.MakeArmor,
                df.item_type.ARMOR, R.armor_type, IT.armor, m.reagent, is_soft_clothing, m.cat)
            enum_entity_defs(defs, 'Clothing', 10, V, df.job_type.MakeHelm,
                df.item_type.HELM, R.helm_type, IT.helms, m.reagent, is_soft_clothing, m.cat)
            enum_entity_defs(defs, 'Clothing', 10, V, df.job_type.MakePants,
                df.item_type.PANTS, R.pants_type, IT.pants, m.reagent, is_soft_clothing, m.cat)
            enum_entity_defs(defs, 'Clothing', 10, V, df.job_type.MakeGloves,
                df.item_type.GLOVES, R.gloves_type, IT.gloves, m.reagent, is_soft_clothing, m.cat,
                pair_namer('Make', m.word))
            enum_entity_defs(defs, 'Clothing', 10, V, df.job_type.MakeShoes,
                df.item_type.SHOES, R.shoes_type, IT.shoes, m.reagent, is_soft_clothing, m.cat,
                pair_namer('Make', m.word))
            -- the three non-armor rows every submenu carries (bag = a CHEST job, rope = a CHAIN job)
            defs[#defs + 1] = { name = V .. ' bag', group = 'Clothing', pri = 10,
                job_fields = { job_type = df.job_type.ConstructChest, material_category = m.cat },
                items = { m.reagent } }
            defs[#defs + 1] = { name = V .. ' rope', group = 'Clothing', pri = 10,
                job_fields = { job_type = df.job_type.MakeChain, material_category = m.cat },
                items = { m.reagent } }
            defs[#defs + 1] = { name = 'Sew ' .. m.word .. ' image', group = 'Clothing', pri = 10,
                job_fields = { job_type = df.job_type.SewImage, material_category = m.cat },
                items = { { item_type = -1, flags1 = { empty = true }, flags2 = { sewn_imageless = true } }, m.reagent } }
        end
    end
    return defs
end

-- Fortress mode must never offer adventure-mode crafting reactions. dfhack.workshops.getJobs
-- enumerates them anyway (e.g. vanilla reaction_adv_carpenter.txt's MAKE WOODEN DOOR, whose
-- PRESERVE_REAGENT+HAS_EDGE tool reagent no fort job can satisfy -- DF queues it then cancels
-- "needs edged log"); DF's own fort UI filters on ADVENTURE_MODE_ENABLED, so we do too.
local adv_reaction_codes
function is_adventure_reaction(code)
    if not code or #code == 0 then return false end
    if not adv_reaction_codes then
        local built = {}
        local ok = pcall(function()
            local world = df.global.world
            local rs = world and world.raws and world.raws.reactions and world.raws.reactions.reactions
            if not rs then error('no reactions') end
            for i = 0, #rs - 1 do
                local rx = rs[i]
                if rx and rx.flags and rx.flags.ADVENTURE_MODE_ENABLED and rx.code then
                    built[rx.code] = true
                end
            end
        end)
        if not ok then return false end
        adv_reaction_codes = built
    end
    return adv_reaction_codes[code] == true
end

-- ===== B22/B21: material-resolved work-order catalog =========================================
-- The "New work order" picker must mirror DF's create-work-order list: every entry is a
-- FULLY-SPECIFIED order DF's own manager could produce (a job PLUS a legal material), never a
-- bare job DF would name "unknown material X" (B22's poison). The material is encoded straight
-- into the order key so nothing on the C++/route layer changes:
--     'j:<Job>'                     -- job that needs no material (reaction/meal/mill/...)
--     'j:<Job>|cat:<category>'      -- any-of-category material (wood/cloth/leather/...), a
--                                      material_category bit
--     'j:<Job>|mat:<matType>:<idx>' -- one specific material (a forge metal, a glass type, rock)
-- create_order() parses the suffix and applies it, and REJECTS anything DF would still call
-- "unknown material" (defence-in-depth: a raw curl POST cannot make an illegal order either).
-- Per-metal expansion of forge jobs is what gives B21 its "forge iron cage" rows to find.

-- material_category bit -> the adjective DF puts in the order name (for our composed labels).
local MATCAT_ADJ = {
    wood = 'wooden', plant = 'plant', cloth = 'cloth', silk = 'silk', leather = 'leather',
    bone = 'bone', shell = 'shell', tooth = 'ivory/tooth', horn = 'horn', pearl = 'pearl',
    yarn = 'yarn', soap = 'soap',
}

-- "make cage" + "wooden" -> "make wooden cage" (adjective after the leading verb).
function name_with_adj(name, adj)
    name = tostring(name or '')
    if adj == nil or adj == '' then return name end
    local verb, rest = name:match('^(%S+)%s+(.+)$')
    if verb then return verb .. ' ' .. adj .. ' ' .. rest end
    return adj .. ' ' .. name
end

-- Forge metals = every IS_METAL inorganic in the raws (mat_type INORGANIC=0, mat_index = the
-- inorganic index), mirroring DF's forge menu, which offers ALL forge-able metals regardless of
-- whether a bar is on hand (queueing an unavailable metal just waits/cancels -- an availability
-- tint is a separate follow-up). Bounded (~few dozen), name = the metal's solid state name
-- ("iron", "steel"). Fully nil/bounds-guarded (a malformed raw is skipped, never raises).
function forge_metals()
    local out = {}
    pcall(function()
        local inorg = df.global.world.raws.inorganics
        local INORGANIC = df.builtin_mats and df.builtin_mats.INORGANIC or 0
        for i = 0, #inorg.all - 1 do
            local m = inorg.all[i]
            local flags = m and m.material and m.material.flags
            if flags and flags.IS_METAL then
                local nm = ''
                local okn, s = pcall(function() return m.material.state_name.Solid end)
                if okn and s and #s > 0 then nm = s end
                out[#out + 1] = { mt = INORGANIC, mi = i, name = (nm ~= '' and nm) or ('metal ' .. i) }
            end
        end
    end)
    table.sort(out, function(a, b) return (a.name or '') < (b.name or '') end)
    return out
end

-- D1: the siege workshop's per-material ballista-arrow rows. NOT every forge metal -- only the metals
-- whose material carries ITEMS_AMMO (df.d_basics.xml's material_flags). In vanilla that is exactly
-- iron / silver / copper / bronze / bismuth bronze / steel / adamantine (read off inorganic_metal.txt:
-- gold, platinum, nickel, lead, tin, zinc, brass, electrum, pewter, aluminum, billon, sterling silver,
-- black bronze, rose gold, nickel silver and pig iron all lack it) -- and those seven are EXACTLY the
-- named metals in WS-SIEGE-native-1of2.png. The rest of that capture's rows are the worldgen-named
-- divine metals ("clear blue metal", "twinkling metal", ...), which carry the same flag and are read
-- from the live raws vector like any other metal. Same guard discipline as forge_metals.
function ammo_metals()
    local out = {}
    for _, m in ipairs(forge_metals()) do
        local ok, ammo = pcall(function()
            return df.global.world.raws.inorganics.all[m.mi].material.flags.ITEMS_AMMO
        end)
        if ok and ammo then out[#out + 1] = m end
    end
    return out
end

-- Derive the material requirement of a job def from its job_fields / reagents. Returns nil when
-- the order is legal WITH NO material (reactions, meals, mill/process, or a reagent that already
-- pins a specific builtin material); otherwise a spec:
--   {mode='cat',   cat='wood'}           any-of-category (material_category bit)
--   {mode='mat',   mt=0, mi=-1, adj=..}  one specific material (rock = INORGANIC/any)
--   {mode='metal'}                       forge metal -> expand per on-hand metal
--   {mode='subtype'}                     needs a specific itemdef -> NOT offered on the manager
--                                        menu (would need the 2-D item x material drill-down;
--                                        those are queued from the workshop Tasks tab instead)
-- Item types that carry an itemdef SUBTYPE (a manager order for these needs the specific def, and
-- DF's namer HARD-CRASHES on an unset subtype -- the B22 crash class). Data-driven so ANY job whose
-- df.job_type.attrs[].item is one of these is caught, not just a hand-list (e.g. MakeToy->TOY,
-- MakeInstrument->INSTRUMENT are covered even though only MakeWeapon was the observed crasher).
local SUBTYPE_ITEM_TYPES = {}
for _, itn in ipairs({ 'WEAPON', 'AMMO', 'ARMOR', 'HELM', 'GLOVES', 'SHOES', 'PANTS', 'SHIELD',
                       'TRAPCOMP', 'TOOL', 'INSTRUMENT', 'SIEGEAMMO', 'TOY' }) do
    local v = df.item_type[itn]
    if v ~= nil then SUBTYPE_ITEM_TYPES[v] = true end
end
function job_is_subtype_bearing(job_type_val)
    if job_type_val == nil then return false end
    local attr = df.job_type.attrs[job_type_val]
    local produced = attr and attr.item
    return produced ~= nil and SUBTYPE_ITEM_TYPES[produced] == true
end

function derive_order_material(def)
    local jf = def.job_fields or {}
    -- CustomReaction: the material comes from the reaction definition, never a manager choice.
    if jf.job_type == df.job_type.CustomReaction or (jf.reaction_name and #jf.reaction_name > 0) then
        return nil
    end
    -- A subtype-bearing product is legal only when the def pins the subtype. The explicit subtype
    -- itself rides in the order key (order_item_suffix below); keep deriving its MATERIAL here.
    -- A bare subtype job (e.g. MakeToy with no particular toy) remains excluded because DF's
    -- manager-order namer crashes when asked to name it.
    if job_is_subtype_bearing(jf.job_type) and
       (jf.item_subtype == nil or jf.item_subtype < 0) then return { mode = 'subtype' } end
    if jf.material_category then return { mode = 'cat', cat = tostring(jf.material_category) } end
    -- D8: a def that pins a SPECIFIC material (mat_type PLUS a real mat_index) already IS its material
    -- choice. The siege workshop's per-metal rows carry mat_type = INORGANIC (0) + the metal's
    -- inorganic index; without this branch the bare `mat_type == 0` rock test below swallowed all 18
    -- of them into ONE key (`|mat:0:-1`) with the label "... (rock)", so 17 rows deduped away and the
    -- survivor ordered the wrong thing. No adjective: these labels are capture-locked and already
    -- name their metal.
    if jf.mat_type ~= nil and jf.mat_type >= 0 and jf.mat_index ~= nil and jf.mat_index >= 0 then
        return { mode = 'mat', mt = jf.mat_type, mi = jf.mat_index }
    end
    if jf.mat_type == 0 then return { mode = 'mat', mt = 0, mi = -1, adj = 'rock' } end
    if jf.job_type == df.job_type.PrepareMeal then return nil end  -- ingredient count, not material
    local items = def.items or {}
    for _, r in ipairs(items) do
        if r.mat_type ~= nil and r.mat_type > 0 then return nil end  -- reagent pins a builtin material
    end
    for _, r in ipairs(items) do
        local it, vid = r.item_type, r.vector_id
        if it == df.item_type.WOOD or vid == df.job_item_vector_id.WOOD then return { mode = 'cat', cat = 'wood' } end
        if it == df.item_type.BAR and r.flags3 and r.flags3.metal then return { mode = 'metal' } end
        if it == df.item_type.BOULDER or vid == df.job_item_vector_id.BOULDER then return { mode = 'mat', mt = 0, mi = -1, adj = 'rock' } end
        if it == df.item_type.SKIN_TANNED then return { mode = 'cat', cat = 'leather' } end
        if it == df.item_type.CLOTH then return { mode = 'cat', cat = 'cloth' } end
        if r.flags2 and r.flags2.bone then return { mode = 'cat', cat = 'bone' } end
        if r.flags2 and r.flags2.shell then return { mode = 'cat', cat = 'shell' } end
        if r.flags2 and r.flags2.totemable then return nil end  -- MakeTotem names itself
    end
    return nil
end

-- Encode the product discriminator needed by subtype-bearing manager orders. manager_order has
-- real item_type/item_subtype fields (DFHack 53.15-r1 manager_order.h); omitting them was why the
-- first B155 fix could queue a direct carpenter task but not a shop/general work order.
function order_item_suffix(def)
    local jf = def.job_fields or {}
    if jf.item_subtype == nil or jf.item_subtype < 0 then return '' end
    local item_type = jf.item_type
    if item_type == nil and jf.job_type ~= nil then
        local attr = df.job_type.attrs[jf.job_type]
        item_type = attr and attr.item or nil
    end
    local item_name = item_type ~= nil and df.item_type[item_type] or nil
    if not item_name then return nil end
    return '|it:' .. item_name .. '|st:' .. tostring(jf.item_subtype)
end

function forge_tool_metal(m)
    local ok, yes = pcall(function()
        return df.global.world.raws.inorganics.all[m.mi].material.flags.ITEMS_HARD
    end)
    return ok and yes
end

-- D8 -- THE TWO ORDER SURFACES ARE THE THIRD CONSUMER OF THE JOB TABLES, AND D1 EMPTIED THE SIEGE.
--
-- Subtype-bearing job types the ORDER surfaces (workshop "Add shop work order" + the fort-wide
-- manager catalog) accept. B155 opened MakeTool; D8 opens AssembleSiegeAmmo, because D1 re-authored
-- the siege workshop as 18 subtype-bearing `Assemble <metal> ballista arrow` defs (item_type
-- SIEGEAMMO + the itemdef index) -- and a MakeTool-only gate silently DELETED all 18 from both
-- surfaces. Before D1 the player could order `assemble balista arrow` (dfhack's generic row); after
-- it, nothing. The subtype rides in the key (order_item_suffix) and create_order validates the
-- itemdef exists, which is what B22's crash class actually required.
-- Every OTHER subtype family (weapons, armor, clothing, ammo) stays excluded -- see the report:
-- the Bowyer's and Clothier's catalogs are empty for that reason and always have been.
ORDER_SUBTYPE_JOBS = {}
ORDER_SUBTYPE_JOBS[df.job_type.MakeTool] = true            -- B155
ORDER_SUBTYPE_JOBS[df.job_type.AssembleSiegeAmmo] = true   -- D8
-- B284: bolts (MakeAmmo, item_type AMMO + the ammo itemdef index) are a subtype-bearing job just like
-- MakeTool/AssembleSiegeAmmo, and they ARE orderable in native DF -- wooden + bone at the craftsdwarf,
-- per-metal at the forge. They were silently absent from both order surfaces (and so from the picker's
-- "Find a task" search) because MakeAmmo was never opened here. The subtype rides in the key
-- (order_item_suffix -> |it:AMMO|st:<sub>) and the material in |cat:wood/bone or |mat:0:<metal>;
-- create_order validates the itemdef + probes DF's namer, exactly as it does for the siege rows.
ORDER_SUBTYPE_JOBS[df.job_type.MakeAmmo] = true            -- B284

-- Jobs that are real workshop TASKS but can never be manager/work ORDERS: they need a selection the
-- order key cannot carry. EngraveSlab needs a specific dead historical figure
-- (manager_order.specdata.hist_figure_id -- see queue_memorial_slab); an EngraveSlab order without
-- one is a nonsense order, so the mason's row 1 is served as a task and withheld from both order
-- surfaces. (df.job.xml:1242 gives EngraveSlab no `item` attr, so job_is_subtype_bearing does NOT
-- catch it -- it needs its own exclusion.)
ORDER_EXCLUDED_JOBS = {}
ORDER_EXCLUDED_JOBS[df.job_type.EngraveSlab] = true

-- Expand a job def into 1+ picker entries with the material encoded in the key. base_key = 'j:'/'r:'.
function expand_order_entries(def, base_key, metals)
    local name = tostring(def.name or base_key)
    local jf = def.job_fields or {}
    if jf.job_type ~= nil and ORDER_EXCLUDED_JOBS[jf.job_type] then return {} end
    local item_suffix = order_item_suffix(def)
    if item_suffix == nil then return {} end
    if item_suffix ~= '' and not ORDER_SUBTYPE_JOBS[jf.job_type] then return {} end
    -- A capture-transcribed label already NAMES its material ("Assemble bismuth bronze ballista
    -- arrow", "Make wooden crossbow"). Re-applying the derived adjective would print it twice
    -- ("Assemble wooden wooden ballista arrow"), so a locked label is used verbatim -- the same rule
    -- native_flat_task_label applies to the Tasks tab.
    local function labelled(adj)
        if def.label_locked then return name end
        return name_with_adj(name, adj)
    end
    base_key = base_key .. item_suffix
    local spec = derive_order_material(def)
    if spec == nil then
        return { { key = base_key, label = name } }
    elseif spec.mode == 'subtype' then
        return {}
    elseif spec.mode == 'cat' then
        return { { key = base_key .. '|cat:' .. spec.cat, label = labelled(MATCAT_ADJ[spec.cat]) } }
    elseif spec.mode == 'mat' then
        return { { key = base_key .. '|mat:' .. spec.mt .. ':' .. spec.mi, label = labelled(spec.adj) } }
    elseif spec.mode == 'metal' then
        local out = {}
        local noun = name:gsub('^forge%s+', ''):gsub('^make%s+', '')
        for _, m in ipairs(metals or {}) do
            -- Native's forge tool branch is under ITEMS_HARD metals. Keep the manager catalog on
            -- the same material set; other metal jobs retain their existing expansion behavior.
            if jf.job_type ~= df.job_type.MakeTool or forge_tool_metal(m) then
                out[#out + 1] = { key = base_key .. '|mat:' .. m.mt .. ':' .. m.mi,
                                  label = 'forge ' .. m.name .. ' ' .. noun }
            end
        end
        return out
    end
    return { { key = base_key, label = name } }
end

-- Shared legal-order projection used by BOTH order-creation surfaces: the workshop's "Add shop
-- work order" picker and the fort-wide Work orders manager. This is intentionally downstream of
-- shop_job_defs/dynamic_shop_jobs so labels, subtype pins, material pins, and exclusions cannot
-- drift between the two surfaces again.
function order_entries_for_defs(defs, metals)
    local items, seen = {}, {}
    for _, def in pairs(defs or {}) do
        local jf = def.job_fields or {}
        local base_key
        if jf.reaction_name and #jf.reaction_name > 0 then
            base_key = 'r:' .. jf.reaction_name
        elseif jf.job_type then
            local jn = df.job_type[jf.job_type]
            if jn then base_key = 'j:' .. jn end
        end
        if base_key then
            for _, e in ipairs(expand_order_entries(def, base_key, metals)) do
                if not seen[e.key] then
                    seen[e.key] = true
                    items[#items + 1] = e
                end
            end
        end
    end
    table.sort(items, function(a, b)
        if a.label == b.label then return a.key < b.key end
        return a.label < b.label
    end)
    return items
end

-- Shared per-shop projection (B261): the exact def set + order gates order_catalog_by_shop applies,
-- for one SHOP_CATALOG_SPECS entry. Extracted so BOTH the by-shop picker (/order-catalog-shops) and
-- the fort-wide catalog (/order-catalog) derive their orderable rows from ONE place -- they can never
-- drift into two hand lists again (the B255/B261 drift class). Returns the projected picker entries
-- ({key,label}), or {} if this build lacks the building type. `wo` is dfhack.workshops or nil.
function order_spec_entries(spec, wo, metals)
    local btype = df.building_type[spec[1]]
    local subtype = (spec[1] == 'Workshop') and df.workshop_type[spec[2]] or df.furnace_type[spec[2]]
    if not (btype and subtype) then return {} end
    local defs = {}
    if wo then
        local okj, jobs = pcall(wo.getJobs, btype, subtype, -1)
        if okj and jobs then
            for _, def in pairs(jobs) do
                if type(def) == 'table' and
                   not is_adventure_reaction(def.job_fields and def.job_fields.reaction_name) and
                   getjobs_def_allowed(spec[2], def) then
                    defs[#defs + 1] = def
                end
            end
        end
    end
    local extra = EXTRA_SHOP_JOBS[spec[2]]
    if extra then for _, def in ipairs(extra) do defs[#defs + 1] = def end end
    if spec[2] == 'MetalsmithsForge' or spec[2] == 'MagmaForge' then
        for _, def in ipairs(FORGE_STATIC) do defs[#defs + 1] = def end
    end
    -- B155 reopen: getJobs omits entity-derived weapons/armor/tools. Pull the same dynamic defs the
    -- workshop Tasks surface uses -- MakeTool for everyone (B155); D8: an AUTHORED shop's WHOLE dynamic
    -- arm IS its list, because its hand-written getJobs table was dropped by getjobs_def_allowed. At
    -- the Siege that list (AssembleSiegeAmmo / Construct*Parts, transcribed from the captures) is built
    -- in dynamic_shop_jobs; a MakeTool-only rule would leave defs EMPTY and drop the group entirely.
    -- B284: admit any subtype-bearing dynamic def whose job the ORDER surfaces accept (ORDER_SUBTYPE_JOBS
    -- -- MakeTool per B155, AssembleSiegeAmmo per D8, MakeAmmo per B284) rather than hard-coding MakeTool
    -- here. This keeps the dynamic-arm admission gate and the expand_order_entries subtype gate reading
    -- the ONE list, so opening a new subtype family (bolts) can never again pass one gate but not the
    -- other. AssembleSiegeAmmo only ever appears in the (authored) Siege arm, so the sole new admission
    -- is the forge's + craftsdwarf's MakeAmmo (bolts); weapons/armor stay excluded as before.
    local dynamic = dynamic_shop_jobs(spec[2])
    if dynamic then
        for _, def in ipairs(dynamic) do
            local jt = (def.job_fields or {}).job_type
            if AUTHORED_SHOPS[spec[2]] or (jt ~= nil and ORDER_SUBTYPE_JOBS[jt]) then
                defs[#defs + 1] = def
            end
        end
    end
    return order_entries_for_defs(defs, metals)
end

-- DF-style catalog grouped by WORKSHOP (served /order-catalog-shops). Sources the SAME rich per-shop
-- job set the workshop Tasks tab uses (dfhack getJobs + EXTRA_SHOP_JOBS + forge statics + dynamic
-- entity defs), with per-material expansion, so the picker offers only legal orders (B22) and carries
-- the per-metal rows B21 needs. All of that now lives in order_spec_entries.
function order_catalog_by_shop()
    local ok_wo, wo = pcall(require, 'dfhack.workshops')
    if not ok_wo then wo = nil end
    local metals = forge_metals()
    local groups = {}
    for _, spec in ipairs(SHOP_CATALOG_SPECS) do
        local items = order_spec_entries(spec, wo, metals)
        if #items > 0 then
            local ij = {}
            for _, it in ipairs(items) do
                ij[#ij + 1] = '{"key":' .. json_string(it.key) .. ',"label":' .. json_string(it.label) .. '}'
            end
            groups[#groups + 1] = '{"shop":' .. json_string(spec[3]) ..
                ',"icon":' .. json_string(spec[4]) ..
                ',"items":[' .. table.concat(ij, ',') .. ']}'
        end
    end
    return '{"ok":true,"shops":[' .. table.concat(groups, ',') .. ']}\n'
end

-- Fort-wide "add a work order" catalog (served /order-catalog). B261: DERIVES from the same
-- order_spec_entries projection as the by-shop picker -- ONE source of truth, no parallel hand list.
-- Grouped by shop (the shop's display label is the category); an order offered at several stations is
-- de-duplicated by key so it appears once. This is why the material-less `Ammo` row and the missing
-- MilkCreature/ShearCreature/ProcessPlantsVial/Siege rows are gone: they can no longer be typed by
-- hand out of sync with the shop definitions.
function order_catalog()
    local ok_wo, wo = pcall(require, 'dfhack.workshops')
    if not ok_wo then wo = nil end
    local metals = forge_metals()
    local cats, seen = {}, {}
    for _, spec in ipairs(SHOP_CATALOG_SPECS) do
        local items = {}
        for _, it in ipairs(order_spec_entries(spec, wo, metals)) do
            if not seen[it.key] then
                seen[it.key] = true
                items[#items + 1] = '{"key":' .. json_string(it.key) ..
                    ',"label":' .. json_string(it.label) .. '}'
            end
        end
        if #items > 0 then
            cats[#cats + 1] = '{"cat":' .. json_string(spec[3]) ..
                ',"items":[' .. table.concat(items, ',') .. ']}'
        end
    end
    return '{"ok":true,"catalog":[' .. table.concat(cats, ',') .. ']}\n'
end

-- Merged job-def table for a workshop/furnace: dfhack.workshops.getJobs (the raws reactions +
-- whatever hardcoded jobs dfhack ships) PLUS our EXTRA_SHOP_JOBS supplement. Keyed by string so
-- both shop_tasks (display) and workshop_add_job (queue) resolve the SAME def from one key.
function shop_job_defs(b)
    local defs = {}
    local shop_key = shop_subtype_key(b)
    local ok, jobs = pcall(function()
        return require('dfhack.workshops').getJobs(b:getType(), b:getSubtype(), b:getCustomType())
    end)
    if ok and jobs then
        for k, def in pairs(jobs) do
            if type(def) == 'table' and
                not is_adventure_reaction(def.job_fields and def.job_fields.reaction_name) and
                getjobs_def_allowed(shop_key, def) then
                defs[tostring(k)] = def
            end
        end
    end
    local extra = EXTRA_SHOP_JOBS[shop_key]
    if extra then
        for i, def in ipairs(extra) do defs['x' .. i] = def end
    end
    -- B01-residue: per-fort forge/carpenter/bowyer/clothier jobs (stable 'd<i>' keys -- the enumeration order
    -- is deterministic, so the display pass and a later queue pass resolve the SAME def per key).
    local dyn = dynamic_shop_jobs(b)
    if dyn then
        for i, def in ipairs(dyn) do defs['d' .. i] = def end
    end
    return defs
end

-- Classify a task into the DF-style group the client renders as a header + sorts by, so the
-- common jobs sit at the top and the procedural instrument reactions don't bury them.
function task_group(job_type, reaction)
    if job_type == df.job_type.CustomReaction then
        -- Procedural reactions sit BELOW the hardcoded common jobs AND below the B01-residue forge/
        -- bowyer/clothier categories (pris 10-14), so the useful jobs never get buried again.
        if reaction and reaction:match('^MAKE_ENT') then return 'Instruments', 91 end
        -- B266/ORDERING LAW: a VANILLA reaction is NOT procedural and DF does not bucket it. Every
        -- capture interleaves them alphabetically with the ordinary jobs -- the farmer's shows
        -- `Make cheese` / `Make sheet from plant` / `Milk animal` / `Process plant to bag` /
        -- `Process plants` in one list, and the ashery puts `Make milk of lime` BETWEEN `Make lye`
        -- and `Make potash from ash`. Bucketing them at pri 90 would have exiled exactly the rows
        -- B257/B258/B259 exist to surface to the bottom of the shop. B01's intent is preserved
        -- precisely: it was the PROCEDURAL MAKE_ENT instrument flood that buried the useful jobs,
        -- and that flood is still pinned at 91.
        return 'Common', 0
    end
    return 'Common', 0
end

-- B180 WIRELABEL_B180_NATIVE_MATERIAL_V2: dfhack.job.getName() is native's
-- interface_button_building_new_jobst::text path, but a prospective job must carry the same
-- material discriminator as the native add-task button. The old probe copied only job_fields;
-- flat-shop material usually lives in the reagent filter, so it produced "unknown material".
-- Resolve that reagent material with the already-shared order helper before asking native to name
-- the row. A rejected/failed native rendering falls back to the source definition, never to the
-- broken placeholder.
-- D6 (parity review): the native probe carries ONLY job_fields. Three defs that differ solely in
-- their `items` (the three Encrust-with-cut-gems rows: same job_type EncrustWithGems, different
-- encrust TARGET in the second reagent) therefore all probe to the SAME string -- native prints
-- three distinct labels, we would print one, three times. Same trap for any row whose native wording
-- is not reconstructible from job_fields alone. `def.label_locked` says: this label was TRANSCRIBED
-- FROM THE CAPTURE (or composed from raws the capture confirms, e.g. the siege metal names) -- it is
-- the oracle, so do NOT hand it to the probe. That is the wave's whole rule applied to labels.
function native_flat_task_label(def, job_type, reaction, fallback)
    fallback = tostring(fallback or def.name or df.job_type[job_type] or 'Task')
    if def.label_locked and type(def.name) == 'string' and #def.name > 0 then
        return def.name, 'capture-verbatim'
    end
    if job_type == nil then return fallback, 'definition-fallback' end

    local jf = def.job_fields or {}
    local probe = df.job:new()
    local native_name = nil
    local ok = pcall(function()
        probe.job_type = job_type
        probe.item_type = -1
        probe.item_subtype = -1
        probe.mat_type = jf.mat_type or -1
        probe.mat_index = jf.mat_index or -1
        if jf.item_type ~= nil then probe.item_type = jf.item_type end
        if jf.item_subtype ~= nil then probe.item_subtype = jf.item_subtype end
        if jf.material_category then probe.material_category[jf.material_category] = true end
        if job_type == df.job_type.CustomReaction then probe.reaction_name = reaction end

        local material = derive_order_material(def)
        if material and material.mode == 'cat' and material.cat then
            probe.material_category[material.cat] = true
        elseif material and material.mode == 'mat' then
            probe.mat_type = material.mt
            probe.mat_index = material.mi
        end
        native_name = dfhack.job.getName(probe)
    end)
    probe:delete()

    if not ok or type(native_name) ~= 'string' or #native_name == 0 or
       native_name:lower():find('unknown material', 1, true) then
        return fallback, 'definition-fallback'
    end
    return native_name, 'native-material-aware'
end

-- D3/D4 (parity review). The generated MAKE_ENT instrument reactions are NOT flat rows in ANY capture
-- -- but they are not absent either. DF collapses them into ONE container row that opens a submenu:
--   WS-CARPENTERS-native-1of3.png   row 1: `Make instrument (opens menu)`
--   WS-LEATHERWORKS-native-1of2.png row 1: `Make instrument piece (opens menu)`
-- We were suppressing the leaves at the mason/carpenter and adding NO container (so the carpenter's
-- own row 1 was simply GONE), while the leatherworks leaked every raw MAKE_ENT leaf as a flat row.
-- Both shops now suppress the leaves AND serve the container, exactly as the craftsdwarf tree does.
local CAPTURED_FLAT_SHOPS = { Masons = true, Carpenters = true, Leatherworks = true }
function shop_tasks(b, defs)
    wtrace('shop_tasks: enter type=' .. tostring(b:getType()) .. ' sub=' .. tostring(b:getSubtype()) .. ' custom=' .. tostring(b:getCustomType()))   -- DIAG
    local tasks = {}
    local suppressed = {}   -- MAKE_ENT leaves pulled out of the flat list -> the container's children
    defs = defs or shop_job_defs(b)
    local shop_key = shop_subtype_key(b)
    for key, def in pairs(defs) do
        if type(def) == 'table' then
            local job_type = def.job_fields and def.job_fields.job_type
            local job_key = job_type and df.job_type[job_type] or ''
            local reaction = def.job_fields and def.job_fields.reaction_name or ''
            -- The generated codes are 'MAKE_ENT<civ_id> <PART>' -- a SPACE, not an underscore (see
            -- parse_tree_task_key's own example, "rc:MAKE_ENT291 INP2_BODY"). The old pattern here
            -- demanded '^MAKE_ENT%d+_' and therefore matched NOTHING, so the suppression it claimed to
            -- perform never actually ran. Match the civ-id prefix and stop there.
            local generated_instrument = CAPTURED_FLAT_SHOPS[shop_key] and
                job_type == df.job_type.CustomReaction and
                type(reaction) == 'string' and reaction:match('^MAKE_ENT%d+') ~= nil
            if generated_instrument then
                suppressed[#suppressed + 1] = { key = tostring(key), reaction = reaction }
            end
            if not generated_instrument then
            local order_key = ''
            if job_type == df.job_type.CustomReaction and reaction and #reaction > 0 then
                order_key = 'r:' .. reaction
            elseif job_key and #job_key > 0 and not ORDER_EXCLUDED_JOBS[job_type] then
                order_key = 'j:' .. job_key
                local item_suffix = order_item_suffix(def)
                -- D8: the SAME subtype allow-list expand_order_entries uses. These two encoders drifted
                -- once already (B155); they must never disagree about which rows are orderable.
                if item_suffix == nil or
                   (item_suffix ~= '' and not ORDER_SUBTYPE_JOBS[job_type]) then order_key = ''
                else order_key = order_key .. item_suffix end
                -- B22: the workshop "Add shop work order" tab submits order_key to /order-create too,
                -- so it must carry a legal material or create_order rejects it. Encode the derived
                -- any-of-category / specific material (organic + rock). The legacy task row still
                -- cannot encode metal-mode; workshop_info.orderTasks supplies its per-metal rows.
                local ms = order_key ~= '' and derive_order_material(def) or nil
                if ms then
                    if ms.mode == 'cat' then order_key = order_key .. '|cat:' .. ms.cat
                    elseif ms.mode == 'mat' then order_key = order_key .. '|mat:' .. ms.mt .. ':' .. ms.mi end
                end
            end
            local group, pri = task_group(job_type, reaction)
            -- B01-residue: a def may carry its own category (Weapons/Armor/Furniture/...) + sort pri.
            if def.group then group = tostring(def.group) end
            if def.pri ~= nil then pri = def.pri end
            local native_name, label_source = native_flat_task_label(def, job_type, reaction,
                def.name or job_key or key)
            local needs_unit = job_type == df.job_type.EngraveSlab
            -- D7b: `Engrave memorial slab` opens the dead-unit picker, and native marks it as such --
            -- WS-MASONS-native-1of2.png reads `Engrave memorial slab (opens menu)`. It IS a container
            -- row; it just drills into units instead of reactions.
            if needs_unit then
                native_name = tostring(native_name) .. ' (opens menu)'
                label_source = 'capture-verbatim'
            end
            -- B274 -- THE `[Requires materials]` PLACEHOLDER AND THE INVERTED RED STATE. DELETED.
            --
            -- WS-STILL-OURS-broken-requires.png (OUR screen, not native): The owner has plants and no fruit,
            -- and we told him the exact opposite -- `Brew drink from fruit` unmarked, `Brew drink from
            -- plant` RED "[Requires materials]". Root cause, and it is one thing, not two:
            --
            -- A crude per-def IN_PLAY scan used to live right here. It walked `def.items` (job_item
            -- FILTERS), asked item_matches_filter whether any item in the fort matched, and on a miss
            -- reded the row with a hand-written reason that could only ever say "wood", "boulders",
            -- "metal bars" or the catch-all "materials". Both halves were wrong:
            --   * THE REASON was a FABRICATION. `[Requires materials]` is a string DF never prints.
            --     grep: this loop was the ONLY producer of it anywhere in the codebase.
            --   * THE TEST was a GUESS, and it could FAIL CLOSED -- mark a job the player can actually
            --     do as blocked. item_matches_filter is a strict buildingplan-era matcher; a reagent it
            --     cannot model (the Still's `barrel/pot` reagent is item_type NONE + EMPTY +
            --     FOOD_STORAGE_CONTAINER) simply never matches, so the row went red while the job was
            --     perfectly queueable. Telling the player a doable job is blocked is WORSE than saying
            --     nothing: he trusts it and never queues the job.
            --
            -- Why DELETE rather than repair: the red state is not ours to compute here. In ALL 30
            -- captures, EVERY red row is a raws REACTION -- one that carries real, checkable reagents
            -- -- and NOT ONE hardcoded-job row is red in any capture. B265 built the accurate engine for
            -- exactly that: annotate_flat_avail (called by workshop_info right after us) recomputes a
            -- reaction row's state from the reaction's OWN reagents with DF's own requirement grammar.
            -- The Still is a reaction shop (dfhack's getJobs has no Still table at all -- all three rows
            -- are BREW_DRINK_FROM_PLANT / _GROWTH / MAKE_MEAD from reaction_other.txt), so it is that
            -- engine, not this loop, that must speak for it.
            --
            -- The rule is the same one this whole wave enforces, applied to STATE instead of ROWS: do
            -- not invent a red row that is not in a capture. A job row is white unless a capture proves
            -- otherwise. The remaining direction of error is fail-OPEN (white where DF might red), which
            -- never hides a job the player can queue -- see reagent_present's own note.
            --
            -- Bonus: this loop was O(defs x reagents x IN_PLAY) under the request's CoreSuspender, on
            -- every workshop open. It is gone.
            local avail, objection = true, ''
            table.insert(tasks, {
                key = tostring(key),
                name = tostring(native_name or def.name or job_key or key),
                job = job_key,
                reaction = tostring(reaction or ''),
                order_key = order_key,
                group = group,
                pri = pri,
                label_source = label_source,
                needs_unit_selection = needs_unit,
                avail = avail,
                objection = objection,
            })
            end
        end
    end
    -- D3/D4: one container row per instrument category the fort's OWN civ has reactions for
    -- (flat_shop_containers applies the fort-civ prefix filter -- the flat path had none, so a FOREIGN
    -- civ's generated reactions could leak in; cd_reaction_cat and the smelter tree have always
    -- filtered). Containers lead the list: DF renders containers first, then leaves alphabetically.
    for _, c in ipairs(flat_shop_containers(b, suppressed)) do table.insert(tasks, c) end
    table.sort(tasks, function(a, b)
        if a.pri ~= b.pri then return a.pri < b.pri end
        if a.name == b.name then return a.key < b.key end
        return a.name < b.name
    end)
    return tasks
end

function shop_order_tasks(defs)
    local out = {}
    for _, entry in ipairs(order_entries_for_defs(defs, forge_metals())) do
        out[#out + 1] = {
            key = entry.key,
            name = entry.label,
            order_key = entry.key,
            group = 'Common',
            pri = 0,
        }
    end
    return out
end

function shop_jobs_json(b)
    local out = {}
    for i = 0, #b.jobs - 1 do
        local job = b.jobs[i]
        -- B286: DestroyBuilding is the workshop's REMOVAL job -- it belongs in the removal panel
        -- (markedForRemoval), never as an ordinary "Destroy Building" task row. Filtering it here makes
        -- the workshop task list fail-safe: even if the removal panel branch is not taken (e.g. a stale
        -- client bundle), the removal job never leaks into the task list as a normal task.
        if job and job.job_type ~= df.job_type.DestroyBuilding then
            table.insert(out, '{"id":' .. tostring(job.id) ..
                ',"pos":' .. tostring(i) ..
                ',"name":' .. json_string(job_label(job)) ..
                ',"jobType":' .. json_string(df.job_type[job.job_type] or '') ..
                ',"reaction":' .. json_string(job.reaction_name or '') ..
                ',"worker":' .. json_string(worker_label(job)) ..
                ',"suspended":' .. json_bool(job.flags.suspend) ..
                ',"repeat":' .. json_bool(job.flags['repeat']) ..
                ',"doNow":' .. json_bool(job.flags.do_now) ..
                ',"working":' .. json_bool(job.flags.working or job.flags.fetching or job.flags.bringing) ..
                ',"byManager":' .. json_bool(job.flags.by_manager) .. '}')
        end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function shop_tasks_json(tasks)
    local out = {}
    for _, task in ipairs(tasks) do
        -- D3/D4: a container row carries its children inline. The client renders it "(opens menu)"
        -- and drills one level; the children keep the SAME task keys, so queueing a child is the
        -- ordinary /workshop-add-job path (shop_job_defs still holds every one of those defs).
        local kids = ''
        if task.submenu and task.children then
            local ks = {}
            for _, c in ipairs(task.children) do
                ks[#ks + 1] = '{"key":' .. json_string(c.key) ..
                    ',"name":' .. json_string(c.name) ..
                    ',"reaction":' .. json_string(c.reaction or '') ..
                    ',"avail":' .. json_bool(c.avail ~= false) ..
                    ',"objection":' .. json_string(c.objection or '') .. '}'
            end
            kids = ',"submenu":true,"children":[' .. table.concat(ks, ',') .. ']'
        end
        table.insert(out, '{"key":' .. json_string(task.key) ..
            ',"name":' .. json_string(task.name) ..
            ',"job":' .. json_string(task.job) ..
            ',"reaction":' .. json_string(task.reaction) ..
            ',"group":' .. json_string(task.group or 'Common') ..
            ',"pri":' .. tostring(task.pri or 0) ..
            ',"labelSource":' .. json_string(task.label_source or '') ..
            ',"needsUnitSelection":' .. json_bool(task.needs_unit_selection or false) ..
            ',"avail":' .. json_bool(task.avail ~= false) ..
            ',"objection":' .. json_string(task.objection or '') ..
            ',"orderKey":' .. json_string(task.order_key) .. kids .. '}')
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function memorial_task_units_json()
    local out = {}
    local units = df.global.world and df.global.world.units and df.global.world.units.all
    if not units then return '[]' end
    for _, unit in ipairs(units) do
        local ok_dead, is_dead = pcall(dfhack.units.isDead, unit)
        if unit and is_dead and (unit.hist_figure_id or -1) >= 0 then
            local ok_name, name = pcall(dfhack.units.getReadableName, unit)
            out[#out + 1] = '{"unitId":' .. tostring(unit.id) ..
                ',"histFigureId":' .. tostring(unit.hist_figure_id) ..
                ',"name":' .. json_string(ok_name and name or ('Unit ' .. tostring(unit.id))) .. '}'
        end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function shop_order_tasks_json(tasks)
    local out = {}
    for _, task in ipairs(tasks) do
        out[#out + 1] = '{"key":' .. json_string(task.key) ..
            ',"name":' .. json_string(task.name) ..
            ',"group":' .. json_string(task.group or 'Common') ..
            ',"pri":' .. tostring(task.pri or 0) ..
            ',"orderKey":' .. json_string(task.order_key) .. '}'
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function shop_order_label(o)
    return order_label(o):gsub('%s+of unknown material', '')
end

function shop_orders_json(id)
    local out = {}
    local all = df.global.world and df.global.world.manager_orders and df.global.world.manager_orders.all
    if not all then return '[]' end
    for pos = 0, #all - 1 do
        local o = all[pos]
        if o and tonumber(o.workshop_id or -1) == tonumber(id) then
            table.insert(out, '{"id":' .. tostring(o.id) ..
                ',"pos":' .. tostring(pos) ..
                ',"job":' .. json_string(shop_order_label(o)) ..
                ',"amountLeft":' .. tostring(o.amount_left) ..
                ',"amountTotal":' .. tostring(o.amount_total) ..
                ',"frequency":' .. json_string(df.workquota_frequency_type[o.frequency] or 'OneTime') ..
                ',"active":' .. json_bool(o.status.active) ..
                ',"validated":' .. json_bool(o.status.validated) .. '}')
        end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function shop_items_json(b)
    local out = {}
    local seen = {}
    local function add_item(item, role)
        if not item or seen[item.id] then return end
        seen[item.id] = true
        local ok, desc = pcall(dfhack.items.getDescription, item, 0, true)
        local okf, forbid = pcall(function() return item.flags.forbid end)
        local okd, dump = pcall(function() return item.flags.dump end)
        local okh, hide = pcall(function() return item.flags.hidden end)
        local oks, sprite = pcall(function()
            return {
                item_type = df.item_type[item:getType()],
                item_subtype = item:getSubtype(),
                material_type = item:getMaterial(),
                material_index = item:getMaterialIndex(),
            }
        end)
        local sprite_json = ''
        if oks and sprite and sprite.item_type then
            sprite_json = ',"spriteRef":{"itemType":' .. json_string(sprite.item_type) ..
                ',"itemSubtype":' .. tostring(sprite.item_subtype or -1) ..
                ',"materialType":' .. tostring(sprite.material_type or -1) ..
                ',"materialIndex":' .. tostring(sprite.material_index or -1) .. '}'
        end
        table.insert(out, '{"id":' .. tostring(item.id) ..
            ',"name":' .. json_string(ok and desc or ('Item ' .. tostring(item.id))) ..
            ',"role":' .. json_string(role or '') ..
            ',"forbidden":' .. json_bool(okf and forbid or false) ..
            ',"dump":' .. json_bool(okd and dump or false) ..
            ',"hidden":' .. json_bool(okh and hide or false) .. sprite_json .. '}')
    end
    if b.contained_items then
        for _, bi in ipairs(b.contained_items) do
            if bi then
                add_item(bi.item, df.building_item_role_type[bi.use_mode] or '')
            end
        end
    end
    -- In-progress reagents/products are job-attached before they become building-contained.
    -- /workshop-info is on demand, so walking this workshop's bounded job/item vectors does not
    -- add any per-tick CoreSuspender work.
    for i = 0, #b.jobs - 1 do
        local job = b.jobs[i]
        if job then
            for _, ref in ipairs(job.items) do
                add_item(ref and ref.item, df.job_role_type[ref.role] or 'Hauled')
            end
        end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function shop_workers_json(b)
    local profile = b.profile
    if not profile then return '[]' end
    local permitted = {}
    for _, uid in ipairs(profile.permitted_workers) do
        permitted[uid] = true
    end
    local rows = {}
    local units = df.global.world and df.global.world.units and df.global.world.units.active
    if not units then return '[]' end
    for _, unit in ipairs(units) do
        if unit and not dfhack.units.isDead(unit) and dfhack.units.isCitizen(unit, true) then
            local ok_name, name = pcall(dfhack.units.getReadableName, unit)
            local ok_prof, prof = pcall(dfhack.units.getProfessionName, unit)
            local ok_color, profession_color = pcall(dfhack.units.getProfessionColor, unit)
            table.insert(rows, {
                id = unit.id,
                name = ok_name and name or ('Unit ' .. tostring(unit.id)),
                profession = ok_prof and prof or '',
                profession_color = (ok_color and profession_color) or -1,
                assigned = permitted[unit.id] or false,
            })
        end
    end
    table.sort(rows, function(a, b)
        if a.assigned ~= b.assigned then return a.assigned end
        return a.name < b.name
    end)
    local out = {}
    for _, u in ipairs(rows) do
        table.insert(out, '{"id":' .. tostring(u.id) ..
            ',"name":' .. json_string(u.name) ..
            ',"profession":' .. json_string(u.profession) ..
            ',"professionColor":' .. tostring(u.profession_color) ..
            ',"assigned":' .. json_bool(u.assigned) .. '}')
    end
    return '[' .. table.concat(out, ',') .. ']'
end

-- Run one workshop_info section under pcall so a single failing section degrades to a safe
-- fallback (empty list) instead of taking down the WHOLE panel ("Workshop data unavailable").
-- Logs the exact section + error so the root cause is still pinpointed. The CoreSuspender fix
-- makes raising/catching a Lua error here safe (full stack -> no traceback overflow).
function ws_section(label, fn, fallback)
    wtrace('workshop_info: ' .. label)
    local ok, res = pcall(fn)
    if ok and res ~= nil then return res end
    wtrace('workshop_info: ' .. label .. ' FAILED: ' .. tostring(res))
    return fallback
end

function ws_safe_str(fn, fallback)
    local ok, v = pcall(fn)
    if ok and v ~= nil then return v end
    return fallback
end

-- B13: DF shows a building's linked stockpiles (take-from / give-to) on its panel. The links live
-- on the STOCKPILE side (stockpile.links.give_to_workshop feeds this shop = we "take from" it;
-- take_from_workshop pulls our output = we "give to" it); workshops carry no link vector of their
-- own. Enumerate every stockpile and collect the ones referencing this workshop, tagged by
-- direction, so the panel mirrors DF's own linked-stockpiles section. Additive JSON, bounds-safe.
function shop_linked_stockpiles_json(b)
    local out = {}
    if not b then return '[]' end
    local all = df.global.world.buildings.other and df.global.world.buildings.other.STOCKPILE
    if not all then
        all = {}
        for _, bb in ipairs(df.global.world.buildings.all) do
            if df.building_stockpilest:is_instance(bb) then table.insert(all, bb) end
        end
    end
    local function sp_name(sp)
        local ok, n = pcall(dfhack.buildings.getName, sp)
        if ok and n and #n > 0 then return n end
        if sp.name and #sp.name > 0 then return sp.name end
        return 'Stockpile ' .. tostring(sp.id)
    end
    local function contains(vec, id)
        if not vec then return false end
        for i = 0, #vec - 1 do
            local e = vec[i]
            if e and e.id == id then return true end
        end
        return false
    end
    for _, sp in ipairs(all) do
        if sp and sp.links then
            local dir = nil
            if contains(sp.links.give_to_workshop, b.id) then dir = 'take'      -- shop takes from pile
            elseif contains(sp.links.take_from_workshop, b.id) then dir = 'give' -- shop gives to pile
            end
            if dir then
                table.insert(out, '{"id":' .. tostring(sp.id) ..
                    ',"name":' .. json_string(sp_name(sp)) ..
                    ',"dir":' .. json_string(dir) ..
                    ',"x":' .. tostring(sp.centerx or sp.x1 or 0) ..
                    ',"y":' .. tostring(sp.centery or sp.y1 or 0) ..
                    ',"z":' .. tostring(sp.z or 0) .. '}')
            end
        end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

-- ===== TRUEMENU WP-1: native forge add-task tree (category -> metal -> leaf) =================
-- Ported from tools/harness/menu_model.lua's forge_root builder (the screenshot-verified model,
-- gate_truemenu 27/27). This is the SERVER side of WP-1: workshop_info serves this nested tree as
-- `taskTree` for the two forges (flat `tasks` stays under its legacy key), and the client drills
-- category -> metal -> leaf. Every read is pcall/bounds-guarded (the MEMORY warns bounds-unsafe lua
-- crashes DF). Label composition + ordering mirror menu_model.lua EXACTLY so the served tree passes
-- the same gate; leaves carry the raw fields (job_type/item_type/item_subtype/mat/reaction/batch)
-- the client composes a `t:` task key from -- see add_tree_task below. Provenance + NOT-VERIFIED
-- surface (instrument metal filter, other-objects leaf set, siege/trap filters) are the spec's.
-- Wrapped in an IIFE: its ~35 helper locals would overflow the main chunk's 200-local cap, so they
-- stay local to this IIFE; forge_task_tree/ft_tree_json/forge_bt_st bind the predeclared exports.
local forge_task_tree, ft_tree_json, forge_bt_st
;(function()
local FTREE_INORGANIC = 0
local function ft_G(fn, fallback)
    local ok, v = pcall(fn)
    if ok then return v end
    return fallback
end
local function ft_raws() return df.global.world.raws end
local function ft_IT() return df.global.world.raws.itemdefs end

-- IS_METAL inorganics carrying a given ITEMS_* flag, in INORGANIC INDEX ORDER (DF's native metal
-- order -- never alphabetical). flagnames = array treated as a union.
local function ft_metals_with(flagnames)
    local out = {}
    local inorg = ft_G(function() return ft_raws().inorganics.all end, nil)
    if not inorg then return out end
    local n = ft_G(function() return #inorg end, 0)
    for i = 0, n - 1 do
        local m = inorg[i]
        local mf = ft_G(function() return m.material.flags end, nil)
        if mf and ft_G(function() return mf.IS_METAL end, false) then
            local hit = false
            for _, fl in ipairs(flagnames) do
                if ft_G(function() return mf[fl] end, false) then hit = true break end
            end
            if hit then
                local nm = ft_G(function() return m.material.state_name.Solid end, nil)
                out[#out + 1] = {
                    label = (nm and #nm > 0) and nm or ('metal ' .. i),
                    mat_type = FTREE_INORGANIC, mat_index = i,
                    token = ft_G(function() return m.id end, ''),
                }
            end
        end
    end
    return out
end
local function ft_metal_has(mat_index, flagname)
    return ft_G(function() return ft_raws().inorganics.all[mat_index].material.flags[flagname] end, false)
end

local function ft_compose(verb, adj, metal, noun)
    local parts = { verb }
    if adj and #adj > 0 then parts[#parts + 1] = adj end
    if metal and #metal > 0 then parts[#parts + 1] = metal end
    parts[#parts + 1] = noun
    return table.concat(parts, ' ')
end
local function ft_jt_name(jt) return df.job_type[jt] or tostring(jt) end
-- DF uppercases the first byte of a reaction's raws NAME for display (capture 28: raws
-- "forge madush case" -> native "Forge madush case"). Mirror of menu_model.lua ncap.
local function ft_cap(s)
    s = tostring(s or '')
    if #s == 0 then return s end
    local b = s:byte(1)
    if b >= 97 and b <= 122 then return string.char(b - 32) .. s:sub(2) end
    return s
end
local function ft_leaf(label, jt, itype, isub, subtok, conf, extra)
    local L = { kind = 'job', label = label, job_type = ft_jt_name(jt), confidence = conf or 'flag-derived' }
    if itype ~= nil then L.item_type = df.item_type[itype] or itype end
    if isub ~= nil then L.item_subtype = isub end
    if subtok and #subtok > 0 then L.subtype_token = subtok end
    if extra then for k, v in pairs(extra) do L[k] = v end end
    return L
end
-- Deterministic byte-wise ascii-lowered sort (matches menu_model.lua + the gate's cp437 key).
local function ft_byte_lt(a, b)
    local la, lb = #a, #b
    for i = 1, math.min(la, lb) do
        local ca, cb = a:byte(i), b:byte(i)
        if ca >= 65 and ca <= 90 then ca = ca + 32 end
        if cb >= 65 and cb <= 90 then cb = cb + 32 end
        if ca ~= cb then return ca < cb end
    end
    return la < lb
end
local function ft_alpha_sort(leaves)
    table.sort(leaves, function(a, b) return ft_byte_lt(a.label or '', b.label or '') end)
    return leaves
end
local function ft_each_entity_def(idx_vec, raws_vec, fn)
    if not idx_vec or not raws_vec then return end
    local n = ft_G(function() return #idx_vec end, 0)
    local rn = ft_G(function() return #raws_vec end, 0)
    local seen = {}
    for i = 0, n - 1 do
        local sub = idx_vec[i]
        if sub and sub >= 0 and sub < rn and not seen[sub] then
            seen[sub] = true
            local d = raws_vec[sub]
            if d then fn(sub, d) end
        end
    end
end
local function ft_props_flag(d, name) return ft_G(function() return d.props.flags[name] end, false) end

local function ft_weapon_leaves(R, metal)
    local out = {}
    local IT = ft_IT()
    local add = function(sub, d)
        if ft_G(function() return d.flags.TRAINING end, false) then return end
        local ranged = ft_G(function() return d.ranged_ammo end, '') or ''
        if #ranged > 0 and not ft_metal_has(metal.mat_index, 'ITEMS_WEAPON_RANGED') then return end
        local adj = ft_G(function() return d.adjective end, '') or ''
        local nm = ft_G(function() return d.name end, 'weapon')
        out[#out + 1] = ft_leaf(ft_compose('Forge', adj, metal.label, nm),
            df.job_type.MakeWeapon, df.item_type.WEAPON, sub, ft_G(function() return d.id end, ''), 'screenshot-verified')
    end
    ft_each_entity_def(R.weapon_type, IT.weapons, add)
    -- diggers (picks) are gated on ITEMS_DIGGER, not ITEMS_WEAPON: DF's native forge menu
    -- offers "Forge iron pick" but NO silver pick (silver has ITEMS_WEAPON only) -- tmverify2
    -- oracle-differential 2026-07-08. Mirror of menu_model.lua weapon_leaves.
    if ft_metal_has(metal.mat_index, 'ITEMS_DIGGER') then
        ft_each_entity_def(R.digger_type, IT.weapons, add)
    end
    if ft_metal_has(metal.mat_index, 'ITEMS_AMMO') then
        ft_each_entity_def(R.ammo_type, IT.ammo, function(sub, d)
            local pl = ft_G(function() return d.name_plural end, nil) or ft_G(function() return d.name end, 'ammo')
            out[#out + 1] = ft_leaf('Forge twenty-five ' .. metal.label .. ' ' .. pl,
                df.job_type.MakeAmmo, df.item_type.AMMO, sub, ft_G(function() return d.id end, ''), 'screenshot-verified', { batch = 25 })
        end)
    end
    return out -- NATIVE ORDER (capture 01): weapon_type vector, digger, ammo -- NOT alpha.
end
-- Family order is NATIVE order (armor, pants, helm, gloves, shoes) -- captures 07 + 27. Mirror of
-- menu_model.lua armor_family.
local function ft_armor_family(R)
    local IT = ft_IT()
    return {
        { R.armor_type,  IT.armor,   df.job_type.MakeArmor,  df.item_type.ARMOR,  false },
        { R.pants_type,  IT.pants,   df.job_type.MakePants,  df.item_type.PANTS,  false },
        { R.helm_type,   IT.helms,   df.job_type.MakeHelm,   df.item_type.HELM,   false },
        { R.gloves_type, IT.gloves,  df.job_type.MakeGloves, df.item_type.GLOVES, true  },
        { R.shoes_type,  IT.shoes,   df.job_type.MakeShoes,  df.item_type.SHOES,  true  },
    }
end
local function ft_clothing_leaves(R, metal, want_armor_category)
    local out = {}
    for _, fam in ipairs(ft_armor_family(R)) do
        ft_each_entity_def(fam[1], fam[2], function(sub, d)
            local is_metal = ft_props_flag(d, 'METAL')
            local is_soft = ft_props_flag(d, 'SOFT')
            local keep
            if want_armor_category then keep = is_metal else keep = (is_soft and not is_metal) end
            if not keep then return end
            local nm, lbl
            if fam[5] then
                nm = ft_G(function() return d.name_plural end, nil) or ft_G(function() return d.name end, 'item')
                lbl = 'Forge pair of ' .. metal.label .. ' ' .. nm
            else
                nm = ft_G(function() return d.name end, 'item')
                lbl = ft_compose('Forge', ft_G(function() return d.adjective end, '') or '', metal.label, nm)
            end
            out[#out + 1] = ft_leaf(lbl, fam[3], fam[4], sub, ft_G(function() return d.id end, ''), 'screenshot-verified')
        end)
    end
    if want_armor_category then
        ft_each_entity_def(R.shield_type, ft_IT().shields, function(sub, d)
            out[#out + 1] = ft_leaf('Forge ' .. metal.label .. ' ' .. (ft_G(function() return d.name end, 'shield')),
                df.job_type.MakeShield, df.item_type.SHIELD, sub, ft_G(function() return d.id end, ''), 'screenshot-verified')
        end)
    else
        out[#out + 1] = ft_leaf('Make ' .. metal.label .. ' backpack', df.job_type.MakeBackpack, df.item_type.BACKPACK, nil, nil, 'screenshot-verified')
        out[#out + 1] = ft_leaf('Make ' .. metal.label .. ' quiver', df.job_type.MakeQuiver, df.item_type.QUIVER, nil, nil, 'screenshot-verified')
    end
    return out -- NATIVE ORDER (captures 07/27): family blocks then shields/backpack+quiver -- NOT alpha.
end
-- ONE hardcoded native sequence (capture 08) -- Forge/Make verbs interleaved. Mirror of
-- menu_model.lua FURNITURE_SEQ. {noun, verb, job}.
local FTREE_FURN_SEQ = {
    { 'cage', 'Forge', 'MakeCage' }, { 'chain', 'Forge', 'MakeChain' },
    { 'animal trap', 'Forge', 'MakeAnimalTrap' }, { 'bucket', 'Forge', 'MakeBucket' },
    { 'barrel', 'Forge', 'MakeBarrel' }, { 'armor stand', 'Make', 'ConstructArmorStand' },
    { 'blocks', 'Make', 'ConstructBlocks' }, { 'door', 'Make', 'ConstructDoor' },
    { 'floodgate', 'Make', 'ConstructFloodgate' }, { 'hatch cover', 'Make', 'ConstructHatchCover' },
    { 'grate', 'Make', 'ConstructGrate' }, { 'statue', 'Make', 'ConstructStatue' },
    { 'cabinet', 'Make', 'ConstructCabinet' }, { 'chest', 'Make', 'ConstructChest' },
    { 'throne', 'Make', 'ConstructThrone' }, { 'sarcophagus', 'Make', 'ConstructCoffin' },
    { 'table', 'Make', 'ConstructTable' }, { 'weapon rack', 'Make', 'ConstructWeaponRack' },
    { 'bin', 'Make', 'ConstructBin' }, { 'pipe section', 'Forge', 'MakePipeSection' },
    { 'splint', 'Make', 'ConstructSplint' }, { 'crutch', 'Make', 'ConstructCrutch' },
}
local function ft_furniture_leaves(metal)
    local out = {}
    for _, f in ipairs(FTREE_FURN_SEQ) do
        if df.job_type[f[3]] then
            out[#out + 1] = ft_leaf(f[2] .. ' ' .. metal.label .. ' ' .. f[1], df.job_type[f[3]], nil, nil, nil, 'screenshot-verified')
        end
    end
    return out -- NATIVE ORDER (capture 08) -- NOT alpha.
end
local function ft_siege_leaves(metal)
    return { ft_leaf('Forge ' .. metal.label .. ' ballista arrow head', df.job_type.MakeBallistaArrowHead, nil, nil, nil, 'screenshot-verified') }
end
local function ft_trap_leaves(R, metal)
    local out = {}
    if ft_metal_has(metal.mat_index, 'ITEMS_WEAPON') then
        ft_each_entity_def(R.trapcomp_type, ft_IT().trapcomps, function(sub, d)
            out[#out + 1] = ft_leaf(
                ft_compose('Forge', ft_G(function() return d.adjective end, '') or '', metal.label, ft_G(function() return d.name end, 'component')),
                df.job_type.MakeTrapComponent or df.job_type.MakeWeapon, df.item_type.TRAPCOMP, sub,
                ft_G(function() return d.id end, ''), 'screenshot-verified')
        end)
    end
    if ft_metal_has(metal.mat_index, 'ITEMS_HARD') then
        out[#out + 1] = ft_leaf('Make ' .. metal.label .. ' mechanisms', df.job_type.ConstructMechanisms, nil, nil, nil, 'screenshot-verified')
    end
    return out -- source order: trapcomp_type vector then mechanisms (native order NOT-VERIFIED).
end
-- OTHER OBJECTS: HARDCODED native sequence (captures 29 iron + 21 silver). Mirror of
-- menu_model.lua other_leaves. Anvil gated on ITEMS_ANVIL; ONE generic toy; tool block from the
-- entity tool_type vector (HARD_MAT|METAL_MAT minus NO_DEFAULT_JOB -- INCOMPLETE_ITEM is NOT an
-- exclusion, refuted 2026-07-08); batch goblets/flasks; "Make large <m> gem"; StudWith.
local function ft_other_leaves(R, metal)
    local out = {}
    local ml = metal.label
    local function add(lbl, jobtok, extra)
        local jt = df.job_type[jobtok]
        if jt then out[#out + 1] = ft_leaf(lbl, jt, nil, nil, nil, 'screenshot-verified', extra) end
    end
    if ft_metal_has(metal.mat_index, 'ITEMS_ANVIL') then add('Forge ' .. ml .. ' anvil', 'ForgeAnvil') end
    add('Make ' .. ml .. ' crafts', 'MakeCrafts')
    add('Forge three ' .. ml .. ' goblets', 'MakeGoblet', { batch = 3 })
    if df.job_type.MakeToy then
        out[#out + 1] = ft_leaf('Forge ' .. ml .. ' toy', df.job_type.MakeToy, df.item_type.TOY, nil, nil, 'screenshot-verified')
    end
    ft_each_entity_def(R.tool_type, ft_IT().tools, function(sub, d)
        local hard = ft_G(function() return d.flags.HARD_MAT end, false) or ft_G(function() return d.flags.METAL_MAT end, false)
        if ft_G(function() return d.flags.NO_DEFAULT_JOB end, false) then hard = false end
        if hard then
            out[#out + 1] = ft_leaf('Forge ' .. ml .. ' ' .. (ft_G(function() return d.name end, 'tool')),
                df.job_type.MakeTool, df.item_type.TOOL, sub, ft_G(function() return d.id end, ''), 'screenshot-verified')
        end
    end)
    add('Forge three ' .. ml .. ' flasks', 'MakeFlask', { batch = 3 })
    add('Mint ' .. ml .. ' coins', 'MintCoins')
    add('Stud with ' .. ml, 'StudWith')
    add('Make ' .. ml .. ' amulet', 'MakeAmulet')
    add('Make ' .. ml .. ' bracelet', 'MakeBracelet')
    add('Make ' .. ml .. ' earring', 'MakeEarring')
    add('Make ' .. ml .. ' crown', 'MakeCrown')
    add('Make ' .. ml .. ' figurine', 'MakeFigurine')
    add('Make ' .. ml .. ' ring', 'MakeRing')
    add('Make large ' .. ml .. ' gem', 'MakeGem')
    add('Make ' .. ml .. ' scepter', 'MakeScepter')
    return out -- NATIVE ORDER -- NOT alpha.
end
-- Fort-civ reaction prefix "MAKE_ENT<civ_id> " (mirror of menu_model.lua fort_civ_prefix). DF
-- shows a custom-category's reactions only for the fort civ's own entity (capture 28 = 9 ENT305).
local function ft_fort_civ_prefix()
    local cid = ft_G(function() return df.global.plotinfo.civ_id end, -1)
    if not cid or cid < 0 then return nil end
    return 'MAKE_ENT' .. cid .. ' '
end
local function ft_reaction_leaves(bt, st, want_category)
    local out = {}
    local rs = ft_G(function() return ft_raws().reactions.reactions end, nil)
    if not rs then return out end
    local prefix = ft_fort_civ_prefix()
    local n = ft_G(function() return #rs end, 0)
    for i = 0, n - 1 do
        local r = rs[i]
        local cat = ft_G(function() return r.category end, '')
        if cat == want_category then
            local code = ft_G(function() return r.code end, '') or ''
            if prefix and code:sub(1, #prefix) == prefix then -- civ filter (B40/B42)
                local hit = false
                local bn = ft_G(function() return #r.building.type end, 0)
                for j = 0, bn - 1 do
                    if ft_G(function() return r.building.type[j] end, nil) == bt and
                       ft_G(function() return r.building.subtype[j] end, nil) == st then hit = true break end
                end
                if hit then
                    out[#out + 1] = { kind = 'reaction', label = ft_cap(ft_G(function() return r.name end, '?')),
                        reaction_code = code, confidence = 'screenshot-verified' }
                end
            end
        end
    end
    return out -- RAWS/attachment order (capture 28) -- NOT alpha.
end

-- Build the forge root tree (returns array of category nodes, or nil,err). bt/st = building_type
-- + workshop_type enum values for MetalsmithsForge/MagmaForge.
function forge_task_tree(bt, st)
    local e = fort_entity()
    local R = e and e.resources or nil
    if not R then return nil, 'no fortress entity' end
    local function metal_branch(flags, leaves_fn, conf)
        local ms = ft_metals_with(flags)
        local branch = {}
        for _, m in ipairs(ms) do
            local ls = leaves_fn(m)
            if #ls > 0 then
                branch[#branch + 1] = { kind = 'material', label = m.label, mat_type = m.mat_type,
                    mat_index = m.mat_index, token = m.token, confidence = conf, leaves = ls }
            end
        end
        return branch
    end
    local root = {
        { kind = 'category', label = 'Weapons and ammunition', df_category = 'WEAPON', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_WEAPON' }, function(m) return ft_weapon_leaves(R, m) end, 'screenshot-verified') },
        { kind = 'category', label = 'Armor', df_category = 'ARMOR', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_ARMOR' }, function(m) return ft_clothing_leaves(R, m, true) end, 'flag-derived') },
        { kind = 'category', label = 'Furniture', df_category = 'FURNITURE', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_HARD' }, ft_furniture_leaves, 'flag-derived') },
        { kind = 'category', label = 'Siege equipment', df_category = 'SIEGE', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_WEAPON' }, ft_siege_leaves, 'speculative') },
        -- B52: TRAP metal LIST filters ITEMS_WEAPON only (native capture 20 = 17 rows == weapons list,
        -- NOT the ITEMS_HARD 35). Mechanisms still gate per-metal on ITEMS_HARD inside ft_trap_leaves,
        -- so an ITEMS_WEAPON∩ITEMS_HARD metal (iron) still gets "Make iron mechanisms"; a HARD-only
        -- metal (gold) never enters the trap list (native offers no gold trap components/mechanisms).
        { kind = 'category', label = 'Trap components', df_category = 'TRAP', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_WEAPON' }, function(m) return ft_trap_leaves(R, m) end, 'speculative') },
        { kind = 'category', label = 'Other objects', df_category = 'OTHER', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_HARD' }, function(m) return ft_other_leaves(R, m) end, 'screenshot-verified') },
        { kind = 'category', label = 'Metal clothing', df_category = 'METAL', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_SOFT' }, function(m) return ft_clothing_leaves(R, m, false) end, 'flag-derived') },
    }
    -- Instrument custom categories (B41): NO metal layer -- leaves live on the category node
    -- directly (capture 28). (B40): HIDE when the civ-filtered leaf set is empty (INSTRUMENT is
    -- empty for this fort -> native root = 8). Mirror of menu_model.lua instrument_node.
    local function instrument_node(label, token)
        local ls = ft_reaction_leaves(bt, st, token)
        if #ls == 0 then return nil end
        return { kind = 'custom_category', label = label, token = token,
                 confidence = 'screenshot-verified', leaves = ls }
    end
    local ip = instrument_node('Make instrument piece', 'INSTRUMENT_PIECE')
    if ip then root[#root + 1] = ip end
    local ia = instrument_node('Make instrument', 'INSTRUMENT')
    if ia then root[#root + 1] = ia end
    return root, nil
end

-- serialize a leaf/metal/category node tree to JSON (json_string handles CP437->UTF-8 + escaping)
local function ft_num_or_null(v) return v ~= nil and tostring(v) or 'null' end
local function ft_leaf_json(l)
    local p = { '"kind":' .. json_string(l.kind or 'job'), '"label":' .. json_string(l.label or '') }
    if l.job_type then p[#p + 1] = '"jobType":' .. json_string(l.job_type) end
    if l.item_type then p[#p + 1] = '"itemType":' .. json_string(tostring(l.item_type)) end
    if l.item_subtype ~= nil then p[#p + 1] = '"itemSubtype":' .. tostring(l.item_subtype) end
    if l.subtype_token then p[#p + 1] = '"subtypeToken":' .. json_string(l.subtype_token) end
    if l.reaction_code then p[#p + 1] = '"reactionCode":' .. json_string(l.reaction_code) end
    if l.batch then p[#p + 1] = '"batch":' .. tostring(l.batch) end
    if l.avail ~= nil then p[#p + 1] = '"avail":' .. json_bool(l.avail) end   -- WP-2 availability bit
    if l.objection ~= nil then p[#p + 1] = '"objection":' .. json_string(l.objection) end
    if l.confidence then p[#p + 1] = '"confidence":' .. json_string(l.confidence) end
    return '{' .. table.concat(p, ',') .. '}'
end
local function ft_metal_json(m)
    local leaves = {}
    for _, l in ipairs(m.leaves or {}) do leaves[#leaves + 1] = ft_leaf_json(l) end
    return '{"kind":"material","label":' .. json_string(m.label or '') ..
        ',"matType":' .. ft_num_or_null(m.mat_type) .. ',"matIndex":' .. ft_num_or_null(m.mat_index) ..
        ',"token":' .. json_string(m.token or '') .. ',"confidence":' .. json_string(m.confidence or '') ..
        ',"leaves":[' .. table.concat(leaves, ',') .. ']}'
end
local function ft_category_json(c)
    local p = { '"kind":' .. json_string(c.kind or 'category'), '"label":' .. json_string(c.label or '') }
    if c.df_category then p[#p + 1] = '"dfCategory":' .. json_string(c.df_category) end
    if c.token then p[#p + 1] = '"token":' .. json_string(c.token) end
    if c.confidence then p[#p + 1] = '"confidence":' .. json_string(c.confidence) end
    if c.leaves then
        -- leaf-only category (instruments, B41): leaves live on the node directly, NO metal layer
        local leaves = {}
        for _, l in ipairs(c.leaves) do leaves[#leaves + 1] = ft_leaf_json(l) end
        p[#p + 1] = '"leaves":[' .. table.concat(leaves, ',') .. ']'
    else
        local metals = {}
        for _, m in ipairs(c.metals or {}) do metals[#metals + 1] = ft_metal_json(m) end
        p[#p + 1] = '"metals":[' .. table.concat(metals, ',') .. ']'
    end
    return '{' .. table.concat(p, ',') .. '}'
end
function ft_tree_json(root)
    if not root then return 'null' end
    local cats = {}
    for _, c in ipairs(root) do cats[#cats + 1] = ft_category_json(c) end
    return '[' .. table.concat(cats, ',') .. ']'
end

-- is this shop one of the two forges? returns bt,st or nil
function forge_bt_st(b)
    local key = shop_subtype_key(b)
    if key == 'MetalsmithsForge' or key == 'MagmaForge' then
        return b:getType(), b:getSubtype(), key
    end
    return nil
end

-- Post-deploy dump hook: build + serialize the forge tree for a subtype NAME (no built building
-- needed -- uses the fort entity). Returns the WP-1 served-model JSON for gate --served.
-- Called via: dfhack-run lua -e "..." require('plugins.dwf').forge_task_tree_json('MetalsmithsForge')
function forge_task_tree_json(subtype_name)
    local st = df.workshop_type[subtype_name]
    local bt = df.building_type.Workshop
    if st == nil then return '{"ok":false,"error":"unknown forge subtype"}\n' end
    local root, err = forge_task_tree(bt, st)
    if not root then return '{"ok":false,"error":' .. json_string(err or 'no tree') .. '}\n' end
    return '{"ok":true,"key":' .. json_string('Workshop/' .. subtype_name) ..
        ',"shape":"forge-tree","root":' .. ft_tree_json(root) .. '}\n'
end
end)()  -- end forge-tree builder IIFE

-- ---------------------------------------------------------------------------------------------
-- TRUEMENU flat-shop rewrite (2026-07-08): DF-native add-task trees for the
-- non-forge shops whose native menus are NOT a flat getJobs list -- Smelter/MagmaSmelter (melt row
-- first, ores in inorganic raws-index order, reactions in raws order, native capitalization:
-- capture 30), Craftsdwarfs (MIXED root -- material-selector submenus + direct leaves + instrument
-- custom-categories: captures 31/32), Kennels a.k.a. the v50 Vermin Catcher's Shop (2 rows: capture
-- 33). Structure + label composition + ordering mirror tools/harness/menu_model.lua EXACTLY so the
-- served tree passes the same gate; every leaf carries an internal `_def` (job_fields + real
-- reagents) so the queue path reuses DF's own reagent filters (Smelter melt/smelt/reaction defs come
-- straight from dfhack.workshops.getJobs; Craftsdwarf hardcoded jobs carry the boulder/cloth/bone/
-- etc. reagent DF uses). Its helpers stay local to an IIFE; its three forward-declared exports bind outside it.
-- native_queue is defined LATER (after add_workshop_task) so it can call it; it is forward-declared.
local native_menu_tree, native_tree_json, native_shop_is, native_queue
;(function()
local function G(fn, fb) local ok, v = pcall(fn); if ok then return v end return fb end
local function raws() return df.global.world.raws end
local function IT() return df.global.world.raws.itemdefs end
-- capitalize the first byte (DF's native reaction display uppercases the raws NAME's first letter:
-- raws "make brass bars (use ore)" -> native "Make brass bars (use ore)", capture 30).
local function cap(s)
    s = tostring(s or '')
    if #s == 0 then return s end
    local b = s:byte(1)
    if b >= 97 and b <= 122 then return string.char(b - 32) .. s:sub(2) end
    return s
end
-- self-describing t: queue key, byte-identical to the client's composeTaskKey + the forge grammar.
local function compose_key(leaf, mat)
    if leaf.kind == 'reaction' or (leaf.reaction_code and not leaf.job_type) then
        if not leaf.reaction_code then return nil end
        return 't:CustomReaction|rc:' .. leaf.reaction_code
    end
    if not leaf.job_type then return nil end
    local k = 't:' .. leaf.job_type
    if leaf.item_type then k = k .. '|it:' .. leaf.item_type end
    if leaf.item_subtype ~= nil then k = k .. '|st:' .. leaf.item_subtype end
    local mt = (mat and mat.mat_type) or leaf.mat_type
    local mi = (mat and mat.mat_index) or leaf.mat_index
    if mt ~= nil and mi ~= nil then k = k .. '|mat:' .. mt .. ':' .. mi end
    -- material_category (organic: cloth/silk/bone/tooth/...) is DF's other material discriminator --
    -- it is what tells "Make cloth crafts" from "Make silk crafts" (same job type, no mat index).
    if leaf.material_category then k = k .. '|cat:' .. leaf.material_category end
    if leaf.batch then k = k .. '|b:' .. leaf.batch end
    return k
end
-- leaf constructor: display fields (job_type/item_type kept as STRING names for the key + JSON) plus
-- an internal `_def` (numeric job_fields + reagent items) the queue path feeds add_workshop_task.
local function leaf_job(label, jt_name, o)
    o = o or {}
    local L = { kind = 'job', label = label, job_type = jt_name, confidence = o.confidence or 'screenshot-verified' }
    if o.item_type then L.item_type = o.item_type end
    if o.item_subtype ~= nil then L.item_subtype = o.item_subtype end
    if o.mat_type ~= nil then L.mat_type = o.mat_type end
    if o.mat_index ~= nil then L.mat_index = o.mat_index end
    if o.material_category then L.material_category = o.material_category end
    if o.batch then L.batch = o.batch end
    L._def = o.def
    return L
end
local function leaf_reaction(label, code, def, conf)
    return { kind = 'reaction', label = label, reaction_code = code, confidence = conf or 'screenshot-verified', _def = def }
end
local function find_sub(vec, name) -- itemdef subtype index by name (short sword / tool defs)
    local n = G(function() return #vec end, 0)
    for i = 0, n - 1 do if G(function() return vec[i].name end, nil) == name then return i end end
    return nil
end
local function fort_civ_prefix()
    local cid = G(function() return df.global.plotinfo.civ_id end, -1)
    if not cid or cid < 0 then return nil end
    return 'MAKE_ENT' .. cid .. ' '
end

-- ---- Smelter / MagmaSmelter -----------------------------------------------------------------
-- 1 melt row, then ores (inorganics with a populated metal_ore, in INDEX order), then reactions
-- attached to this furnace in RAWS order -- native capture 30. _def reused from getJobs (authoritative
-- reagents: ore boulder + fuel for SmeltOre, the metal-item filter for melt, full reagent set for
-- reactions), matched by job_type / mat_index / reaction code.
local function smelter_tree(bt, st)
    local wo = G(function() return require('dfhack.workshops') end, nil)
    local jobs = wo and G(function() return wo.getJobs(bt, st, -1) end, nil) or nil
    local melt_def, ore_by_idx, rx = nil, {}, {}
    if jobs then for _, d in pairs(jobs) do if type(d) == 'table' then
        local jf = d.job_fields or {}
        local jn = jf.job_type and df.job_type[jf.job_type]
        if jn == 'MeltMetalObject' then melt_def = d
        elseif jn == 'SmeltOre' and jf.mat_index ~= nil then ore_by_idx[jf.mat_index] = d
        elseif jf.reaction_name and #tostring(jf.reaction_name) > 0 then rx[tostring(jf.reaction_name)] = d end
    end end end
    local out = {}
    out[#out + 1] = leaf_job('Melt a metal object', 'MeltMetalObject', { def = melt_def or
        { job_fields = { job_type = df.job_type.MeltMetalObject }, items = {} } })
    local inorg = G(function() return raws().inorganics.all end, nil)
    if inorg then
        local n = G(function() return #inorg end, 0)
        for i = 0, n - 1 do
            local m = inorg[i]
            local nore = G(function() return #m.metal_ore.mat_index end, 0)
            if nore and nore > 0 then
                local nm = G(function() return m.material.state_name.Solid end, 'ore')
                out[#out + 1] = leaf_job('Smelt ' .. nm .. ' ore', 'SmeltOre',
                    { mat_type = 0, mat_index = i, def = ore_by_idx[i] })
            end
        end
    end
    local prefix = fort_civ_prefix()
    local rs = G(function() return raws().reactions.reactions end, nil)
    if rs then
        local n = G(function() return #rs end, 0)
        for i = 0, n - 1 do
            local r = rs[i]
            local hit = false
            local bn = G(function() return #r.building.type end, 0)
            for j = 0, bn - 1 do
                if G(function() return r.building.type[j] end, nil) == bt and
                   G(function() return r.building.subtype[j] end, nil) == st then hit = true break end
            end
            if hit then
                local code = G(function() return r.code end, '') or ''
                -- skip a foreign entity's generated reaction (only the fort civ's are native-shown)
                if code:sub(1, 8) ~= 'MAKE_ENT' or (prefix and code:sub(1, #prefix) == prefix) then
                    out[#out + 1] = leaf_reaction(cap(G(function() return r.name end, '?')), code, rx[code])
                end
            end
        end
    end
    return out
end

-- ---- Kennels (v50 Vermin Catcher's Shop) ----------------------------------------------------
-- getJobs returns nothing for this shop; DF hardcodes the two rows (capture 33).
local function kennels_tree()
    return {
        leaf_job('Catch live land animal', 'CatchLiveLandAnimal',
            { def = { job_fields = { job_type = df.job_type.CatchLiveLandAnimal }, items = {} }, confidence = 'screenshot-verified' }),
        leaf_job('Tame a small animal', 'TameVermin',
            { def = { job_fields = { job_type = df.job_type.TameVermin }, items = {} }, confidence = 'screenshot-verified' }),
    }
end

-- ---- Craftsdwarf's Workshop (MIXED root, captures 31/32) -------------------------------------
local CD_STONE = { item_type = df.item_type.BOULDER, vector_id = df.job_item_vector_id.BOULDER, mat_type = 0, flags3 = { hard = true } }
local function cd_reagent(matcat)
    if matcat == 'cloth' then return { item_type = df.item_type.CLOTH } end
    if matcat == 'silk' then return { item_type = df.item_type.CLOTH, flags2 = { silk = true } } end
    if matcat == 'yarn' then return { item_type = df.item_type.CLOTH, flags2 = { yarn = true } } end
    if matcat == 'leather' then return { item_type = df.item_type.SKIN_TANNED, flags1 = { unrotten = true } } end
    if matcat == 'tooth' then return { flags1 = { unrotten = true }, flags2 = { ivory_tooth = true } } end
    if matcat == 'horn' then return { flags1 = { unrotten = true }, flags2 = { horn = true } } end
    if matcat == 'pearl' then return { flags1 = { unrotten = true }, flags2 = { pearl = true } } end
    if matcat == 'bone' then return { flags1 = { unrotten = true }, flags2 = { bone = true } } end
    if matcat == 'shell' then return { flags1 = { unrotten = true }, flags2 = { shell = true } } end
    if matcat == 'wood' then return { item_type = df.item_type.WOOD, vector_id = df.job_item_vector_id.WOOD } end
    return {}
end
-- per-family jewelry noun -> job type. BASE = every material; +EXTRA (crown..scepter) for hard
-- ivory/horn; PEARL_EXTRA drops the scepter (capture 31).
local CD_BASE = { { 'crafts', 'MakeCrafts' }, { 'amulet', 'MakeAmulet' }, { 'bracelet', 'MakeBracelet' }, { 'earring', 'MakeEarring' } }
local CD_EXTRA = { { 'crown', 'MakeCrown' }, { 'figurine', 'MakeFigurine' }, { 'ring', 'MakeRing' }, { 'gem', 'MakeGem', true }, { 'scepter', 'MakeScepter' } }
local CD_PEARL_EXTRA = { { 'crown', 'MakeCrown' }, { 'figurine', 'MakeFigurine' }, { 'ring', 'MakeRing' }, { 'gem', 'MakeGem', true } }
local CD_FAMILIES = { -- ROOT family blocks, in native order (capture 31)
    { word = 'cloth', cat = 'cloth', set = 'base' },
    { word = 'silk', cat = 'silk', set = 'base' },
    { word = 'yarn', cat = 'yarn', set = 'base' },
    { word = 'ivory/tooth', cat = 'tooth', set = 'hard' },
    { word = 'horn', cat = 'horn', set = 'hard' },
    { word = 'pearl', cat = 'pearl', set = 'pearl' },
    { word = 'leather', cat = 'leather', set = 'base' },
}
local function cd_family_leaf(jt, word, matcat, noun, big)
    local label = big and ('Make large ' .. word .. ' ' .. noun) or ('Make ' .. word .. ' ' .. noun)
    return leaf_job(label, jt, { confidence = 'screenshot-verified', material_category = matcat,
        def = { job_fields = { job_type = df.job_type[jt], material_category = matcat }, items = { cd_reagent(matcat) } } })
end
local function cd_family_leaves(fam, out)
    local set = (fam.set == 'hard') and CD_EXTRA or (fam.set == 'pearl') and CD_PEARL_EXTRA or nil
    for _, e in ipairs(CD_BASE) do out[#out + 1] = cd_family_leaf(e[2], fam.word, fam.cat, e[1], e[3]) end
    if set then for _, e in ipairs(set) do out[#out + 1] = cd_family_leaf(e[2], fam.word, fam.cat, e[1], e[3]) end end
end
-- B264 THE ORDERING LAW. Every one of the 30 native captures (evidence/oracles/workshops/) shows the
-- SAME shape: container rows first, then EVERY leaf sorted ALPHABETICALLY by its full label. Zero
-- exceptions in 30 captures. Our lists were in source order, so every shop was mis-ordered even where
-- the row SET happened to be right (the craftsdwarf's rock submenu is exactly that case: right 19
-- rows, wrong order). Byte-wise, ascii-lowered -- same key as menu_model.lua's byte_lt and the gate.
local function cd_byte_lt(a, b)
    local la, lb = #a, #b
    for i = 1, math.min(la, lb) do
        local ca, cb = a:byte(i), b:byte(i)
        if ca >= 65 and ca <= 90 then ca = ca + 32 end
        if cb >= 65 and cb <= 90 then cb = cb + 32 end
        if ca ~= cb then return ca < cb end
    end
    return la < lb
end
local function cd_alpha_sort(leaves)
    table.sort(leaves, function(a, b) return cd_byte_lt(a.label or '', b.label or '') end)
    return leaves
end
-- rock submenu -- VERBATIM from WS-CRAFTSDWARF-ROCK-native-{1,2}of2.png (19 rows, alphabetical).
-- Material pinned to any rock (mat 0:-1); weapon/tool leaves resolve their itemdef subtype by NAME.
-- The tool block (book binding, die, hive, jug, nest box, pot, scroll rollers) is exactly the
-- entity's non-FURNITURE HARD_MAT tools -- see the FURNITURE split in cd_tool_is_furniture below.
local CD_ROCK_SEQ = {
    { 'Make large rock gem', 'MakeGem' },
    { 'Make rock amulet', 'MakeAmulet' },
    { 'Make rock book binding', 'MakeTool', tool = 'book binding' },
    { 'Make rock bracelet', 'MakeBracelet' },
    { 'Make rock crafts', 'MakeCrafts' },
    { 'Make rock crown', 'MakeCrown' },
    { 'Make rock die', 'MakeTool', tool = 'die' },
    { 'Make rock earring', 'MakeEarring' },
    { 'Make rock figurine', 'MakeFigurine' },
    { 'Make rock hive', 'MakeTool', tool = 'hive' },
    { 'Make rock jug', 'MakeTool', tool = 'jug' },
    { 'Make rock nest box', 'MakeTool', tool = 'nest box' },
    { 'Make rock pot', 'MakeTool', tool = 'pot' },
    { 'Make rock ring', 'MakeRing' },
    { 'Make rock scepter', 'MakeScepter' },
    { 'Make rock scroll rollers', 'MakeTool', tool = 'scroll rollers' },
    { 'Make rock short sword', 'MakeWeapon', wpn = 'short sword' },
    { 'Make rock toy', 'MakeToy', toy = true },
    { 'Make three rock mugs', 'MakeGoblet', batch = 3 },
}
local function cd_rock_submenu()
    local out = {}
    for _, e in ipairs(CD_ROCK_SEQ) do
        local o = { mat_type = 0, mat_index = -1, confidence = 'screenshot-verified' }
        local jf = { job_type = df.job_type[e[2]], mat_type = 0, mat_index = -1 }
        if e.batch then o.batch = e.batch end
        if e.wpn then local s = find_sub(IT().weapons, e.wpn); o.item_type = 'WEAPON'; o.item_subtype = s; jf.item_type = df.item_type.WEAPON; jf.item_subtype = s end
        if e.tool then local s = find_sub(IT().tools, e.tool); o.item_type = 'TOOL'; o.item_subtype = s; jf.item_type = df.item_type.TOOL; jf.item_subtype = s end
        if e.toy then o.item_type = 'TOY'; jf.item_type = df.item_type.TOY end
        o.def = { job_fields = jf, items = { CD_STONE } }
        out[#out + 1] = leaf_job(e[1], e[2], o)
    end
    return cd_alpha_sort(out)
end
-- B255: the ammo leaves of an organic submenu (bolts + any modded ammo the fort entity permits),
-- entity-derived, sharing ammo_shop_defs with the flat/work-order path so the two can never drift.
local function cd_ammo_leaves(adj, matcat, conf)
    local out, defs = {}, {}
    ammo_shop_defs(defs, 'Ammo', 11, adj, matcat, cd_reagent(matcat))
    for _, d in ipairs(defs) do
        local jf = d.job_fields or {}
        out[#out + 1] = leaf_job(d.name, 'MakeAmmo', { item_type = 'AMMO', item_subtype = jf.item_subtype,
            material_category = matcat, batch = AMMO_COUNT_N[matcat], confidence = conf, def = d })
    end
    return out
end
-- WOOD submenu -- VERBATIM from WS-CRAFTSDWARF-WOOD-native-FULL.png. B255 built this list from a
-- capture whose bottom rows were below the fold, and carried 'Make wooden toy' over from the hand
-- list on the guess that it sat past the fold. the new capture shows the COMPLETE list (it fits one
-- screen, 18 rows) and there is NO wooden toy in it: DF makes toys in rock, not wood. The row is
-- DELETED -- it was invented, which is the exact failure class B255 existed to end.
local CD_WOOD_SEQ = {
    { 'Make large wooden gem',      'MakeGem' },
    { 'Make three wooden cups',     'MakeGoblet', batch = 3 },
    { 'AMMO' },                                                  -- Make twenty-five wooden bolts
    { 'Make wooden amulet',         'MakeAmulet' },
    { 'Make wooden book binding',   'MakeTool', tool = 'book binding' },
    { 'Make wooden bracelet',       'MakeBracelet' },
    { 'Make wooden crafts',         'MakeCrafts' },
    { 'Make wooden crown',          'MakeCrown' },
    { 'Make wooden die',            'MakeTool', tool = 'die' },
    { 'Make wooden earring',        'MakeEarring' },
    { 'Make wooden figurine',       'MakeFigurine' },
    { 'Make wooden hive',           'MakeTool', tool = 'hive' },
    { 'Make wooden jug',            'MakeTool', tool = 'jug' },
    { 'Make wooden nest box',       'MakeTool', tool = 'nest box' },
    { 'Make wooden pot',            'MakeTool', tool = 'pot' },
    { 'Make wooden ring',           'MakeRing' },
    { 'Make wooden scepter',        'MakeScepter' },
    { 'Make wooden scroll rollers', 'MakeTool', tool = 'scroll rollers' },
}
local function cd_wood_submenu()
    local out = {}
    for _, e in ipairs(CD_WOOD_SEQ) do
        if e[1] == 'AMMO' then
            for _, l in ipairs(cd_ammo_leaves('wooden', 'wood', 'screenshot-verified')) do out[#out + 1] = l end
        else
            local o = { material_category = 'wood',
                confidence = e.derived and 'derived-not-captured' or 'screenshot-verified' }
            local jf = { job_type = df.job_type[e[2]], material_category = 'wood' }
            local skip = false
            if e.batch then o.batch = e.batch end
            if e.tool then
                local s = find_sub(IT().tools, e.tool)
                if s == nil then skip = true else
                    o.item_type = 'TOOL'; o.item_subtype = s
                    jf.item_type = df.item_type.TOOL; jf.item_subtype = s
                end
            end
            if e.toy then o.item_type = 'TOY'; jf.item_type = df.item_type.TOY end
            if not skip then
                o.def = { job_fields = jf, items = { cd_reagent('wood') } }
                out[#out + 1] = leaf_job(e[1], e[2], o)
            end
        end
    end
    return cd_alpha_sort(out)   -- keeps a modded entity ammo type in DF's alphabetical slot
end
-- B264 BONE + SHELL submenus -- now CAPTURED (WS-CRAFTSDWARF-BONE-native.png,
-- WS-CRAFTSDWARF-SHELL-native.png). These were a guessed 8-row crafts+jewelry set; the captures show
-- 15 and 12 rows, and both are structurally richer than anything we guessed:
--   * each opens with a `Decorate with <mat>` row INSIDE the submenu,
--   * bone carries real ARMOR (greaves / helm / leggings / pair of gauntlets); shell carries helm /
--     leggings / gauntlets but NO greaves and NO scepter,
--   * bone's ammo row is "Make five bone bolts" -- B255's uncaptured stack word "five" is CONFIRMED,
--   * SHELL HAS NO AMMO AT ALL. The old code gave the bone submenu ammo and the shell submenu none,
--     which was right by luck; it is now right by evidence.
-- Armor leaves resolve their itemdef subtype by name against the raws (nil-guarded: a missing def
-- drops the row rather than queueing a subtype-less MakeArmor, which is the B22 crash class).
local CD_BONE_SEQ = {
    { 'Decorate with bone',           'DecorateWith' },
    { 'Make bone amulet',             'MakeAmulet' },
    { 'Make bone bracelet',           'MakeBracelet' },
    { 'Make bone crafts',             'MakeCrafts' },
    { 'Make bone crown',              'MakeCrown' },
    { 'Make bone earring',            'MakeEarring' },
    { 'Make bone figurine',           'MakeFigurine' },
    { 'Make bone greaves',            'MakePants',  pants = 'greaves' },
    { 'Make bone helm',               'MakeHelm',   helm  = 'helm' },
    { 'Make bone leggings',           'MakePants',  pants = 'leggings' },
    { 'Make bone ring',               'MakeRing' },
    { 'Make bone scepter',            'MakeScepter' },
    { 'AMMO' },                                            -- Make five bone bolts
    { 'Make large bone gem',          'MakeGem' },
    { 'Make pair of bone gauntlets',  'MakeGloves', gloves = 'gauntlet' },
}
local CD_SHELL_SEQ = {
    { 'Decorate with shell',          'DecorateWith' },
    { 'Make large shell gem',         'MakeGem' },
    { 'Make pair of shell gauntlets', 'MakeGloves', gloves = 'gauntlet' },
    { 'Make shell amulet',            'MakeAmulet' },
    { 'Make shell bracelet',          'MakeBracelet' },
    { 'Make shell crafts',            'MakeCrafts' },
    { 'Make shell crown',             'MakeCrown' },
    { 'Make shell earring',           'MakeEarring' },
    { 'Make shell figurine',          'MakeFigurine' },
    { 'Make shell helm',              'MakeHelm',   helm = 'helm' },
    { 'Make shell leggings',          'MakePants',  pants = 'leggings' },
    { 'Make shell ring',              'MakeRing' },
}
local CD_ORGANIC_SEQ = { bone = CD_BONE_SEQ, shell = CD_SHELL_SEQ }
local function cd_organic_submenu(word, matcat)
    local out = {}
    for _, e in ipairs(CD_ORGANIC_SEQ[matcat] or {}) do
        if e[1] == 'AMMO' then
            for _, l in ipairs(cd_ammo_leaves(word, matcat, 'screenshot-verified')) do out[#out + 1] = l end
        else
            local o = { material_category = matcat, confidence = 'screenshot-verified' }
            local jf = { job_type = df.job_type[e[2]], material_category = matcat }
            local skip = false
            -- armor leaves: pin the itemdef subtype DF's own menu pins
            local vec, want = nil, nil
            if e.pants then vec, want, o.item_type, jf.item_type = IT().pants, e.pants, 'PANTS', df.item_type.PANTS end
            if e.helm then vec, want, o.item_type, jf.item_type = IT().helms, e.helm, 'HELM', df.item_type.HELM end
            if e.gloves then vec, want, o.item_type, jf.item_type = IT().gloves, e.gloves, 'GLOVES', df.item_type.GLOVES end
            if want then
                local s = find_sub(vec, want)
                if s == nil then skip = true else o.item_subtype = s; jf.item_subtype = s end
            end
            if not skip then
                o.def = { job_fields = jf, items = { cd_reagent(matcat) } }
                out[#out + 1] = leaf_job(e[1], e[2], o)
            end
        end
    end
    return cd_alpha_sort(out)
end
-- D3/D4 -- the FLAT shops' container rows. shop_tasks hands us the MAKE_ENT leaves it pulled out of
-- the flat list; we bucket them by their raws `category` and return one container task per bucket,
-- named exactly as the captures name them:
--   WS-CARPENTERS-native-1of3.png   `Make instrument (opens menu)`        (category INSTRUMENT)
--   WS-LEATHERWORKS-native-1of2.png `Make instrument piece (opens menu)`  (category INSTRUMENT_PIECE)
-- THE CIV FILTER (D4): the flat path applied NONE, so another civ's generated reactions could be
-- served as fort jobs. cd_reaction_cat and the smelter tree have always filtered on
-- `fort_civ_prefix()`; the flat list now does the same, and a leaf that fails it is dropped, not
-- re-listed. The submenu CONTENTS are not captured (see the MANIFEST's "Still missing") -- the
-- container ROW is, so we ship the row and fill it from the fort's own reactions.
local FLAT_CONTAINER_LABEL = {
    INSTRUMENT = 'Make instrument',
    INSTRUMENT_PIECE = 'Make instrument piece',
}
function flat_shop_containers(b, suppressed)
    local out = {}
    if not suppressed or #suppressed == 0 then return out end
    local by_code = {}
    for _, s in ipairs(suppressed) do by_code[s.reaction] = s.key end
    local prefix = fort_civ_prefix()
    if not prefix then return out end   -- no fort civ -> we cannot tell ours from theirs -> serve none
    local buckets = {}
    local rs = G(function() return raws().reactions.reactions end, nil)
    local n = G(function() return #rs end, 0)
    for i = 0, n - 1 do
        local r = rs[i]
        local code = G(function() return r.code end, '') or ''
        local cat = G(function() return r.category end, '') or ''
        if by_code[code] and FLAT_CONTAINER_LABEL[cat] and code:sub(1, #prefix) == prefix then
            buckets[cat] = buckets[cat] or {}
            table.insert(buckets[cat], {
                key = by_code[code],
                name = cap(G(function() return r.name end, '?')),
                reaction = code,
                avail = true, objection = '',
            })
        end
    end
    for cat, label in pairs(FLAT_CONTAINER_LABEL) do
        local kids = buckets[cat]
        if kids and #kids > 0 then
            table.sort(kids, function(x, y) return x.name < y.name end)
            out[#out + 1] = {
                key = 'cat:' .. cat,
                name = label .. ' (opens menu)',
                job = '', reaction = '', order_key = '',
                group = 'Common', pri = -1,   -- containers lead the list (the universal ordering law)
                label_source = 'capture-verbatim',
                needs_unit_selection = false,
                submenu = true, children = kids,
                avail = true, objection = '',
            }
        end
    end
    table.sort(out, function(x, y) return x.name < y.name end)
    return out
end

-- reactions of a given custom category attached to the shop, civ-filtered, RAWS order (mirror of the
-- forge instrument logic). _def reused from getJobs by code.
local function cd_reaction_cat(bt, st, category, rxmap)
    local out = {}
    local rs = G(function() return raws().reactions.reactions end, nil)
    if not rs then return out end
    local prefix = fort_civ_prefix()
    local n = G(function() return #rs end, 0)
    for i = 0, n - 1 do
        local r = rs[i]
        if G(function() return r.category end, '') == category then
            local code = G(function() return r.code end, '') or ''
            if prefix and code:sub(1, #prefix) == prefix then
                local hit = false
                local bn = G(function() return #r.building.type end, 0)
                for j = 0, bn - 1 do
                    if G(function() return r.building.type[j] end, nil) == bt and
                       G(function() return r.building.subtype[j] end, nil) == st then hit = true break end
                end
                if hit then out[#out + 1] = leaf_reaction(cap(G(function() return r.name end, '?')), code, rxmap[code]) end
            end
        end
    end
    return out
end
local function craftsdwarf_tree(bt, st)
    local wo = G(function() return require('dfhack.workshops') end, nil)
    local jobs = wo and G(function() return wo.getJobs(bt, st, -1) end, nil) or nil
    local rx = {}
    if jobs then for _, d in pairs(jobs) do if type(d) == 'table' then
        local jf = d.job_fields or {}
        if jf.reaction_name and #tostring(jf.reaction_name) > 0 then rx[tostring(jf.reaction_name)] = d end
    end end end
    -- B264/B266 NATIVE SHAPE (WS-CRAFTSDWARF-TOPLEVEL-native-{1..4}of4.png): the root is SIX
    -- container rows -- rock / wood / bone / shell / Make instrument piece / Make instrument, each
    -- rendered "(opens menu)" -- followed by EVERY leaf in ONE alphabetical block. The old code
    -- emitted the leaves in source order (decorate, totem, strands, reactions, then family blocks),
    -- which put e.g. "Make totem" 40 rows away from where DF puts it. The row SET was already right;
    -- only the order was wrong. Containers first, leaves alpha -- the law from all 30 captures.
    local root, leaves = {}, {}
    root[#root + 1] = { kind = 'material_selector', label = 'rock', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_rock_submenu() }
    root[#root + 1] = { kind = 'material_selector', label = 'wood', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_wood_submenu() }
    root[#root + 1] = { kind = 'material_selector', label = 'bone', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_organic_submenu('bone', 'bone') }
    root[#root + 1] = { kind = 'material_selector', label = 'shell', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_organic_submenu('shell', 'shell') }
    -- 2 instrument custom-categories (civ-filtered; hidden when the fort civ has none -- B40).
    -- Their CONTENTS are not captured; the container ROWS are (both read "(opens menu)").
    local ip = cd_reaction_cat(bt, st, 'INSTRUMENT_PIECE', rx)
    if #ip > 0 then root[#root + 1] = { kind = 'custom_category', label = 'Make instrument piece', token = 'INSTRUMENT_PIECE', confidence = 'screenshot-verified', leaves = ip } end
    local ia = cd_reaction_cat(bt, st, 'INSTRUMENT', rx)
    if #ia > 0 then root[#root + 1] = { kind = 'custom_category', label = 'Make instrument', token = 'INSTRUMENT', confidence = 'screenshot-verified', leaves = ia } end
    -- ---- leaves (all alpha-sorted together below) ----
    for _, mc in ipairs({ { 'ivory/tooth', 'tooth' }, { 'horn', 'horn' }, { 'pearl', 'pearl' } }) do
        leaves[#leaves + 1] = leaf_job('Decorate with ' .. mc[1], 'DecorateWith', { material_category = mc[2],
            def = { job_fields = { job_type = df.job_type.DecorateWith, material_category = mc[2] }, items = { cd_reagent(mc[2]) } } })
    end
    leaves[#leaves + 1] = leaf_job('Make totem', 'MakeTotem',
        { def = { job_fields = { job_type = df.job_type.MakeTotem }, items = { { flags1 = { unrotten = true }, flags2 = { totemable = true } } } } })
    leaves[#leaves + 1] = leaf_job('Extract metal strands', 'ExtractMetalStrands', { mat_type = 0, mat_index = 242,
        def = { job_fields = { job_type = df.job_type.ExtractMetalStrands, mat_type = 0, mat_index = 242 },
                items = { { item_type = df.item_type.BOULDER, mat_type = 0, mat_index = 242 } } }, confidence = 'flag-derived' })
    -- standard reactions (_def from getJobs by code). All four render RED in the capture with their
    -- own "[Requires ...]" line -- see the B265 objection work in annotate_native_avail.
    for _, wc in ipairs({ { 'Make wax crafts', 'MAKE_WAX_CRAFTS' }, { 'Make scroll', 'MAKE_SCROLL' },
        { 'Make quire', 'MAKE_QUIRE' }, { 'Bind book', 'BIND_BOOK' } }) do
        leaves[#leaves + 1] = leaf_reaction(wc[1], wc[2], rx[wc[2]])
    end
    -- per-material family blocks (cloth/silk/yarn/ivory/horn/pearl/leather)
    for _, fam in ipairs(CD_FAMILIES) do cd_family_leaves(fam, leaves) end
    cd_alpha_sort(leaves)
    for _, l in ipairs(leaves) do root[#root + 1] = l end
    return root
end

-- ---- Bowyer / Clothier (entity-derived, WP-3) -----------------------------------------------
-- getJobs returns 0 for these two; their native add-task list is the fort ENTITY's permitted ranged
-- weapons + ammo (Bowyer, in wood) / soft + leather clothing pieces (Clothier). Reuse the proven
-- dynamic_shop_jobs entity enumeration (the SAME defs the flat Tasks path built) and present them as
-- a flat leaf-at-root native tree so they render through the WP-1 drill UI with WP-2 availability
-- annotation. Native label CASE is applied (DF capitalizes the leading verb); the exact native label
-- COMPOSITION for these two shops is NOT oracle-captured -> confidence 'derived-not-captured',
-- NOT-VERIFIED live. dynamic_shop_jobs is a chunk-level upvalue (defined above this IIFE).
local function entity_leaf(d, conf)
    local jf = d.job_fields or {}
    local jt_name = jf.job_type and df.job_type[jf.job_type]
    if not jt_name then return nil end
    local o = { def = d, confidence = conf or 'screenshot-verified' }
    if jf.item_type ~= nil then o.item_type = df.item_type[jf.item_type] end
    if jf.item_subtype ~= nil then o.item_subtype = jf.item_subtype end
    if jf.material_category then o.material_category = tostring(jf.material_category) end
    return leaf_job(cap(d.name or jt_name), jt_name, o)
end
-- BOWYER: a flat leaf-at-root tree. WS-BOWYERS-native.png confirms it EXACTLY -- two rows,
-- "Make bone crossbow" and "Make wooden crossbow", and no ammo of any kind. That is B255's fix
-- standing up to its first real oracle, so the confidence is no longer 'derived-not-captured'.
local function entity_flat_tree(b)
    local defs = dynamic_shop_jobs(b)
    if not defs then return nil end
    local out = {}
    for _, d in ipairs(defs) do
        local l = entity_leaf(d)
        if l then out[#out + 1] = l end
    end
    return cd_alpha_sort(out)
end
-- CLOTHIER (B266): three material submenus, nothing at the root. WS-CLOTHIERS-native-top.png shows
-- the ENTIRE top level is `cloth (opens menu)` / `silk (opens menu)` / `yarn (opens menu)`; each opens
-- the same 16 rows in that material. We were serving one flat list -- the wrong SHAPE, which is why
-- this is a structural fix and not a row fix. Leaves come from the same dynamic_shop_jobs defs the
-- flat/work-order surfaces use, so the two can never drift apart.
local function clothier_tree(b)
    local defs = dynamic_shop_jobs(b)
    if not defs then return nil end
    local by_cat = {}
    for _, d in ipairs(defs) do
        local cat = tostring((d.job_fields or {}).material_category or '')
        local l = entity_leaf(d)
        if l and #cat > 0 then
            by_cat[cat] = by_cat[cat] or {}
            table.insert(by_cat[cat], l)
        end
    end
    local root = {}
    for _, m in ipairs(CLOTHIER_MATS) do
        local leaves = by_cat[m.cat]
        if leaves and #leaves > 0 then
            root[#root + 1] = { kind = 'material_selector', label = m.word,
                confidence = 'screenshot-verified', leaves = cd_alpha_sort(leaves) }
        end
    end
    if #root == 0 then return nil end
    return root
end

-- dispatch: which shops get a native tree, keyed by shop_subtype_key.
function native_shop_is(b)
    local k = shop_subtype_key(b)
    return k == 'Smelter' or k == 'MagmaSmelter' or k == 'Craftsdwarfs' or k == 'Kennels'
        or k == 'Bowyers' or k == 'Clothiers'
end
-- Build the native add-task tree from scratch. Every branch derives ONLY from world raws + the fort
-- ENTITY (getJobs, the raws-reaction scans, itemdefs, the entity's permitted item defs) -- all FIXED
-- for a loaded world -- so the result is STATIC for the world session. It carries NO live fort state:
-- per-leaf availability is added later, separately, by annotate_native_avail.
local function native_build_tree(b)
    local k = shop_subtype_key(b)
    local bt, st = b:getType(), b:getSubtype()
    if k == 'Smelter' or k == 'MagmaSmelter' then return smelter_tree(bt, st) end
    if k == 'Craftsdwarfs' then return craftsdwarf_tree(bt, st) end
    if k == 'Kennels' then return kennels_tree() end
    if k == 'Clothiers' then return clothier_tree(b) end
    if k == 'Bowyers' then return entity_flat_tree(b) end
    return nil
end
-- B221 (workshop-stall): building native_build_tree scans EVERY raws reaction -- twice for the
-- craftsdwarf (INSTRUMENT_PIECE + INSTRUMENT), plus itemdefs -- and it runs under the request's full
-- CoreSuspender (GET /workshop-info -> run_lua_locked). On a real fort that exceeds the 1500 ms busy
-- watchdog, so EVERY player's world visibly freezes on every craftsdwarf open (misread as "saving",
-- B213). The tree is world-static (see native_build_tree), so cache it per (shop_key,type,subtype)
-- and skip the scan on repeat opens. Scope = the loaded save (cur_savegame.save_dir, the same save
-- identity menu_model.lua uses): raws never change within a world session, and a different save (or
-- reloading a new world without a plugin restart) rebuilds. The cache holds ONLY the static structure;
-- live per-leaf availability stays in annotate_native_avail (run fresh every open in workshop_info),
-- so served JSON is byte-identical to the un-cached path -- just without the per-open raws scan.
local _native_tree_cache = {}        -- [key] -> static tree (never carries live availability)
local _native_tree_cache_save = nil  -- save_dir the cached trees belong to (world-load scope guard)
function native_menu_tree(b)
    local save = G(function() return df.global.world.cur_savegame.save_dir end, nil) or ''
    if save ~= _native_tree_cache_save then   -- world changed (or first call): drop the whole cache
        _native_tree_cache = {}
        _native_tree_cache_save = save
    end
    local key = shop_subtype_key(b) .. ':' .. tostring(b:getType()) .. ':' .. tostring(b:getSubtype())
    local hit = _native_tree_cache[key]
    if hit ~= nil then return hit end
    local tree = native_build_tree(b)
    if tree ~= nil then _native_tree_cache[key] = tree end
    return tree
end

-- serialize the native tree (camelCase for the browser; matType/matIndex ride on leaves + selectors).
local function n_leaf_json(l)
    local p = { '"kind":' .. json_string(l.kind or 'job'), '"label":' .. json_string(l.label or '') }
    if l.job_type then p[#p + 1] = '"jobType":' .. json_string(l.job_type) end
    if l.item_type then p[#p + 1] = '"itemType":' .. json_string(tostring(l.item_type)) end
    if l.item_subtype ~= nil then p[#p + 1] = '"itemSubtype":' .. tostring(l.item_subtype) end
    if l.reaction_code then p[#p + 1] = '"reactionCode":' .. json_string(l.reaction_code) end
    if l.mat_type ~= nil then p[#p + 1] = '"matType":' .. tostring(l.mat_type) end
    if l.mat_index ~= nil then p[#p + 1] = '"matIndex":' .. tostring(l.mat_index) end
    if l.material_category then p[#p + 1] = '"materialCategory":' .. json_string(l.material_category) end
    if l.batch then p[#p + 1] = '"batch":' .. tostring(l.batch) end
    if l.avail ~= nil then p[#p + 1] = '"avail":' .. json_bool(l.avail) end   -- WP-2 availability bit
    if l.objection ~= nil then p[#p + 1] = '"objection":' .. json_string(l.objection) end
    if l.confidence then p[#p + 1] = '"confidence":' .. json_string(l.confidence) end
    return '{' .. table.concat(p, ',') .. '}'
end
local function n_node_json(node)
    if node.kind == 'material_selector' or node.kind == 'custom_category' then
        local p = { '"kind":' .. json_string(node.kind), '"label":' .. json_string(node.label or '') }
        if node.token then p[#p + 1] = '"token":' .. json_string(node.token) end
        if node.mat_type ~= nil then p[#p + 1] = '"matType":' .. tostring(node.mat_type) end
        if node.mat_index ~= nil then p[#p + 1] = '"matIndex":' .. tostring(node.mat_index) end
        if node.confidence then p[#p + 1] = '"confidence":' .. json_string(node.confidence) end
        local ls = {}
        for _, l in ipairs(node.leaves or {}) do ls[#ls + 1] = n_leaf_json(l) end
        p[#p + 1] = '"leaves":[' .. table.concat(ls, ',') .. ']'
        return '{' .. table.concat(p, ',') .. '}'
    end
    return n_leaf_json(node)
end
function native_tree_json(tree)
    if not tree then return 'null' end
    local rows = {}
    for _, n in ipairs(tree) do rows[#rows + 1] = n_node_json(n) end
    return '[' .. table.concat(rows, ',') .. ']'
end

-- queue a native leaf: rebuild the shop's tree, match the incoming t: key against each leaf's
-- composed key, and add the leaf's authoritative _def (real reagents) as a direct workshop job.
-- Reused by native_queue (defined after add_workshop_task, below). Exposed as an upvalue.
_native_find_def = function(b, task_key)
    local tree = native_menu_tree(b)
    if not tree then return nil end
    for _, node in ipairs(tree) do
        if node.kind == 'material_selector' or node.kind == 'custom_category' then
            local mat = (node.kind == 'material_selector') and node or nil
            for _, l in ipairs(node.leaves or {}) do
                if compose_key(l, mat) == task_key then return l._def end
            end
        elseif compose_key(node, nil) == task_key then
            return node._def
        end
    end
    return nil
end
end)()  -- end native-shop builder IIFE

-- ---------------------------------------------------------------------------------------------
-- TRUEMENU WP-2 (2026-07-08): per-leaf availability + native "[Requires X]" objection.
-- Native DF oranges an add-task leaf whose reagents have NO matching item in the fort and shows the
-- requirement of the LAST unmet reagent (raws order; fuel/coal reagents excluded). VERIFIED byte-exact
-- vs capture 30's 40 Smelter rows (SmeltOre "[Requires ore]"; flux "[Requires Flux boulders]";
-- metal-bar "[Requires <Metal> bars]"; ore "[Requires <Metal>-bearing boulders]"; coke "[Requires
-- Bituminous coal]"/"[Requires Lignite]"; adamantine "[Requires Adamantine strands]") + capture 28
-- instrument reactions "[Requires Metal metal bars]". Availability = presence-of-matching-materials
-- (DF's own orange trigger, NOT claimability -- a present-but-forbidden/in-use bar still counts;
-- B43 nuance). Computed SERVER-SIDE (proper thread) with ONE pass over IN_PLAY items + a raws
-- precompute, then O(1) per reagent (forge ~200 leaves, smelter ~22 reactions -> < 50ms serve
-- budget). FAIL-OPEN: any error leaves leaves un-annotated (client treats missing avail as available)
-- so a serve glitch never HIDES a queueable job. Wrapped in an IIFE (helper-local budget).
local annotate_forge_avail, annotate_native_avail
;(function()
local function G(fn, fb) local ok, v = pcall(fn); if ok then return v end return fb end
local function raws() return df.global.world.raws end
local INORGANIC = 0
local COAL_MAT = G(function() return df.builtin_mats.COAL end, nil)  -- fuel-bar material (skip in objection)
local function cap(s)  -- DF display uppercases the first byte: "copper" -> "Copper bars"
    s = tostring(s or ''); if #s == 0 then return s end
    local b = s:byte(1); if b >= 97 and b <= 122 then return string.char(b - 32) .. s:sub(2) end; return s
end
local function sname(idx)  -- inorganic solid state name ("iron","bituminous coal","copper")
    return G(function() return raws().inorganics.all[idx].material.state_name.Solid end, nil)
end

-- ONE pass over IN_PLAY: present bars/boulders/threads by inorganic index + any-metal-bar; then the
-- derived sets (which metals an on-hand ore yields; whether any flux boulder is present). Presence =
-- DF's orange trigger (item exists in play, forbidden/in-use or not -- mirrors native, not claimability).
local function build_presence()
    local P = { bar = {}, boulder = {}, thread = {}, any_metal_bar = false, metal_yielded = {}, flux_present = false,
                itype = {}, itype_sub = {} }
    local items = G(function() return df.global.world.items.other.IN_PLAY end, nil)
    if not items then return P end
    local BAR, BOULDER, THREAD = df.item_type.BAR, df.item_type.BOULDER, df.item_type.THREAD
    local n = G(function() return #items end, 0)
    for i = 0, n - 1 do
        local it = items[i]
        local ity = is_fort_stock_item(it, 'presence') and
                    G(function() return it:getType() end, nil) or nil
        -- B265: DF LISTS a job it cannot satisfy, reds it, and prints the unmet reagent underneath.
        -- To mirror that we need presence for EVERY reagent class the captures show (globs, plants,
        -- bags, sheets, windows, tool subtypes), not just the three metal-bearing ones WP-2 indexed.
        -- Same single pass -- one extra table write per item, so the serve budget is unchanged.
        if ity ~= nil then
            P.itype[ity] = true
            local sub = G(function() return it:getSubtype() end, nil)
            if sub ~= nil and sub >= 0 then P.itype_sub[tostring(ity) .. ':' .. tostring(sub)] = true end
        end
        if ity == BAR or ity == BOULDER or ity == THREAD then
            local mt = G(function() return it:getMaterial() end, -1)
            local mi = G(function() return it:getMaterialIndex() end, -1)
            local stack = G(function() return it.stack_size end, 1) or 1
            if mt == INORGANIC and mi >= 0 then
                if ity == BAR then
                    P.bar[mi] = (P.bar[mi] or 0) + stack
                    if not P.any_metal_bar and G(function() return raws().inorganics.all[mi].material.flags.IS_METAL end, false) then
                        P.any_metal_bar = true
                    end
                elseif ity == BOULDER then P.boulder[mi] = (P.boulder[mi] or 0) + stack
                else P.thread[mi] = (P.thread[mi] or 0) + stack end
            end
        end
    end
    for bidx, _ in pairs(P.boulder) do
        local rcv = G(function() return raws().inorganics.all[bidx].material.reaction_class end, nil)
        if rcv then local m = G(function() return #rcv end, 0)
            for k = 0, m - 1 do if G(function() return rcv[k] end, '') == 'FLUX' then P.flux_present = true break end end
        end
        local mo = G(function() return raws().inorganics.all[bidx].metal_ore.mat_index end, nil)
        if mo then local m = G(function() return #mo end, 0)
            for k = 0, m - 1 do local mm = G(function() return mo[k] end, nil); if mm then P.metal_yielded[mm] = true end end
        end
    end
    return P
end

-- B265 -- THE UNMET-REQUIREMENT GRAMMAR, and an honest statement of its limit.
--
-- WHAT DF EXPOSES. A reaction's reagents are fully readable (df.reaction.reagents: item_type,
-- item_subtype, mat_type/mat_index, reaction_class, has_material_reaction_product, flags), and
-- every RED row in all 30 captures is a raws REACTION -- not one hardcoded job row is ever red. So
-- the reason IS computable from data we can read, and the set of rows that need one is bounded.
--
-- WHAT DF DOES NOT EXPOSE. The ADJECTIVE DF prints for a reagent's reaction_class or material
-- reaction product ("paper-making" for PAPER_PLANT, "renderable" for RENDER_MAT, "fat" for FAT) is a
-- display string compiled into the DF binary. It is not in the raws and not in df-structures -- the
-- same wall that made these job lists unknowable in the first place. It cannot be derived; it can
-- only be READ OFF A CAPTURE. So the table below is capture-pinned, and a token that is NOT in it
-- yields a row that is still correctly RED, with the part of the requirement we can prove and no
-- invented adjective. We never guess a reason.
local RX_CLASS_ADJ = {         -- reaction_class  -> DF's printed adjective (from the captures)
    FAT = 'fat',               -- "Unrotten fat renderable glob"  (WS-KITCHEN)
    WAX = 'wax',               -- "Wax glob"                      (WS-CRAFTSDWARF-TOPLEVEL)
    PAPER_PLANT = 'paper-making', -- "Unrotten paper-making plant" (WS-FARMERS)
}
local RX_PRODUCT_ADJ = {       -- has_material_reaction_product -> DF's printed adjective
    RENDER_MAT = 'renderable', -- "Unrotten fat renderable glob"  (WS-KITCHEN)
}
-- Nouns DF prints for the item types the captures exercise. df.item_type's enum name is SHOUTY and
-- sometimes unlike the display word (BOX -> "bag"), so the ones we have ground truth for are pinned
-- and anything else falls back to the lowercased enum name.
local ITEM_NOUN = {
    GLOB = 'glob', PLANT = 'plant', SHEET = 'sheet', WINDOW = 'window', BOX = 'bag',
    BUCKET = 'bucket', THREAD = 'thread', CLOTH = 'cloth', BAR = 'bar', BOULDER = 'boulder',
}
local function item_noun(ity)
    local nm = G(function() return df.item_type[ity] end, nil)
    if not nm then return nil end
    return ITEM_NOUN[nm] or tostring(nm):lower():gsub('_', ' ')
end
-- Compose DF's requirement phrase for one reagent, e.g. "Unrotten fat renderable glob", "Empty bag",
-- "Scroll rollers", "Window", "Quicklime-containing item".
local function reagent_desc(rg, P)
    local ity = G(function() return rg.item_type end, -1)
    local isub = G(function() return rg.item_subtype end, -1)
    local mt = G(function() return rg.mat_type end, -1)
    local mi = G(function() return rg.mat_index end, -1)
    local rc = tostring(G(function() return rg.reaction_class end, '') or '')
    local mrp = tostring(G(function() return rg.has_material_reaction_product end, '') or '')
    -- a TOOL/subtype-bearing reagent is named by its itemdef ("scroll rollers", "book binding")
    local noun
    if ity == df.item_type.TOOL and isub ~= nil and isub >= 0 then
        noun = G(function() return raws().itemdefs.tools[isub].name end, nil)
    end
    -- a reagent pinned to ONE inorganic material and no useful item type reads "<Mat>-containing item"
    if not noun and mt == INORGANIC and mi ~= nil and mi >= 0 and (ity == nil or ity < 0 or ity == df.item_type.POWDER_MISC) then
        local s = sname(mi)
        if s then return cap(s) .. '-containing item' end
    end
    noun = noun or (ity ~= nil and ity >= 0 and item_noun(ity)) or nil
    if not noun then return nil end
    local parts = {}
    if G(function() return rg.flags.unrotten end, false) then parts[#parts + 1] = 'unrotten' end
    if G(function() return rg.flags.empty end, false) then parts[#parts + 1] = 'empty' end
    if #rc > 0 and RX_CLASS_ADJ[rc] then parts[#parts + 1] = RX_CLASS_ADJ[rc] end
    if #mrp > 0 and RX_PRODUCT_ADJ[mrp] then parts[#parts + 1] = RX_PRODUCT_ADJ[mrp] end
    parts[#parts + 1] = noun
    return cap(table.concat(parts, ' '))
end
-- Is a reagent satisfied? Presence-of-a-matching-item (DF's own red trigger, NOT claimability --
-- the WP-2/B43 nuance). NOTE the limit: we match on item TYPE (+ subtype), not on the reagent's
-- EMPTY / UNROTTEN / reaction_class predicates, because those need a per-item material walk we do
-- not do in the serve budget. So a fort holding a FULL bag reads as satisfying "Empty bag". That is
-- a FAIL-OPEN (we show white where DF shows red), never a fail-closed, and it never hides a
-- queueable job. Both are exactly right in the captures' bare fort, which holds neither.
local function reagent_present(rg, P)
    local ity = G(function() return rg.item_type end, -1)
    local isub = G(function() return rg.item_subtype end, -1)
    if ity == nil or ity < 0 then return nil end     -- "any item" -> not objection-reported
    if isub ~= nil and isub >= 0 then
        return P.itype_sub[tostring(ity) .. ':' .. tostring(isub)] == true
    end
    return P.itype[ity] == true
end

-- classify one reaction reagent -> present(bool), desc(string); or nil = SKIP (fuel/coal or a reagent
-- class DF doesn't objection-report -> excluded so we never emit a wrong requirement). Desc grammar
-- is capture-30/28 ground truth.
local function reagent_check(rg, P)
    local ity = G(function() return rg.item_type end, -1)
    local mt  = G(function() return rg.mat_type end, -1)
    local mi  = G(function() return rg.mat_index end, -1)
    local metal_ore = G(function() return rg.metal_ore end, -1)
    local rc = tostring(G(function() return rg.reaction_class end, '') or '')
    local BAR, BOULDER, THREAD = df.item_type.BAR, df.item_type.BOULDER, df.item_type.THREAD
    if COAL_MAT and mt == COAL_MAT then return nil end                      -- fuel bar: never reported (capture 30)
    if metal_ore and metal_ore >= 0 then                                    -- METAL_ORE:X -> "<Metal>-bearing boulders"
        return (P.metal_yielded[metal_ore] == true), cap(sname(metal_ore) or ('metal ' .. metal_ore)) .. '-bearing boulders'
    end
    if rc == 'FLUX' then return P.flux_present, 'Flux boulders' end          -- REACTION_CLASS:FLUX boulder
    if ity == BAR then
        if mt == INORGANIC and mi >= 0 then return ((P.bar[mi] or 0) > 0), cap(sname(mi) or ('metal ' .. mi)) .. ' bars' end
        return P.any_metal_bar, 'Metal metal bars'                          -- generic metal (instrument, capture 28)
    end
    if ity == THREAD then
        if mt == INORGANIC and mi >= 0 then return ((P.thread[mi] or 0) > 0), cap(sname(mi) or ('metal ' .. mi)) .. ' strands' end
        return nil
    end
    if ity == BOULDER then
        if mt == INORGANIC and mi >= 0 then return ((P.boulder[mi] or 0) > 0), cap(sname(mi) or ('stone ' .. mi)) end
        return nil
    end
    -- B265: everything else (globs, plants, bags, sheets, windows, tool subtypes, quicklime...).
    -- Before this, every one of these returned nil -- which is why NOT ONE of the nine RED rows in
    -- the captures rendered red for us: we skipped exactly the reagents DF objects about.
    local desc = reagent_desc(rg, P)
    if not desc then return nil end                                         -- unnameable -> skip (fail-open)
    local present = reagent_present(rg, P)
    if present == nil then return nil end
    return present, desc
end

-- objection for a df.reaction: DF reports the LAST unmet (objection-eligible) reagent (capture 30).
local function reaction_objection(r, P)
    local reg = G(function() return r.reagents end, nil)
    if not reg then return true, '' end
    local n = G(function() return #reg end, 0)
    local all_present, last_desc = true, nil
    for j = 0, n - 1 do
        local present, desc = reagent_check(reg[j], P)
        if desc ~= nil and not present then all_present = false; last_desc = desc end
    end
    if all_present or not last_desc then return true, '' end
    return false, '[Requires ' .. last_desc .. ']'
end

local function reaction_by_code()
    local map = {}
    local rs = G(function() return raws().reactions.reactions end, nil)
    if rs then local n = G(function() return #rs end, 0)
        for i = 0, n - 1 do local c = G(function() return rs[i].code end, nil); if c then map[tostring(c)] = rs[i] end end
    end
    return map
end

-- FORGE: metal-pinned job leaves consume bars of the pinned metal ("[Requires <Metal> bars]");
-- instrument-category reaction leaves consume generic metal bars ("[Requires Metal metal bars]").
annotate_forge_avail = function(root)
    if not root then return end
    pcall(function()
        local P = build_presence()
        local rbc  -- lazy reaction lookup (only if an instrument category is present)
        for _, cat in ipairs(root) do
            if cat.leaves then                                              -- leaf-only category (instruments, B41)
                rbc = rbc or reaction_by_code()
                for _, l in ipairs(cat.leaves) do
                    if l.kind == 'reaction' and l.reaction_code and rbc[l.reaction_code] then
                        l.avail, l.objection = reaction_objection(rbc[l.reaction_code], P)
                    else
                        l.avail = P.any_metal_bar
                        l.objection = P.any_metal_bar and '' or '[Requires Metal metal bars]'
                    end
                end
            elseif cat.metals then
                for _, m in ipairs(cat.metals) do
                    local mi = m.mat_index
                    local has = (mi ~= nil) and ((P.bar[mi] or 0) > 0) or false
                    local obj = has and '' or ('[Requires ' .. cap((mi ~= nil and sname(mi)) or 'metal') .. ' bars]')
                    for _, l in ipairs(m.leaves or {}) do l.avail = has; l.objection = obj end
                end
            end
        end
    end)
end

-- NATIVE shops: reaction leaves via their df.reaction reagents; SmeltOre = ore boulder presence
-- ("[Requires ore]"); Melt never objections (capture 30). Craftsdwarf rock/organic/decorate leaves
-- (organic reagents, NOT in the capture-30 oracle) are left un-annotated -> avail (NOT-VERIFIED).
-- B265 (flat shops): the farmer's, quern, ashery, kitchen, carpenter and the rest serve a FLAT task
-- list, and their RED rows are all raws reactions -- `Make sheet from plant`, `Process plant to bag`,
-- `Make milk of lime`, `Render fat`, `Make display case`. We rendered NONE of them: the flat path's
-- objection was a 3-way guess over item_type (wood / boulders / metal bars / "materials") that could
-- not name a bag, a sheet, a window or a glob, and it never even looked at a reaction's reagents.
-- One presence pass for the whole shop, then O(1) per reagent. Chunk-global on purpose: shop_tasks
-- is defined ABOVE this IIFE and resolves the name at call time.
function annotate_flat_avail(tasks)
    if not tasks then return end
    pcall(function()
        local need = false
        for _, t in ipairs(tasks) do
            if type(t.reaction) == 'string' and #t.reaction > 0 then need = true break end
            for _, c in ipairs(t.children or {}) do
                if type(c.reaction) == 'string' and #c.reaction > 0 then need = true break end
            end
            if need then break end
        end
        if not need then return end
        local P = build_presence()
        local rbc = reaction_by_code()
        local function annotate(t)
            local r = (type(t.reaction) == 'string' and #t.reaction > 0) and rbc[t.reaction] or nil
            if r then t.avail, t.objection = reaction_objection(r, P) end
        end
        for _, t in ipairs(tasks) do
            annotate(t)
            -- D3/D4: a container's children are reactions too -- they get the same B265 red state.
            for _, c in ipairs(t.children or {}) do annotate(c) end
        end
    end)
end

annotate_native_avail = function(root)
    if not root then return end
    pcall(function()
        local P = build_presence()
        local rbc = reaction_by_code()
        local function do_leaf(l)
            if l.reaction_code and rbc[l.reaction_code] then
                l.avail, l.objection = reaction_objection(rbc[l.reaction_code], P)
            elseif l.job_type == 'SmeltOre' and l.mat_index ~= nil then
                local has = (P.boulder[l.mat_index] or 0) > 0
                l.avail = has; l.objection = has and '' or '[Requires ore]'
            elseif l.job_type == 'MeltMetalObject' then
                l.avail = true; l.objection = ''
            end
        end
        for _, node in ipairs(root) do
            if node.leaves then for _, l in ipairs(node.leaves) do do_leaf(l) end else do_leaf(node) end
        end
    end)
end
end)()  -- end WP-2 availability IIFE

-- TRUEMENU WP-3 (2026-07-08): Workers-tab profile controls (audit rows 25-27).
-- workshop_profile is a plain struct on every workshop/furnace (df.building.xml): min_level/
-- max_level (int32 skill range, max_level sentinel 3000 = "no cap"), max_general_orders (int32),
-- blocked_labors (STATIC bool array indexed by df.unit_labor -- NOT a vector; blocking labor N is
-- profile.blocked_labors[N]=true), flags.block_general_orders. Read here, written by
-- workshop_profile_set (below). Fully nil/bounds-guarded (a bad index is rejected, never written).
function profile_blocked_labors_json(profile)
    local out = {}
    pcall(function()
        local bl = profile.blocked_labors
        if not bl then return end
        local n = #bl
        for i = 0, n - 1 do
            if bl[i] then
                local nm = df.unit_labor[i] or tostring(i)
                out[#out + 1] = '{"id":' .. i .. ',"name":' .. json_string(tostring(nm)) .. '}'
            end
        end
    end)
    return '[' .. table.concat(out, ',') .. ']'
end
function profile_general_orders_banned(profile)
    local v = false
    pcall(function() v = profile.flags and profile.flags.block_general_orders or false end)
    return v
end

-- B286: df-structures df.job.xml declares DestroyBuilding as the removal job, and
-- df.reference.xml declares its UNIT_WORKER ref. dfhack.job.getWorker resolves that ref: a worker
-- means removal is active; no worker means the exact B286-1 state "Removal inactive.". The active
-- copy has not been captured, so the boolean is still emitted but its display string stays empty.
function building_removal_state(b)
    if not b or not b.jobs then return false, false end
    for i = 0, #b.jobs - 1 do
        local job = b.jobs[i]
        if job and job.job_type == df.job_type.DestroyBuilding then
            local active = false
            pcall(function() active = dfhack.job.getWorker(job) ~= nil end)
            return true, active
        end
    end
    return false, false
end

function workshop_info(id)
    wtrace('workshop_info: ENTER id=' .. tostring(id))   -- DIAG: logged BEFORE get_shop (fishery hunt)
    local ok_gs, b = pcall(get_shop, id)
    if not ok_gs then
        wtrace('workshop_info: get_shop THREW id=' .. tostring(id) .. ': ' .. tostring(b))
        return '{"ok":false,"error":"get_shop error"}\n'
    end
    if not b then
        local okr, raw = pcall(df.building.find, tonumber(id) or -1)
        wtrace('workshop_info: get_shop NIL id=' .. tostring(id) ..
            ' rawType=' .. tostring(okr and raw and raw:getType()) ..
            ' isWkshop=' .. tostring(okr and raw and df.building_workshopst:is_instance(raw)) ..
            ' isFurnace=' .. tostring(okr and raw and df.building_furnacest:is_instance(raw)))
        return '{"ok":false,"error":"workshop not found"}\n'
    end
    wtrace('workshop_info: id=' .. tostring(id))   -- DIAG (crash hunt)
    local profile = b.profile or {}
    local marked_for_removal, removal_active = building_removal_state(b)
    local defs     = ws_section('shop_job_defs',     function() return shop_job_defs(b) end, {})
    local tasks    = ws_section('shop_tasks',        function() return shop_tasks(b, defs) end, {})
    -- B265: give the flat list DF's real "[Requires X]" line for every reaction row it can't run.
    ws_section('annotate_flat_avail', function() annotate_flat_avail(tasks); return true end, false)
    local order_tasks = ws_section('shop_order_tasks', function() return shop_order_tasks(defs) end, {})
    local j_jobs   = ws_section('shop_jobs_json',    function() return shop_jobs_json(b) end, '[]')
    local j_tasks  = ws_section('shop_tasks_json',   function() return shop_tasks_json(tasks) end, '[]')
    local j_order_tasks = ws_section('shop_order_tasks_json', function() return shop_order_tasks_json(order_tasks) end, '[]')
    local j_orders = ws_section('shop_orders_json',  function() return shop_orders_json(b.id) end, '[]')
    local j_items  = ws_section('shop_items_json',   function() return shop_items_json(b) end, '[]')
    local j_workers= ws_section('shop_workers_json', function() return shop_workers_json(b) end, '[]')
    -- TRUEMENU WP-1: nested forge add-task tree (category -> metal -> leaf) for the two forges;
    -- null elsewhere (client falls back to the flat `tasks` picker). Additive: `tasks` unchanged.
    -- native tree: non-null also for Smelter/MagmaSmelter/Craftsdwarfs/Kennels,
    -- whose native add-task menu is NOT the flat getJobs list. Computed once so canAddTasks can flip
    -- true even when the flat `tasks` list is empty (Kennels getJobs=0).
    local native_root = ws_section('native_menu_tree', function()
        if native_shop_is(b) then return native_menu_tree(b) end
        return nil
    end, nil)
    local j_tree = ws_section('forge_task_tree', function()
        local bt, st = forge_bt_st(b)
        if bt then
            local root = select(1, forge_task_tree(bt, st))
            annotate_forge_avail(root)   -- WP-2: per-leaf availability + "[Requires X]" objection
            return ft_tree_json(root)
        end
        if native_root then
            annotate_native_avail(native_root)   -- WP-2 (Smelter/MagmaSmelter reactions + SmeltOre)
            return native_tree_json(native_root)
        end
        return 'null'
    end, 'null')
    wtrace('workshop_info: assemble')   -- DIAG
    local parts = {
        '"ok":true',
        '"id":' .. tostring(b.id),
        '"name":' .. json_string(ws_safe_str(function() return building_label(b) end, 'Workshop')),
        '"kind":' .. json_string(ws_safe_str(function() return shop_kind(b) end, 'Workshop')),
        '"subtype":' .. json_string(ws_safe_str(function() return shop_subtype_key(b) end, '')),
        '"x":' .. tostring(b.centerx or b.x1 or 0),
        '"y":' .. tostring(b.centery or b.y1 or 0),
        '"z":' .. tostring(b.z or 0),
        '"jobs":' .. j_jobs,
        '"tasks":' .. j_tasks,
        '"orderTasks":' .. j_order_tasks,
        '"taskTree":' .. j_tree,
        '"taskSelectionUnits":{"EngraveSlab":' .. ws_section('memorial_task_units', memorial_task_units_json, '[]') .. '}',
        '"orders":' .. j_orders,
        '"items":' .. j_items,
        '"profile":{"maxGeneralOrders":' .. tostring(profile.max_general_orders or 0) ..
            ',"permittedCount":' .. tostring((profile.permitted_workers and #profile.permitted_workers) or 0) ..
            ',"minLevel":' .. tostring(profile.min_level or -1) ..
            ',"maxLevel":' .. tostring(profile.max_level or -1) ..
            ',"generalOrdersBanned":' .. json_bool(profile_general_orders_banned(profile)) ..
            ',"blockedLabors":' .. profile_blocked_labors_json(profile) .. '}',
        '"workers":' .. j_workers,
        '"linkedStockpiles":' .. ws_section('shop_linked_stockpiles', function() return shop_linked_stockpiles_json(b) end, '[]'),
        '"built":' .. json_bool((function() local ok, v = pcall(function() return b:getBuildStage() >= b:getMaxBuildStage() end); return ok and v end)()),
        '"markedForRemoval":' .. json_bool(marked_for_removal),
        '"removalActive":' .. json_bool(removal_active),
        '"removalStatus":' .. json_string(marked_for_removal and 'Slated for removal' or ''),
        '"removalActivityStatus":' .. json_string(marked_for_removal and not removal_active and 'Removal inactive.' or ''),
        '"canAddTasks":' .. json_bool(#tasks > 0 or (native_root ~= nil and #native_root > 0)),
    }
    return '{' .. table.concat(parts, ',') .. '}\n'
end

function find_shop_job(b, job_id)
    job_id = tonumber(job_id)
    if not b or not job_id then return nil end
    for i = 0, #b.jobs - 1 do
        local job = b.jobs[i]
        if job and job.id == job_id then return job end
    end
    return nil
end

function workshop_job_action(id, job_id, action)
    local b = get_shop(id)
    if not b then return false, 'workshop not found' end
    local job = find_shop_job(b, job_id)
    if not job then return false, 'job not found in workshop' end
    action = tostring(action or '')
    if action == 'cancel' then
        local ok, err = pcall(dfhack.job.removeJob, job)
        if not ok then return false, tostring(err) end
        return true, ''
    elseif action == 'suspend' then
        job.flags.suspend = true
    elseif action == 'resume' then
        job.flags.suspend = false
    elseif action == 'repeat' then
        job.flags['repeat'] = not job.flags['repeat']
    elseif action == 'now' then
        job.flags.do_now = true
    elseif action == 'priority' then
        -- B121: native's per-task priority IS the do_now flag; unlike 'now' (kept set-only for
        -- deployed-client compat) this TOGGLES it so the client's "!" button can un-prioritize.
        job.flags.do_now = not job.flags.do_now
    else
        return false, 'unknown job action'
    end
    pcall(dfhack.job.checkBuildingsNow)
    return true, ''
end

function task_material_categories(def)
    local seen, out = {}, {}
    local function add(name)
        if name and not seen[name] then
            seen[name] = true
            table.insert(out, name)
        end
    end
    for _, item_def in ipairs((def and def.items) or {}) do
        if item_def.item_type == df.item_type.WOOD or item_def.vector_id == df.job_item_vector_id.WOOD then
            add('wood')
        elseif item_def.vector_id == df.job_item_vector_id.PLANT or item_def.item_type == df.item_type.PLANT then
            add('plant')
        elseif item_def.item_type == df.item_type.THREAD then
            add('plant')
        end
    end
    return #out > 0 and out or nil
end

function create_shop_order_from_task(b, def, amount, frequency)
    if not b then return false, 'workshop not found' end
    if not def then return false, 'task not found' end
    local job_fields = def.job_fields or {}
    local job_type = job_fields.job_type
    if not job_type or not df.job_type[job_type] then return false, 'task has no manager-order job type' end

    local order_def = {
        amount_total = clamp(tonumber(amount) or 1, 1, 9999),
        frequency = tostring(frequency or 'OneTime'),
        workshop_id = b.id,
    }
    if not df.workquota_frequency_type[order_def.frequency] then order_def.frequency = 'OneTime' end
    -- job is the STRING name (workorder's ensure_df_id accepts string or int; string matches the
    -- proven Manager create_order). material_category restored so the order shows its material.
    local job_name = (type(job_type) == 'string') and job_type or df.job_type[job_type]
    if job_name == 'CustomReaction' then
        if not job_fields.reaction_name or #job_fields.reaction_name == 0 then
            return false, 'custom reaction task has no reaction code'
        end
        order_def.job = 'CustomReaction'
        order_def.reaction = job_fields.reaction_name
    else
        order_def.job = job_name
    end

    local cats = task_material_categories(def)
    if cats then order_def.material_category = cats end

    local ok_req, wo = pcall(reqscript, 'workorder')
    if not ok_req or not wo then return false, 'workorder module unavailable' end
    wtrace('create_shop_order: job=' .. tostring(order_def.job) ..
        ' mat_cat=' .. tostring(order_def.material_category and 'set' or 'nil'))   -- DIAG (crash hunt)
    local ok, err = pcall(function()
        local orders = wo.preprocess_orders({order_def})
        wtrace('create_shop_order: preprocess ok, fillin_defaults')   -- DIAG
        wo.fillin_defaults(orders)
        wtrace('create_shop_order: fillin ok, create_orders')   -- DIAG
        wo.create_orders(orders, true)
        wtrace('create_shop_order: create_orders ok')   -- DIAG
    end)
    if not ok then return false, tostring(err) end
    return true, 'shop work order queued'
end

-- Turn a workshops.getJobs() item-filter table into a real df.job_item (the reagent
-- requirement DF gathers materials against). input_filter_defaults is exactly a job_item
-- template, so we only copy the fields that are present and leave job_item's own defaults
-- for the rest (clobbering with nil/wrong values causes "unknown material" + uncompletable jobs).
function build_job_item(item_def)
    local ji = df.job_item:new()
    if item_def.item_type ~= nil then ji.item_type = item_def.item_type end
    if item_def.item_subtype ~= nil then ji.item_subtype = item_def.item_subtype end
    if item_def.mat_type ~= nil then ji.mat_type = item_def.mat_type end
    if item_def.mat_index ~= nil then ji.mat_index = item_def.mat_index end
    if item_def.quantity ~= nil then ji.quantity = item_def.quantity end
    if item_def.vector_id ~= nil then ji.vector_id = item_def.vector_id end
    if item_def.reaction_class ~= nil then ji.reaction_class = item_def.reaction_class end
    if item_def.has_material_reaction_product ~= nil then ji.has_material_reaction_product = item_def.has_material_reaction_product end
    if item_def.metal_ore ~= nil then ji.metal_ore = item_def.metal_ore end
    if item_def.min_dimension ~= nil then ji.min_dimension = item_def.min_dimension end
    if item_def.has_tool_use ~= nil then ji.has_tool_use = item_def.has_tool_use end
    if type(item_def.flags1) == 'table' then for k, v in pairs(item_def.flags1) do pcall(function() ji.flags1[k] = v end) end end
    if type(item_def.flags2) == 'table' then for k, v in pairs(item_def.flags2) do pcall(function() ji.flags2[k] = v end) end end
    if type(item_def.flags3) == 'table' then for k, v in pairs(item_def.flags3) do pcall(function() ji.flags3[k] = v end) end end
    if type(item_def.flags4) == 'number' then ji.flags4 = item_def.flags4 end
    if type(item_def.flags5) == 'number' then ji.flags5 = item_def.flags5 end
    return ji
end

-- DIAG (material hunt): dump every job of a given type with the exact fields DF's namer reads,
-- so a natively-queued bed (shows "Make bed") can be compared field-by-field with ours
-- (shows "Make unknown material bed"). REMOVE once the field difference is found + fixed.
function dump_jobs_of_type(jt)
    local link = df.global.world.jobs.list.next
    while link do
        local j = link.item
        if j and j.job_type == jt then
            local okn, nm = pcall(dfhack.job.getName, j)
            wtrace(string.format('DUMP-JOB id=%s mat_type=%s mat_index=%s item_type=%s item_subtype=%s specflag=%s matcat=%s njobitems=%s name=%s',
                tostring(j.id), tostring(j.mat_type), tostring(j.mat_index),
                tostring(j.item_type), tostring(j.item_subtype),
                tostring(j.specflag.whole), tostring(j.material_category.whole),
                tostring(#j.job_items.elements), tostring(okn and nm or 'ERR')))
        end
        link = link.next
    end
end

-- Add a SINGLE direct job to the workshop building (exactly what DF's "Add new task" does):
-- not a manager work order. Direct jobs need no manager, use the building's real reagent
-- filters (so dwarves gather "any wood" etc.), and show the correct material -- which also
-- fixes the "Make unknown material X" jobs the manager-order path produced.
function add_workshop_task(b, def, unit_id)
    local job_fields = def.job_fields or {}
    local job_type = job_fields.job_type
    if not job_type or not df.job_type[job_type] then return false, 'task has no job type' end
    if job_type == df.job_type.CustomReaction and (not job_fields.reaction_name or #job_fields.reaction_name == 0) then
        return false, 'custom reaction task has no reaction code'
    end

    local job = df.job:new()
    job.job_type = job_type
    job.completion_timer = -1
    job.pos.x = b.centerx or b.x1 or 0
    job.pos.y = b.centery or b.y1 or 0
    job.pos.z = b.z or 0
    -- product material: -1 means "decided by the gathered reagent" (the normal case, e.g. a bed
    -- takes the wood it's made from); only jobs that hardcode a material set job_fields.mat_type.
    job.mat_type = job_fields.mat_type or -1
    job.mat_index = job_fields.mat_index or -1
    -- B01: material_category drives DF's "<material> crafts/toy/..." caption (verified live). Our
    -- supplemental craftsdwarf jobs carry it so a queued task reads "Make bone crafts" etc. instead
    -- of "Make unknown material crafts".
    if job_fields.material_category then
        pcall(function() job.material_category[job_fields.material_category] = true end)
    end
    -- B01-residue: subtype jobs (weapons/armor/ammo/clothing) carry the product item_type +
    -- item_subtype (the itemdef index), exactly as DF sets a forge MakeWeapon/MakeArmor job so the
    -- gathered reagent is turned into that specific weapon/armor piece.
    if job_fields.item_type ~= nil then pcall(function() job.item_type = job_fields.item_type end) end
    if job_fields.item_subtype ~= nil then pcall(function() job.item_subtype = job_fields.item_subtype end) end
    if job_type == df.job_type.CustomReaction then
        job.reaction_name = job_fields.reaction_name
    end
    if job_type == df.job_type.EngraveSlab then
        local unit = unit_id and df.unit.find(tonumber(unit_id)) or nil
        if not unit or (unit.hist_figure_id or -1) < 0 or not dfhack.units.isDead(unit) then
            job:delete()
            return false, 'EngraveSlab requires a dead or missing unitId'
        end
        job.hist_figure_id = unit.hist_figure_id
    end

    -- link the job to the building, then append the reagent requirements.
    job.general_refs:insert('#', { new = df.general_ref_building_holderst, building_id = b.id })
    b.jobs:insert('#', job)
    wtrace('add_task: job_type=' .. tostring(df.job_type[job_type]) .. ' job.mat_type=' .. tostring(job.mat_type) ..
        ' #def.items=' .. tostring(def.items and #def.items or 0))   -- DIAG (material hunt)
    for i, item_def in ipairs(def.items or {}) do
        wtrace('add_task: item[' .. i .. '] item_type=' .. tostring(item_def.item_type) ..
            ' mat_type=' .. tostring(item_def.mat_type) .. ' vector_id=' .. tostring(item_def.vector_id) ..
            ' quantity=' .. tostring(item_def.quantity))   -- DIAG
        job.job_items.elements:insert('#', build_job_item(item_def))
    end
    wtrace('add_task: built #job_items=' .. tostring(#job.job_items.elements))   -- DIAG
    local ok_nm, nm = pcall(dfhack.job.getName, job)
    wtrace('add_task: getName=' .. tostring(ok_nm and nm or 'ERR'))   -- DIAG

    local ok, err = pcall(dfhack.job.linkIntoWorld, job, true)
    if not ok then
        -- back out the half-built job: drop the building's reference, then free the job
        -- (which owns the building-holder ref and the job_items we inserted).
        pcall(function() b.jobs:erase(#b.jobs - 1) end)
        pcall(function() job:delete() end)
        return false, 'could not link job: ' .. tostring(err)
    end
    pcall(dfhack.job.checkBuildingsNow)
    if DWF_DIAG then
        pcall(dump_jobs_of_type, job_type)   -- DIAG: dump ALL jobs of this type (native + ours) to compare
    end
    return true, 'task added'
end

-- TRUEMENU WP-1: a forge-tree leaf key the client composes from the served tree, self-describing so
-- NO C++ change is needed (it rides the same `task` query param). Grammar (pipe-delimited):
--   t:<JobType>[|it:<ItemType>][|st:<subtype>][|mat:<matType>:<matIndex>][|rc:<reactionCode>][|b:<batch>]
-- e.g. "t:MakeWeapon|it:WEAPON|st:1|mat:0:0"  (Forge iron battle axe),
--      "t:ConstructTable|mat:0:12"            (Make gold table),
--      "t:CustomReaction|rc:MAKE_ENT291 INP2_BODY"  (an instrument-piece reaction).
-- The `mat` pins BOTH the product material and the specific metal-bar reagent -> per-metal forging
-- (kills the any-metal divergence, audit row 17). Reaction leaves reuse the proven getJobs def
-- (full reagent set) looked up by reaction code.
function parse_tree_task_key(task)
    if type(task) ~= 'string' or task:sub(1, 2) ~= 't:' then return nil end
    local out = {}
    local first = true
    for field in (task .. '|'):gmatch('([^|]*)|') do
        if first then
            out.job_type_name = field:sub(3)   -- strip "t:"
            first = false
        elseif field:sub(1, 3) == 'it:' then out.item_type_name = field:sub(4)
        elseif field:sub(1, 3) == 'st:' then out.item_subtype = tonumber(field:sub(4))
        elseif field:sub(1, 4) == 'mat:' then
            local mt, mi = field:sub(5):match('^(%-?%d+):(%-?%d+)$')
            if mt then out.mat_type = tonumber(mt); out.mat_index = tonumber(mi) end
        elseif field:sub(1, 4) == 'cat:' then out.material_category = field:sub(5)
        elseif field:sub(1, 3) == 'rc:' then out.reaction_code = field:sub(4)
        elseif field:sub(1, 2) == 'b:' then out.batch = tonumber(field:sub(3))
        end
    end
    return out
end

function add_tree_task(b, task)
    local p = parse_tree_task_key(task)
    if not p or not p.job_type_name then return false, 'malformed tree task key' end
    local job_type = df.job_type[p.job_type_name]
    if job_type == nil then return false, 'unknown job type: ' .. tostring(p.job_type_name) end

    -- Reaction leaf: reuse the fully-formed getJobs def (its reagents are authoritative) matched by
    -- reaction code, so instrument reactions gather the right materials.
    if p.reaction_code and #p.reaction_code > 0 then
        local defs = shop_job_defs(b)
        for _, def in pairs(defs) do
            local jf = type(def) == 'table' and def.job_fields or nil
            if jf and jf.reaction_name and tostring(jf.reaction_name) == p.reaction_code then
                return add_workshop_task(b, def)
            end
        end
        -- fall back to a minimal reaction def (reagents resolved by DF from the reaction code)
        return add_workshop_task(b, { job_fields = { job_type = df.job_type.CustomReaction, reaction_name = p.reaction_code }, items = {} })
    end

    -- Hardcoded forge job: pin product material + a specific metal-bar reagent (per-metal forging).
    local jf = { job_type = job_type }
    if p.item_type_name then jf.item_type = df.item_type[p.item_type_name] end
    if p.item_subtype ~= nil then jf.item_subtype = p.item_subtype end
    local items = {}
    if p.mat_type ~= nil and p.mat_index ~= nil then
        jf.mat_type = p.mat_type
        jf.mat_index = p.mat_index
        -- forge reagent = one bar of exactly this metal (INORGANIC/mat_index), mirroring DF's own
        -- "Forge <metal> X" job. flags3.metal is redundant with the pinned mat but harmless.
        items[#items + 1] = { item_type = df.item_type.BAR, mat_type = p.mat_type, mat_index = p.mat_index,
            flags3 = { metal = true }, quantity = 1 }
    end
    return add_workshop_task(b, { job_fields = jf, items = items })
end

-- Queue a native-shop leaf. Rebuild the shop's native tree, match the incoming
-- t: key against each leaf's composed key, and add the leaf's authoritative _def (real reagents:
-- getJobs melt/smelt/reaction defs for the Smelter, boulder/cloth/bone reagents for the Craftsdwarf)
-- as a direct workshop job -- so the queued job gathers exactly what DF's own menu would.
function native_queue(b, task_key)
    local def = _native_find_def(b, task_key)
    if def then return add_workshop_task(b, def) end
    -- reaction leaves whose _def was absent (getJobs miss) still queue via the reaction-code path.
    local p = parse_tree_task_key(task_key)
    if p and p.reaction_code and #p.reaction_code > 0 then return add_tree_task(b, task_key) end
    return false, 'native task not found'
end

function workshop_add_job(id, task_key, unit_id)
    local b = get_shop(id)
    if not b then return false, 'workshop not found' end
    -- TRUEMENU WP-1: forge drill-down leaves send a self-describing 't:' key (per-metal).
    if type(task_key) == 'string' and task_key:sub(1, 2) == 't:' then
        -- Native flat/mixed shops resolve the leaf's real def (correct reagents)
        -- instead of the forge's BAR-reagent reconstruction.
        if native_shop_is(b) then return native_queue(b, task_key) end
        return add_tree_task(b, task_key)
    end
    local defs = shop_job_defs(b)
    local def = defs[tostring(task_key)]
    if not def then return false, 'task not found' end
    -- Tasks tab = a single direct workshop job (NOT a manager work order). Work orders are created
    -- separately via the Work Orders tab / create_order.
    return add_workshop_task(b, def, unit_id)
end

function workshop_worker_action(id, unit_id, assign)
    local b = get_shop(id)
    if not b then return false, 'workshop not found' end
    local profile = b.profile
    if not profile then return false, 'workshop has no profile' end
    unit_id = tonumber(unit_id)
    if not unit_id or not df.unit.find(unit_id) then return false, 'unit not found' end
    local vec = profile.permitted_workers
    local found = -1
    for i = 0, #vec - 1 do
        if vec[i] == unit_id then found = i; break end
    end
    if assign and found < 0 then
        vec:insert('#', unit_id)
    elseif not assign and found >= 0 then
        vec:erase(found)
    end
    return true, ''
end

function workshop_workers_clear(id)
    local b = get_shop(id)
    if not b then return false, 'workshop not found' end
    if not b.profile then return false, 'workshop has no profile' end
    b.profile.permitted_workers:resize(0)
    return true, ''
end

-- TRUEMENU WP-3: write one workshop_profile control (audit rows 25-27). ONE field per call,
-- mirroring workshop_worker_action's route/bridge shape. Every write is clamped to a legal range
-- (min<=max skill level in [0,3000]; general orders [0,10]; labor index bounds-checked against the
-- static array length) so a raw curl POST can never write an out-of-range value DF's Workers tab
-- would misrender or that would index past blocked_labors. Runs on the sim thread (run_lua_locked).
--   field: minLevel | maxLevel | maxGeneralOrders | blockLabor | unblockLabor | banGeneralOrders
--   value: integer (skill level / order cap / df.unit_labor index / 0|1 for the ban flag)
function workshop_profile_set(id, field, value)
    local b = get_shop(id)
    if not b then return false, 'workshop not found' end
    local profile = b.profile
    if not profile then return false, 'workshop has no profile' end
    field = tostring(field or '')
    value = tonumber(value)
    if value == nil then return false, 'missing/invalid value' end
    local function clampi(v, lo, hi)
        v = math.floor(v)
        if v < lo then return lo elseif v > hi then return hi end
        return v
    end
    if field == 'minLevel' then
        local v = clampi(value, 0, 3000)
        profile.min_level = v
        if (profile.max_level or 3000) < v then profile.max_level = v end   -- keep min<=max
        return true, ''
    elseif field == 'maxLevel' then
        local v = clampi(value, 0, 3000)
        profile.max_level = v
        if (profile.min_level or 0) > v then profile.min_level = v end
        return true, ''
    elseif field == 'maxGeneralOrders' then
        profile.max_general_orders = clampi(value, 0, 10)
        return true, ''
    elseif field == 'blockLabor' or field == 'unblockLabor' then
        local idx = math.floor(value)
        local n = 0
        local okn = pcall(function() n = #profile.blocked_labors end)
        if not okn or idx < 0 or idx >= n then return false, 'labor index out of range' end
        profile.blocked_labors[idx] = (field == 'blockLabor')
        return true, ''
    elseif field == 'banGeneralOrders' then
        local ok = pcall(function() profile.flags.block_general_orders = (value ~= 0) end)
        if not ok then return false, 'cannot set general-order ban' end
        return true, ''
    end
    return false, 'unknown profile field: ' .. field
end

function find_order(id)
    id = tonumber(id)
    if not id then return nil end
    local all = df.global.world.manager_orders.all
    for i = 0, #all - 1 do
        local o = all[i]
        if o and o.id == id then return o end
    end
    return nil
end

-- Create one manager order from a catalog key. The key is 'j:<job>'/'r:<reaction>' with optional
-- product fields '|it:<item type>|st:<subtype>' and material '|cat:<category>' or
-- '|mat:<type>:<index>'. B22: an order that DF's own namer would call "unknown material" is
-- REJECTED here, so neither the browser picker nor a raw curl can create an illegal order.
function create_order(key, amount, frequency, workshop_id)
    key = tostring(key or '')
    local fields = {}
    for field in key:gmatch('[^|]+') do fields[#fields + 1] = field end
    local base = fields[1] or ''
    local jname = base:match('^j:(.+)$')
    local rcode = base:match('^r:(.+)$')
    local def_job, def_reaction, job_type_val
    if jname then
        job_type_val = df.job_type[jname]
        if job_type_val == nil then return false, 'unknown job: ' .. jname end
        -- D8 defence-in-depth: a raw POST cannot create an order for a job that needs a selection the
        -- key cannot carry (EngraveSlab wants a specific dead historical figure -- see the
        -- ORDER_EXCLUDED_JOBS note). Neither picker offers it; nothing else may sneak it in.
        if ORDER_EXCLUDED_JOBS[job_type_val] then
            return false, 'this job is queued from the workshop, not as a work order'
        end
        def_job = jname
    elseif rcode then
        if not reaction_exists(rcode) then return false, 'unknown reaction: ' .. rcode end
        def_reaction = rcode
    else
        return false, 'unknown order key: ' .. key
    end

    -- Parse product + material choices. Multiple suffixes are needed for MakeTool orders, e.g.
    -- j:MakeTool|it:TOOL|st:17|cat:wood. Legacy material-only keys remain byte-for-byte valid.
    local mat_cat, mat_type, mat_index, item_type_val, item_subtype
    for i = 2, #fields do
        local field = fields[i]
        local c = field:match('^cat:(.+)$')
        local mt, mi = field:match('^mat:(-?%d+):(-?%d+)$')
        local it = field:match('^it:([%w_]+)$')
        local st = field:match('^st:(-?%d+)$')
        if c and not mat_cat and mat_type == nil then mat_cat = c
        elseif mt and not mat_cat and mat_type == nil then mat_type, mat_index = tonumber(mt), tonumber(mi)
        elseif it and item_type_val == nil then
            item_type_val = df.item_type[it]
            if item_type_val == nil or item_type_val == df.item_type.NONE then
                return false, 'bad item type: ' .. it
            end
        elseif st and item_subtype == nil then item_subtype = tonumber(st)
        else return false, 'bad or duplicate order spec: ' .. field end
    end

    -- SAFETY: subtype-bearing jobs may reach DF's namer only with a real, matching itemdef.
    -- manager_order.h and workorder.lua both carry item_type/item_subtype explicitly.
    if def_job and job_is_subtype_bearing(job_type_val) then
        local expected = df.job_type.attrs[job_type_val] and df.job_type.attrs[job_type_val].item
        item_type_val = item_type_val or expected
        if item_subtype == nil or item_subtype < 0 then
            return false, 'pick the specific item'
        end
        if expected == nil or item_type_val ~= expected then
            return false, 'item type does not match job'
        end
        local item_name = df.item_type[item_type_val]
        local def_class = item_name and df['itemdef_' .. item_name:lower() .. 'st'] or nil
        local ok_def, itemdef = pcall(function() return def_class and def_class.find(item_subtype) end)
        if not ok_def or not itemdef then return false, 'unknown item subtype' end
    elseif item_type_val ~= nil or item_subtype ~= nil then
        return false, 'item subtype is not valid for this job'
    end

    -- LEGALITY GATE (getManagerOrderName-safe by construction): ask DF's OWN namer on a throwaway
    -- manager order carrying the resolved material; reject anything it calls "unknown material"
    -- (exactly B22's poison). No subtype-required job reaches here, so the namer is safe to call;
    -- the temp order is deleted, never inserted into world.manager_orders.
    do
        local ok_probe, probe_name = pcall(function()
            local t = df.manager_order:new()
            t.job_type = def_reaction and df.job_type.CustomReaction or job_type_val
            if def_reaction then t.reaction_name = def_reaction end
            if item_type_val ~= nil then t.item_type = item_type_val end
            if item_subtype ~= nil then t.item_subtype = item_subtype end
            t.mat_type = mat_type or -1
            t.mat_index = mat_index or -1
            if mat_cat then pcall(function() t.material_category[mat_cat] = true end) end
            local nm = dfhack.job.getManagerOrderName(t)
            t:delete()
            return nm
        end)
        if ok_probe and type(probe_name) == 'string'
           and probe_name:lower():find('unknown material') then
            return false, 'this order needs a material -- pick one'
        end
    end

    amount = clamp(tonumber(amount) or 1, 1, 9999)
    frequency = tostring(frequency or 'OneTime')
    if not df.workquota_frequency_type[frequency] then frequency = 'OneTime' end

    local def = {amount_total = amount, frequency = frequency}
    local wid = tonumber(workshop_id)
    if wid and wid >= 0 then
        if not df.building.find(wid) then return false, 'workshop not found' end
        def.workshop_id = wid
    end
    if def_reaction then
        def.job = 'CustomReaction'
        def.reaction = def_reaction
    else
        def.job = def_job
    end
    if item_type_val ~= nil then def.item_type = df.item_type[item_type_val] end
    if item_subtype ~= nil then def.item_subtype = item_subtype end
    if mat_cat then def.material_category = { mat_cat } end   -- workorder.lua sets the bit

    -- snapshot existing ids BEFORE creating, so we can (a) return the newly-created order id(s)
    -- for WP-C/WT06 attribution and (b) find them to apply a specific-material set. Unconditional
    -- now (was mat_type-only); the diff is cheap and both consumers need it.
    local before = {}
    do
        local all = df.global.world.manager_orders.all
        for i = 0, #all - 1 do local o = all[i]; if o then before[o.id] = true end end
    end

    local ok_req, wo = pcall(reqscript, 'workorder')
    if not ok_req or not wo then return false, 'workorder module unavailable' end
    local ok, err = pcall(function()
        local orders = wo.preprocess_orders({def})
        wo.fillin_defaults(orders)
        wo.create_orders(orders, true)
    end)
    if not ok then return false, tostring(err) end

    -- collect the newly created order id(s); apply the specific material to them when one was
    -- chosen. (workorder.lua's it["material"] takes only a matinfo token; we set the fields
    -- directly to avoid token-format ambiguity.)
    local new_ids = {}
    do
        local all = df.global.world.manager_orders.all
        for i = 0, #all - 1 do
            local o = all[i]
            if o and not before[o.id] then
                new_ids[#new_ids + 1] = o.id
                if mat_type then
                    pcall(function() o.mat_type = mat_type; o.mat_index = mat_index end)
                end
            end
        end
    end
    return true, 'order queued', new_ids
end

-- ---------------------------------------------------------------------------
-- B285 wave-2: the condition EDITOR write path.
--
-- NO permission gates here -- the explicit decision ("groups of friends ... there does not need
-- to be much security at all"). What stays STRICT is data validation, because it is correctness,
-- not security: a bad item_type/mat index written into a df::manager_order_condition_item is read
-- by DF's DAILY condition check and can misbehave/crash far from the write. Every write goes
-- through validate_item_condition_input, which resolves each field against DF's real enums and
-- registries and refuses malformed input with a clear error.
-- ---------------------------------------------------------------------------

-- Adjective keys the editor may write. '' = none. Accepts a comma-separated list (the /orders
-- serializer emits condition_adjective_key(c) that way, so an edit round-trips losslessly).
-- 'empty' is the native barrel/bin/bucket bit (job_item_flags1.empty, df.d_basics.xml:2812); it is
-- deliberately NOT in CONDITION_ADJECTIVES (that table also drives display iteration, which
-- special-cases empty), so it is resolved explicitly here.
local function resolve_condition_adjectives(adjective)
    local specs = {}
    for key in tostring(adjective or ''):gmatch('[^,]+') do
        local spec
        if key == 'empty' then
            spec = { 'flags1', 'empty' }
        else
            spec = CONDITION_ADJECTIVES[key]
        end
        if not spec then return nil, 'bad adjective: ' .. tostring(key) end
        specs[#specs + 1] = spec
    end
    return specs
end

-- Validate the FULL state of a stock condition. Returns a resolved table, or nil + error.
-- compare must be one of DF's 6 real logic_condition_type values (df.workquota.xml:2); the NONE
-- sentinel (-1) and unknown names are refused. material must decode through DF's own material
-- registry (dfhack.matinfo) -- a syntactically valid "mt:mi" pair that names no real material is
-- refused, never written.
local function validate_item_condition_input(compare, value, item_name, material, adjective)
    local ctype = df.logic_condition_type[tostring(compare or '')]
    if ctype == nil or ctype < 0 then return nil, 'bad comparison: ' .. tostring(compare) end
    local v = tonumber(value)
    if v == nil then return nil, 'bad value: ' .. tostring(value) end
    v = clamp(math.floor(v), 0, 999999)
    local it = df.item_type.NONE
    if item_name and item_name ~= '' then
        local resolved = df.item_type[tostring(item_name)]
        if resolved == nil then return nil, 'bad item type: ' .. tostring(item_name) end
        it = resolved
    end
    local mt, mi = -1, -1
    if material and material ~= '' then
        local a, b = tostring(material):match('^(-?%d+):(-?%d+)$')
        if not a then return nil, 'bad material: ' .. tostring(material) end
        mt, mi = tonumber(a), tonumber(b)
        local okm, info = pcall(dfhack.matinfo.decode, mt, mi)
        if not okm or not info then return nil, 'bad material: ' .. tostring(material) end
    end
    local specs, aerr = resolve_condition_adjectives(adjective)
    if not specs then return nil, aerr end
    return { compare = ctype, value = v, item = it, mat_type = mt, mat_index = mi,
             adjectives = specs }
end

-- Add a stock condition: "amount of [adjective] [material] <item_name> <compare> <value>".
-- material = "matType:matIndex" (optional), adjective = comma-separated validated keys (optional).
-- Allocation: df.manager_order_condition_item:new() + item_conditions:insert('#', c) is this
-- repo's established pattern for DF-owned structs from lua (same shape add_order_condition uses
-- below; it mirrors DFHack's own orders plugin). The C++-side analogue is fort_admin.cpp's
-- create_assignment (new df::entity_position_assignment + push_back onto the DF-owned vector).
function add_item_condition(order_id, compare, value, item_name, material, adjective)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    local spec, verr = validate_item_condition_input(compare, value, item_name, material, adjective)
    if not spec then return false, verr end
    local c = df.manager_order_condition_item:new()
    local ok, err = pcall(function()
        c.compare_type = spec.compare
        c.compare_val = spec.value
        c.item_type = spec.item
        c.item_subtype = -1
        c.mat_type = spec.mat_type
        c.mat_index = spec.mat_index
        c.min_dimension = -1
        c.reaction_id = -1
        -- CRITICAL: these have NO init-value in df-structures, so :new() leaves them at 0 -- but DF's
        -- "any" sentinel is -1. Left at 0 the condition means "metal ore #0 / dye color #0 / tool-use
        -- LIQUID_COOKING", which DF's condition checker crashes on. Set them to the proper -1/NONE.
        c.metal_ore = -1
        c.has_tool_use = -1   -- df.tool_uses.NONE
        c.dye_color = -1
        for _, adj in ipairs(spec.adjectives) do c[adj[1]][adj[2]] = true end
        local candidate_label = item_condition_label(c)
        for i = 0, #o.item_conditions - 1 do
            local existing = o.item_conditions[i]
            if existing and item_condition_label(existing) == candidate_label then
                c:delete()
                c = nil
                return
            end
        end
        o.item_conditions:insert('#', c)
    end)
    if not ok then pcall(function() c:delete() end); return false, tostring(err) end
    if not c then return true, 'condition already exists' end
    return true, 'condition added'
end

-- Edit a stock condition IN PLACE (value/comparison/target mutate the existing entry -- native
-- behaviour; the row keeps its position and identity). The request carries the condition's FULL
-- new state and is validated exactly like an add. Only the adjective bits this editor owns
-- (CONDITION_ADJECTIVES + empty) are cleared/rewritten; any other DF-set filter fields
-- (reaction_class, contains, dimensions, ...) survive untouched.
function edit_item_condition(order_id, idx, compare, value, item_name, material, adjective)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    idx = tonumber(idx)
    if not idx or idx < 0 or idx >= #o.item_conditions then return false, 'bad condition index' end
    local spec, verr = validate_item_condition_input(compare, value, item_name, material, adjective)
    if not spec then return false, verr end
    local c = o.item_conditions[idx]
    if not c then return false, 'bad condition index' end
    local ok, err = pcall(function()
        c.compare_type = spec.compare
        c.compare_val = spec.value
        if c.item_type ~= spec.item then c.item_subtype = -1 end -- subtype belongs to the old type
        c.item_type = spec.item
        c.mat_type = spec.mat_type
        c.mat_index = spec.mat_index
        c.flags1.empty = false
        for _, s in pairs(CONDITION_ADJECTIVES) do c[s[1]][s[2]] = false end
        for _, adj in ipairs(spec.adjectives) do c[adj[1]][adj[2]] = true end
    end)
    if not ok then return false, tostring(err) end
    return true, 'condition updated'
end

-- Materials available in the fort for a given condition item type (for the condition "Mat" picker).
-- item_name is an item_type enum name (e.g. "BAR", "BOULDER"); empty = across all item types.
function condition_materials(item_name)
    local it = nil
    if item_name and item_name ~= '' then it = df.item_type[tostring(item_name)] end
    local items_vec = df.global.world.items.other.IN_PLAY
    local groups, order = {}, {}
    for ii = 0, #items_vec - 1 do
        local item = items_vec[ii]
        if is_fort_stock_item(item, 'condition-material') and
           (it == nil or item:getType() == it) then
            local mt, mi = item:getMaterial(), item:getMaterialIndex()
            if mt and mt >= 0 then
                local key = tostring(mt) .. ':' .. tostring(mi)
                local g = groups[key]
                if not g then
                    local nm = ''
                    local okm, info = pcall(dfhack.matinfo.decode, mt, mi)
                    if okm and info then
                        local oks, s = pcall(function() return info:toString() end)
                        if oks and s then nm = s end
                    end
                    g = { mat_type = mt, mat_index = mi, name = nm, count = 0 }
                    groups[key] = g
                    table.insert(order, key)
                end
                g.count = g.count + (item.stack_size or 1)
            end
        end
    end
    table.sort(order, function(a, b) return (groups[a].name or '') < (groups[b].name or '') end)
    local mats = {}
    for _, key in ipairs(order) do
        local g = groups[key]
        table.insert(mats, '{"matType":' .. tostring(g.mat_type) ..
            ',"matIndex":' .. tostring(g.mat_index) ..
            ',"name":' .. json_string((g.name ~= '' and g.name) or ('material ' .. key)) ..
            ',"count":' .. tostring(g.count) .. '}')
    end
    return '{"ok":true,"materials":[' .. table.concat(mats, ',') .. ']}\n'
end

-- DF's complete suggested filters exist only as transient native condition-editor state. DFHack
-- does not expose a lossless offscreen product-filter provider: workflow.listJobOutputs() drops
-- flags, strings, contains, reaction fields, tool use, and dye colour, and diverges for several
-- job families. A single observed MakeBarrel case therefore cannot authorize a general provider.
-- Fail closed until the server can return an opaque token bound to a same-order render-thread
-- snapshot of DF's own vector. Never reconstruct an addable filter from browser-visible prose.
function suggested_conditions(order_id)
    local o = find_order(order_id)
    if not o then return '{"ok":false,"suggestions":[]}\n' end
    return '{"ok":true,"authoritative":false,"deferred":true,"suggestions":[]}\n'
end

-- Add a dependency: this order runs only after <other_id> is Activated/Completed.
function add_order_condition(order_id, other_id, cond_type)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    local other = find_order(other_id)
    if not other then return false, 'target order not found' end
    if other.id == o.id then return false, 'an order cannot depend on itself' end
    local ct = df.workquota_order_condition_type[tostring(cond_type or 'Completed')]
    if ct == nil then return false, 'bad condition type' end
    for i = 0, #o.order_conditions - 1 do
        local existing = o.order_conditions[i]
        if existing and existing.order_id == other.id and existing.condition == ct then
            return true, 'dependency already exists'
        end
    end
    local c = df.manager_order_condition_order:new()
    local ok, err = pcall(function()
        c.order_id = other.id
        c.condition = ct
        o.order_conditions:insert('#', c)
    end)
    if not ok then pcall(function() c:delete() end); return false, tostring(err) end
    return true, 'dependency added'
end

-- Remove a condition by index. kind = 'item' or 'order'. Erases the pointer (no
-- delete) the same way cancel_order does -- safe, tiny leak.
function remove_condition(order_id, kind, idx)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    idx = tonumber(idx)
    local vec = (tostring(kind) == 'order') and o.order_conditions or o.item_conditions
    if not idx or idx < 0 or idx >= #vec then return false, 'bad condition index' end
    vec:erase(idx)
    return true, 'condition removed'
end

-- Limit how many workshops fill this order at once (0 = unlimited).
function set_order_max_workshops(order_id, max)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    o.max_workshops = clamp(tonumber(max) or 0, 0, 30)
    return true, 'updated'
end

-- Assign an order to one workshop/furnace. workshop_id < 0 clears the assignment.
function set_order_workshop(order_id, workshop_id)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    local wid = tonumber(workshop_id) or -1
    if wid >= 0 and not df.building.find(wid) then return false, 'workshop not found' end
    o.workshop_id = wid
    return true, 'updated'
end

-- Move an order up (dir<0) or down (dir>0) in the manager queue (= priority).
function reorder_order(order_id, dir)
    local all = df.global.world.manager_orders.all
    order_id = tonumber(order_id)
    local idx = nil
    for i = 0, #all - 1 do
        if all[i].id == order_id then idx = i; break end
    end
    if idx == nil then return false, 'order not found' end
    local j = idx + ((tonumber(dir) or 0) < 0 and -1 or 1)
    if j < 0 or j >= #all then return false, 'cannot move further' end
    local moved = all[idx]
    all:erase(idx)
    all:insert(j, moved)
    return true, 'reordered'
end

-- Import a shipped/saved order preset by name (e.g. "library/basic"). Returns (ok, msg).
function import_order_preset(name)
    name = tostring(name or '')
    if #name == 0 then return false, 'no preset name' end
    local before = #df.global.world.manager_orders.all
    local ok, err = pcall(dfhack.run_command, 'orders', 'import', name)
    if not ok then return false, tostring(err) end
    local added = #df.global.world.manager_orders.all - before
    return true, ('imported %d order(s) from %s'):format(added, name)
end

-- List shipped presets without invoking another DFHack command during panel load.
function order_presets()
    local out = {
        json_string('library/basic'),
        json_string('library/furnace'),
        json_string('library/glassstock'),
        json_string('library/military'),
        json_string('library/rockstock'),
        json_string('library/smelting'),
    }
    return '{"ok":true,"presets":[' .. table.concat(out, ',') .. ']}\n'
end

-- Cancel (remove) a manager order by id. Mirrors workorder.lua's own erase path.
function cancel_order(id)
    id = tonumber(id)
    if not id then return false, 'bad id' end
    local all = df.global.world.manager_orders.all
    for i = #all - 1, 0, -1 do
        if all[i].id == id then
            all:erase(i)
            return true, ''
        end
    end
    return false, 'order not found'
end

-- Change an order's target amount and/or frequency. Returns (ok, msg).
function adjust_order(id, amount, frequency)
    id = tonumber(id)
    if not id then return false, 'bad id' end
    local all = df.global.world.manager_orders.all
    for i = 0, #all - 1 do
        local o = all[i]
        if o and o.id == id then
            local a = tonumber(amount)
            if a and a >= 0 then
                o.amount_total = clamp(a, 0, 9999)
                o.amount_left = o.amount_total
            end
            if frequency ~= nil and frequency ~= '' then
                local f = df.workquota_frequency_type[tostring(frequency)]
                if f then o.frequency = f end
            end
            return true, ''
        end
    end
    return false, 'order not found'
end

-- ---------------------------------------------------------------------------
-- WT26 -- DFHack command console (browser gui/launcher equivalent)
-- ---------------------------------------------------------------------------
-- SECURITY: the BLOCKLIST LIVES IN C++ (src/console_policy.h), not here. It is enforced twice on
-- the way in -- once in the POST /console/run handler (console_routes.cpp) and once again in the
-- console_run_via_lua bridge fn (lua_bridge.cpp) -- BOTH calling the single
-- dwf::console::command_denied table, and it applies to EVERY caller including the host.
-- Nothing reaches console_run() below that has not already cleared that gate. Do NOT add a second,
-- divergent deny table here: one table, two enforcement sites, is the whole design.
--
-- The catalog is helpdb's own -- literally the data DFHack's native autocomplete ranks against
-- (helpdb.get_commands() = "a list of all commands. used by Core's autocomplete functionality").
-- It is STATIC for a play session, so the client fetches it ONCE and does search-as-you-type
-- entirely offline: no per-keystroke round-trip and, crucially, no per-keystroke CoreSuspender.
-- Only EXECUTING a command touches the core lock.

-- Cap what a single command may hand back. `lua`-class output is unbounded and would cross the
-- wire whole; anything huge is truncated with an explicit marker rather than silently cut.
local CONSOLE_OUTPUT_CAP = 64 * 1024

function console_catalog()
    local helpdb = require('helpdb')
    local out = {}
    for _, name in ipairs(helpdb.get_commands()) do
        local short = ''
        local ok, s = pcall(helpdb.get_entry_short_help, name)
        if ok and type(s) == 'string' then short = s end
        out[#out + 1] = '{"name":' .. json_string(name) .. ',"short":' .. json_string(short) .. '}'
    end
    return '{"ok":true,"commands":[' .. table.concat(out, ',') .. ']}\n'
end

-- Run one already-gate-cleared command line and hand back its captured console text.
-- Returns (status:int, text:string). status: 0 = CR_OK (DFHack's command_result convention);
-- any non-zero is DFHack's own failure code, passed through untouched.
--
-- THE HARD LIMITATION (spec 2026-07-13-dfhack-gui-launcher-spec.md section 7, surfaced to the owner and
-- accepted): dfhack.run_command_silent -> internal.runCommand takes its OWN CoreSuspender, so the
-- command runs synchronously with DF's core lock held for its entire duration and CANNOT be
-- interrupted. There is no cooperative cancellation point, hence no server-side timeout can abort a
-- runaway command. Containment is PREVENTION (the C++ blocklist), not recovery -- and the client
-- states this in the panel before you press Run.
function console_run(cmd)
    cmd = tostring(cmd or '')
    if cmd:match('^%s*$') then return -1, 'empty command' end
    local ok, output, status = pcall(dfhack.run_command_silent, cmd)
    if not ok then
        -- `output` is the pcall error here.
        return -1, tostring(output)
    end
    output = tostring(output or '')
    if #output > CONSOLE_OUTPUT_CAP then
        output = output:sub(1, CONSOLE_OUTPUT_CAP) ..
            '\n... (output truncated at ' .. CONSOLE_OUTPUT_CAP .. ' bytes)'
    end
    return tonumber(status) or 0, output
end

function safe_json(fn)
    return function(...)
        local ok, result = pcall(fn, ...)
        if ok then return result end
        return '{"ok":false,"error":' .. json_string(result) .. '}\n'
    end
end

-- B228 (missions): bring home squads DF stranded. DF has a long-standing bug where a squad sent on
-- a mission ends up on an army whose controller pointer is null (army.controller_id ~= 0 and
-- army.controller == nil) -- those dwarves never come back and the fort keeps counting them.
--
-- We do NOT reimplement the repair. DFHack ships it (scripts/fix/stuck-squad.lua, declared
-- `--@ module=true`), and its unstick_armies() is the only tested code anywhere that touches the
-- squad <-> army <-> army_controller links. reqscript() loads that module and dfhack.run_script
-- runs the very same entry point the `fix/stuck-squad` command runs; scan_fort_armies() is its
-- exported pre-check, so we can tell the player WHY it will refuse instead of running it blind.
--
-- Returns (rescued:int, text:string). rescued >= 0 = how many stranded squads were carried home;
-- rescued < 0 = a refusal, with the script's own reason in `text` (never a message we invented).
function missions_rescue_stuck()
    local ok, mod = pcall(reqscript, 'fix/stuck-squad')
    if not ok or not mod or type(mod.scan_fort_armies) ~= 'function' then
        return -1, 'DFHack fix/stuck-squad is not available in this DFHack build'
    end
    local scanned, stuck, returning = pcall(mod.scan_fort_armies)
    if not scanned then
        return -1, tostring(stuck)
    end
    local stuck_n = stuck and #stuck or 0
    if stuck_n == 0 then
        return -1, 'No stranded squads to rescue.'
    end
    if not returning then
        return -1, 'No army or messenger is on its way home, so there is nothing to carry them ' ..
            'back. Send a squad or a messenger on a mission that returns, and rescue once they ' ..
            'have turned for home.'
    end
    -- run_script goes through DFHack's own script runner, so the repair executes exactly as it
    -- does from the console; qerror() inside it surfaces here as a pcall failure, not a crash.
    local ran, err = pcall(dfhack.run_script, 'fix/stuck-squad')
    if not ran then
        return -1, tostring(err)
    end
    local left = select(1, mod.scan_fort_armies())
    local remaining = left and #left or 0
    return stuck_n - remaining,
        ('fix/stuck-squad: %d stranded squad(s) found, %d rescued.'):format(stuck_n, stuck_n - remaining)
end

order_catalog = safe_json(order_catalog)
order_catalog_by_shop = safe_json(order_catalog_by_shop)
condition_targets = safe_json(condition_targets)
order_workshops = safe_json(order_workshops)
list_orders = safe_json(list_orders)
order_presets = safe_json(order_presets)
workshop_info = safe_json(workshop_info)
burial_coffin_info = safe_json(burial_coffin_info)
console_catalog = safe_json(console_catalog)

-- ================================================================================================
-- HOST-WRITES (B226 browser barter / B227 justice convict+interrogate)
--
-- Design principle: THE PLUGIN NEVER HAND-WRITES a trade or conviction record. Both write-sets
-- are DF-native object graphs (item ownership/trader flags + caravan value counters + entity
-- resources + history events for barter; crime.punishment + plotinfo.punishments + a
-- history_event_hf_convictedst for conviction) that even DFHack itself never reconstructs --
-- its own trade UI (scripts/internal/caravan/trade.lua) only flips selection bits and leaves the
-- barter to the native button, and no DFHack API convicts anyone. Instead we drive the NATIVE
-- code through the same channels a local player uses:
--
--   * selection state (trade.goodflag[side][idx].selected, widget cursor_idx, scroll) is plain
--     UI state -- DFHack's caravan/sort/confirm tools write these exact fields routinely;
--   * the commits (barter confirm, conviction) are delivered by calling the native viewscreen's
--     feed() with the real interface keys / enabler mouse state -- the byte-identical path a
--     local keyboard+mouse takes (gui.simulateInput; precedent: DFHack ci/test.lua clicks
--     native title-screen buttons, scripts/hide-tutorials.lua clicks native popups).
--
-- So every record written during a barter or conviction is written BY DWARF FORTRESS, with all
-- of its invariants. The plugin's failure mode is "nothing happened + an honest error", never a
-- half-written record.
--
-- Runtime guards: risky steps stay OFF until host-side live probes verify them on the
-- host (file dfcapture-hostwrites.json next to the DF exe; see hw_flags below). The guarded
-- endpoints return {"guarded":true} with a plain-English reason until then. The probe list lives
-- in docs/superpowers/specs/2026-07-14-hostwrites-B226-B227.md (internal spec; see docs/NAMING.md).
-- ================================================================================================

local hw_gui = require('gui')
local hw_json = require('json')

-- ---- runtime guard flags -----------------------------------------------------------------------
-- dfcapture-hostwrites.json, next to the DF executable, host-controlled (NOT settable over HTTP;
-- a browser-flippable guard would not be a guard). Orchestrator flips a flag to true after the
-- matching probe passes. Missing file = everything guarded.
--   { "trade_select": true,      -- goodflag selection writes (DFHack-parity; default-on if file exists)
--     "trade_confirm": true,     -- clicking Trade / Offer / Seize on the native trade screen
--     "trade_open": true,        -- opening the native trade screen by state-write (probe P-T1)
--     "justice_convict": true,   -- the full native convict drive (probes P-J1..P-J3)
--     "justice_interrogate": true,
--     "click_without_text_assert": true }  -- only if probe P-T3 finds screen text unreadable
function hw_flags()
    local path = dfhack.getDFPath() .. '/dfcapture-hostwrites.json'
    local f = io.open(path, 'r')
    if not f then return {} end
    local text = f:read('*a')
    f:close()
    local ok, data = pcall(hw_json.decode, text)
    if ok and type(data) == 'table' then return data end
    return {}
end

local function hw_flag(name)
    local flags = hw_flags()
    return flags[name] == true
end

local function hw_err(msg)
    return '{"ok":false,"error":' .. json_string(msg) .. '}\n'
end

local function hw_guarded(flag, what)
    return '{"ok":false,"unsupported":true,"guarded":true,"flag":' .. json_string(flag) ..
        ',"error":' .. json_string(what .. ' is implemented but locked behind the host-side ' ..
        'verification probe (flag "' .. flag .. '" in dfcapture-hostwrites.json). The host ' ..
        'owner runs the probe on the live fort and unlocks it; until then this action ' ..
        'must be done at the host keyboard.') .. '}\n'
end

local function hw_retry(stage)
    return '{"ok":false,"retry":true,"stage":' .. json_string(stage) .. '}\n'
end

-- ---- native input delivery ----------------------------------------------------------------------
-- All of these end in viewscreen::feed() on the DF viewscreen -- the native input path. No OS
-- input is synthesized (no cursor moves, no focus theft; operator-at-keyboard rule intact).

local function hw_screen()
    return dfhack.gui.getDFViewscreen(true)
end

local function hw_feed(key)
    hw_gui.simulateInput(hw_screen(), key)
end

-- Click at UI-grid tile (x, y). Same recipe as DFHack ci/test.lua click_top_title_button and
-- scripts/hide-tutorials.lua: gps mouse tile+pixel coords, then _MOUSE_L through feed().
local function hw_click_at(x, y)
    local gps = df.global.gps
    gps.mouse_x, gps.mouse_y = x, y
    gps.precise_mouse_x = x * gps.tile_pixel_x
    gps.precise_mouse_y = y * gps.tile_pixel_y
    hw_gui.simulateInput(hw_screen(), '_MOUSE_L')
end

local function hw_click_rect_center(x1, y1, x2, y2)
    hw_click_at(math.floor((x1 + x2) / 2), math.floor((y1 + y2) / 2))
end

-- DFHack's `confirm` overlay intercepts exactly the inputs we feed (convict SELECT/_MOUSE_L,
-- trade-confirm/offer/seize clicks) and would swallow them into a dialog no remote player can
-- see. Temporarily disable the named specs around fn, restoring after. If confirm isn't
-- installed/enabled this is a no-op.
local function hw_with_confirms_disabled(ids, fn)
    local ok_req, confirm = pcall(dfhack.reqscript, 'confirm')
    local restore = {}
    if ok_req and confirm and confirm.get_conf_data and confirm.set_enabled then
        local want = {}
        for _, id in ipairs(ids) do want[id] = true end
        local ok_data, data = pcall(confirm.get_conf_data)
        if ok_data and type(data) == 'table' then
            for _, conf in pairs(data) do
                if type(conf) == 'table' and want[conf.id] and conf.enabled then
                    restore[#restore + 1] = conf.id
                    pcall(confirm.set_enabled, conf.id, false)
                end
            end
        end
    end
    local ok, err = pcall(fn)
    for _, id in ipairs(restore) do
        pcall(confirm.set_enabled, id, true)
    end
    if not ok then error(err) end
end

-- ---- screen geometry + text ---------------------------------------------------------------------

-- Replicates DFHack gui.get_interface_rect() (library/lua/gui.lua:124): the UI grid area the
-- native interface (and the confirm plugin's intercept frames) are laid out against.
local function hw_interface_rect()
    local sw, sh = dfhack.screen.getWindowSize()
    local l, w = 0, sw
    local pct = df.global.init.display.max_interface_percentage
    if pct < 100 then
        local iw = math.max(114, sw * pct / 100)
        l = math.ceil((sw - iw) / 2)
        w = math.floor(iw)
    end
    return l, 0, w, sh
end

-- Native trade-screen button rects, replicated from DFHack's confirm plugin intercept frames
-- (scripts/internal/confirm/specs.lua: trade-confirm-trade / trade-offer / trade-seize), which
-- ship as correct for DF 53.15. Frame spec semantics per gui.compute_frame_rect: l&r both set ->
-- horizontally centered in [l, W-r]; only b set -> bottom-anchored.
local HW_TRADE_BUTTONS = {
    trade = { l = 0, r = 23, b = 4, w = 11, h = 3, label = 'trade' },
    offer = { l = 40, r = 5, b = 4, w = 19, h = 3, label = 'offer' },
    seize = { l = 0, r = 73, b = 4, w = 11, h = 3, label = 'seize' },
}

local function hw_button_rect(spec)
    local il, it, iw, ih = hw_interface_rect()
    local sw = iw - spec.l - spec.r
    local sh = ih - (spec.t or 0) - spec.b
    local rqw = math.min(sw, spec.w)
    local rqh = math.min(sh, spec.h)
    local ax = math.floor((sw - rqw) * 0.5) -- l and r both present -> centered
    local ay = sh - rqh                     -- b only -> bottom
    local x1 = il + spec.l + ax
    local y1 = it + (spec.t or 0) + ay
    return x1, y1, x1 + rqw - 1, y1 + rqh - 1
end

local function hw_rect_text(x1, y1, x2, y2)
    local lines = {}
    for y = y1, y2 do
        local chars = {}
        for x = x1, x2 do
            local ok, pen = pcall(dfhack.screen.readTile, x, y)
            local c = ok and pen and pen.ch or 0
            chars[#chars + 1] = (c >= 32 and c < 127) and string.char(c) or ' '
        end
        lines[#lines + 1] = table.concat(chars)
    end
    return table.concat(lines, '\n')
end

-- Find a word on the interface grid (case-insensitive); returns center tile or nil.
local function hw_find_screen_text(word, y_from, y_to)
    local il, it, iw, ih = hw_interface_rect()
    y_from = y_from or it
    y_to = y_to or (ih - 1)
    local needle = word:lower()
    for y = y_from, y_to do
        local row = hw_rect_text(il, y, il + iw - 1, y):lower()
        local s = row:find(needle, 1, true)
        if s then
            return il + s - 1 + math.floor(#needle / 2), y
        end
    end
    return nil
end

-- ---- widget-tree helpers (DF 53.15 widget UI) ----------------------------------------------------

local function hw_widget_visible(w)
    -- Gui.cpp get_visible_child parity: ACTIVE + VISIBLE = actually visible.
    local ok, vis = pcall(function()
        return w.flag.VISIBILITY_ACTIVE and w.flag.VISIBILITY_VISIBLE
    end)
    return ok and vis or false
end

local function hw_visible_child(container)
    local ok, n = pcall(function() return #container.children end)
    if not ok then return nil end
    for i = 0, n - 1 do
        local c = container.children[i]
        if c and hw_widget_visible(c) then return c end
    end
    return nil
end

-- Depth-first hunt for the first widget_scroll_rows in a subtree, skipping subtrees rooted at a
-- widget named skip_name (used to find the open-cases case list without wandering into the
-- Right panel's own scroll lists).
local function hw_find_scroll_rows(w, skip_name, depth)
    depth = depth or 0
    if not w or depth > 8 then return nil end
    if skip_name and w.name == skip_name then return nil end
    if df.widget_scroll_rows and df.widget_scroll_rows:is_instance(w) then return w end
    -- widget_radio_rows carries its scroll_rows as a compound field, not a child.
    if df.widget_radio_rows and df.widget_radio_rows:is_instance(w) then return w.rows end
    local ok, n = pcall(function() return #w.children end)
    if ok then
        for i = 0, n - 1 do
            local found = hw_find_scroll_rows(w.children[i], skip_name, depth + 1)
            if found then return found end
        end
    end
    return nil
end

local function hw_widget_json(w, depth, max_depth)
    if not w then return 'null' end
    depth = depth or 0
    local parts = {}
    local function put(k, v) parts[#parts + 1] = '"' .. k .. '":' .. v end
    put('name', json_string(w.name or ''))
    put('type', json_string(tostring(w._type):gsub('^<type: ', ''):gsub('>$', '')))
    local ok_rect, rect = pcall(function() return w.rect end)
    if ok_rect and rect then
        put('rect', string.format('[%d,%d,%d,%d]', rect.x1, rect.y1, rect.x2, rect.y2))
    end
    put('visible', json_bool(hw_widget_visible(w)))
    local ok_cur, cur = pcall(function() return w.cursor_idx end)
    if ok_cur and cur ~= nil then put('cursorIdx', tostring(cur)) end
    local ok_scroll, scroll = pcall(function() return w.scroll end)
    if ok_scroll and scroll ~= nil then put('scroll', tostring(scroll)) end
    local ok_hk, hk = pcall(function()
        local keys = {}
        for _, k in ipairs(w.activation_hotkeys) do keys[#keys + 1] = json_string(df.interface_key[k] or tostring(k)) end
        return keys
    end)
    if ok_hk and hk and #hk > 0 then put('hotkeys', '[' .. table.concat(hk, ',') .. ']') end
    local ok_n, n = pcall(function() return #w.children end)
    if ok_n and n > 0 then
        if depth >= (max_depth or 8) then
            put('children', tostring(n))
        else
            local kids = {}
            for i = 0, math.min(n, 60) - 1 do
                kids[#kids + 1] = hw_widget_json(w.children[i], depth + 1, max_depth)
            end
            put('children', '[' .. table.concat(kids, ',') .. ']')
        end
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

-- Probe instrument: dump a named widget tree as JSON. GET /justice-convict?widgets=1 serves this.
function hw_widget_dump(which)
    local mi = df.global.game.main_interface
    local root
    if which == 'justice' then root = mi.info.justice
    elseif which == 'info' then root = mi.info
    else return hw_err('unknown widget root: ' .. tostring(which)) end
    return '{"ok":true,"root":' .. json_string(which) .. ',"tree":' .. hw_widget_json(root, 0, 8) .. '}\n'
end

-- ================================================================================================
-- B226: the native trade screen (game.main_interface.trade, df.d_interface.xml:871)
-- ================================================================================================

local function hw_trade()
    return df.global.game.main_interface.trade
end

local function hw_trade_focus_ok()
    return dfhack.gui.matchFocusString('dwarfmode/Trade', hw_screen())
end

-- B226 trade-screen enrichment (all reads, all pcall-guarded, all ADDITIVE -- an older client
-- ignores the extra keys; a newer client falls back gracefully when a key is absent):
--   * per-row weight (mirrors src/interaction.cpp item_weight_text: weight_computed -> whole /
--     "<1" fraction, else getBaseWeight; the fraction is served so the client can do the
--     footer Allowed/Excess-Weight arithmetic the native bottom bar shows),
--   * per-row group = the df.item_type key (native's panel group headers -- Bars / Cut gems /
--     ... -- follow item-type runs in the native list order),
--   * per-row spriteRef in the same four-field shape the stock-item wire ships (interaction.cpp
--     stock_item_action_json), so DWFUI.iconHtml({item}) paints the native item tile,
--   * caravan capacity (caravan_state.total_capacity, massst kg/mg -- df.plotinfo.xml:442) for
--     the native Allowed Weight / Excess Weight footer line,
--   * the native screen's own display strings (trade_interfacest title/talker/fortname/place,
--     df.d_interface.xml) + the merchant negotiator's name -- header parity without inventing
--     copy. Their live contents are unprobed (P-T1 notes them); the client must treat each as
--     optional.
local function hw_item_weight(item)
    -- returns whole_kg, fraction_mg, text ("", "<1", "N") -- item_weight_text parity.
    local ok, w, f = pcall(function()
        if item.flags.weight_computed then return item.weight.whole, item.weight.fraction end
        return item:getBaseWeight(), 0
    end)
    if not ok then return 0, 0, '' end
    w, f = w or 0, f or 0
    if w > 0 then return w, f, tostring(w) end
    if f > 0 then return 0, f, '<1' end
    return 0, 0, ''
end

-- Full trade-session state, including both goods tables. side 0 = caravan, 1 = fort (native
-- ordering, same as trade.good/goodflag). Values are caravan-adjusted when DFHack can compute
-- them (Items::getValue(item, caravan) -- the same call DFHack's trade UI uses).
function hw_trade_state()
    local tr = hw_trade()
    local parts = { '"ok":true' }
    local function put(k, v) parts[#parts + 1] = '"' .. k .. '":' .. v end
    put('open', json_bool(tr.open))
    local flags = hw_flags()
    put('guards', string.format(
        '{"tradeSelect":%s,"tradeConfirm":%s,"tradeOpen":%s}',
        json_bool(flags.trade_select == true), json_bool(flags.trade_confirm == true),
        json_bool(flags.trade_open == true)))
    if not tr.open then
        return '{' .. table.concat(parts, ',') .. '}\n'
    end
    put('choosingMerchant', json_bool(tr.choosing_merchant))
    put('stillUnloading', tostring(tr.stillunloading))
    put('haveTalker', tostring(tr.havetalker))
    put('counterOffer', json_bool(tr.counter_offer))
    put('depotId', tostring(tr.bld and tr.bld.id or -1))
    local civ = ''
    if tr.civ then
        local ok, name = pcall(function() return dfhack.translation.translateName(tr.civ.name, true) end)
        if ok then civ = name or '' end
    end
    put('merchantCiv', json_string(civ))
    local mood = -1
    if tr.mer then
        local ok, m = pcall(function() return tr.mer.mood end)
        if ok then mood = m end
    end
    put('merchantMood', tostring(mood))
    local talk = ''
    local ok_talk, talk_name = pcall(function() return df.talk_line_type[tr.talkline] end)
    if ok_talk and talk_name then talk = talk_name end
    put('talkLine', json_string(talk))
    -- Native header/footer strings straight from the struct -- never composed here.
    local function put_str(key, fn)
        local ok, s = pcall(fn)
        put(key, json_string(ok and s or ''))
    end
    put_str('screenTitle', function() return tr.title end)
    put_str('talkerName', function() return tr.talker end)
    put_str('fortName', function() return tr.fortname end)
    put_str('placeName', function() return tr.place end)
    put_str('merchantName', function()
        return tr.merchant_trader and dfhack.units.getReadableName(tr.merchant_trader) or ''
    end)
    -- The oracle footer shows the caravan civ's NATIVE-language name ("Merchants from
    -- Sarvabôk"); merchantCiv above is the translated form. Serve both, invent neither.
    put_str('merchantCivNative', function()
        return tr.civ and dfhack.translation.translateName(tr.civ.name, false) or ''
    end)
    local ok_mid, mid = pcall(function() return tr.merchant_trader and tr.merchant_trader.id or -1 end)
    put('merchantTraderId', tostring(ok_mid and mid or -1))
    local ok_ha, ha = pcall(function() return tr.handle_appraisal end)
    put('handleAppraisal', tostring(ok_ha and ha or 0))
    -- Caravan carrying capacity (massst: whole=kg, fraction=mg) for the Allowed/Excess
    -- Weight footer. -1 = unavailable (client omits the weight line rather than faking one).
    local ok_cap, cap_w, cap_f = pcall(function()
        return tr.mer.total_capacity.whole, tr.mer.total_capacity.fraction
    end)
    put('capacity', tostring(ok_cap and cap_w or -1))
    put('capacityFr', tostring(ok_cap and cap_f or 0))
    for side = 0, 1 do
        local rows = {}
        local n = #tr.good[side]
        for i = 0, n - 1 do
            local item = tr.good[side][i]
            local gf = tr.goodflag[side][i]
            local desc = ''
            local ok_d, d = pcall(dfhack.items.getReadableDescription, item)
            if ok_d then desc = d or '' end
            local value = 0
            local ok_v, v = pcall(dfhack.items.getValue, item, tr.mer)
            if ok_v then value = v or 0 end
            local w, wf, wtext = hw_item_weight(item)
            local group, sprite = '', 'null'
            local ok_t, t = pcall(function() return item:getType() end)
            if ok_t then
                group = df.item_type[t] or ''
                local ok_s, sub, mat, mi = pcall(function()
                    return item:getSubtype(), item:getMaterial(), item:getMaterialIndex()
                end)
                if ok_s then
                    sprite = string.format(
                        '{"itemType":%s,"itemSubtype":%d,"materialType":%d,"materialIndex":%d}',
                        json_string(group), sub or -1, mat or -1, mi or -1)
                end
            end
            rows[#rows + 1] = string.format(
                '{"id":%d,"idx":%d,"desc":%s,"value":%d,"selected":%s,"contained":%s,' ..
                '"weight":%d,"weightFr":%d,"weightText":%s,"group":%s,"spriteRef":%s}',
                item.id, i, json_string(desc), value,
                json_bool(gf.selected), json_bool(gf.contained),
                w, wf, json_string(wtext), json_string(group), sprite)
        end
        put(side == 0 and 'caravanGoods' or 'fortGoods', '[' .. table.concat(rows, ',') .. ']')
    end
    if tr.counter_offer then
        local rows = {}
        for i = 0, #tr.counter_offer_item - 1 do
            local item = tr.counter_offer_item[i]
            local ok_d, d = pcall(dfhack.items.getReadableDescription, item)
            rows[#rows + 1] = string.format('{"id":%d,"desc":%s}', item.id, json_string(ok_d and d or ''))
        end
        put('counterOfferItems', '[' .. table.concat(rows, ',') .. ']')
    end
    -- Button rects (probe evidence + text-assert transparency).
    local btns = {}
    for name, spec in pairs(HW_TRADE_BUTTONS) do
        local x1, y1, x2, y2 = hw_button_rect(spec)
        btns[#btns + 1] = string.format('"%s":{"rect":[%d,%d,%d,%d],"text":%s}',
            name, x1, y1, x2, y2, json_string(hw_rect_text(x1, y1, x2, y2)))
    end
    put('buttons', '{' .. table.concat(btns, ',') .. '}')
    return '{' .. table.concat(parts, ',') .. '}\n'
end

-- Set/clear the native selection bit on items by id. EXACTLY what DFHack's trade UI writes
-- (scripts/internal/caravan/trade.lua toggle_item_base: trade.goodflag[side][idx].selected).
local function hw_trade_select(side, ids_csv, on)
    local tr = hw_trade()
    if not tr.open then return hw_err('no trade session is open') end
    side = tonumber(side)
    if side ~= 0 and side ~= 1 then return hw_err('side must be 0 (caravan) or 1 (fort)') end
    local want = {}
    for id in tostring(ids_csv or ''):gmatch('[-%d]+') do want[tonumber(id)] = true end
    if not next(want) then return hw_err('no item ids given') end
    local hit, missing = 0, 0
    local n = #tr.good[side]
    for i = 0, n - 1 do
        local item = tr.good[side][i]
        if item and want[item.id] then
            tr.goodflag[side][i].selected = (on and true or false)
            want[item.id] = nil
            hit = hit + 1
        end
    end
    for _ in pairs(want) do missing = missing + 1 end
    return string.format('{"ok":true,"changed":%d,"missing":%d}\n', hit, missing)
end

-- Count selected items per side (container contents follow their selected bin -- native
-- for_selected_item semantics, mirrored from caravan/trade.lua).
local function hw_trade_selected_count(side)
    local tr = hw_trade()
    local count, in_selected_container = 0, false
    for i = 0, #tr.good[side] - 1 do
        local gf = tr.goodflag[side][i]
        if not gf.contained then in_selected_container = gf.selected end
        if gf.selected or in_selected_container then count = count + 1 end
    end
    return count
end

-- Click one of the native trade-screen commit buttons. Belt and suspenders: the click only
-- fires if the replicated confirm-plugin rect ALSO carries the expected label on screen (unless
-- the host explicitly set click_without_text_assert after probe P-T3 found text unreadable).
local function hw_trade_confirm(which)
    if not hw_flag('trade_confirm') then return hw_guarded('trade_confirm', 'the barter commit') end
    local spec = HW_TRADE_BUTTONS[which]
    if not spec then return hw_err('unknown trade button: ' .. tostring(which)) end
    local tr = hw_trade()
    if not tr.open then return hw_err('no trade session is open') end
    if not hw_trade_focus_ok() then return hw_err('the host screen is not on the trade view') end
    if tr.choosing_merchant then return hw_err('merchant selection is still open on the host screen') end
    if tr.counter_offer then return hw_err('the merchant made a counter-offer; accept or decline it first') end
    if tr.stillunloading ~= 0 then return hw_err('the merchants are still unloading') end
    if tr.havetalker == 0 then return hw_err('no merchant negotiator is at the depot') end
    if which == 'trade' and hw_trade_selected_count(1) == 0 and hw_trade_selected_count(0) == 0 then
        return hw_err('nothing is selected on either side of the table')
    end
    if which == 'offer' and hw_trade_selected_count(1) == 0 then
        return hw_err('no fort goods are selected to offer')
    end
    if which == 'seize' and hw_trade_selected_count(0) == 0 then
        return hw_err('no caravan goods are selected to seize')
    end
    local x1, y1, x2, y2 = hw_button_rect(spec)
    local seen = hw_rect_text(x1, y1, x2, y2)
    if not seen:lower():find(spec.label, 1, true) and not hw_flag('click_without_text_assert') then
        return hw_err(('the "%s" button is not where expected (saw %q at [%d,%d]-[%d,%d]); ' ..
            'refusing to click blind. Probe P-T3 pins this.'):format(which, seen, x1, y1, x2, y2))
    end
    local before0, before1 = #hw_trade().good[0], #hw_trade().good[1]
    hw_with_confirms_disabled({ 'trade-confirm-trade', 'trade-offer', 'trade-seize' }, function()
        hw_click_rect_center(x1, y1, x2, y2)
    end)
    local talk = ''
    local ok_talk, talk_name = pcall(function() return df.talk_line_type[tr.talkline] end)
    if ok_talk and talk_name then talk = talk_name end
    return string.format(
        '{"ok":true,"clicked":%s,"open":%s,"counterOffer":%s,"talkLine":%s,' ..
        '"goodsBefore":[%d,%d],"goodsAfter":[%d,%d]}\n',
        json_string(which), json_bool(tr.open), json_bool(tr.counter_offer), json_string(talk),
        before0, before1, #tr.good[0], #tr.good[1])
end

-- Merchant counter-offer: native draws Accept/Refuse controls on the trade screen. Their frames
-- are not in confirm's specs, so we locate the label text on the live grid and refuse to act if
-- it isn't found. Probe P-T4 pins the real labels/positions.
local function hw_trade_counter(accept)
    if not hw_flag('trade_confirm') then return hw_guarded('trade_confirm', 'the counter-offer reply') end
    local tr = hw_trade()
    if not tr.open then return hw_err('no trade session is open') end
    if not tr.counter_offer then return hw_err('there is no counter-offer to answer') end
    local words = accept and { 'accept' } or { 'refuse', 'reject', 'decline' }
    local cx, cy
    for _, word in ipairs(words) do
        cx, cy = hw_find_screen_text(word)
        if cx then break end
    end
    if not cx then
        return hw_err('could not locate the counter-offer buttons on screen (probe P-T4 pins them)')
    end
    hw_with_confirms_disabled({ 'trade-confirm-trade' }, function() hw_click_at(cx, cy) end)
    return string.format('{"ok":true,"accepted":%s,"counterOffer":%s,"open":%s}\n',
        json_bool(accept), json_bool(tr.counter_offer), json_bool(tr.open))
end

-- Open the native trade screen without the host keyboard. HYPOTHESIS (guarded until probe P-T1
-- diffs a native open): the depot sheet's Trade button seeds the fields below and the native
-- logic builds the goods lists when `buildlists` is set. Everything here is interface state --
-- no save-owned structure is touched; if the hypothesis is wrong the native logic closes the
-- screen or leaves it empty, and the caller reports that honestly.
local function hw_trade_open(depot_id)
    if not hw_flag('trade_open') then return hw_guarded('trade_open', 'opening the trade screen remotely') end
    local tr = hw_trade()
    if tr.open then return '{"ok":true,"already":true}\n' end
    if not dfhack.world.isFortressMode() then return hw_err('not in fortress mode') end
    local depot = df.building.find(tonumber(depot_id) or -1)
    if not depot or not df.building_tradedepotst:is_instance(depot) then
        return hw_err('not a trade depot')
    end
    local caravan
    for _, car in ipairs(df.global.plotinfo.caravans) do
        if car.trade_state == df.caravan_state.T_trade_state.AtDepot and car.time_remaining > 0 then
            caravan = car
            break
        end
    end
    if not caravan then return hw_err('no caravan is at the depot') end
    tr.bld = depot
    tr.mer = caravan
    tr.civ = df.historical_entity.find(caravan.entity)
    tr.st = df.world_site.find(df.global.plotinfo.site_id)
    tr.choosing_merchant = false
    tr.counter_offer = false
    tr.stillunloading = 1 -- native logic recomputes; start pessimistic
    tr.havetalker = 0
    for side = 0, 1 do
        tr.scroll_position_item[side] = 0
        tr.item_filter[side] = ''
        tr.entering_item_filter[side] = false
    end
    tr.buildlists = 1
    tr.open = true
    return '{"ok":true,"opened":true,"pendingBuild":true}\n'
end

local function hw_trade_close()
    local tr = hw_trade()
    if not tr.open then return '{"ok":true,"already":true}\n' end
    hw_with_confirms_disabled({ 'trade-cancel' }, function() hw_feed('LEAVESCREEN') end)
    return string.format('{"ok":true,"open":%s}\n', json_bool(tr.open))
end

-- Single dispatch entry for the C++ bridge. `arg1/arg2/arg3` meaning depends on action.
function hw_trade_action(action, arg1, arg2, arg3)
    if action == 'select' then return hw_trade_select(tonumber(arg1), arg2, tonumber(arg3) ~= 0) end
    if action == 'trade' or action == 'offer' or action == 'seize' then return hw_trade_confirm(action) end
    if action == 'counter-accept' then return hw_trade_counter(true) end
    if action == 'counter-decline' then return hw_trade_counter(false) end
    if action == 'open' then return hw_trade_open(tonumber(arg1)) end
    if action == 'close' then return hw_trade_close() end
    return hw_err('unknown trade action: ' .. tostring(action))
end

-- ================================================================================================
-- B227: justice convict / interrogate (game.main_interface.info.justice, widgetized in 53.15)
-- ================================================================================================

local function hw_justice()
    return df.global.game.main_interface.info.justice
end

local function hw_justice_widget(...)
    local ok, w = pcall(dfhack.gui.getWidget, hw_justice(), ...)
    if ok then return w end
    return nil
end

-- The widget paths below are the ones DFHack itself ships against DF 53.15:
--   Tabs / 'Open cases' / 'Right panel' / 'Convict'  + 'Unit List'/1 rows whose child 0 is a
--   widget_unit_portrait carrying .u  -- scripts/internal/confirm/specs.lua (convict spec) and
--   plugins/lua/sort/info.lua (JusticeOverlay), library/modules/Gui.cpp (focus strings).

local function hw_case_rows()
    local tab = hw_justice_widget('Tabs', 'Open cases')
    if not tab then return nil end
    local rows_container = hw_find_scroll_rows(tab, 'Right panel')
    if not rows_container then return nil end
    return rows_container
end

local function hw_pane_unit_rows(pane_name)
    local pane = hw_justice_widget('Tabs', 'Open cases', 'Right panel', pane_name)
    if not pane then return nil, nil end
    local ok, rows = pcall(dfhack.gui.getWidget, pane, 'Unit List', 1)
    if not ok then rows = nil end
    return pane, rows
end

-- Row -> unit resolution, indexing THROUGH the container exactly like confirm/specs.lua does
-- (`dfhack.gui.getWidget(scroll_rows, pos, 0).u` -- child 0 is a widget_unit_portrait,
-- df.widgets.unit_list.xml).
local function hw_unit_row_index(rows, unit_id)
    local ok_n, n = pcall(function() return #rows.children end)
    if not ok_n then return nil, 0 end
    for i = 0, n - 1 do
        local ok_u, u = pcall(function()
            local cell = dfhack.gui.getWidget(rows, i, 0)
            return cell and cell.u or nil
        end)
        if ok_u and u and u.id == unit_id then return i, n end
    end
    return nil, n
end

-- State snapshot: the GET side of /justice-convict, and probe P-J1's instrument.
function hw_justice_state()
    local mi = df.global.game.main_interface
    local j = hw_justice()
    local parts = { '"ok":true' }
    local function put(k, v) parts[#parts + 1] = '"' .. k .. '":' .. v end
    local flags = hw_flags()
    put('guards', string.format('{"justiceConvict":%s,"justiceInterrogate":%s}',
        json_bool(flags.justice_convict == true), json_bool(flags.justice_interrogate == true)))
    put('infoOpen', json_bool(mi.info.open))
    put('justiceMode', json_bool(mi.info.open and
        mi.info.current_mode == df.info_interface_mode_type.JUSTICE))
    put('currentTab', json_string(df.justice_interface_mode_type[j.current_mode] or ''))
    put('convicting', json_bool(j.convicting))
    put('interrogating', json_bool(j.interrogating))
    local crimes = {}
    for i = 0, #j.convict_crime - 1 do
        local c = j.convict_crime[i]
        if c then crimes[#crimes + 1] = tostring(c.id) end
    end
    put('convictCrimeIds', '[' .. table.concat(crimes, ',') .. ']')
    local rows_container = hw_case_rows()
    local ok_rows, case_rows = pcall(function() return #rows_container.children end)
    put('caseRows', tostring(rows_container and ok_rows and case_rows or 0))
    for _, pane_name in ipairs({ 'Convict', 'Interrogate' }) do
        local pane, rows = hw_pane_unit_rows(pane_name)
        if pane and rows then
            local ids = {}
            local ok_n, n = pcall(function() return #rows.children end)
            for i = 0, (ok_n and math.min(n, 200) or 0) - 1 do
                local ok_u, u = pcall(function()
                    local cell = dfhack.gui.getWidget(rows, i, 0)
                    return cell and cell.u or nil
                end)
                ids[#ids + 1] = tostring(ok_u and u and u.id or -1)
            end
            local cursor = -1
            local ok_c, c = pcall(function() return pane.cursor_idx end)
            if ok_c and c ~= nil then cursor = c end
            put(pane_name == 'Convict' and 'convictPane' or 'interrogatePane', string.format(
                '{"unitIds":[%s],"cursorIdx":%d}', table.concat(ids, ','), cursor))
        end
    end
    return '{' .. table.concat(parts, ',') .. '}\n'
end

-- Per-drive session (module-global; the C++ side serializes drives behind a mutex and calls
-- hw_justice_action repeatedly, sleeping between calls so native frames can run).
hw_justice_session = hw_justice_session or nil

local function hw_session_for(kind, crime_id, unit_id)
    local s = hw_justice_session
    if not s or s.kind ~= kind or s.crime ~= crime_id or s.unit ~= unit_id then
        s = { kind = kind, crime = crime_id, unit = unit_id, row_attempt = 0,
              open_feeds = 0, tab_fixes = 0, key = kind == 'convict' and 'JUSTICE_CONVICT'
                                                  or 'JUSTICE_INTERROGATE',
              pane = kind == 'convict' and 'Convict' or 'Interrogate' }
        hw_justice_session = s
    end
    return s
end

-- One step of the native convict/interrogate drive. Returns done-json, retry-json (caller sleeps
-- a few frames and calls again), or error-json. EVERY game-record write in here is performed by
-- native DF code reacting to fed input; the only direct writes are widget cursor/scroll state
-- and (rarely) the tab-visibility trio, all pure interface state.
function hw_justice_action(action, crime_id, unit_id, final)
    crime_id, unit_id = tonumber(crime_id) or -1, tonumber(unit_id) or -1
    final = tonumber(final) == 1
    if action ~= 'convict' and action ~= 'interrogate' then
        return hw_err('unknown justice action: ' .. tostring(action))
    end
    local flag = action == 'convict' and 'justice_convict' or 'justice_interrogate'
    if not hw_flag(flag) then
        hw_justice_session = nil
        return hw_guarded(flag, action == 'convict' and 'the native conviction drive'
                                 or 'the native interrogation drive')
    end
    if not dfhack.world.isFortressMode() then return hw_err('not in fortress mode') end

    local crime = df.crime.find(crime_id)
    if not crime then return hw_err('no crime with id ' .. crime_id) end
    if crime.flags.sentenced then return hw_err('this case is already closed (sentenced)') end
    if not crime.flags.discovered then
        return hw_err('this is a cold (undiscovered) case; v1 drives open cases only')
    end
    local unit = df.unit.find(unit_id)
    if not unit then return hw_err('no unit with id ' .. unit_id) end

    local s = hw_session_for(action, crime_id, unit_id)
    local function step_retry(stage)
        if final then
            hw_justice_session = nil
            return hw_err('timed out at stage: ' .. stage)
        end
        return hw_retry(stage)
    end

    local mi = df.global.game.main_interface
    if mi.trade.open then return hw_err('a trade session is open on the host screen; finish it first') end

    -- Stage 1: the justice screen.
    if not (mi.info.open and mi.info.current_mode == df.info_interface_mode_type.JUSTICE) then
        if s.open_feeds >= 3 then
            hw_justice_session = nil
            return hw_err('could not open the justice screen (another native window may be blocking it)')
        end
        -- Precedent for closing a blocking view sheet by state-write: gui/teleport.lua:54.
        if mi.view_sheets.open then mi.view_sheets.open = false end
        s.open_feeds = s.open_feeds + 1
        hw_feed('D_JUSTICE')
        return step_retry('opening justice screen')
    end

    -- Stage 2: the Open cases tab (the default tab; direct visibility write is the fallback).
    local tabs = hw_justice_widget('Tabs')
    if not tabs then return step_retry('waiting for justice widgets') end
    local visible_tab = hw_visible_child(tabs)
    if not visible_tab then return step_retry('waiting for a visible tab') end
    if visible_tab.name ~= 'Open cases' then
        if s.tab_fixes >= 2 then
            hw_justice_session = nil
            return hw_err('could not switch to the Open cases tab')
        end
        s.tab_fixes = s.tab_fixes + 1
        local ok_fix = pcall(function()
            local n = #tabs.children
            for i = 0, n - 1 do
                local c = tabs.children[i]
                local on = (c.name == 'Open cases')
                c.flag.VISIBILITY_ACTIVE = on
                c.flag.VISIBILITY_VISIBLE = on
                if on then tabs.cur_idx = i end
            end
            hw_justice().current_mode = df.justice_interface_mode_type.OPEN_CASES
        end)
        if not ok_fix then
            hw_justice_session = nil
            return hw_err('tab switch failed (widget layout differs; probe P-J1 dumps it)')
        end
        return step_retry('switching to Open cases tab')
    end

    local j = hw_justice()

    -- Stage 3: get the right case selected and enter convict/interrogate mode natively.
    local in_mode = (action == 'convict') and j.convicting or j.interrogating
    if in_mode then
        -- Verify the native mode is aimed at OUR crime before touching a unit.
        local found = false
        for i = 0, #j.convict_crime - 1 do
            if j.convict_crime[i] and j.convict_crime[i].id == crime_id then found = true end
        end
        if action == 'interrogate' and #j.convict_crime == 0 then
            -- convict_crime is the convict-mode vector; interrogate mode may not fill it. The
            -- case identity was already checked when we entered the mode below (same click),
            -- so accept interrogate mode as-is only if this session did the entering.
            found = s.entered_mode == true
        end
        if not found then
            -- Back out of a mode aimed at the wrong case. The row counter advances in the
            -- not-in-mode branch below (pending_backout), NOT here: LEAVESCREEN may need more
            -- than one frame to exit the mode, and incrementing per backout attempt would skip
            -- case rows.
            hw_feed('LEAVESCREEN')
            s.pending_backout = true
            s.entered_mode = false
            return step_retry('backing out of wrong case (row ' .. s.row_attempt .. ')')
        end

        -- Stage 4: the unit list (rows build deferred -- widget_unit_list.deferred_units_builds).
        local pane, rows = hw_pane_unit_rows(s.pane)
        if not pane or not rows then return step_retry('waiting for the ' .. s.pane .. ' pane') end
        local idx, count = hw_unit_row_index(rows, unit_id)
        if not idx then
            if count == 0 then return step_retry('waiting for suspect rows to build') end
            hw_feed('LEAVESCREEN')
            hw_justice_session = nil
            return hw_err(('unit %d is not among the %d candidates DF lists for this case')
                :format(unit_id, count))
        end
        local ok_cursor = pcall(function() pane.cursor_idx = idx end)
        if not ok_cursor then
            hw_justice_session = nil
            return hw_err('the ' .. s.pane .. ' pane has no cursor_idx (widget layout differs)')
        end

        local punishments_before = #df.global.plotinfo.punishments
        local reports_before = #crime.reports
        hw_with_confirms_disabled({ 'convict' }, function() hw_feed('SELECT') end)

        if action == 'convict' then
            if crime.flags.sentenced then
                hw_justice_session = nil
                if j.convicting then hw_feed('LEAVESCREEN') end
                return string.format(
                    '{"ok":true,"convicted":true,"crimeId":%d,"unitId":%d,"prisonTime":%d,' ..
                    '"hammerstrikes":%d,"beating":%s,"exiled":%s,"deathSentence":%s,' ..
                    '"punishmentsDelta":%d}\n',
                    crime_id, unit_id, crime.punishment.prison_time, crime.punishment.hammerstrikes,
                    json_bool(crime.punishment.flags.beating), json_bool(crime.punishment.flags.exiled),
                    json_bool(crime.punishment.flags.death_sentence),
                    #df.global.plotinfo.punishments - punishments_before)
            end
            hw_justice_session = nil
            if j.convicting then hw_feed('LEAVESCREEN') end
            return hw_err('SELECT was delivered but the case did not close (sentenced flag ' ..
                'unchanged); nothing was written. Probe P-J3 pins the final activation.')
        else
            hw_justice_session = nil
            return string.format(
                '{"ok":true,"toggled":true,"crimeId":%d,"unitId":%d,"reportsDelta":%d}\n',
                crime_id, unit_id, #crime.reports - reports_before)
        end
    end

    -- Not in mode yet: click the next candidate case row, then feed the mode hotkey.
    if s.pending_backout then
        -- The backout above has completed (we are provably out of the mode) -> next row.
        s.pending_backout = false
        s.row_attempt = s.row_attempt + 1
    end
    local rows_container = hw_case_rows()
    if not rows_container then return step_retry('waiting for the case list') end
    local ok_n, case_count = pcall(function() return #rows_container.children end)
    if not ok_n or case_count == 0 then return step_retry('waiting for case rows') end
    if s.row_attempt >= case_count then
        hw_justice_session = nil
        return hw_err(('crime %d was not found among the %d listed open cases')
            :format(crime_id, case_count))
    end
    local row = rows_container.children[s.row_attempt]
    -- Ensure the row is scrolled into view so its rect is live, then click it.
    local ok_scroll = pcall(function()
        local scroll, visible = rows_container.scroll, rows_container.num_visible
        if visible > 0 and (s.row_attempt < scroll or s.row_attempt >= scroll + visible) then
            rows_container.scroll = s.row_attempt
            error('scrolled') -- surface as retry below
        end
    end)
    if not ok_scroll then return step_retry('scrolling the case list') end
    local ok_rect, rx1, ry1, rx2, ry2 = pcall(function()
        return row.rect.x1, row.rect.y1, row.rect.x2, row.rect.y2
    end)
    if not ok_rect or rx2 < rx1 or ry2 < ry1 then return step_retry('waiting for row layout') end
    hw_click_rect_center(rx1, ry1, rx2, ry2)
    hw_feed(s.key)
    s.entered_mode = true
    return step_retry('entering ' .. action .. ' mode (case row ' .. s.row_attempt .. ')')
end

hw_trade_state = safe_json(hw_trade_state)
hw_trade_action = safe_json(hw_trade_action)
hw_justice_state = safe_json(hw_justice_state)
hw_justice_action = safe_json(hw_justice_action)
hw_widget_dump = safe_json(hw_widget_dump)

return _ENV
