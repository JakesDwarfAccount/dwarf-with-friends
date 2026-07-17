-- b285_exec_prelude.lua -- a minimal DFHack/df STUB, just enough to load dwf.lua and
-- EXECUTE the work-order condition write path (B285 wave-2) in a plain Lua 5.3 state.
-- Nothing here talks to a real game; the runner is b285_condition_editor_lua_exec_test.py.
-- SPDX-License-Identifier: AGPL-3.0-only

-- ---- module plumbing: dwf.lua starts with `local _ENV = mkmodule('plugins.dwf')`.
-- The returned env inherits _G (so these stubs resolve) and is stashed for the test suite.
function mkmodule(name)
  MODULE_ENV = setmetatable({}, { __index = _G })
  return MODULE_ENV
end

-- ---- auto-enum: unknown df.<enum> tables mint stable ints for any string key. Load-time code in
-- dwf.lua indexes dozens of enums this test does not care about; they only need to be
-- non-nil and bidirectional. Enums whose VALUES matter are pinned explicitly below.
local function autoenum()
  local nextv = 1000
  return setmetatable({}, { __index = function(t, k)
    if type(k) == 'string' then
      nextv = nextv + 1
      rawset(t, k, nextv); rawset(t, nextv, k)
      return nextv
    end
    return nil -- unknown numeric key -> nil, like a real enum
  end })
end

local function enum(names, start)
  local t = autoenum()
  local v = start or 0
  for _, n in ipairs(names) do rawset(t, n, v); rawset(t, v, n); v = v + 1 end
  return t
end

-- deep auto-table for df.global.* namespaces (NOT enum-like: indexing yields another table)
local function autotable()
  return setmetatable({}, { __index = function(t, k)
    local v = autotable(); rawset(t, k, v); return v
  end })
end

function autotable_export() return autotable() end

df = setmetatable({}, { __index = function(t, k)
  local e = autoenum(); rawset(t, k, e); return e
end })
df.global = autotable()

-- The three enums the VALIDATOR resolves against are PLAIN tables with DF's real values -- they
-- must return nil for unknown names exactly like the real enum, or the "malformed input refused"
-- checks would pass against a stub that mints values for anything (that bug was caught live:
-- auto-minting here made 'Sometimes' and 'ADAMANTINE_SOCKS' look like valid enum members).
local function enum_exact(names, start)
  local t = {}
  local v = start or 0
  for _, n in ipairs(names) do t[n] = v; t[v] = n; v = v + 1 end
  t.NONE = -1; t[-1] = 'NONE'
  return t
end
-- df.workquota.xml:2
df.logic_condition_type = enum_exact({ 'AtLeast', 'AtMost', 'GreaterThan', 'LessThan', 'Exactly', 'Not' })
-- df.workquota.xml:37
df.workquota_order_condition_type = enum_exact({ 'Activated', 'Completed' })
-- df.items.xml item_type, real order (so CONDITION_TARGETS load-time filtering sees real members)
df.item_type = enum_exact({
  'BAR', 'SMALLGEM', 'BLOCKS', 'ROUGH', 'BOULDER', 'WOOD', 'DOOR', 'FLOODGATE', 'BED', 'CHAIR',
  'CHAIN', 'FLASK', 'GOBLET', 'INSTRUMENT', 'TOY', 'WINDOW', 'CAGE', 'BARREL', 'BUCKET',
  'ANIMALTRAP', 'TABLE', 'COFFIN', 'STATUE', 'CORPSE', 'WEAPON', 'ARMOR', 'SHOES', 'SHIELD',
  'HELM', 'GLOVES', 'BOX', 'BIN', 'ARMORSTAND', 'WEAPONRACK', 'CABINET', 'FIGURINE', 'AMULET',
  'SCEPTER', 'AMMO', 'CROWN', 'RING', 'EARRING', 'BRACELET', 'GEM', 'ANVIL', 'CORPSEPIECE',
  'REMAINS', 'MEAT', 'FISH', 'FISH_RAW', 'VERMIN', 'PET', 'SEEDS', 'PLANT', 'SKIN_TANNED',
  'PLANT_GROWTH', 'THREAD', 'CLOTH', 'TOTEM', 'PANTS', 'BACKPACK', 'QUIVER', 'CATAPULTPARTS',
  'BALLISTAPARTS', 'SIEGEAMMO', 'BALLISTAARROWHEAD', 'TRAPPARTS', 'TRAPCOMP', 'DRINK',
  'POWDER_MISC', 'CHEESE', 'FOOD', 'LIQUID_MISC', 'COIN', 'GLOB', 'ROCK', 'PIPE_SECTION',
  'HATCH_COVER', 'GRATE', 'QUERN', 'MILLSTONE', 'SPLINT', 'CRUTCH', 'TRACTION_BENCH',
  'ORTHOPEDIC_CAST', 'TOOL', 'SLAB', 'EGG', 'BOOK', 'SHEET', 'BRANCH',
})
df.tool_uses = enum_exact({})

