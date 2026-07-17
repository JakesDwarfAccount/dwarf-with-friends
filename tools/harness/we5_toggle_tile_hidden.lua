-- we5_toggle_tile_hidden.lua: WE-5 fixture helper (read-write, single bitfield).
-- Sets/clears designation.hidden on ONE tile, for the before/after wire-visibility
-- fixture (a unit standing on an unrevealed tile must not appear on the wire).
-- ALWAYS restore to the original value when done testing.
-- Run:  dfhack-run lua -f tools/harness/we5_toggle_tile_hidden.lua <x> <y> <z> <0|1>
local args = {...}
local x, y, z, val = tonumber(args[1]), tonumber(args[2]), tonumber(args[3]), tonumber(args[4])
assert(x and y and z, "usage: we5_toggle_tile_hidden.lua <x> <y> <z> <0|1>")
assert(val == 0 or val == 1, "usage: we5_toggle_tile_hidden.lua <x> <y> <z> <0|1>")

local blk = dfhack.maps.getTileBlock(x, y, z)
assert(blk, "no map block at " .. x .. "," .. y .. "," .. z)
local lx, ly = x % 16, y % 16
local des = blk.designation[lx][ly]
local before = des.hidden
des.hidden = (val == 1)
print(("tile %d,%d,%d designation.hidden: %s -> %s"):format(x, y, z, tostring(before), tostring(des.hidden)))
