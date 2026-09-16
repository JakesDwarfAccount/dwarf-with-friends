-- ---------------------------------------------------------------------------
-- Workshop/furnace panels

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

-- Reagents for the common craftsdwarf jobs dfhack.workshops.getJobs omits.
local STONE_REAGENT = {
    item_type = df.item_type.BOULDER,
    vector_id = df.job_item_vector_id.BOULDER,
    mat_type = 0,
    flags2 = { non_economic = true },
    flags3 = { hard = true },
}
local WOOD_REAGENT  = { item_type = df.item_type.WOOD, vector_id = df.job_item_vector_id.WOOD }
function craft_job(name, jt, matcat, reagent)
    local jf = { job_type = jt }
    if matcat == 'stone' then jf.mat_type = 0            -- no 'stone' material_category bit exists
    elseif matcat then jf.material_category = matcat end
    return { name = name, job_fields = jf, items = { reagent } }
end
-- DF's own hardcoded jobs resolve their own target, so they ship with NO job_item filter --
-- inventing one both mis-reds the row and can queue a job DF cannot satisfy.
local function plain_job(name, jt)
    return { name = name, job_fields = { job_type = df.job_type[jt] }, items = {} }
end
-- Encrust reagents: the gem half follows the job type, the target half is the improvable item.
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
    Farmers = {
        plain_job('Make cheese',              'MakeCheese'),
        plain_job('Milk animal',              'MilkCreature'),
        plain_job('Process plants',           'ProcessPlants'),
        plain_job('Process plants (barrel)',  'ProcessPlantsBarrel'),
        plain_job('Process plants (vial)',    'ProcessPlantsVial'),
        plain_job('Shear animal',             'ShearCreature'),
        plain_job('Spin thread',              'SpinThread'),
    },
    Quern = {
        plain_job('Mill plants', 'MillPlants'),
    },
    Ashery = {
        plain_job('Make lye',              'MakeLye'),
        plain_job('Make potash from ash',  'MakePotashFromAsh'),
        plain_job('Make potash from lye',  'MakePotashFromLye'),
    },
    Masons = {
        { name = 'Engrave memorial slab', label_locked = true,
          job_fields = { job_type = df.job_type.EngraveSlab },
          items = { { item_type = df.item_type.SLAB } } },
    },
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
        craft_job('Make three rock mugs',  df.job_type.MakeGoblet, 'stone',   STONE_REAGENT),
        craft_job('Make totem',            df.job_type.MakeTotem,  nil,       { flags1 = { unrotten = true }, flags2 = { totemable = true } }),
    },
}

-- Shops authored here in full; dfhack getJobs' hardcoded rows for them are dropped.
local AUTHORED_SHOPS = { Jewelers = true, Siege = true }
function getjobs_def_allowed(shop_key, def)
    if not AUTHORED_SHOPS[shop_key] then return true end
    local jf = (type(def) == 'table' and def.job_fields) or {}
    return jf.job_type == df.job_type.CustomReaction
end

-- Forge / carpenter / bowyer / clothier reagents; their job lists are entity-scoped and live.
local METALBAR_REAGENT = { item_type = df.item_type.BAR, flags3 = { metal = true } }
local WOODLOG_REAGENT  = { item_type = df.item_type.WOOD, vector_id = df.job_item_vector_id.WOOD }
local CLOTH_REAGENT    = { item_type = df.item_type.CLOTH }
local BONE_REAGENT     = { flags1 = { unrotten = true }, flags2 = { bone = true } }
local LEATHER_REAGENT  = { item_type = df.item_type.SKIN_TANNED, flags1 = { unrotten = true } }
-- The clothier's three materials; the split is a flags2 bit on the CLOTH item, 'cloth' unflagged.
local CLOTHIER_MATS = {
    { word = 'cloth', cat = 'cloth', reagent = { item_type = df.item_type.CLOTH } },
    { word = 'silk',  cat = 'silk',  reagent = { item_type = df.item_type.CLOTH, flags2 = { silk = true } } },
    { word = 'yarn',  cat = 'yarn',  reagent = { item_type = df.item_type.CLOTH, flags2 = { yarn = true } } },
}

-- Subtype-free metal jobs: job_type alone determines the product. One metal bar each.
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

-- Enumerate a fort-entity resource vector of itemdef indices into job defs. filter(itemdef)
-- restricts by class, matcat pins material_category, namer(itemdef) composes the whole label.
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

-- Bolts are made at the craftsdwarf's shop (wood/bone) and the forges (metal). The bowyer
-- makes no ammo at all -- an ammo row there offers a job that shop cannot run.
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
    -- These labels already name their material, so lock them against a re-applied adjective.
    for i = before + 1, #defs do defs[i].label_locked = true end
end

-- item_tool.txt's [FURNITURE] token splits the MakeTool shops: FURNITURE + wood-capable ->
-- carpenter, FURNITURE + HARD_MAT -> mason, not-FURNITURE + HARD_MAT -> craftsdwarf.
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
-- armor_general_flags: SOFT = cloth/silk/yarn clothing, LEATHER = leather-capable.
local function armor_prop(d, name)
    local ok, v = pcall(function() return d.props.flags[name] end)
    return ok and v or false
end
-- Itemdefs the fort entity may permit but that native never shows; intersecting with this
-- list can only ever remove a row, never add one.
local CAPTURE_ABSENT_CLOTHING = {
    ITEM_ARMOR_SHIRT = true,   -- SOFT+LEATHER; in no capture
    ITEM_ARMOR_TUNIC = true,   -- SOFT+LEATHER; in no capture
    ITEM_ARMOR_TOGA = true,   -- SOFT+LEATHER; in no capture
    ITEM_PANTS_LOINCLOTH = true,   -- SOFT+LEATHER; in no capture
}
capture_absent_count = 0   -- chunk-global, cumulative since load; non-zero means the civ rolled these itemdefs in
local function capture_shows(d)
    local id = nil
    dwf_probe('lua.probe.itemdef-id', function() id = d.id end)
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
        dwf_probe('lua.probe.itemdef-plural', function() pl = d.name_plural end)
        if type(pl) ~= 'string' or #pl == 0 then dwf_probe('lua.probe.itemdef-name-fallback', function() pl = d.name end) end
        if type(pl) ~= 'string' or #pl == 0 then return nil end
        return verb .. ' pair of ' .. adj .. ' ' .. pl
    end
end
-- Trap components carry an adjective spliced before the material ("Make menacing wooden spike").
local function trapcomp_namer(adj_mat)
    return function(d)
        local a, nm = '', ''
        dwf_probe('lua.probe.itemdef-adjective', function() a = d.adjective or '' end)
        dwf_probe('lua.probe.itemdef-name', function() nm = d.name or '' end)
        if #nm == 0 then return nil end
        if #a > 0 then return 'Make ' .. a .. ' ' .. adj_mat .. ' ' .. nm end
        return 'Make ' .. adj_mat .. ' ' .. nm
    end
