-- dwf-spawn-shops: spawn one fully-built example of every workshop (and furnace) type,
-- so their NATIVE task menus can be screenshotted.
--
-- WHY THIS EXISTS (B255, 2026-07-14): Dwarf Fortress does NOT store per-workshop job lists
-- in the raws or in any readable table -- they are compiled into the DF binary. The ONLY
-- machine-readable oracle is `main_interface.building.button`, which DF populates *only while
-- that shop's task menu is open in the native UI*. So every workshop job list we ship is a
-- curated guess unless it has been pinned to a native capture. B255 proved that: the bowyer
-- was offering bolts it cannot make, and the craftsdwarf was missing bolts, cups, and its
-- entire tool block. B257-B261 are the same disease in five more shops.
--
-- Usage, from the DFHack console with a fort loaded:
--     dwf-spawn-shops              -- spawn the shops that still need captures
--     dwf-spawn-shops all          -- spawn EVERY workshop + furnace type
--     dwf-spawn-shops clear        -- delete everything this script spawned
--
-- Buildings are force-completed (no construction job, no materials, no dwarves needed) --
-- which matters, because the fort that motivated this had just lost its population.

local args = {...}
local mode = (args[1] or "needed"):lower()

local ws = df.workshop_type
local fu = df.furnace_type

-- The shops whose menus we have never captured, worst first.
local NEEDED = {
    { t = "w", st = ws.Farmers,      label = "Farmer's Workshop  (B257: NO built-in jobs at all)" },
    { t = "w", st = ws.Quern,        label = "Quern             (B258: mill-plants missing)" },
    { t = "w", st = ws.Millstone,    label = "Millstone         (B258: mill-plants missing)" },
    { t = "w", st = ws.Ashery,       label = "Ashery            (B259: lye/potash missing)" },
    { t = "w", st = ws.Leatherworks, label = "Leatherworks      (B260: no armor/helms/gloves/shoes)" },
    { t = "w", st = ws.Carpenters,   label = "Carpenter's       (B260: no shields/training weapons)" },
    { t = "w", st = ws.Bowyers,      label = "Bowyer's          (B255: confirm ammo is GONE, crossbows only)" },
    { t = "w", st = ws.Craftsdwarfs, label = "Craftsdwarf's     (B255: need BONE + SHELL submenus)" },
    { t = "w", st = ws.Clothiers,    label = "Clothier's        (never captured)" },
    { t = "w", st = ws.Kitchen,      label = "Kitchen           (never captured)" },
    { t = "w", st = ws.Butchers,     label = "Butcher's         (never captured)" },
    { t = "w", st = ws.Fishery,      label = "Fishery           (never captured)" },
    { t = "w", st = ws.Loom,         label = "Loom              (never captured)" },
    { t = "w", st = ws.Dyers,        label = "Dyer's            (never captured)" },
    { t = "w", st = ws.Mechanics,    label = "Mechanic's        (never captured)" },
    { t = "w", st = ws.Masons,       label = "Mason's           (never captured)" },
    { t = "w", st = ws.Jewelers,     label = "Jeweler's         (never captured)" },
    { t = "w", st = ws.Siege,        label = "Siege             (never captured)" },
}

local EXTRA = {
    { t = "w", st = ws.Still,     label = "Still" },
    { t = "w", st = ws.Tanners,   label = "Tanner's" },
    { t = "w", st = ws.Kennels,   label = "Kennels" },
    { t = "f", st = fu.Smelter,   label = "Smelter" },
    { t = "f", st = fu.WoodFurnace, label = "Wood Furnace" },
    { t = "f", st = fu.Kiln,      label = "Kiln" },
    { t = "f", st = fu.GlassFurnace, label = "Glass Furnace" },
}

-- Buildings spawned by this script are named "DWF <n>: <shop>" -- the PREFIX is what `clear`
-- matches on, and the rest is there so the shop is identifiable on screen. (First version named
-- every building the bare marker, which overwrote the shop names and made the whole grid
-- anonymous. The owner, correctly: "idk what the workshops are lol".)
local MARKER = "DWF "

