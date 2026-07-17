-- menu_oracle.lua -- TRUEMENU deliverable 2: filtered_button LIVE-READ ORACLE.
--
-- Answers: "what buttons does NATIVE DF show RIGHT NOW in the open workshop menu, with what
-- enabled/disabled state" -- the ground truth the web menu must match (oracle-differential
-- acceptance, completeness protocol rule 2: this reads DF's OWN button list, not a re-model).
--
-- Reads df.global.game.main_interface (READ-ONLY, nil-guarded; no DF_LOCK needed):
--   * building.button / building.filtered_button / press_button -- the actual menu rows, each
--     downcast to its concrete class (df.d_interface.xml):
--       interface_button_building_category_selectorst -> a "<X> (opens menu)" category row
--       interface_button_building_material_selectorst -> a metal/material row
--       interface_button_building_new_jobst           -> a task leaf (jobtype/itemtype/subtype/
--                                                        mat + objection = DF's own
--                                                        "why you can't" string -> availability
--                                                        coloring ground truth)
--       interface_button_building_custom_category_selectorst -> reaction category row
--                                                        (INSTRUMENT_PIECE / INSTRUMENT)
--   * building.category / selected / material / matgloss / current_custom_category_token
--   * view_sheets: active tab, task search box, scroll position
--   * job_details: the details/material sub-layer state incl. material[] candidates + counts
--
-- Run:  dfhack-run.exe lua -f <repo>/tools/harness/menu_oracle.lua <out.json> [--call-text]
--   --call-text additionally calls each button's text() vmethod to capture DF's exact composed
--   label (executes DF code inside the core suspend; read-effect only -- writes into a scratch
--   string we allocate/free). Without it we record filter_str, DF's own lowercase search key.
--
-- A workshop sheet must be OPEN in native DF for button vectors to be non-empty; when closed
-- this tool emits open=false snapshots (still valid JSON) -- callers treat that as CANNOT-RUN,
-- never as PASS.

local args = { ... }
local out_path = args[1]
local call_text = false
for i = 2, #args do if args[i] == '--call-text' then call_text = true end end
if not out_path or out_path == '' then
    qerror('usage: lua -f menu_oracle.lua <out.json> [--call-text]')
end

local ok_json, json = pcall(require, 'json')
if not ok_json then qerror('dfhack json module unavailable') end

local function G(fn, fallback)
    local ok, v = pcall(fn)
    if ok then return v end
    return fallback
end

local mi = df.global.game.main_interface

-- ---------------------------------------------------------------------------------------------
local function button_text(btn)
    if not call_text then return nil end
    local txt = nil
    pcall(function()
        local s = df.new('string')
        btn:text(s)
        txt = s.value
        df.delete(s)
    end)
    return txt
end

local function enum_name(enum, v)
    if v == nil then return nil end
    return enum[v] or v
end