-- ---- 0-based df-style vector (#, [i], :insert('#'|i, v), :erase(i)) ----
function dfvec(items)
  local v = { _items = items or {} }
  function v.insert(self, pos, val)
    if pos == '#' then table.insert(self._items, val)
    else table.insert(self._items, (tonumber(pos) or 0) + 1, val) end
  end
  function v.erase(self, i) table.remove(self._items, i + 1) end
  return setmetatable(v, {
    __len = function(s) return #s._items end,
    __index = function(s, k)
      if type(k) == 'number' then return rawget(s, '_items')[k + 1] end
      return rawget(s, k)
    end,
    __newindex = function(s, k, val)
      if type(k) == 'number' then rawget(s, '_items')[k + 1] = val else rawset(s, k, val) end
    end,
  })
end

-- df-struct constructors the write path allocates
df.manager_order_condition_item = {
  new = function()
    -- mirrors df-structures init-values: fields WITHOUT an init-value start at 0 (the exact trap
    -- the plugin's sentinel writes exist for); item_type/item_subtype/mat_index have init-values.
    return {
      compare_type = 0, compare_val = 0, item_type = -1, item_subtype = -1,
      mat_type = 0, mat_index = -1,
      flags1 = {}, flags2 = {}, flags3 = {}, flags4 = 0, flags5 = 0,
      reaction_class = '', has_material_reaction_product = '',
      metal_ore = 0, min_dimension = -1, contains = dfvec(), reaction_id = 0,
      has_tool_use = 0, dye_color = 0,
      delete = function() end,
    }
  end,
}
df.manager_order_condition_order = {
  new = function() return { order_id = -1, condition = -1, delete = function() end } end,
}

-- ---- dfhack stub: matinfo.decode succeeds ONLY for materials the fixture declares real,
-- so "well-formed but nonexistent material" genuinely fails the registry check.
local REAL_MATERIALS = { ['420:12'] = 'oak', ['0:0'] = 'iron' }
dfhack = {
  matinfo = {
    decode = function(mt, mi)
      local name = REAL_MATERIALS[tostring(mt) .. ':' .. tostring(mi)]
      if not name then error('no such material') end
      return { toString = function() return name end }
    end,
  },
  job = {}, buildings = {}, units = {}, items = {}, maps = {}, gui = {},
  printerr = function(...) end,
  run_command = function(...) end,
}

-- DFHack modules require()'d at LOAD time (hw_* host-writes machinery; unused by this test)
package.preload['gui'] = function() return autotable_export() end
package.preload['json'] = function() return { encode = function() return '' end,
  decode = function() return {} end } end
package.preload['helpdb'] = function() return autotable_export() end
package.preload['dfhack.workshops'] = function() return { getJobs = function() return {} end } end
package.preload['plugins.stockpiles'] = function() return { import_settings = function() end } end

-- DFHack lua-env globals that dwf.lua touches at LOAD time (values irrelevant to this test)
function xy2pos(x, y) return { x = x, y = y } end
function xyz2pos(x, y, z) return { x = x, y = y, z = z } end
function pos2xyz(p) return p.x, p.y, p.z end
function copyall(t) local r = {}; for k, v in pairs(t or {}) do r[k] = v end; return r end
function safe_index(t, ...)
  for _, k in ipairs({ ... }) do
    if type(t) ~= 'table' then return nil end
    t = t[k]
  end
  return t
end
function printall(...) end
function ensure_key(t, k, default)
  if t[k] == nil then t[k] = default ~= nil and default or {} end
  return t[k]
end