local function is_open_floor(x, y, z)
    local tt = dfhack.maps.getTileType(x, y, z)
    if not tt then return false end
    local shape = df.tiletype.attrs[tt].shape
    local sa = df.tiletype_shape.attrs[shape]
    if not sa.walkable then return false end
    if dfhack.buildings.findAtTile(x, y, z) then return false end
    local occ = dfhack.maps.getTileFlags(x, y, z)
    if occ and occ.hidden then return false end
    return true
end

-- A workshop needs a clear 3x3 (plus a 1-tile gap so the menus don't overlap visually).
local function area_clear(cx, cy, z, half)
    for dx = -half, half do
        for dy = -half, half do
            if not is_open_floor(cx + dx, cy + dy, z) then return false end
        end
    end
    return true
end

local function force_complete(bld)
    -- No construction job, no materials, no dwarves. The fort may have no population left.
    for i = #bld.jobs - 1, 0, -1 do
        local job = bld.jobs[i]
        if job then dfhack.job.removeJob(job) end
    end
    bld:setBuildStage(bld:getMaxBuildStage())
    bld.flags.exists = true
end

local function spawn(entry, x, y, z)
    local btype = (entry.t == "f") and df.building_type.Furnace or df.building_type.Workshop
    local ok, bld = pcall(dfhack.buildings.constructBuilding, {
        type = btype, subtype = entry.st, pos = { x = x, y = y, z = z },
    })
    if not ok or not bld then return nil, tostring(bld) end
    force_complete(bld)
    return bld
end

local function do_clear()
    local n = 0
    for _, bld in ipairs(df.global.world.buildings.all) do
        if bld.name:sub(1, #MARKER) == MARKER then
            dfhack.buildings.deconstruct(bld)
            n = n + 1
        end
    end
    print(("dwf-spawn-shops: removed %d spawned building(s)."):format(n))
end

if mode == "clear" then
    do_clear()
    return
end

if not dfhack.world.isFortressMode() then
    qerror("load a fortress first")
end

local list = {}
for _, e in ipairs(NEEDED) do table.insert(list, e) end
if mode == "all" then
    for _, e in ipairs(EXTRA) do table.insert(list, e) end
end

-- Search outward from the centre of the player's current view for clear 5x5 pockets.
local vx = df.global.window_x + math.floor(df.global.world.map.x_count_block * 8 / 8)
local view = df.global.window_x
local z = df.global.window_z
local cx0 = df.global.window_x + 20
local cy0 = df.global.window_y + 15

local placed, failed = {}, {}
local idx = 1
local step = 5  -- 3x3 shop + a 1-tile margin all round

local xmax = df.global.world.map.x_count - 3
local ymax = df.global.world.map.y_count - 3

for _, entry in ipairs(list) do
    local found = false
    -- spiral-ish scan: sweep the z-level in a grid, take the first clear pocket
    for cy = 3, ymax, step do
        if found then break end
        for cx = 3, xmax, step do
            if area_clear(cx, cy, z, 2) then
                local bld, err = spawn(entry, cx, cy, z)
                if bld then
                    -- short shop name = the label up to the first double-space / paren
                    local short = entry.label:match("^(.-)%s%s") or entry.label:match("^(.-)%s*%(") or entry.label
                    short = short:gsub("%s+$", "")
                    bld.name = ("%s%d: %s"):format(MARKER, idx, short)
                    table.insert(placed, { label = entry.label, x = cx, y = cy, z = z, name = bld.name })
                    found = true
                    break
                else
                    table.insert(failed, entry.label .. "  (" .. tostring(err) .. ")")
                    found = true
                    break
                end
            end
        end
    end
    if not found then
        table.insert(failed, entry.label .. "  (no clear 5x5 pocket on this z-level)")
    end
    idx = idx + 1
end

print("")
print("=== dwf-spawn-shops: spawned on z=" .. z .. " ===")
for _, p in ipairs(placed) do
    print(("  (%3d,%3d)  [%s]  %s"):format(p.x, p.y, p.name or "?", p.label))
end
if #failed > 0 then
    print("")
    print("  COULD NOT PLACE:")
    for _, f in ipairs(failed) do print("    " .. f) end
end
print("")
print("  Click each shop -> Tasks tab -> screenshot the FULL job list (scroll if it cuts off).")
print("  For the craftsdwarf, open the BONE and SHELL submenus specifically.")
print("  Run `dwf-spawn-shops clear` to remove them all again.")
