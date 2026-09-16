-- ---------------------------------------------------------------------------
-- DFHack command console (browser gui/launcher equivalent)

-- The command blocklist lives in C++ (dwf::console::command_denied) and is enforced before
-- anything reaches console_run; a second deny table here would diverge from it.

-- Cap on one command's captured output; anything larger is truncated with an explicit marker.
local CONSOLE_OUTPUT_CAP = 64 * 1024

function console_catalog()
    local helpdb = require('helpdb')
    local out = {}
    for _, name in ipairs(helpdb.get_commands()) do
        local short = ''
        local ok, s = pcall(helpdb.get_entry_short_help, name)
        if ok and type(s) == 'string' then short = s end
        out[#out + 1] = '{"name":' .. json_string(name) .. ',"short":' .. json_string(short) .. '}'
    end
    return '{"ok":true,"commands":[' .. table.concat(out, ',') .. ']}\n'
end

-- dfhack.run_command_silent holds DF's core lock for the whole command and cannot be
-- interrupted, so containment is the C++ blocklist, not a server-side timeout.
function console_run(cmd)
    cmd = tostring(cmd or '')
    if cmd:match('^%s*$') then return -1, 'empty command' end
    local ok, output, status = pcall(dfhack.run_command_silent, cmd)
    if not ok then
        -- `output` is the pcall error here.
        return -1, tostring(output)
    end
    output = tostring(output or '')
    if #output > CONSOLE_OUTPUT_CAP then
        output = output:sub(1, CONSOLE_OUTPUT_CAP) ..
            '\n... (output truncated at ' .. CONSOLE_OUTPUT_CAP .. ' bytes)'
    end
    return tonumber(status) or 0, output
end

function safe_json(fn)
    return function(...)
        local ok, result = pcall(fn, ...)
        if ok then return result end
        return '{"ok":false,"error":' .. json_string(result) .. '}\n'
    end
end

-- The stuck-squad repair is DFHack's own (fix/stuck-squad, module=true); never reimplement
-- the squad <-> army <-> army_controller relink here.
function missions_rescue_stuck()
    local ok, mod = pcall(reqscript, 'fix/stuck-squad')
    if not ok or not mod or type(mod.scan_fort_armies) ~= 'function' then
        return -1, 'DFHack fix/stuck-squad is not available in this DFHack build'
    end
    local scanned, stuck, returning = pcall(mod.scan_fort_armies)
    if not scanned then
        return -1, tostring(stuck)
    end
    local stuck_n = stuck and #stuck or 0
    if stuck_n == 0 then
        return -1, 'No stranded squads to rescue.'
    end
    if not returning then
        return -1, 'No army or messenger is on its way home, so there is nothing to carry them ' ..
            'back. Send a squad or a messenger on a mission that returns, and rescue once they ' ..
            'have turned for home.'
    end
    local ran, err = pcall(dfhack.run_script, 'fix/stuck-squad')
    if not ran then
        return -1, tostring(err)
    end
    local left = select(1, mod.scan_fort_armies())
    local remaining = left and #left or 0
    return stuck_n - remaining,
        ('fix/stuck-squad: %d stranded squad(s) found, %d rescued.'):format(stuck_n, stuck_n - remaining)
end

order_catalog = safe_json(order_catalog)
order_catalog_by_shop = safe_json(order_catalog_by_shop)
condition_targets = safe_json(condition_targets)
order_workshops = safe_json(order_workshops)
list_orders = safe_json(list_orders)
order_presets = safe_json(order_presets)
workshop_info = safe_json(workshop_info)
burial_coffin_info = safe_json(burial_coffin_info)
console_catalog = safe_json(console_catalog)