end
-- Pin "any rock" (mat 0 / index -1), which is what DF's own rock jobs carry.
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
        -- Forge tools: entity-permitted, hard/metal-capable, not reaction-only.
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
        enum_entity_defs(defs, 'Tools', 13, 'Make wooden', df.job_type.MakeTool,
            df.item_type.TOOL, R.tool_type, IT.tools, WOODLOG_REAGENT, carpenter_tool, 'wood')
        enum_entity_defs(defs, 'Armor', 12, 'Make wooden', df.job_type.MakeShield,
            df.item_type.SHIELD, R.shield_type, IT.shields, WOODLOG_REAGENT, nil, 'wood')
        -- Training weapons: the TRAINING flag is what keeps these off the forge.
        local training = function(d) local ok, v = pcall(function() return d.flags.TRAINING end); return ok and v end
        enum_entity_defs(defs, 'Weapons', 10, 'Make wooden', df.job_type.MakeWeapon,
            df.item_type.WEAPON, R.weapon_type, IT.weapons, WOODLOG_REAGENT, training, 'wood')
        -- item_trapcomp.txt's [WOOD] token selects the wood-capable trap components; the axe blade
        -- and serrated disc are metal-only.
        if df.job_type.MakeTrapComponent then
            local wood_trapcomp = function(d) local ok, v = pcall(function() return d.flags.WOOD end); return ok and v end
            enum_entity_defs(defs, 'Trap components', 12, 'Make wooden', df.job_type.MakeTrapComponent,
                df.item_type.TRAPCOMP, R.trapcomp_type, IT.trapcomps, WOODLOG_REAGENT, wood_trapcomp,
                'wood', trapcomp_namer('wooden'))
        end
    elseif is_mason then
        local before = #defs
        enum_entity_defs(defs, 'Tools', 13, 'Make rock', df.job_type.MakeTool,
            df.item_type.TOOL, R.tool_type, IT.tools, STONE_REAGENT, mason_tool)
        pin_rock(defs, before + 1)
    elseif is_leatherworks then
        -- The gate is the itemdef's [LEATHER] props flag.
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
        -- One ballista-arrow row per ammo-capable metal plus the wooden row; labels are locked.
        local WOOD_ITEM = { item_type = df.item_type.WOOD }
        local n_sa = pcall(function() return #R.siegeammo_type end) and #R.siegeammo_type or 0
        local n_it = pcall(function() return #IT.siege_ammo end) and #IT.siege_ammo or 0
        for i = 0, n_sa - 1 do
            local sub = R.siegeammo_type[i]
            if sub and sub >= 0 and sub < n_it then
                local sdef = IT.siege_ammo[sub]
                local nm = nil
                dwf_probe('lua.probe.subdef-name', function() nm = sdef.name end)
                if type(nm) == 'string' and #nm > 0 then
                    local jf_base = { job_type = df.job_type.AssembleSiegeAmmo,
                                      item_type = df.item_type.SIEGEAMMO, item_subtype = sub }
                    -- Wooden shaft, no head; a material_category, not a pinned mat -- DF offers no tree species.
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
        -- The bowyer makes ranged weapons only, in bone or wood; metal crossbows are forged.
        local ranged = function(d) local ok, a = pcall(function() return d.ranged_ammo end); return ok and type(a) == 'string' and #a > 0 end
        enum_entity_defs(defs, 'Weapons', 10, 'Make bone',   df.job_type.MakeWeapon, df.item_type.WEAPON, R.weapon_type, IT.weapons, BONE_REAGENT,    ranged, 'bone')
        enum_entity_defs(defs, 'Weapons', 10, 'Make wooden', df.job_type.MakeWeapon, df.item_type.WEAPON, R.weapon_type, IT.weapons, WOODLOG_REAGENT, ranged, 'wood')
    elseif is_craftsdwarf then
        ammo_shop_defs(defs, 'Ammo', 11, 'wooden', 'wood', WOODLOG_REAGENT)
        ammo_shop_defs(defs, 'Ammo', 11, 'bone',   'bone', BONE_REAGENT)
    elseif is_clothier then
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

-- Fortress mode must never offer adventure-mode reactions: getJobs enumerates them and DF
-- queues then cancels them. DF's own fort UI filters on ADVENTURE_MODE_ENABLED.
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

-- Order keys: 'j:<Job>', 'j:<Job>|cat:<category>', 'j:<Job>|mat:<matType>:<idx>'. Every entry
-- must be a fully-specified order; a bare job DF cannot name is rejected by create_order.

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

-- Every IS_METAL inorganic, mirroring DF's forge menu (which offers all forgeable metals).
function forge_metals()
    local out = {}
    dwf_pcall('lua.orders.forge-metals', function()
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

-- Only metals whose material carries ITEMS_AMMO.
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

-- Returns nil when the order needs no material, else {mode='cat'|'mat'|'metal'|'subtype'}.
-- A subtype-bearing job with no subtype is never offered: DF's order namer crashes on one.
local SUBTYPE_ITEM_TYPES = {}
for _, itn in ipairs({ 'WEAPON', 'AMMO', 'ARMOR', 'HELM', 'GLOVES', 'SHOES', 'PANTS', 'SHIELD',
                       'TRAPCOMP', 'TOOL', 'INSTRUMENT', 'SIEGEAMMO' }) do
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
    if job_is_subtype_bearing(jf.job_type) and
       (jf.item_subtype == nil or jf.item_subtype < 0) then return { mode = 'subtype' } end
    if jf.material_category then return { mode = 'cat', cat = tostring(jf.material_category) } end
    -- A def pinning mat_type AND a real mat_index already is its material choice.
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

-- manager_order carries real item_type/item_subtype; omitting them breaks shop and general orders.
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

-- Subtype-bearing job types the order surfaces accept; absent here means absent from both.
ORDER_SUBTYPE_JOBS = {}
ORDER_SUBTYPE_JOBS[df.job_type.MakeTool] = true
ORDER_SUBTYPE_JOBS[df.job_type.AssembleSiegeAmmo] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeAmmo] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeWeapon] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeArmor] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeHelm] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeGloves] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeShoes] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakePants] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeShield] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeTrapComponent] = true
ORDER_SUBTYPE_JOBS[df.job_type.MakeToy] = true

-- Workshop tasks that can never be manager orders: they need a selection the key cannot carry.
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
            -- Forge tool rows stay on the ITEMS_HARD metal set.
            if jf.job_type ~= df.job_type.MakeTool or forge_tool_metal(m) then
                out[#out + 1] = { key = base_key .. '|mat:' .. m.mt .. ':' .. m.mi,
                                  label = 'forge ' .. m.name .. ' ' .. noun }
            end
        end
        return out
    end
    return { { key = base_key, label = name } }
end

-- The shared legal-order projection used by both order-creation surfaces.
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

