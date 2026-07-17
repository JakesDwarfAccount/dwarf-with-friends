-- menu_model.lua -- TRUEMENU deliverable 1: DF-structure workshop-menu model GENERATOR.
--
-- Walks the live game's raws + fort entity (READ-ONLY, nil/bounds-guarded, no DF_LOCK needed)
-- and emits a machine-readable model of DF v50's native workshop add-task menus as JSON:
--   workshop type -> [category ->] [material ->] task leaves, with DF's own label composition
--   and ordering semantics.
--
-- Run:  dfhack-run.exe lua -f <repo>/tools/harness/menu_model.lua <out.json> [shopkey ...]
--       (shopkey e.g. "Workshop/MetalsmithsForge"; no keys = all shops)
-- NOTE: output goes to a FILE, never stdout -- dfhack.workshops.getJobs prints debug spew for
--       smelters (observed live 2026-07-08), so stdout is not a clean channel.
--
-- Model provenance (see docs/superpowers/specs/2026-07-08-truemenu-spec.md):
--   * forge category rows + per-category leaf lists: the Menu Oracle Screenshots (9 drill-downs)
--   * per-category metal filters: inorganic material flags, differentially verified against the
--     screenshots (ITEMS_WEAPON==weapons list; ITEMS_HARD==other-objects list; ITEMS_ARMOR
--     disproves the armor montage's reused metal panel -- silver is weapons-only)
--   * button/struct model: df-structures df.d_interface.xml (interface_button_building_*st)
-- Every node carries "confidence": screenshot-verified | flag-derived | dfhack-derived | speculative.

local args = { ... }
local out_path = args[1]
if not out_path or out_path == '' then
    qerror('usage: lua -f menu_model.lua <out.json> [Workshop/<type>|Furnace/<type> ...]')
end
local only = {}
for i = 2, #args do only[args[i]] = true end
local filter_active = (#args >= 2)

local ok_json, json = pcall(require, 'json')
if not ok_json then qerror('dfhack json module unavailable') end

-- ---------------------------------------------------------------------------------------------
-- guarded readers
local function G(fn, fallback)
    local ok, v = pcall(fn)
    if ok then return v end
    return fallback
end

local raws = df.global.world.raws
local IT = raws.itemdefs
local INORGANIC = 0 -- builtin mat_type for inorganic materials

local function fort_entity()
    return G(function() return df.global.plotinfo.main.fortress_entity end, nil)
end

-- ---------------------------------------------------------------------------------------------
-- metals: IS_METAL inorganics carrying a given ITEMS_* flag, in INORGANIC INDEX ORDER.
-- Index order is DF's native metal-list order (oracle: the other-objects screenshot list matches
-- raws order exactly: iron, gold, silver, copper, nickel, zinc, bronze, brass, steel, ...).
local function metals_with(flagnames) -- flagnames: array = union
    local out = {}
    local inorg = G(function() return raws.inorganics.all end, nil)
    if not inorg then return out end
    local n = G(function() return #inorg end, 0)
    for i = 0, n - 1 do
        local m = inorg[i]
        local mf = G(function() return m.material.flags end, nil)
        if mf and G(function() return mf.IS_METAL end, false) then
            local hit = false
            for _, fl in ipairs(flagnames) do
                if G(function() return mf[fl] end, false) then hit = true break end
            end
            if hit then
                local nm = G(function() return m.material.state_name.Solid end, nil)
                out[#out + 1] = {
                    label = (nm and #nm > 0) and nm or ('metal ' .. i),
                    mat_type = INORGANIC, mat_index = i,
                    token = G(function() return m.id end, ''),
                }
            end
        end
    end
    return out
end

local function metal_has(mat_index, flagname)
    return G(function() return raws.inorganics.all[mat_index].material.flags[flagname] end, false)
end

-- ---------------------------------------------------------------------------------------------
-- label composition, mirroring DF's native strings (screenshot-verified forms):
--   "Forge <adj?> <metal> <name>"            weapons / trap comps ("Forge large, serrated iron disc")
--   "Forge pair of <metal> <name_plural>"    gloves / shoes ("Forge pair of iron gauntlets")
--   "Forge twenty-five <metal> <plural>"     ammo ("Forge twenty-five iron bolts")
--   "Make <metal> <noun>"                    the Make-verb furniture/goods split
local function compose(verb, adj, metal, noun)
    local parts = { verb }
    if adj and #adj > 0 then parts[#parts + 1] = adj end
    if metal and #metal > 0 then parts[#parts + 1] = metal end
    parts[#parts + 1] = noun
    return table.concat(parts, ' ')
end

local function jt_name(jt) return df.job_type[jt] or tostring(jt) end

-- DF's native menu uppercases the first byte of a reaction's raws NAME for display (raws
-- "make brass bars"/"forge madush case" -> native "Make brass bars"/"Forge madush case", captures
-- 28 + 30). Applied to every reaction leaf label.
local function ncap(s)
    s = tostring(s or '')
    if #s == 0 then return s end
    local b = s:byte(1)
    if b >= 97 and b <= 122 then return string.char(b - 32) .. s:sub(2) end
    return s
end

local function leaf(label, jt, itype, isub, subtok, conf, extra)
    local L = {
        kind = 'job', label = label, job_type = jt_name(jt),
        confidence = conf or 'flag-derived',
    }
    if itype ~= nil then L.item_type = df.item_type[itype] or itype end
    if isub ~= nil then L.item_subtype = isub end
    if subtok and #subtok > 0 then L.subtype_token = subtok end
    if extra then for k, v in pairs(extra) do L[k] = v end end
    return L
end

-- Deterministic BYTE-WISE ascii-lowered sort. Lua's `<` on strings is strcoll (locale-dependent
-- inside DF's process: cp437 accented bytes collate like their base letter there), which would
-- make the model's order host-locale-dependent. Byte order is stable and matches the ASCII-only
-- vanilla labels; how NATIVE DF collates accented WORLD-GENERATED names (instrument pieces) is
-- NOT-VERIFIED -- resolve with menu_oracle.lua alpha_order when a forge sheet is open.
local function byte_lt(a, b)
    local la, lb = #a, #b
    for i = 1, math.min(la, lb) do
        local ca, cb = a:byte(i), b:byte(i)
        if ca >= 65 and ca <= 90 then ca = ca + 32 end
        if cb >= 65 and cb <= 90 then cb = cb + 32 end
        if ca ~= cb then return ca < cb end
    end
    return la < lb
end
local function alpha_sort(leaves)
    table.sort(leaves, function(a, b) return byte_lt(a.label or '', b.label or '') end)
    return leaves
end

-- enumerate one entity resource vector of itemdef subtype indices (dedup, guarded)
local function each_entity_def(idx_vec, raws_vec, fn)
    if not idx_vec or not raws_vec then return end
    local n = G(function() return #idx_vec end, 0)
    local rn = G(function() return #raws_vec end, 0)
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

-- ---------------------------------------------------------------------------------------------
-- FORGE leaf builders (metal = {label, mat_index})

local function weapon_leaves(R, metal)
    local out = {}
    local add = function(sub, d)
        if G(function() return d.flags.TRAINING end, false) then return end
        local ranged = G(function() return d.ranged_ammo end, '') or ''
        if #ranged > 0 and not metal_has(metal.mat_index, 'ITEMS_WEAPON_RANGED') then return end
        local adj = G(function() return d.adjective end, '') or ''
        local nm = G(function() return d.name end, 'weapon')
        out[#out + 1] = leaf(compose('Forge', adj, metal.label, nm),
            df.job_type.MakeWeapon, df.item_type.WEAPON, sub,
            G(function() return d.id end, ''), 'screenshot-verified')
    end
    each_entity_def(R.weapon_type, IT.weapons, add)
    -- diggers (picks) are gated on ITEMS_DIGGER, not ITEMS_WEAPON: DF's native forge menu
    -- offers "Forge iron pick" but NO silver pick (silver has ITEMS_WEAPON only) -- tmverify2
    -- oracle-differential 2026-07-08.
    if metal_has(metal.mat_index, 'ITEMS_DIGGER') then
        each_entity_def(R.digger_type, IT.weapons, add)
    end
    if metal_has(metal.mat_index, 'ITEMS_AMMO') then
        each_entity_def(R.ammo_type, IT.ammo, function(sub, d)
            local pl = G(function() return d.name_plural end, nil) or G(function() return d.name end, 'ammo')
            out[#out + 1] = leaf('Forge twenty-five ' .. metal.label .. ' ' .. pl,
                df.job_type.MakeAmmo, df.item_type.AMMO, sub,
                G(function() return d.id end, ''), 'screenshot-verified', { batch = 25 })
        end)
    end
    -- NATIVE ORDER (capture 01): entity weapon_type vector, then digger, then ammo -- NOT alpha.
    return out
end

-- armor-family vectors: {entity_vec, raws_vec, job, item_type, pair_of}
-- Family order is NATIVE order (armor, pants, helm, gloves, shoes), verified against oracle
-- captures 07 (ARMOR x glowing metal) + 27 (Metal clothing x adamantine): DF emits the item
-- families in exactly this sequence, then shields (ARMOR) / backpack+quiver (Metal clothing).
local function armor_family(R)
    return {
        { R.armor_type,  IT.armor,   df.job_type.MakeArmor,  df.item_type.ARMOR,  false },
        { R.pants_type,  IT.pants,   df.job_type.MakePants,  df.item_type.PANTS,  false },
        { R.helm_type,   IT.helms,   df.job_type.MakeHelm,   df.item_type.HELM,   false },
        { R.gloves_type, IT.gloves,  df.job_type.MakeGloves, df.item_type.GLOVES, true  },
        { R.shoes_type,  IT.shoes,   df.job_type.MakeShoes,  df.item_type.SHOES,  true  },
    }
end

-- Category membership rule (live-verified 2026-07-08 against the screenshots + itemdef props):
--   ARMOR category          <=> itemdef props flag METAL   (breastplate/helm/cap/gauntlets...;
--                               excludes leather armor which native's armor list omits)
--   METAL CLOTHING category <=> props SOFT and NOT METAL   (cloak/robe/socks...; cap is
--                               SOFT+METAL and natively appears under ARMOR only)
-- NOTE: armorlevel is the WRONG filter -- cap has armorlevel 0 yet is native-listed under Armor.
local function props_flag(d, name)
    return G(function() return d.props.flags[name] end, false)
end

local function clothing_leaves(R, metal, want_armor_category)
    local out = {}
    for _, fam in ipairs(armor_family(R)) do
        each_entity_def(fam[1], fam[2], function(sub, d)
            local is_metal = props_flag(d, 'METAL')
            local is_soft = props_flag(d, 'SOFT')
            local keep
            if want_armor_category then keep = is_metal else keep = (is_soft and not is_metal) end
            if not keep then return end
            local nm, lbl
            if fam[5] then
                nm = G(function() return d.name_plural end, nil) or G(function() return d.name end, 'item')
                lbl = 'Forge pair of ' .. metal.label .. ' ' .. nm
            else
                nm = G(function() return d.name end, 'item')
                lbl = compose('Forge', G(function() return d.adjective end, '') or '', metal.label, nm)
            end
            out[#out + 1] = leaf(lbl, fam[3], fam[4], sub, G(function() return d.id end, ''),
                'screenshot-verified')
        end)
    end
    if want_armor_category then
        -- shields carry no armorlevel; all metal-forgeable (buckler + shield on vanilla dwarves)
        each_entity_def(R.shield_type, IT.shields, function(sub, d)
            out[#out + 1] = leaf('Forge ' .. metal.label .. ' ' .. (G(function() return d.name end, 'shield')),
                df.job_type.MakeShield, df.item_type.SHIELD, sub, G(function() return d.id end, ''),
                'screenshot-verified')
        end)
    else
        -- metal clothing extras (screenshot: "Make adamantine backpack", "Make adamantine quiver")
        out[#out + 1] = leaf('Make ' .. metal.label .. ' backpack', df.job_type.MakeBackpack,
            df.item_type.BACKPACK, nil, nil, 'screenshot-verified')
        out[#out + 1] = leaf('Make ' .. metal.label .. ' quiver', df.job_type.MakeQuiver,
            df.item_type.QUIVER, nil, nil, 'screenshot-verified')
    end
    -- NATIVE ORDER (captures 07/27): family blocks in the armor_family() sequence, each block in
    -- entity-vector order, then shields / backpack+quiver appended -- NOT alpha.
    return out
end

-- Furniture: ONE hardcoded native sequence (oracle capture 08, FURNITURE x gold). DF interleaves
-- Forge/Make verbs (pipe section sits between bin and splint, NOT grouped) -- {noun, verb, job}.
local FURNITURE_SEQ = {
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
local function furniture_leaves(metal)
    local out = {}
    for _, f in ipairs(FURNITURE_SEQ) do
        if df.job_type[f[3]] then
            out[#out + 1] = leaf(f[2] .. ' ' .. metal.label .. ' ' .. f[1], df.job_type[f[3]], nil, nil, nil,
                'screenshot-verified')
        end
    end
    return out -- NATIVE ORDER (capture 08) -- NOT alpha.
end

local function siege_leaves(metal)
    return { leaf('Forge ' .. metal.label .. ' ballista arrow head', df.job_type.MakeBallistaArrowHead,
        nil, nil, nil, 'screenshot-verified') }
end

local function trap_leaves(R, metal)
    local out = {}
    if metal_has(metal.mat_index, 'ITEMS_WEAPON') then
        each_entity_def(R.trapcomp_type, IT.trapcomps, function(sub, d)
            out[#out + 1] = leaf(
                compose('Forge', G(function() return d.adjective end, '') or '', metal.label,
                    G(function() return d.name end, 'component')),
                df.job_type.MakeTrapComponent or df.job_type.MakeWeapon, df.item_type.TRAPCOMP, sub,
                G(function() return d.id end, ''), 'screenshot-verified')
        end)
    end
    if metal_has(metal.mat_index, 'ITEMS_HARD') then
        out[#out + 1] = leaf('Make ' .. metal.label .. ' mechanisms', df.job_type.ConstructMechanisms,
            nil, nil, nil, 'screenshot-verified')
    end
    -- source order: entity trapcomp_type vector then mechanisms (native trap leaf order NOT
    -- captured -- order NOT-VERIFIED; set membership is verified).
    return out
end

-- OTHER OBJECTS: HARDCODED native sequence (oracle captures 29 iron + 21 silver, byte-verified).
-- Order is metal-independent (only the anvil row is gated on ITEMS_ANVIL); the entity tool block
-- is spliced after the toy row. Verbs/batches/labels are native-exact:
--   anvil(Forge), crafts(Make), "Forge three <m> goblets", "Forge <m> toy" (ONE generic MakeToy),
--   <tools Forge>, "Forge three <m> flasks", "Mint <m> coins", "Stud with <m>",
--   amulet/bracelet/earring/crown/figurine/ring (Make), "Make large <m> gem", scepter (Make).
-- Tool filter: entity tool_type flagged HARD_MAT|METAL_MAT minus NO_DEFAULT_JOB (which drops the
-- generated instrument-piece tools). INCOMPLETE_ITEM is NOT an exclusion (refuted 2026-07-08:
-- scroll rollers / book binding carry it yet ARE native OTHER rows -- captures 29/21).
local OTHER_TAIL = { -- {noun-phrase after "<verb> <metal>", verb, job token, extra}
    { 'flasks',   'Forge three', 'MakeFlask',    { batch = 3 }, true }, -- verb before metal for batch
    { 'coins',    'Mint',        'MintCoins',    nil },
    { 'amulet',   'Make',        'MakeAmulet',   nil },
    { 'bracelet', 'Make',        'MakeBracelet', nil },
    { 'earring',  'Make',        'MakeEarring',  nil },
    { 'crown',    'Make',        'MakeCrown',    nil },
    { 'figurine', 'Make',        'MakeFigurine', nil },
    { 'ring',     'Make',        'MakeRing',     nil },
    { 'scepter',  'Make',        'MakeScepter',  nil },
}
local function other_leaves(R, metal)
    local out = {}
    local ml = metal.label
    local function add(lbl, jobtok, extra)
        local jt = df.job_type[jobtok]
        if jt then out[#out + 1] = leaf(lbl, jt, nil, nil, nil, 'screenshot-verified', extra) end
    end
    -- 1. anvil (metals flagged ITEMS_ANVIL only -- silver has none, capture 21)
    if metal_has(metal.mat_index, 'ITEMS_ANVIL') then add('Forge ' .. ml .. ' anvil', 'ForgeAnvil') end
    -- 2. crafts  3. goblets(x3)  4. one generic toy
    add('Make ' .. ml .. ' crafts', 'MakeCrafts')
    add('Forge three ' .. ml .. ' goblets', 'MakeGoblet', { batch = 3 })
    if df.job_type.MakeToy then
        out[#out + 1] = leaf('Forge ' .. ml .. ' toy', df.job_type.MakeToy, df.item_type.TOY, nil, nil,
            'screenshot-verified')
    end
    -- 5. entity tool block (Forge <metal> <tool>) in entity-vector order
    each_entity_def(R.tool_type, IT.tools, function(sub, d)
        local hard = G(function() return d.flags.HARD_MAT end, false) or
                     G(function() return d.flags.METAL_MAT end, false)
        if G(function() return d.flags.NO_DEFAULT_JOB end, false) then hard = false end
        if hard then
            out[#out + 1] = leaf('Forge ' .. ml .. ' ' .. (G(function() return d.name end, 'tool')),
                df.job_type.MakeTool, df.item_type.TOOL, sub, G(function() return d.id end, ''),
                'screenshot-verified')
        end
    end)
    -- 6. flasks(x3)  7. coins  8. stud  9-16. jewelry / large gem / scepter (native tail order)
    add('Forge three ' .. ml .. ' flasks', 'MakeFlask', { batch = 3 })
    add('Mint ' .. ml .. ' coins', 'MintCoins')
    add('Stud with ' .. ml, 'StudWith')
    add('Make ' .. ml .. ' amulet', 'MakeAmulet')
    add('Make ' .. ml .. ' bracelet', 'MakeBracelet')
    add('Make ' .. ml .. ' earring', 'MakeEarring')
    add('Make ' .. ml .. ' crown', 'MakeCrown')
    add('Make ' .. ml .. ' figurine', 'MakeFigurine')
    add('Make ' .. ml .. ' ring', 'MakeRing')
    add('Make large ' .. ml .. ' gem', 'MakeGem') -- "large" precedes the metal (capture 29)
    add('Make ' .. ml .. ' scepter', 'MakeScepter')
    return out -- NATIVE ORDER -- NOT alpha.
end

-- Fort-civ reaction prefix. Generated instrument reactions are per-entity, coded
-- "MAKE_ENT<entity_id> <token>"; DF only shows a custom-category row's reactions for the FORT
-- CIV's own entity (live-verified: fort civ == plotinfo.civ_id, forge shows only its ENT<civ>
-- reactions -- capture 28 = 9 ENT305 rows, no foreign-entity leaves). Derived dynamically.
local function fort_civ_prefix()
    local cid = G(function() return df.global.plotinfo.civ_id end, -1)
    if not cid or cid < 0 then return nil end
    return 'MAKE_ENT' .. cid .. ' '
end

-- instrument reactions attached to this shop, filtered to the fort civ, in RAWS/attachment order.
local function reaction_leaves(bt, st, want_category)
    local out = {}
    local rs = G(function() return raws.reactions.reactions end, nil)
    if not rs then return out end
    local prefix = fort_civ_prefix()
    local n = G(function() return #rs end, 0)
    for i = 0, n - 1 do
        local r = rs[i]
        local cat = G(function() return r.category end, '')
        if cat == want_category then
            local code = G(function() return r.code end, '') or ''
            -- civ filter (B40/B42): keep only the fort civ's generated reactions
            if prefix and code:sub(1, #prefix) == prefix then
                local hit = false
                local bn = G(function() return #r.building.type end, 0)
                for j = 0, bn - 1 do
                    if G(function() return r.building.type[j] end, nil) == bt and
                       G(function() return r.building.subtype[j] end, nil) == st then hit = true break end
                end
                if hit then
                    out[#out + 1] = {
                        kind = 'reaction', label = ncap(G(function() return r.name end, '?')),
                        reaction_code = code,
                        confidence = 'screenshot-verified', -- civ-filtered set + raws order (capture 28)
                    }
                end
            end
        end
    end
    return out -- RAWS/attachment order (capture 28: alpha_order=0 on every row) -- NOT alpha.
end

-- ---------------------------------------------------------------------------------------------
-- the forge tree (MetalsmithsForge / MagmaForge)
local function forge_root(bt, st)
    local R = G(function() return fort_entity().resources end, nil)
    if not R then return nil, 'no fortress entity' end
    local function metal_branch(flags, leaves_fn, conf)
        local ms = metals_with(flags)
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
        { kind = 'category', label = 'Weapons and ammunition', df_category = 'WEAPON',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_WEAPON' },
          metals = metal_branch({ 'ITEMS_WEAPON' }, function(m) return weapon_leaves(R, m) end, 'screenshot-verified') },
        { kind = 'category', label = 'Armor', df_category = 'ARMOR',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_ARMOR' },
          metals = metal_branch({ 'ITEMS_ARMOR' }, function(m) return clothing_leaves(R, m, true) end, 'flag-derived') },
        { kind = 'category', label = 'Furniture', df_category = 'FURNITURE',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_HARD' },
          metals = metal_branch({ 'ITEMS_HARD' }, furniture_leaves, 'flag-derived') },
        { kind = 'category', label = 'Siege equipment', df_category = 'SIEGE',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_WEAPON' },
          metals = metal_branch({ 'ITEMS_WEAPON' }, siege_leaves, 'speculative') },
        -- B52: TRAP metal LIST filters ITEMS_WEAPON only (native capture 20 = 17 rows == weapons list,
        -- NOT the ITEMS_HARD 35); mechanisms still gate per-metal on ITEMS_HARD inside trap_leaves.
        { kind = 'category', label = 'Trap components', df_category = 'TRAP',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_WEAPON' },
          metals = metal_branch({ 'ITEMS_WEAPON' }, function(m) return trap_leaves(R, m) end, 'speculative') },
        { kind = 'category', label = 'Other objects', df_category = 'OTHER',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_HARD' },
          metals = metal_branch({ 'ITEMS_HARD' }, function(m) return other_leaves(R, m) end, 'screenshot-verified') },
        { kind = 'category', label = 'Metal clothing', df_category = 'METAL',
          confidence = 'screenshot-verified', metal_flags = { 'ITEMS_SOFT' },
          metals = metal_branch({ 'ITEMS_SOFT' }, function(m) return clothing_leaves(R, m, false) end, 'flag-derived') },
    }
    -- Instrument custom categories (B41): NO metal layer -- the category node holds reaction leaves
    -- DIRECTLY (reactions carry their own reagents; DF never asks for a metal -- capture 28 goes
    -- straight to 9 new_job leaves). (B40): HIDE a custom category whose civ-filtered leaf set is
    -- empty -- for this fort INSTRUMENT (assemble) has zero ENT<civ> reactions, so native root = 8.
    local function instrument_node(label, token)
        local ls = reaction_leaves(bt, st, token)
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

-- ---------------------------------------------------------------------------------------------
-- flat shops via dfhack.workshops.getJobs (tagged dfhack-derived: NOT DF's native menu -- known
-- holes for Bowyers/Clothiers/Kennels/Tool and label wording; the oracle closes the gap)
local function flat_root(bt, st)
    local ok_wo, wo = pcall(require, 'dfhack.workshops')
    if not ok_wo then return {}, 'dfhack.workshops unavailable' end
    local okj, jobs = pcall(wo.getJobs, bt, st, -1)
    if not okj or not jobs then return {}, 'getJobs failed' end
    local out = {}
    for _, def in pairs(jobs) do
        if type(def) == 'table' then
            local jf = def.job_fields or {}
            local L = { kind = 'job', label = tostring(def.name or '?'), confidence = 'dfhack-derived' }
            if jf.job_type ~= nil then L.job_type = jt_name(jf.job_type) end
            if jf.reaction_name and #tostring(jf.reaction_name) > 0 then
                L.kind = 'reaction'; L.reaction_code = tostring(jf.reaction_name)
            end
            if jf.item_type ~= nil then L.item_type = df.item_type[jf.item_type] or jf.item_type end
            if jf.item_subtype ~= nil and jf.item_subtype >= 0 then L.item_subtype = jf.item_subtype end
            if jf.material_category ~= nil then L.material_category = tostring(jf.material_category) end
            if jf.mat_type ~= nil and jf.mat_type >= 0 then L.mat_type = jf.mat_type; L.mat_index = jf.mat_index or -1 end
            out[#out + 1] = L
        end
    end
    return alpha_sort(out), nil
end

-- ---------------------------------------------------------------------------------------------
-- FLAT-SHOP native trees (flatshop-executor 2026-07-08). Line-mirror of dwf.lua's native
-- builder IIFE (display fields only -- no reagent _def): DF-native add-task menus for the non-forge
-- shops whose native menu is NOT a flat getJobs list. Structure/labels/order MUST match the served
-- tree so the gate's model checks and --served diff agree. Provenance: Smelter capture 30, Craftsdwarf
-- captures 31/32, Kennels (v50 Vermin Catcher's Shop) capture 33. (ncap is defined above.)
local function nleaf_job(label, jt_name, o)
    o = o or {}
    local L = { kind = 'job', label = label, job_type = jt_name, confidence = o.confidence or 'screenshot-verified' }
    if o.item_type then L.item_type = o.item_type end
    if o.item_subtype ~= nil then L.item_subtype = o.item_subtype end
    if o.mat_type ~= nil then L.mat_type = o.mat_type end
    if o.mat_index ~= nil then L.mat_index = o.mat_index end
    if o.material_category then L.material_category = o.material_category end
    if o.batch then L.batch = o.batch end
    return L
end
local function nleaf_reaction(label, code, conf)
    return { kind = 'reaction', label = label, reaction_code = code, confidence = conf or 'screenshot-verified' }
end
local function nfind_sub(vec, name)
    local n = G(function() return #vec end, 0)
    for i = 0, n - 1 do if G(function() return vec[i].name end, nil) == name then return i end end
    return nil
end
-- reactions attached to a building, RAWS order, foreign-civ generated ones skipped.
local function each_shop_reaction(bt, st, fn)
    local rs = G(function() return raws.reactions.reactions end, nil)
    if not rs then return end
    local prefix = fort_civ_prefix()
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
            if code:sub(1, 8) ~= 'MAKE_ENT' or (prefix and code:sub(1, #prefix) == prefix) then
                fn(r, code)
            end
        end
    end
end
local function smelter_native(bt, st)
    local out = {}
    out[#out + 1] = nleaf_job('Melt a metal object', 'MeltMetalObject')
    local inorg = G(function() return raws.inorganics.all end, nil)
    if inorg then
        local n = G(function() return #inorg end, 0)
        for i = 0, n - 1 do
            local m = inorg[i]
            local nore = G(function() return #m.metal_ore.mat_index end, 0)
            if nore and nore > 0 then
                local nm = G(function() return m.material.state_name.Solid end, 'ore')
                out[#out + 1] = nleaf_job('Smelt ' .. nm .. ' ore', 'SmeltOre', { mat_type = INORGANIC, mat_index = i })
            end
        end
    end
    each_shop_reaction(bt, st, function(r, code)
        out[#out + 1] = nleaf_reaction(ncap(G(function() return r.name end, '?')), code)
    end)
    return out
end
local function kennels_native()
    return {
        nleaf_job('Catch live land animal', 'CatchLiveLandAnimal'),
        nleaf_job('Tame a small animal', 'TameVermin'),
    }
end
local ND_BASE = { { 'crafts', 'MakeCrafts' }, { 'amulet', 'MakeAmulet' }, { 'bracelet', 'MakeBracelet' }, { 'earring', 'MakeEarring' } }
local ND_EXTRA = { { 'crown', 'MakeCrown' }, { 'figurine', 'MakeFigurine' }, { 'ring', 'MakeRing' }, { 'gem', 'MakeGem', true }, { 'scepter', 'MakeScepter' } }
local ND_PEARL_EXTRA = { { 'crown', 'MakeCrown' }, { 'figurine', 'MakeFigurine' }, { 'ring', 'MakeRing' }, { 'gem', 'MakeGem', true } }
local ND_FAMILIES = {
    { word = 'cloth', cat = 'cloth', set = 'base' }, { word = 'silk', cat = 'silk', set = 'base' },
    { word = 'yarn', cat = 'yarn', set = 'base' }, { word = 'ivory/tooth', cat = 'tooth', set = 'hard' },
    { word = 'horn', cat = 'horn', set = 'hard' }, { word = 'pearl', cat = 'pearl', set = 'pearl' },
    { word = 'leather', cat = 'leather', set = 'base' },
}
-- B264 ORDERING LAW: DF sorts every menu's leaves ALPHABETICALLY (containers first). Verified in all
-- 30 captures with zero exceptions. ND_ROCK was the right 19 rows in the WRONG order.
local ND_ROCK = {
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
local function rock_submenu_native()
    local out = {}
    for _, e in ipairs(ND_ROCK) do
        local o = { mat_type = INORGANIC, mat_index = -1 }
        if e.batch then o.batch = e.batch end
        if e.wpn then o.item_type = 'WEAPON'; o.item_subtype = nfind_sub(IT.weapons, e.wpn) end
        if e.tool then o.item_type = 'TOOL'; o.item_subtype = nfind_sub(IT.tools, e.tool) end
        if e.toy then o.item_type = 'TOY' end
        out[#out + 1] = nleaf_job(e[1], e[2], o)
    end
    return out
end
-- B255: ammo leaves of an organic submenu (bolts, entity-derived). Mirror of dwf.lua's
-- cd_ammo_leaves / ammo_shop_defs: wooden bolts (25/log) and bone bolts (5/bone) are made HERE, at
-- the craftsdwarf's workshop -- never at the bowyer. Native wood row (capture B255-1.png):
-- "Make twenty-five wooden bolts".
local ND_AMMO_WORD = { wood = 'twenty-five', bone = 'five' }
local ND_AMMO_N = { wood = 25, bone = 5 }
local function ammo_leaves_native(adj, matcat)
    local out = {}
    local R = G(function() return fort_entity().resources end, nil)
    if not R then return out end
    each_entity_def(R.ammo_type, IT.ammo, function(sub, d)
        local pl = G(function() return d.name_plural end, nil) or G(function() return d.name end, 'ammo')
        out[#out + 1] = nleaf_job('Make ' .. ND_AMMO_WORD[matcat] .. ' ' .. adj .. ' ' .. pl, 'MakeAmmo',
            { item_type = 'AMMO', item_subtype = sub, material_category = matcat, batch = ND_AMMO_N[matcat],
              confidence = 'screenshot-verified' })   -- B264: bone stack word "five" now captured
    end)
    return out
end
-- WOOD submenu: VERBATIM native sequence from capture B255-1.png (was a guessed 8-row set).
local ND_WOOD = {
    { 'Make large wooden gem', 'MakeGem' }, { 'Make three wooden cups', 'MakeGoblet', batch = 3 },
    { 'AMMO' },
    { 'Make wooden amulet', 'MakeAmulet' }, { 'Make wooden book binding', 'MakeTool', tool = 'book binding' },
    { 'Make wooden bracelet', 'MakeBracelet' }, { 'Make wooden crafts', 'MakeCrafts' },
    { 'Make wooden crown', 'MakeCrown' }, { 'Make wooden die', 'MakeTool', tool = 'die' },
    { 'Make wooden earring', 'MakeEarring' }, { 'Make wooden figurine', 'MakeFigurine' },
    { 'Make wooden hive', 'MakeTool', tool = 'hive' }, { 'Make wooden jug', 'MakeTool', tool = 'jug' },
    { 'Make wooden nest box', 'MakeTool', tool = 'nest box' }, { 'Make wooden pot', 'MakeTool', tool = 'pot' },
    { 'Make wooden ring', 'MakeRing' }, { 'Make wooden scepter', 'MakeScepter' },
    { 'Make wooden scroll rollers', 'MakeTool', tool = 'scroll rollers' },
    -- B264: WS-CRAFTSDWARF-WOOD-native-FULL.png is the COMPLETE list and has NO wooden toy.
    -- The row B255 carried over on the guess that it sat below the fold is DELETED.
}
local function wood_submenu_native()
    local out = {}
    for _, e in ipairs(ND_WOOD) do
        if e[1] == 'AMMO' then
            for _, l in ipairs(ammo_leaves_native('wooden', 'wood')) do out[#out + 1] = l end
        else
            local o = { material_category = 'wood',
                confidence = e.derived and 'derived-not-captured' or 'screenshot-verified' }
            if e.batch then o.batch = e.batch end
            if e.tool then o.item_type = 'TOOL'; o.item_subtype = nfind_sub(IT.tools, e.tool) end
            if e.toy then o.item_type = 'TOY' end
            out[#out + 1] = nleaf_job(e[1], e[2], o)
        end
    end
    return out
end
-- B264: BONE + SHELL are now CAPTURED (WS-CRAFTSDWARF-{BONE,SHELL}-native.png). Both open with a
-- `Decorate with <mat>` row; bone carries armor (greaves/helm/leggings/gauntlets) and its ammo row
-- confirms the stack word "five"; shell carries helm/leggings/gauntlets, NO scepter, NO greaves and
-- NO AMMO AT ALL. The old guessed 8-row crafts+jewelry set is gone.
local ND_BONE = {
    { 'Decorate with bone', 'DecorateWith' },
    { 'Make bone amulet', 'MakeAmulet' }, { 'Make bone bracelet', 'MakeBracelet' },
    { 'Make bone crafts', 'MakeCrafts' }, { 'Make bone crown', 'MakeCrown' },
    { 'Make bone earring', 'MakeEarring' }, { 'Make bone figurine', 'MakeFigurine' },
    { 'Make bone greaves', 'MakePants', pants = 'greaves' },
    { 'Make bone helm', 'MakeHelm', helm = 'helm' },
    { 'Make bone leggings', 'MakePants', pants = 'leggings' },
    { 'Make bone ring', 'MakeRing' }, { 'Make bone scepter', 'MakeScepter' },
    { 'AMMO' },
    { 'Make large bone gem', 'MakeGem' },
    { 'Make pair of bone gauntlets', 'MakeGloves', gloves = 'gauntlet' },
}
local ND_SHELL = {
    { 'Decorate with shell', 'DecorateWith' },
    { 'Make large shell gem', 'MakeGem' },
    { 'Make pair of shell gauntlets', 'MakeGloves', gloves = 'gauntlet' },
    { 'Make shell amulet', 'MakeAmulet' }, { 'Make shell bracelet', 'MakeBracelet' },
    { 'Make shell crafts', 'MakeCrafts' }, { 'Make shell crown', 'MakeCrown' },
    { 'Make shell earring', 'MakeEarring' }, { 'Make shell figurine', 'MakeFigurine' },
    { 'Make shell helm', 'MakeHelm', helm = 'helm' },
    { 'Make shell leggings', 'MakePants', pants = 'leggings' },
    { 'Make shell ring', 'MakeRing' },
}
local ND_ORGANIC = { bone = ND_BONE, shell = ND_SHELL }
local function organic_submenu_native(word, matcat)
    local out = {}
    for _, e in ipairs(ND_ORGANIC[matcat] or {}) do
        if e[1] == 'AMMO' then
            for _, l in ipairs(ammo_leaves_native(word, matcat)) do out[#out + 1] = l end
        else
            local o = { material_category = matcat, confidence = 'screenshot-verified' }
            if e.pants then o.item_type = 'PANTS'; o.item_subtype = nfind_sub(IT.pants, e.pants) end
            if e.helm then o.item_type = 'HELM'; o.item_subtype = nfind_sub(IT.helms, e.helm) end
            if e.gloves then o.item_type = 'GLOVES'; o.item_subtype = nfind_sub(IT.gloves, e.gloves) end
            out[#out + 1] = nleaf_job(e[1], e[2], o)
        end
    end
    return alpha_sort(out)
end
local function craftsdwarf_native(bt, st)
    -- B264/B266 (WS-CRAFTSDWARF-TOPLEVEL-native-{1..4}of4.png): SIX container rows -- rock / wood /
    -- bone / shell / Make instrument piece / Make instrument, each "(opens menu)" -- then EVERY leaf
    -- in one ALPHABETICAL block. The row SET was already right; the ORDER was source order. This
    -- mirrors dwf.lua's craftsdwarf_tree exactly, or gate_truemenu grades the served tree
    -- against a stale model and reports the fix as a regression (the trap B255 fell into).
    local root, leaves = {}, {}
    root[#root + 1] = { kind = 'material_selector', label = 'rock', mat_type = INORGANIC, mat_index = -1, confidence = 'screenshot-verified', leaves = rock_submenu_native() }
    root[#root + 1] = { kind = 'material_selector', label = 'wood', mat_type = INORGANIC, mat_index = -1, confidence = 'screenshot-verified', leaves = wood_submenu_native() }
    root[#root + 1] = { kind = 'material_selector', label = 'bone', mat_type = INORGANIC, mat_index = -1, confidence = 'screenshot-verified', leaves = organic_submenu_native('bone', 'bone') }
    root[#root + 1] = { kind = 'material_selector', label = 'shell', mat_type = INORGANIC, mat_index = -1, confidence = 'screenshot-verified', leaves = organic_submenu_native('shell', 'shell') }
    local ip = {}
    each_shop_reaction(bt, st, function(r, code)
        if G(function() return r.category end, '') == 'INSTRUMENT_PIECE' then ip[#ip + 1] = nleaf_reaction(ncap(G(function() return r.name end, '?')), code) end
    end)
    if #ip > 0 then root[#root + 1] = { kind = 'custom_category', label = 'Make instrument piece', token = 'INSTRUMENT_PIECE', confidence = 'screenshot-verified', leaves = ip } end
    local ia = {}
    each_shop_reaction(bt, st, function(r, code)
        if G(function() return r.category end, '') == 'INSTRUMENT' then ia[#ia + 1] = nleaf_reaction(ncap(G(function() return r.name end, '?')), code) end
    end)
    if #ia > 0 then root[#root + 1] = { kind = 'custom_category', label = 'Make instrument', token = 'INSTRUMENT', confidence = 'screenshot-verified', leaves = ia } end
    -- leaves (one alphabetical block)
    leaves[#leaves + 1] = nleaf_job('Decorate with ivory/tooth', 'DecorateWith', { material_category = 'tooth' })
    leaves[#leaves + 1] = nleaf_job('Decorate with horn', 'DecorateWith', { material_category = 'horn' })
    leaves[#leaves + 1] = nleaf_job('Decorate with pearl', 'DecorateWith', { material_category = 'pearl' })
    leaves[#leaves + 1] = nleaf_job('Make totem', 'MakeTotem')
    leaves[#leaves + 1] = nleaf_job('Extract metal strands', 'ExtractMetalStrands', { mat_type = INORGANIC, mat_index = 242, confidence = 'flag-derived' })
    leaves[#leaves + 1] = nleaf_reaction('Make wax crafts', 'MAKE_WAX_CRAFTS')
    leaves[#leaves + 1] = nleaf_reaction('Make scroll', 'MAKE_SCROLL')
    leaves[#leaves + 1] = nleaf_reaction('Make quire', 'MAKE_QUIRE')
    leaves[#leaves + 1] = nleaf_reaction('Bind book', 'BIND_BOOK')
    for _, fam in ipairs(ND_FAMILIES) do
        local extra = (fam.set == 'hard') and ND_EXTRA or (fam.set == 'pearl') and ND_PEARL_EXTRA or nil
        for _, e in ipairs(ND_BASE) do
            local label = e[3] and ('Make large ' .. fam.word .. ' ' .. e[1]) or ('Make ' .. fam.word .. ' ' .. e[1])
            leaves[#leaves + 1] = nleaf_job(label, e[2], { material_category = fam.cat })
        end
        if extra then for _, e in ipairs(extra) do
            local label = e[3] and ('Make large ' .. fam.word .. ' ' .. e[1]) or ('Make ' .. fam.word .. ' ' .. e[1])
            leaves[#leaves + 1] = nleaf_job(label, e[2], { material_category = fam.cat })
        end end
    end
    alpha_sort(leaves)
    for _, l in ipairs(leaves) do root[#root + 1] = l end
    return root
end
-- returns (root, shape) for a native flat-shop, or nil
local function native_shop_root(st_name, bt, st)
    if st_name == 'Smelter' or st_name == 'MagmaSmelter' then return smelter_native(bt, st), 'flat-native' end
    if st_name == 'Craftsdwarfs' then return craftsdwarf_native(bt, st), 'mixed-native' end
    if st_name == 'Kennels' then return kennels_native(), 'flat-native' end
    return nil
end

local KNOWN_GAPS = { -- keyed by full shop key
    -- B255: NOT "+ ammo". The bowyer makes ranged weapons only (bone or wooden crossbows); DF's
    -- ammo lives at the craftsdwarf (wood/bone) and the forges (metal).
    -- B255 CONFIRMED by WS-BOWYERS-native.png: exactly 2 rows, bone + wooden crossbow, no ammo.
    ['Workshop/Bowyers'] = 'getJobs=0: entity-derived (ranged weapons in bone + wood; NO ammo). CONFIRMED by WS-BOWYERS-native.png',
    -- B266: the served clothier is now a THREE-SUBMENU tree (cloth/silk/yarn, 16 rows each, from
    -- WS-CLOTHIERS-native-*). This generator does NOT yet mirror that shape -- it still reports the
    -- shop as a gap rather than modelling it, so the gate excuses it instead of grading it. Mirroring
    -- it here is the remaining menu_model debt for this wave.
    ['Workshop/Clothiers'] = 'getJobs=0: served as a 3-submenu cloth/silk/yarn tree (entity SOFT defs); NOT yet mirrored in this model',
    ['Workshop/Leatherworks'] = 'getJobs ships 5 of 25 rows; served list adds the entity [LEATHER] armor line. Not yet mirrored here',
    ['Workshop/Tool'] = 'getJobs=0: reactions-only building; needs raws building-token match',
    ['Furnace/Custom'] = 'getJobs=0: placeholder furnace subtype; per-building custom raws reactions apply',
}

-- ---------------------------------------------------------------------------------------------
local shops = {}
local function add_shop(bt_name, st_enum, st_name)
    local key = bt_name .. '/' .. st_name
    if filter_active and not only[key] then return end
    local bt = df.building_type[bt_name]
    local rec = { key = key, building_type = bt_name, subtype = st_name }
    local nroot, nshape = native_shop_root(st_name, bt, st_enum)
    if st_name == 'MetalsmithsForge' or st_name == 'MagmaForge' then
        rec.shape = 'forge-tree'
        rec.ordering = { root = 'fixed (DF order, screenshot-verified)',
                         metals = 'inorganic raws index order (screenshot-verified)',
                         leaves = 'alphabetical by label (screenshot-verified)' }
        local root, err = forge_root(bt, st_enum)
        rec.root = root or {}
        if err then rec.error = err end
    elseif nroot then
        -- flatshop-executor: DF-native flat/mixed shop tree (Smelter/MagmaSmelter/Craftsdwarfs/Kennels)
        rec.shape = nshape
        rec.ordering = { root = 'DF-native source order (capture-verified: smelter 30, craftsdwarf 31/32, kennels 33)' }
        rec.root = nroot
    else
        rec.shape = 'flat'
        rec.ordering = { leaves = 'alphabetical (assumed; verify via oracle)' }
        local root, err = flat_root(bt, st_enum)
        rec.root = root
        if err then rec.error = err end
    end
    if KNOWN_GAPS[key] then rec.known_gap = KNOWN_GAPS[key] end
    shops[#shops + 1] = rec
end

for i = 0, df.workshop_type._last_item do
    local nm = df.workshop_type[i]
    if nm and nm ~= 'NONE' then add_shop('Workshop', i, nm) end
end
for i = 0, df.furnace_type._last_item do
    local nm = df.furnace_type[i]
    if nm and nm ~= 'NONE' then add_shop('Furnace', i, nm) end
end

local model = {
    schema = 'truemenu-model-v1',
    generated_by = 'tools/harness/menu_model.lua',
    world = {
        save_dir = G(function() return df.global.world.cur_savegame.save_dir end, '?'),
        fortress_entity_id = G(function() return fort_entity().id end, -1),
    },
    confidence_legend = {
        ['screenshot-verified'] = 'label/structure matches the owner Menu Oracle Screenshots 2026-07-08',
        ['flag-derived'] = 'derived from raws/entity flags whose mapping was differentially verified',
        ['dfhack-derived'] = 'from dfhack.workshops.getJobs; wording/coverage NOT native-verified',
        ['speculative'] = 'best-effort; MUST be oracle-diffed (menu_oracle.lua) before shipping',
    },
    shops = shops,
}

local f, ferr = io.open(out_path, 'w')
if not f then qerror('cannot open ' .. tostring(out_path) .. ': ' .. tostring(ferr)) end
f:write(json.encode(model))
f:close()
print(('menu_model: wrote %d shops -> %s'):format(#shops, out_path))
