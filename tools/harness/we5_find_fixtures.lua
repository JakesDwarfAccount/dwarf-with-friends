-- we5_find_fixtures.lua: WE-5 fixture scout (read-only).
-- Scans world.units.active and reports:
--   1) any unit currently flagged flags1.hidden_in_ambush (candidate for the
--      ambush-leak fixture -- before/after the visibility fix lands).
--   2) any unit standing on a tile whose designation.hidden bit is set
--      (candidate for the unrevealed-cavern fixture).
-- Run:  dfhack-run lua -f tools/harness/we5_find_fixtures.lua
local json = require('json')

local function racetok(race)
    local cr = df.global.world.raws.creatures.all[race]
    return cr and cr.creature_id or ("race" .. race)
end

local ambushers, hidden_tile_units = {}, {}

for _, u in ipairs(df.global.world.units.active) do
    if u.flags1.hidden_in_ambush then
        table.insert(ambushers, {
            id = u.id, x = u.pos.x, y = u.pos.y, z = u.pos.z,
            race = racetok(u.race), name = dfhack.units.getReadableName(u),
        })
    end
    local ok, blk = pcall(dfhack.maps.getTileBlock, u.pos.x, u.pos.y, u.pos.z)
    if ok and blk then
        local lx, ly = u.pos.x % 16, u.pos.y % 16
        local des = blk.designation[lx][ly]
        if des.hidden then
            table.insert(hidden_tile_units, {
                id = u.id, x = u.pos.x, y = u.pos.y, z = u.pos.z,
                race = racetok(u.race), name = dfhack.units.getReadableName(u),
                inactive = u.flags1.inactive,
            })
        end
    end
end

local out = { ambushers = ambushers, hidden_tile_units = hidden_tile_units }
print(json.encode(out))
print("ambushers=" .. #ambushers .. " hidden_tile_units=" .. #hidden_tile_units)