-- render a bitfield as the comma-joined names of its set bits ('' when none)
local function bits(bf)
    local out = {}
    pcall(function()
        for name, on in pairs(bf) do
            if on == true then out[#out + 1] = tostring(name) end
        end
    end)
    table.sort(out)
    return table.concat(out, ',')
end

local function dump_button(btn)
    local rec = {
        class = G(function() return tostring(btn._type) end, '?'),
        filter_str = G(function() return btn.filter_str end, nil),
        alpha_order = G(function() return btn.alpha_order end, nil),
        hotkey = G(function() return enum_name(df.interface_key, btn.hotkey) end, nil),
        leave_button = G(function() return btn.leave_button end, nil),
    }
    local text = button_text(btn)
    if text ~= nil then rec.text = text end
    -- subclass fields (each read individually guarded; absent fields simply omitted)
    rec.category = G(function() return enum_name(df.interface_category_building, btn.category) end, nil)
    rec.custom_category_token = G(function() return btn.custom_category_token end, nil)
    rec.jobtype = G(function() return enum_name(df.job_type, btn.jobtype) end, nil)
    rec.mstring = G(function() return btn.mstring end, nil)
    rec.itemtype = G(function() return enum_name(df.item_type, btn.itemtype) end, nil)
    rec.subtype = G(function() return btn.subtype end, nil)
    rec.material = G(function() return btn.material end, nil)
    rec.matgloss = G(function() return btn.matgloss end, nil)
    rec.job_item_flag = G(function() return bits(btn.job_item_flag) end, nil)
    -- availability ground truth: DF's own objection string ("Needs metal bars" class) + info
    rec.objection = G(function() return btn.objection end, nil)
    rec.info = G(function() return btn.info end, nil)
    rec.add_building_location = G(function() return btn.add_building_location end, nil)
    rec.show_help_instead = G(function() return btn.show_help_instead end, nil)
    -- resolve material name when this is a material row or a materialized job leaf
    if rec.material ~= nil and rec.material >= 0 and rec.matgloss ~= nil and rec.matgloss >= 0 then
        rec.material_name = G(function()
            return df.global.world.raws.inorganics.all[rec.matgloss].material.state_name.Solid
        end, nil)
    end
    return rec
end

local function dump_button_vec(vec)
    local out = {}
    local n = G(function() return #vec end, 0)
    for i = 0, n - 1 do
        local btn = G(function() return vec[i] end, nil)
        if btn then out[#out + 1] = dump_button(btn) end
    end
    return out
end

-- ---------------------------------------------------------------------------------------------
local b = mi.building
local snapshot = {
    schema = 'truemenu-oracle-v1',
    generated_by = 'tools/harness/menu_oracle.lua',
    call_text = call_text,
    building = {
        category = G(function() return enum_name(df.interface_category_building, b.category) end, nil),
        selected = G(function() return b.selected end, nil),
        material = G(function() return b.material end, nil),
        matgloss = G(function() return b.matgloss end, nil),
        job = G(function() return enum_name(df.job_type, b.job) end, nil),
        job_item_flag = G(function() return bits(b.job_item_flag) end, nil),
        current_custom_category_token = G(function() return b.current_custom_category_token end, nil),
        n_button = G(function() return #b.button end, 0),
        n_filtered_button = G(function() return #b.filtered_button end, 0),
        n_press_button = G(function() return #b.press_button end, 0),
        button = dump_button_vec(b.button),
        filtered_button = dump_button_vec(b.filtered_button),
    },
    view_sheets = {
        open = G(function() return mi.view_sheets.open end, nil),
        active_sub_tab = G(function() return mi.view_sheets.active_sub_tab end, nil),
        active_id = G(function() return mi.view_sheets.active_id end, nil),
        building_job_filter_str = G(function() return mi.view_sheets.building_job_filter_str end, nil),
        entering_building_job_filter = G(function() return mi.view_sheets.entering_building_job_filter end, nil),
        scroll_position_building_job = G(function() return mi.view_sheets.scroll_position_building_job end, nil),
    },
    job_details = {
        open = G(function() return mi.job_details.open end, nil),
        context = G(function() return enum_name(df.job_details_context_type, mi.job_details.context) end, nil),
        current_option = G(function() return enum_name(df.job_details_option_type, mi.job_details.current_option) end, nil),
        material_filter = G(function() return mi.job_details.material_filter end, nil),
    },
}

-- job_details material candidate lists (the details/material sub-layer ground truth)
snapshot.job_details.materials = G(function()
    local jd = mi.job_details
    local out = {}
    for i = 0, #jd.material_master - 1 do
        local mt = jd.material_master[i]
        local mg = jd.matgloss_master[i]
        local cnt = G(function() return jd.material_count_master[i] end, nil)
        local nm = nil
        if mt == 0 and mg >= 0 then
            nm = G(function()
                return df.global.world.raws.inorganics.all[mg].material.state_name.Solid
            end, nil)
        end
        out[#out + 1] = { mat_type = mt, matgloss = mg, count = cnt, name = nm }
    end
    return out
end, {})

-- is a menu actually open? (callers must treat open=false as CANNOT-RUN)
snapshot.open = (snapshot.building.n_button or 0) > 0

local f, ferr = io.open(out_path, 'w')
if not f then qerror('cannot open ' .. tostring(out_path) .. ': ' .. tostring(ferr)) end
f:write(json.encode(snapshot))
f:close()
print(('menu_oracle: open=%s buttons=%d filtered=%d category=%s -> %s'):format(
    tostring(snapshot.open), snapshot.building.n_button or 0,
    snapshot.building.n_filtered_button or 0,
    tostring(snapshot.building.category), out_path))
