-- Read-only live-world enumeration for the texture-coverage audit.
-- Prints counts by building_type, item_type, and the set of on-map plant ids.
-- Pure reads (no state change); safe to run while the owner plays.
local world = df.global.world

-- ---- buildings by type (+ workshop/furnace subtype breakdown) ----
local bcount = {}
local bsub = {}      -- "Type:SubtypeName" -> count (workshops/furnaces)
local WSUB = {[0]="Carpenters","Farmers","Masons","Craftsdwarfs","Jewelers","MetalsmithsForge",
  "MagmaForge","Bowyers","Mechanics","Siege","Butchers","Leatherworks","Tanners","Clothiers",
  "Fishery","Still","Loom","Quern","Kennels","Kitchen","Ashery","Dyers","Millstone","Custom","Tool"}
local FSUB = {[0]="WoodFurnace","Smelter","GlassFurnace","Kiln","MagmaSmelter","MagmaGlassFurnace","MagmaKiln","Custom"}
for _, b in ipairs(world.buildings.all) do
    local t = df.building_type[b:getType()] or ("?"..tostring(b:getType()))
    bcount[t] = (bcount[t] or 0) + 1
    local st = b:getSubtype()
    if t == "Workshop" and WSUB[st] then
        local k = "Workshop:"..WSUB[st]; bsub[k] = (bsub[k] or 0) + 1
    elseif t == "Furnace" and FSUB[st] then
        local k = "Furnace:"..FSUB[st]; bsub[k] = (bsub[k] or 0) + 1
    end
end
print("== BUILDINGS by type ==")
local bk = {}
for k in pairs(bcount) do bk[#bk+1] = k end
table.sort(bk)
for _, k in ipairs(bk) do print(string.format("BLD\t%s\t%d", k, bcount[k])) end
local sk = {}
for k in pairs(bsub) do sk[#sk+1] = k end
table.sort(sk)
for _, k in ipairs(sk) do print(string.format("BSUB\t%s\t%d", k, bsub[k])) end

-- ---- items by type (+ raw itemdef token for subtype-keyed items) ----
local icount = {}
local idef = {}   -- raw ITEM_* token -> count (weapons/armor/tools/toys/ammo/...)
for _, it in ipairs(world.items.all) do
    local t = df.item_type[it:getType()] or ("?"..tostring(it:getType()))
    icount[t] = (icount[t] or 0) + 1
    local sd = nil
    if it.getSubtype and it:getSubtype() >= 0 then
        pcall(function()
            local def = it.subtype
            if type(def) ~= "number" and def and def.id then sd = def.id end
        end)
    end
    if sd then idef[sd] = (idef[sd] or 0) + 1 end
end
print("== ITEMS by type ==")
local ik = {}
for k in pairs(icount) do ik[#ik+1] = k end
table.sort(ik)
for _, k in ipairs(ik) do print(string.format("ITM\t%s\t%d", k, icount[k])) end
local dk = {}
for k in pairs(idef) do dk[#dk+1] = k end
table.sort(dk)
for _, k in ipairs(dk) do print(string.format("IDEF\t%s\t%d", k, idef[k])) end

-- ---- plants on the map (distinct plant_raw ids; TREE vs SHRUB) ----
local pset = {}
local ptree = {}
for _, col in ipairs(world.map.map_block_columns) do
    for _, pl in ipairs(col.plants) do
        local pr = df.plant_raw.find(pl.material)
        if pr then
            pset[pr.id] = (pset[pr.id] or 0) + 1
            ptree[pr.id] = pr.flags and pr.flags.TREE and "TREE" or "SHRUB"
        end
    end
end
print("== PLANTS on map (distinct ids) ==")
local pk = {}
for k in pairs(pset) do pk[#pk+1] = k end
table.sort(pk)
for _, k in ipairs(pk) do print(string.format("PLT\t%s\t%d\t%s", k, pset[k], ptree[k] or "SHRUB")) end

-- ---- built-furniture material families (sample: what mat_type do furniture buildings carry) ----
print("== FURNITURE-BUILDING mat_type sample ==")
local fset = {}
for _, b in ipairs(world.buildings.all) do
    local t = df.building_type[b:getType()]
    if t == "Door" or t == "Bed" or t == "Table" or t == "Chair" or t == "Cabinet"
       or t == "Coffin" or t == "Statue" or t == "Box" or t == "Well" then
        local mt = b.mat_type
        local key = t.."\t"..tostring(mt)
        fset[key] = (fset[key] or 0) + 1
    end
end
local fk = {}
for k in pairs(fset) do fk[#fk+1] = k end
table.sort(fk)
for _, k in ipairs(fk) do print(string.format("FMAT\t%s\t%d", k, fset[k])) end
print("== END ==")