-- The per-shop projection both /order-catalog-shops and /order-catalog derive from.
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
                    if spec[2] == 'Dyers' and type(correct_dfhack_dyer_job_type) == 'function' then
                        def = correct_dfhack_dyer_job_type(def)
                    end
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
    -- This admission gate and the expand_order_entries subtype gate must read the ONE list
    -- (ORDER_SUBTYPE_JOBS), or a new subtype family passes one gate but not the other.
    local dynamic = dynamic_shop_jobs(spec[2])
    if dynamic then
        for _, def in ipairs(dynamic) do
            defs[#defs + 1] = def
        end
    end
    -- Union in the native task-tree defs so the order surfaces match the Tasks surface.
    if type(native_order_defs) == 'function' then
        local okn, ndefs = pcall(native_order_defs, spec[2], btype, subtype)
        if okn and ndefs then
            for _, def in ipairs(ndefs) do defs[#defs + 1] = def end
        end
    end
    return order_entries_for_defs(defs, metals)
end

-- DF-style catalog grouped by workshop, served at /order-catalog-shops.
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
    -- Append custom-workshop groups (Soap Maker etc.) from the raws.
    if type(custom_workshop_order_groups) == 'function' then
        for _, g in ipairs(custom_workshop_order_groups(metals)) do
            if #g.items > 0 then
                local ij = {}
                for _, it in ipairs(g.items) do
                    ij[#ij + 1] = '{"key":' .. json_string(it.key) .. ',"label":' .. json_string(it.label) .. '}'
                end
                groups[#groups + 1] = '{"shop":' .. json_string(g.name) ..
                    ',"icon":' .. json_string('') ..
                    ',"items":[' .. table.concat(ij, ',') .. ']}'
            end
        end
    end
    return '{"ok":true,"shops":[' .. table.concat(groups, ',') .. ']}\n'
end

-- Fort-wide work-order catalog, served at /order-catalog; derives from order_spec_entries.
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

-- DFHack's Dyer table gives both rows job_type DyeThread; correct our own copy only -- that
-- table is shared module state and editing it changes every DFHack script in the process.
function correct_dfhack_dyer_job_type(def)
    local jt = def.job_fields and def.job_fields.job_type
    if jt ~= df.job_type.DyeThread then return def end
    local first = def.items and def.items[1]
    if not first or first.item_type ~= df.item_type.CLOTH then return def end
    local fixed = {}
    for k, v in pairs(def) do fixed[k] = v end
    fixed.job_fields = {}
    for k, v in pairs(def.job_fields) do fixed.job_fields[k] = v end
    fixed.job_fields.job_type = df.job_type.DyeCloth
    return fixed
end

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
                if shop_key == 'Dyers' then def = correct_dfhack_dyer_job_type(def) end
                defs[tostring(k)] = def
            end
        end
    end
    local extra = EXTRA_SHOP_JOBS[shop_key]
    if extra then
        for i, def in ipairs(extra) do defs['x' .. i] = def end
    end
    -- Stable 'd<i>' keys: the enumeration order is deterministic, so display and queue agree.
    local dyn = dynamic_shop_jobs(b)
    if dyn then
        for i, def in ipairs(dyn) do defs['d' .. i] = def end
    end
    return defs
end

-- Classify a task into the DF-style group the client renders as a header and sorts by.
function task_group(job_type, reaction)
    if job_type == df.job_type.CustomReaction then
        if reaction and reaction:match('^MAKE_ENT') then return 'Instruments', 91 end
        -- Only the procedural MAKE_ENT instrument flood is bucketed (pri 91). A vanilla reaction is
        -- not procedural and DF interleaves it alphabetically with the ordinary jobs.
        return 'Common', 0
    end
    return 'Common', 0
end

-- def.label_locked means the label is the oracle -- never hand it to the native probe, which
-- sees only job_fields and would print one string for three rows that differ by reagent.
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

-- Flat shops that suppress MAKE_ENT leaves and serve a container row instead.
local CAPTURED_FLAT_SHOPS = { Masons = true, Carpenters = true, Leatherworks = true }
function shop_tasks(b, defs)
    wtrace('shop_tasks: enter type=' .. tostring(b:getType()) .. ' sub=' .. tostring(b:getSubtype()) .. ' custom=' .. tostring(b:getCustomType()))
    local tasks = {}
    local suppressed = {}   -- MAKE_ENT leaves pulled out of the flat list -> the container's children
    defs = defs or shop_job_defs(b)
    local shop_key = shop_subtype_key(b)
    for key, def in pairs(defs) do
        if type(def) == 'table' then
            local job_type = def.job_fields and def.job_fields.job_type
            local job_key = job_type and df.job_type[job_type] or ''
            local reaction = def.job_fields and def.job_fields.reaction_name or ''
            -- Generated codes are 'MAKE_ENT<civ_id> <PART>' -- a space, not an underscore.
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
                -- Must use the same ORDER_SUBTYPE_JOBS list expand_order_entries uses, or the encoders disagree.
                if item_suffix == nil or
                   (item_suffix ~= '' and not ORDER_SUBTYPE_JOBS[job_type]) then order_key = ''
                else order_key = order_key .. item_suffix end
                local ms = order_key ~= '' and derive_order_material(def) or nil
                if ms then
                    if ms.mode == 'cat' then order_key = order_key .. '|cat:' .. ms.cat
                    elseif ms.mode == 'mat' then order_key = order_key .. '|mat:' .. ms.mt .. ':' .. ms.mi end
                end
            end
            local group, pri = task_group(job_type, reaction)
            -- A def may carry its own category and sort pri.
            if def.group then group = tostring(def.group) end
            if def.pri ~= nil then pri = def.pri end
            local native_name, label_source = native_flat_task_label(def, job_type, reaction,
                def.name or job_key or key)
            local needs_unit = job_type == df.job_type.EngraveSlab
            if needs_unit then
                native_name = tostring(native_name) .. ' (opens menu)'
                label_source = 'capture-verbatim'
            end
            -- This loop never computes the red state -- annotate_flat_avail does. Never reinstate a
            -- per-def IN_PLAY scan here: it fails closed on reagents like the Still's barrel/pot.
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
    -- Containers lead the list: DF renders containers first, then leaves alphabetically.
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
    -- The move-up control needs >= 2 jobs and a non-first row, decided over the vector the swap mutates.
    local job_count = #b.jobs
    for i = 0, job_count - 1 do
        local job = b.jobs[i]
        -- DestroyBuilding is the removal job; it must never appear as an ordinary task row.
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
                ',"byManager":' .. json_bool(job.flags.by_manager) ..
                ',"canMoveUp":' .. json_bool(job_count >= 2 and i >= 1) .. '}')
        end
    end
    return '[' .. table.concat(out, ',') .. ']'
end

function shop_tasks_json(tasks)
    local out = {}
    for _, task in ipairs(tasks) do
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
            -- The job-policy bit is on the UNIT (unit.flags4.only_do_assigned_jobs), not the building.
            local ok_only, only_assigned = pcall(function() return unit.flags4.only_do_assigned_jobs end)
            table.insert(rows, {
                id = unit.id,
                name = ok_name and name or ('Unit ' .. tostring(unit.id)),
                profession = ok_prof and prof or '',
                profession_color = (ok_color and profession_color) or -1,
                assigned = permitted[unit.id] or false,
                only_assigned_jobs = (ok_only and only_assigned) or false,
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
            ',"assigned":' .. json_bool(u.assigned) ..
            ',"onlyAssignedJobs":' .. json_bool(u.only_assigned_jobs) .. '}')
    end
    return '[' .. table.concat(out, ',') .. ']'
end

-- Run one workshop_info section under pcall so one failing section degrades, not the panel.
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

-- Stockpile links live on the stockpile (links.give_to_workshop = this shop takes from it;
-- take_from_workshop = it gives to it); workshops carry no link vector of their own.
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

-- The native forge add-task tree (category -> metal -> leaf), served as taskTree.
-- Wrapped in an IIFE: its ~35 helper locals would overflow the chunk's 200-local cap.
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

-- IS_METAL inorganics carrying a given ITEMS_* flag, in inorganic INDEX order, never alphabetical.
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
-- DF uppercases the first byte of a reaction's raws name for display.
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
    -- Diggers (picks) gate on ITEMS_DIGGER, not ITEMS_WEAPON.
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
    return out   -- native order: weapon_type vector, digger, ammo -- NOT alpha.
end
-- Family order is native order: armor, pants, helm, gloves, shoes.
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
    return out   -- native order: family blocks then shields/backpack+quiver -- NOT alpha.
end
-- One hardcoded native sequence, Forge/Make verbs interleaved. {noun, verb, job}.
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
    return out   -- native order -- NOT alpha.
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
    return out   -- source order: trapcomp_type vector then mechanisms.
end
-- Hardcoded native sequence: anvil gated on ITEMS_ANVIL, one generic toy, entity tool block.
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
    return out   -- native order -- NOT alpha.
end
-- Fort-civ reaction prefix "MAKE_ENT<civ_id> ": DF shows a custom category's reactions only
-- for the fort civ's own entity.
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
            if prefix and code:sub(1, #prefix) == prefix then   -- civ filter
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
    return out   -- raws/attachment order -- NOT alpha.
end

-- Build the forge root tree (category nodes, or nil,err). bt/st = the forge's building/workshop type.
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
        -- The trap metal list filters ITEMS_WEAPON only; mechanisms gate per-metal on ITEMS_HARD.
        { kind = 'category', label = 'Trap components', df_category = 'TRAP', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_WEAPON' }, function(m) return ft_trap_leaves(R, m) end, 'speculative') },
        { kind = 'category', label = 'Other objects', df_category = 'OTHER', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_HARD' }, function(m) return ft_other_leaves(R, m) end, 'screenshot-verified') },
        { kind = 'category', label = 'Metal clothing', df_category = 'METAL', confidence = 'screenshot-verified',
          metals = metal_branch({ 'ITEMS_SOFT' }, function(m) return ft_clothing_leaves(R, m, false) end, 'flag-derived') },
    }
    -- Instrument custom categories have no metal layer, and hide when the civ-filtered set is empty.
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
    if l.avail ~= nil then p[#p + 1] = '"avail":' .. json_bool(l.avail) end   -- availability bit
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
        -- leaf-only category (instruments): leaves live on the node directly, no metal layer
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

-- Build + serialize the forge tree for a subtype NAME (no built building needed).
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

-- Native add-task trees for the non-forge shops whose menus are not a flat getJobs list
-- (Smelter/MagmaSmelter, Craftsdwarfs, Kennels). Each leaf carries an internal _def.
local native_menu_tree, native_tree_json, native_shop_is, native_queue
;(function()
local function G(fn, fb) local ok, v = pcall(fn); if ok then return v end return fb end
local function raws() return df.global.world.raws end
local function IT() return df.global.world.raws.itemdefs end
-- capitalize the first byte: DF's native reaction display uppercases the raws name's first letter.
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
    -- material_category is DF's other material discriminator: it tells "cloth crafts" from "silk crafts".
    if leaf.material_category then k = k .. '|cat:' .. leaf.material_category end
    if leaf.batch then k = k .. '|b:' .. leaf.batch end
    return k
end
-- leaf constructor: display fields as strings, plus an internal _def for add_workshop_task.
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

-- Smelter: melt row, then ores in inorganic index order, then reactions in raws order.
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

-- Kennels (v50 Vermin Catcher's Shop): getJobs returns nothing; DF hardcodes the two rows.
local function kennels_tree()
    return {
        leaf_job('Catch live land animal', 'CatchLiveLandAnimal',
            { def = { job_fields = { job_type = df.job_type.CatchLiveLandAnimal }, items = {} }, confidence = 'screenshot-verified' }),
        leaf_job('Tame a small animal', 'TameVermin',
            { def = { job_fields = { job_type = df.job_type.TameVermin }, items = {} }, confidence = 'screenshot-verified' }),
    }
end

-- ---- Craftsdwarf's Workshop (mixed root) ----
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
-- per-family jewelry noun -> job type; +EXTRA for hard ivory/horn, PEARL_EXTRA drops the scepter.
local CD_BASE = { { 'crafts', 'MakeCrafts' }, { 'amulet', 'MakeAmulet' }, { 'bracelet', 'MakeBracelet' }, { 'earring', 'MakeEarring' } }
local CD_EXTRA = { { 'crown', 'MakeCrown' }, { 'figurine', 'MakeFigurine' }, { 'ring', 'MakeRing' }, { 'gem', 'MakeGem', true }, { 'scepter', 'MakeScepter' } }
local CD_PEARL_EXTRA = { { 'crown', 'MakeCrown' }, { 'figurine', 'MakeFigurine' }, { 'ring', 'MakeRing' }, { 'gem', 'MakeGem', true } }
local CD_FAMILIES = {   -- root family blocks, in native order
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
-- The ordering law for every shop menu: container rows first, then every leaf sorted
-- alphabetically by its full label, byte-wise and ascii-lowered (menu_model.lua byte_lt).
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
-- Rock submenu, alphabetical. Material pinned to any rock (mat 0:-1); tools resolve subtype by name.
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
-- Ammo leaves of an organic submenu, entity-derived, sharing ammo_shop_defs with the flat path.
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
-- Wood submenu: DF makes toys in rock, not wood, so there is no wooden toy row.
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
-- Bone and shell submenus; shell has no ammo. Armor leaves resolve their itemdef subtype by name.
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
-- Flat shops' container rows, bucketed by the leaves' raws category and civ-filtered.
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

-- Reactions of a custom category attached to the shop, civ-filtered, in raws order.
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
    -- Root is six container rows, then every leaf in one alphabetical block.
    local root, leaves = {}, {}
    root[#root + 1] = { kind = 'material_selector', label = 'rock', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_rock_submenu() }
    root[#root + 1] = { kind = 'material_selector', label = 'wood', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_wood_submenu() }
    root[#root + 1] = { kind = 'material_selector', label = 'bone', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_organic_submenu('bone', 'bone') }
    root[#root + 1] = { kind = 'material_selector', label = 'shell', mat_type = 0, mat_index = -1,
        confidence = 'screenshot-verified', leaves = cd_organic_submenu('shell', 'shell') }
    -- Two instrument custom-categories, civ-filtered and hidden when the fort civ has none.
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
    -- standard reactions (_def from getJobs by code)
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

-- ---- Bowyer / Clothier: entity-derived leaves reused from dynamic_shop_jobs ----
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
-- Clothier: three material submenus, nothing at the root.
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
-- Derives only from world raws and the fort entity, so the tree is static for a world session
-- and carries no live fort state -- availability is added later by annotate_native_avail.
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
-- Building this tree scans every raws reaction under the request's CoreSuspender and blows
-- DF's 1500 ms busy watchdog, freezing every player; cache it per save and per shop key.
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

-- order_entries_for_defs dedupes by key, so this union can only add entries, never remove one.
local function nod_leaf_def(l, metal)
    if l._def then
        local d = l._def
        return { name = l.label, label_locked = true, job_fields = d.job_fields, items = d.items }
    end
    if l.reaction_code then
        return { name = l.label, label_locked = true, job_fields = { reaction_name = l.reaction_code } }
    end
    if l.job_type then
        local jt = df.job_type[l.job_type]
        if jt == nil then return nil end
        local jf = { job_type = jt }
        if l.item_type then jf.item_type = df.item_type[l.item_type] end
        if l.item_subtype ~= nil then jf.item_subtype = l.item_subtype end
        if metal then jf.mat_type = metal.mat_type; jf.mat_index = metal.mat_index end
        return { name = l.label, label_locked = true, job_fields = jf }
    end
    return nil
end
function native_order_defs(shop_key, bt, st)
    local out = {}
    local function take(l, metal)
        local d = nod_leaf_def(l, metal)
        if d then out[#out + 1] = d end
    end
    if shop_key == 'MetalsmithsForge' or shop_key == 'MagmaForge' then
        local root = forge_task_tree(bt, st)
        if not root then return out end
        for _, cat in ipairs(root) do
            for _, l in ipairs(cat.leaves or {}) do take(l, nil) end
            for _, m in ipairs(cat.metals or {}) do
                for _, l in ipairs(m.leaves or {}) do take(l, m) end
            end
        end
        return out
    end
    local root = nil
    if shop_key == 'Craftsdwarfs' then root = craftsdwarf_tree(bt, st)
    elseif shop_key == 'Kennels' then root = kennels_tree() end
    if not root then return out end
    for _, node in ipairs(root) do
        if node.kind == 'material_selector' or node.kind == 'custom_category' then
            for _, l in ipairs(node.leaves or {}) do take(l, nil) end
        else
            take(node, nil)
        end
    end
    return out
end

-- Custom workshops (e.g. the Soap Maker) live in raws.buildings, not SHOP_CATALOG_SPECS.
function custom_workshop_order_groups(metals)
    local out = {}
    local ok = pcall(function()
        local raws = df.global.world.raws
        for _, bdef in ipairs(raws.buildings.all) do
            local defs = {}
            for _, r in ipairs(raws.reactions.reactions) do
                for j = 0, #r.building.type - 1 do
                    if r.building.type[j] == df.building_type.Workshop and
                       r.building.subtype[j] == df.workshop_type.Custom and
                       r.building.custom[j] == bdef.id then
                        defs[#defs + 1] = { name = r.name, label_locked = true,
                            job_fields = { reaction_name = r.code } }
                        break
                    end
                end
            end
            if #defs > 0 then
                out[#out + 1] = { name = bdef.name, items = order_entries_for_defs(defs, metals) }
            end
        end
    end)
    if not ok then return {} end
    return out
end

-- Both catalogs are world-static, so cache their serialized JSON per save_dir.
local _order_catalog_json_cache = {}
local _order_catalog_json_save = nil
local function _oc_cached(kind, build)
    local save = G(function() return df.global.world.cur_savegame.save_dir end, nil) or ''
    if save ~= _order_catalog_json_save then
        _order_catalog_json_cache = {}
        _order_catalog_json_save = save
    end
    local hit = _order_catalog_json_cache[kind]
    if hit ~= nil then return hit end
    local out = build()
    if type(out) == 'string' and #out > 0 then _order_catalog_json_cache[kind] = out end
    return out
end
local _order_catalog_impl = order_catalog
local _order_catalog_by_shop_impl = order_catalog_by_shop
function order_catalog()
    return _oc_cached('catalog', _order_catalog_impl)
end
function order_catalog_by_shop()
    return _oc_cached('by_shop', _order_catalog_by_shop_impl)
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
    if l.avail ~= nil then p[#p + 1] = '"avail":' .. json_bool(l.avail) end   -- availability bit
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

-- Match a t: key against each leaf's composed key and return the leaf's authoritative _def.
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

-- Per-leaf availability and the native "[Requires X]" objection. Availability is presence of
-- matching materials (DF's own orange trigger), not claimability; on error leaves stay clean.
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

-- One pass over IN_PLAY building the presence tables; presence is DF's trigger, not claimability.
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

-- The adjective DF prints for a reagent's reaction_class or material product is a display
-- string compiled into the binary, so an unpinned token yields a red row with no adjective.
local RX_CLASS_ADJ = {   -- reaction_class -> DF's printed adjective
    FAT = 'fat',   -- "Unrotten fat renderable glob"
    WAX = 'wax',   -- "Wax glob"
    PAPER_PLANT = 'paper-making',   -- "Unrotten paper-making plant"
}
local RX_PRODUCT_ADJ = {   -- has_material_reaction_product -> DF's printed adjective
    RENDER_MAT = 'renderable',   -- "Unrotten fat renderable glob"
}
-- Nouns DF prints for item types; anything unpinned falls back to the lowercased enum name.
local ITEM_NOUN = {
    GLOB = 'glob', PLANT = 'plant', SHEET = 'sheet', WINDOW = 'window', BOX = 'bag',
    BUCKET = 'bucket', THREAD = 'thread', CLOTH = 'cloth', BAR = 'bar', BOULDER = 'boulder',
}
local function item_noun(ity)
    local nm = G(function() return df.item_type[ity] end, nil)
    if not nm then return nil end
    return ITEM_NOUN[nm] or pretty_enum_name(nm):lower()
end
-- Compose DF's requirement phrase for one reagent, e.g. "Unrotten fat renderable glob".
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
-- Presence is matched on item TYPE (and subtype) only, not the reagent's EMPTY/UNROTTEN
-- predicates, so it fails OPEN (white where DF reds) and never hides a queueable job.
local function reagent_present(rg, P)
    local ity = G(function() return rg.item_type end, -1)
    local isub = G(function() return rg.item_subtype end, -1)
    if ity == nil or ity < 0 then return nil end     -- "any item" -> not objection-reported
    if isub ~= nil and isub >= 0 then
        return P.itype_sub[tostring(ity) .. ':' .. tostring(isub)] == true
    end
    return P.itype[ity] == true
end

-- Classify one reagent -> present(bool), desc(string); nil = skip (fuel, or a class DF never reports).
local function reagent_check(rg, P)
    local ity = G(function() return rg.item_type end, -1)
    local mt  = G(function() return rg.mat_type end, -1)
    local mi  = G(function() return rg.mat_index end, -1)
    local metal_ore = G(function() return rg.metal_ore end, -1)
    local rc = tostring(G(function() return rg.reaction_class end, '') or '')
    local BAR, BOULDER, THREAD = df.item_type.BAR, df.item_type.BOULDER, df.item_type.THREAD
    if COAL_MAT and mt == COAL_MAT then return nil end   -- fuel bar: never reported
    if metal_ore and metal_ore >= 0 then                                    -- METAL_ORE:X -> "<Metal>-bearing boulders"
        return (P.metal_yielded[metal_ore] == true), cap(sname(metal_ore) or ('metal ' .. metal_ore)) .. '-bearing boulders'
    end
    if rc == 'FLUX' then return P.flux_present, 'Flux boulders' end          -- REACTION_CLASS:FLUX boulder
    if ity == BAR then
        if mt == INORGANIC and mi >= 0 then return ((P.bar[mi] or 0) > 0), cap(sname(mi) or ('metal ' .. mi)) .. ' bars' end
        return P.any_metal_bar, 'Metal metal bars'   -- generic metal
    end
    if ity == THREAD then
        if mt == INORGANIC and mi >= 0 then return ((P.thread[mi] or 0) > 0), cap(sname(mi) or ('metal ' .. mi)) .. ' strands' end
        return nil
    end
    if ity == BOULDER then
        if mt == INORGANIC and mi >= 0 then return ((P.boulder[mi] or 0) > 0), cap(sname(mi) or ('stone ' .. mi)) end
        return nil
    end
    local desc = reagent_desc(rg, P)
    if not desc then return nil end                                         -- unnameable -> skip (fail-open)
    local present = reagent_present(rg, P)
    if present == nil then return nil end
    return present, desc
end

-- objection for a df.reaction: DF reports the LAST unmet objection-eligible reagent.
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
    dwf_pcall('lua.orders.annotate-forge-avail', function()
        local P = build_presence()
        local rbc  -- lazy reaction lookup (only if an instrument category is present)
        for _, cat in ipairs(root) do
            if cat.leaves then   -- leaf-only category (instruments)
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

-- Annotate flat-shop reaction rows from their own df.reaction reagents, one presence pass per shop.
function annotate_flat_avail(tasks)
    if not tasks then return end
    dwf_pcall('lua.orders.annotate-flat-avail', function()
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
            -- A container's children are reactions too -- they get the same red state.
            for _, c in ipairs(t.children or {}) do annotate(c) end
        end
    end)
end

annotate_native_avail = function(root)
    if not root then return end
    dwf_pcall('lua.orders.annotate-native-avail', function()
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
end)()   -- end availability IIFE

-- workshop_profile.blocked_labors is a STATIC bool array indexed by df.unit_labor, not a
-- vector; max_level sentinel 3000 means "no cap".
function profile_blocked_labors_json(profile)
    local out = {}
    dwf_pcall('lua.workshop.blocked-labors', function()
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
-- A workshop's master is element ZERO of permitted_workers and nothing else; -1 means the
-- shop is free for anybody to use.
function profile_master_id(profile)
    local id = -1
    dwf_probe('lua.probe.profile-master', function()
        local pw = profile and profile.permitted_workers
        if pw and #pw > 0 then id = pw[0] end
    end)
    return tonumber(id) or -1
end
function profile_general_orders_banned(profile)
    local v = false
    dwf_probe('lua.probe.profile-general-orders', function() v = profile.flags and profile.flags.block_general_orders or false end)
    return v
end

-- DestroyBuilding is the removal job; its UNIT_WORKER ref means removal is active.
function building_removal_state(b)
    if not b or not b.jobs then return false, false end
    for i = 0, #b.jobs - 1 do
        local job = b.jobs[i]
        if job and job.job_type == df.job_type.DestroyBuilding then
            local active = false
            dwf_probe('lua.probe.job-worker', function() active = dfhack.job.getWorker(job) ~= nil end)
            return true, active
        end
    end
    return false, false
end

function workshop_info(id)
    wtrace('workshop_info: ENTER id=' .. tostring(id))
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
    wtrace('workshop_info: id=' .. tostring(id))
    -- The three tabs are unconditional, so "no profile at all" must stay distinguishable from
    -- a profile whose fields are all at their defaults.
    local has_profile = b.profile ~= nil
    local profile = b.profile or {}
    local marked_for_removal, removal_active = building_removal_state(b)
    local defs     = ws_section('shop_job_defs',     function() return shop_job_defs(b) end, {})
    local tasks    = ws_section('shop_tasks',        function() return shop_tasks(b, defs) end, {})
    -- Give the flat list DF's real "[Requires X]" line for every reaction row it can't run.
    ws_section('annotate_flat_avail', function() annotate_flat_avail(tasks); return true end, false)
    local order_tasks = ws_section('shop_order_tasks', function() return shop_order_tasks(defs) end, {})
    local j_jobs   = ws_section('shop_jobs_json',    function() return shop_jobs_json(b) end, '[]')
    local j_tasks  = ws_section('shop_tasks_json',   function() return shop_tasks_json(tasks) end, '[]')
    local j_order_tasks = ws_section('shop_order_tasks_json', function() return shop_order_tasks_json(order_tasks) end, '[]')
    local j_orders = ws_section('shop_orders_json',  function() return shop_orders_json(b.id) end, '[]')
    local j_items  = ws_section('shop_items_json',   function() return shop_items_json(b) end, '[]')
    local j_workers= ws_section('shop_workers_json', function() return shop_workers_json(b) end, '[]')
    -- Nested native add-task tree for the forges and the native shops; null elsewhere.
    local native_root = ws_section('native_menu_tree', function()
        if native_shop_is(b) then return native_menu_tree(b) end
        return nil
    end, nil)
    local j_tree = ws_section('forge_task_tree', function()
        local bt, st = forge_bt_st(b)
        if bt then
            local root = select(1, forge_task_tree(bt, st))
            annotate_forge_avail(root)   -- per-leaf availability + "[Requires X]" objection
            return ft_tree_json(root)
        end
        if native_root then
            annotate_native_avail(native_root)   -- Smelter/MagmaSmelter reactions + SmeltOre
            return native_tree_json(native_root)
        end
        return 'null'
    end, 'null')
    wtrace('workshop_info: assemble')
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
        '"hasProfile":' .. json_bool(has_profile),
        -- Reuses has_manager() so this panel and /orders can never disagree.
        '"hasManager":' .. json_bool(ws_section('has_manager', has_manager, false)),
        '"profile":{"maxGeneralOrders":' .. tostring(profile.max_general_orders or 0) ..
            ',"permittedCount":' .. tostring((profile.permitted_workers and #profile.permitted_workers) or 0) ..
            ',"masterId":' .. tostring(profile_master_id(profile)) ..
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
        -- Native's per-task priority IS do_now; this toggles it, while 'now' stays set-only.
        job.flags.do_now = not job.flags.do_now
    elseif action == 'moveup' then
        -- Re-derive the move-up guard here: the sim can finish or cancel a job between the panel read
        -- and this POST, so a stale browser index is refused, never written.
        local n = #b.jobs
        if n < 2 then return false, 'workshop has fewer than two tasks' end
        local idx = -1
        for i = 0, n - 1 do
            local cur = b.jobs[i]
            if cur and cur.id == job.id then idx = i; break end
        end
        if idx < 0 then return false, 'job not found in workshop' end
        if idx < 1 then return false, 'task is already first' end
        local ok_move = pcall(function()
            local above = b.jobs[idx - 1]
            b.jobs[idx - 1] = b.jobs[idx]
            b.jobs[idx] = above
        end)
        if not ok_move then return false, 'could not reorder tasks' end
    else
        return false, 'unknown job action'
    end
    dwf_pcall('lua.job.check-buildings-now', dfhack.job.checkBuildingsNow)
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
    -- job is the STRING name: ensure_df_id accepts either, and the string matches create_order.
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

    local before = {}
    do
        local all = df.global.world.manager_orders.all
        for i = 0, #all - 1 do local o = all[i]; if o then before[o.id] = true end end
    end
    local ok_req, wo = pcall(reqscript, 'workorder')
    if not ok_req or not wo then return false, 'workorder module unavailable' end
    wtrace('create_shop_order: job=' .. tostring(order_def.job) ..
        ' mat_cat=' .. tostring(order_def.material_category and 'set' or 'nil'))
    local ok, err = pcall(function()
        local orders = wo.preprocess_orders({order_def})
        wtrace('create_shop_order: preprocess ok, fillin_defaults')
        wo.fillin_defaults(orders)
        wtrace('create_shop_order: fillin ok, create_orders')
        wo.create_orders(orders, true)
        wtrace('create_shop_order: create_orders ok')
    end)
    if not ok then return false, tostring(err) end
    if job_fields.mat_type == 0 and (job_fields.mat_index == nil or job_fields.mat_index == -1) then
        local all = df.global.world.manager_orders.all
        local filter_error
        for i = 0, #all - 1 do
            local order = all[i]
            if order and not before[order.id] then
                order.mat_type = 0
                order.mat_index = -1
                local filter_ok, filter_err = attach_generic_stone_order_filter(order, 0, -1)
                if not filter_ok then filter_error = filter_err or 'could not attach stone filter' end
            end
        end
        if filter_error then
            for i = #all - 1, 0, -1 do
                local order = all[i]
                if order and not before[order.id] then all:erase(i) end
            end
            return false, 'could not apply native stone policy: ' .. filter_error
        end
    end
    return true, 'shop work order queued'
end

-- input_filter_defaults is a job_item template: copy only the fields present, because
-- clobbering the rest with nil produces "unknown material" and uncompletable jobs.
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
    if type(item_def.flags1) == 'table' then for k, v in pairs(item_def.flags1) do dwf_probe('lua.probe.job-item-flags1', function() ji.flags1[k] = v end) end end
    if type(item_def.flags2) == 'table' then for k, v in pairs(item_def.flags2) do dwf_probe('lua.probe.job-item-flags2', function() ji.flags2[k] = v end) end end
    if type(item_def.flags3) == 'table' then for k, v in pairs(item_def.flags3) do dwf_probe('lua.probe.job-item-flags3', function() ji.flags3[k] = v end) end end
    if type(item_def.flags4) == 'number' then ji.flags4 = item_def.flags4 end
    if type(item_def.flags5) == 'number' then ji.flags5 = item_def.flags5 end
    -- dye_color, contains, reagent_index and reaction_id are not cosmetic: DF reads them at
    -- runtime and abandons its walk on reagent_index == -1. vector_id is set elsewhere.
    if item_def.reagent_index ~= nil then dwf_probe('lua.probe.job-item-reagent-index', function() ji.reagent_index = item_def.reagent_index end) end
    if item_def.reaction_id ~= nil then dwf_probe('lua.probe.job-item-reaction-id', function() ji.reaction_id = item_def.reaction_id end) end
    if item_def.dye_color ~= nil then dwf_probe('lua.probe.job-item-dye-color', function() ji.dye_color = item_def.dye_color end) end
    if type(item_def.contains) == 'table' then
        for _, reagent_idx in ipairs(item_def.contains) do
            dwf_pcall('lua.job.reagent-contains-insert',
                      function() ji.contains:insert('#', reagent_idx) end)
        end
    end
    return ji
end

-- Container-held reagents ("dye in a bag") are flagged do-not-check-directly and DF's own job
-- builder skips them; keeping them queues a job that fetches the wrong container or stalls.
function reaction_requirement_rows(reaction_code, items)
    if not reaction_code or #reaction_code == 0 then return nil end
    items = items or {}

    local reaction, reaction_id
    local ok = pcall(function()
        local rs = df.global.world.raws.reactions.reactions
        for i = 0, #rs - 1 do
            if rs[i].code == reaction_code then reaction, reaction_id = rs[i], i return end
        end
    end)
    if not ok or not reaction then return nil end

    local reagent_count = 0
    if not pcall(function() reagent_count = #reaction.reagents end) then return nil end

    -- DFHack builds one row per reagent, optionally plus a fuel row; any other shape means the
    -- alignment assumption is wrong and must not be acted on.
    if #items ~= reagent_count and #items ~= reagent_count + 1 then return nil end

    local out = {}
    for i = 0, reagent_count - 1 do
        local reagent = reaction.reagents[i]
        local in_container = false
        dwf_probe('lua.probe.reagent-in-container', function() in_container = reagent.flags.IN_CONTAINER == true end)
        if not in_container then
            local row = {}
            for k, v in pairs(items[i + 1] or {}) do row[k] = v end
            row.reagent_index = i
            row.reaction_id = reaction_id   -- DFHack fills this with a filtered-list index, not the raws index
            dwf_probe('lua.probe.reagent-dye', function() row.dye_color = reagent.dye_color end)
            dwf_probe('lua.probe.reagent-contains', function()
                local contains = {}
                for j = 0, #reagent.contains - 1 do contains[#contains + 1] = reagent.contains[j] end
                if #contains > 0 then row.contains = contains end
            end)
            out[#out + 1] = row
        end
    end
    -- keep the trailing fuel row verbatim; it is not a reagent and has no index.
    if #items == reagent_count + 1 then out[#out + 1] = items[#items] end
    return out
end

-- A generic inorganic order needs BOTH flags2.non_economic and flags3.hard, which DFHack's
-- workorder.lua leaves unset; an explicitly pinned material is a different branch.
function attach_generic_stone_order_filter(order, mat_type, mat_index)
    if not order or mat_type ~= 0 or mat_index ~= -1 then return true end
    local ok, err = pcall(function()
        if not order.items then order.items = df.job_reqst:new() end
        local matched = false
        for i = 0, #order.items.elements - 1 do
            local item = order.items.elements[i]
            if item and item.item_type == df.item_type.BOULDER
               and item.mat_type == 0 and item.mat_index == -1 then
                item.flags2.non_economic = true
                item.flags3.hard = true
                matched = true
            end
        end
        if not matched then
            local item = build_job_item(STONE_REAGENT)
            item.mat_index = -1
            order.items.elements:insert('#', item)
        end
    end)
    return ok, ok and nil or tostring(err)
end

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

-- Add a SINGLE direct job to the building (DF's "Add new task"), not a manager work order.
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
    -- product material: -1 = decided by the gathered reagent; only hardcoding jobs set mat_type.
    job.mat_type = job_fields.mat_type or -1
    job.mat_index = job_fields.mat_index or -1
    -- material_category drives DF's "<material> crafts/toy/..." caption.
    if job_fields.material_category then
        dwf_pcall('lua.job.material-category-write',
                  function() job.material_category[job_fields.material_category] = true end)
    end
    -- Subtype jobs carry the product item_type and item_subtype, as DF sets a forge MakeWeapon job.
    if job_fields.item_type ~= nil then dwf_probe('lua.probe.job-item-type', function() job.item_type = job_fields.item_type end) end
    if job_fields.item_subtype ~= nil then dwf_probe('lua.probe.job-item-subtype', function() job.item_subtype = job_fields.item_subtype end) end
    if job_type == df.job_type.CustomReaction then
        job.reaction_name = job_fields.reaction_name
    end
    if job_type == df.job_type.EngraveSlab then
        local unit = unit_id and df.unit.find(tonumber(unit_id)) or nil
        if not unit or (unit.hist_figure_id or -1) < 0 or not dfhack.units.isDead(unit) then
            job:delete()
            return false, 'EngraveSlab requires a dead or missing unitId'
        end
        -- df.job has no top-level hist_figure_id: the subject rides job.specdata. Writing
        -- job.hist_figure_id raises "Cannot write field job.hist_figure_id: not found".
        job.specdata.hist_figure_id = unit.hist_figure_id
    end

    -- link the job to the building, then append the reagent requirements.
    job.general_refs:insert('#', { new = df.general_ref_building_holderst, building_id = b.id })
    b.jobs:insert('#', job)
    wtrace('add_task: job_type=' .. tostring(df.job_type[job_type]) .. ' job.mat_type=' .. tostring(job.mat_type) ..
        ' #def.items=' .. tostring(def.items and #def.items or 0))
    -- For a custom reaction, drop the container-held reagent rows DF never creates; nil = fall back.
    local reqs = def.items or {}
    if job_type == df.job_type.CustomReaction then
        local native_rows = reaction_requirement_rows(job_fields.reaction_name, reqs)
        if native_rows then
            wtrace('add_task: reaction reqs ' .. tostring(#reqs) .. ' -> ' .. tostring(#native_rows) ..
                ' (container-held reagents skipped)')
            reqs = native_rows
        end
    end
    for i, item_def in ipairs(reqs) do
        wtrace('add_task: item[' .. i .. '] item_type=' .. tostring(item_def.item_type) ..
            ' mat_type=' .. tostring(item_def.mat_type) .. ' vector_id=' .. tostring(item_def.vector_id) ..
            ' quantity=' .. tostring(item_def.quantity))
        job.job_items.elements:insert('#', build_job_item(item_def))
    end
    wtrace('add_task: built #job_items=' .. tostring(#job.job_items.elements))
    local ok_nm, nm = pcall(dfhack.job.getName, job)
    wtrace('add_task: getName=' .. tostring(ok_nm and nm or 'ERR'))

    local ok, err = pcall(dfhack.job.linkIntoWorld, job, true)
    if not ok then
        -- back out the half-built job: drop the building's reference, then free the job.
        dwf_pcall('lua.job.rollback-unlink', function() b.jobs:erase(#b.jobs - 1) end)
        dwf_pcall('lua.job.rollback-delete', function() job:delete() end)
        return false, 'could not link job: ' .. tostring(err)
    end
    dwf_pcall('lua.job.check-buildings-now', dfhack.job.checkBuildingsNow)
    if DWF_DIAG then
        dwf_probe('lua.probe.diag-dump-jobs', dump_jobs_of_type, job_type)
    end
    return true, 'task added'
end

-- Forge-tree leaf key: t:<JobType>[|it:<ItemType>][|st:<subtype>][|mat:<matType>:<matIndex>]
-- [|rc:<reactionCode>][|b:<batch>]. mat pins the product material AND the metal-bar reagent.
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

    -- Reaction leaf: reuse the getJobs def (its reagents are authoritative), matched by reaction code.
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
        -- forge reagent = one bar of exactly this metal, mirroring DF's own "Forge <metal> X" job.
        items[#items + 1] = { item_type = df.item_type.BAR, mat_type = p.mat_type, mat_index = p.mat_index,
            flags3 = { metal = true }, quantity = 1 }
    end
    return add_workshop_task(b, { job_fields = jf, items = items })
end

-- Queue a native-shop leaf by matching the t: key against each leaf's composed key.
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
    -- Forge drill-down leaves send a self-describing 't:' key (per-metal).
    if type(task_key) == 'string' and task_key:sub(1, 2) == 't:' then
        -- Native flat/mixed shops resolve the leaf's real def, not the forge's BAR-reagent rebuild.
        if native_shop_is(b) then return native_queue(b, task_key) end
        return add_tree_task(b, task_key)
    end
    local defs = shop_job_defs(b)
    local def = defs[tostring(task_key)]
    if not def then return false, 'task not found' end
    -- Tasks tab = a single direct workshop job, not a manager work order.
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

-- One profile field per call, every write clamped to a legal range (skill 0..3000, general
-- orders 0..99, labor index bounds-checked) so a raw POST cannot index past blocked_labors.
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
        -- The native cap is 99, not 10; a tighter bound makes legal values 11..99 unreachable.
        profile.max_general_orders = clampi(value, 0, 99)
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

-- Create one manager order from a catalog key: 'j:<job>'/'r:<reaction>' plus optional
-- '|it:|st:' product fields and '|cat:' or '|mat:' material.
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
        -- Defence in depth: a raw POST must not create an order for an ORDER_EXCLUDED_JOBS job.
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

    -- Multiple suffixes are needed for MakeTool orders, e.g. j:MakeTool|it:TOOL|st:17|cat:wood.
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

    -- Subtype-bearing jobs may reach DF's namer only with a real, matching itemdef.
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

    -- Legality gate: ask DF's own namer on a throwaway manager order and reject "unknown
    -- material". The temp order is deleted, never inserted into world.manager_orders.
    do
        local ok_probe, probe_name = pcall(function()
            local t = df.manager_order:new()
            t.job_type = def_reaction and df.job_type.CustomReaction or job_type_val
            if def_reaction then t.reaction_name = def_reaction end
            if item_type_val ~= nil then t.item_type = item_type_val end
            if item_subtype ~= nil then t.item_subtype = item_subtype end
            t.mat_type = mat_type or -1
            t.mat_index = mat_index or -1
            if mat_cat then dwf_probe('lua.probe.material-category', function() t.material_category[mat_cat] = true end) end
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

    -- snapshot existing ids BEFORE creating so the new order id(s) can be found afterwards.
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

    -- collect the new order id(s) and apply the chosen specific material to them.
    local new_ids = {}
    local filter_error
    do
        local all = df.global.world.manager_orders.all
        for i = 0, #all - 1 do
            local o = all[i]
            if o and not before[o.id] then
                new_ids[#new_ids + 1] = o.id
                if mat_type then
                    dwf_pcall('lua.order.material-write',
                              function() o.mat_type = mat_type; o.mat_index = mat_index end)
                end
                local filter_ok, filter_err =
                    attach_generic_stone_order_filter(o, mat_type, mat_index)
                if not filter_ok then filter_error = filter_err or 'could not attach stone filter' end
            end
        end
    end
    if filter_error then
        -- Do not leave behind the exact malformed order this guard exists to prevent.
        local all = df.global.world.manager_orders.all
        for i = #all - 1, 0, -1 do
            local o = all[i]
            if o and not before[o.id] then
                all:erase(i)
                dwf_pcall('lua.order.rollback-delete', function() o:delete() end)
            end
        end
        return false, 'could not apply native stone policy: ' .. filter_error
    end
    return true, 'order queued', new_ids
end

-- The condition EDITOR write path.

-- A bad item_type or material index in a manager_order_condition_item is read by DF's daily
-- condition check and can crash far from the write, so every field is validated first.

-- Adjective keys the editor may write; '' = none, comma-separated lists round-trip losslessly.
-- 'empty' is job_item_flags1.empty and is deliberately outside CONDITION_ADJECTIVES.
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

-- Validate the FULL state of a stock condition. compare must be one of DF's six real
-- logic_condition_type values; material must decode through dfhack.matinfo or it is refused.
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
        -- These have no init-value in df-structures, so :new() leaves them 0 -- but DF's "any"
        -- sentinel is -1, and at 0 the condition names a real ore/colour/tool-use and DF crashes.
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
    if not ok then dwf_probe('lua.probe.condition-rollback-delete', function() c:delete() end); return false, tostring(err) end
    if not c then return true, 'condition already exists' end
    return true, 'condition added'
end

-- Edit a stock condition IN PLACE so the row keeps its position and identity. Only the
-- adjective bits this editor owns are rewritten; other DF-set filter fields survive.
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

-- DF's suggested filters exist only as transient native editor state and DFHack exposes no
-- lossless provider, so this fails closed: never rebuild a filter from browser-visible prose.
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
    if not ok then dwf_probe('lua.probe.condition-rollback-delete', function() c:delete() end); return false, tostring(err) end
    return true, 'dependency added'
end

-- Flip an existing dependency's check type IN PLACE (Activated <-> Completed); only
-- 'condition' is written, and the index is bounds-checked against the live vector.
function edit_order_condition(order_id, idx, cond_type)
    local o = find_order(order_id)
    if not o then return false, 'order not found' end
    idx = tonumber(idx)
    if not idx or idx < 0 or idx >= #o.order_conditions then return false, 'bad condition index' end
    local ct = df.workquota_order_condition_type[tostring(cond_type or '')]
    if ct == nil then return false, 'bad condition type' end
    local c = o.order_conditions[idx]
    if not c then return false, 'bad condition index' end
    local ok, err = pcall(function() c.condition = ct end)
    if not ok then return false, tostring(err) end
    return true, 'check type updated'
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

-- Change an order's target amount and/or frequency; the browser sends the new ABSOLUTE total.
-- amount_total and amount_left move by the same delta, preserving completed progress.
function adjust_order(id, amount, frequency)
    id = tonumber(id)
    if not id then return false, 'bad id' end
    local all = df.global.world.manager_orders.all
    for i = 0, #all - 1 do
        local o = all[i]
        if o and o.id == id then
            local a = tonumber(amount)
            if a and a >= 0 then
                local completed = math.max(0, (tonumber(o.amount_total) or 0) -
                    (tonumber(o.amount_left) or 0))
                local new_total = clamp(a, 0, 9999)
                o.amount_total = new_total
                o.amount_left = clamp(new_total - completed, 0, new_total)
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
