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
