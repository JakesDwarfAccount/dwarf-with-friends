-- we5_toggle_ambush.lua: WE-5 fixture helper (read-write, single bitfield).
-- Sets/clears df::unit.flags1.hidden_in_ambush on ONE unit by id, for the
-- before/after wire-visibility fixture. ALWAYS restore to the original value
-- when done testing.
-- Run:  dfhack-run lua -f tools/harness/we5_toggle_ambush.lua <unit_id> <0|1>
local args = {...}
local uid = tonumber(args[1])
local val = tonumber(args[2])
assert(uid, "usage: we5_toggle_ambush.lua <unit_id> <0|1>")
assert(val == 0 or val == 1, "usage: we5_toggle_ambush.lua <unit_id> <0|1>")

local u = df.unit.find(uid)
assert(u, "no unit with id " .. uid)
local before = u.flags1.hidden_in_ambush
u.flags1.hidden_in_ambush = (val == 1)
print(("unit %d flags1.hidden_in_ambush: %s -> %s"):format(uid, tostring(before), tostring(u.flags1.hidden_in_ambush)))
