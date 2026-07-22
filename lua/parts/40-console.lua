-- ---------------------------------------------------------------------------
-- WT26 -- DFHack command console (browser gui/launcher equivalent)
-- ---------------------------------------------------------------------------
-- SECURITY: the BLOCKLIST LIVES IN C++ (src/console_policy.h), not here. It is enforced twice on
-- the way in -- once in the POST /console/run handler (console_routes.cpp) and once again in the
-- console_run_via_lua bridge fn (lua_bridge.cpp) -- BOTH calling the single
-- dwf::console::command_denied table, and it applies to EVERY caller including the host.
-- Nothing reaches console_run() below that has not already cleared that gate. Do NOT add a second,
-- divergent deny table here: one table, two enforcement sites, is the whole design.
--
-- The catalog is helpdb's own -- literally the data DFHack's native autocomplete ranks against
-- (helpdb.get_commands() = "a list of all commands. used by Core's autocomplete functionality").
-- It is STATIC for a play session, so the client fetches it ONCE and does search-as-you-type
-- entirely offline: no per-keystroke round-trip and, crucially, no per-keystroke CoreSuspender.
-- Only EXECUTING a command touches the core lock.

-- Cap what a single command may hand back. `lua`-class output is unbounded and would cross the
-- wire whole; anything huge is truncated with an explicit marker rather than silently cut.
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

-- Run one already-gate-cleared command line and hand back its captured console text.
-- Returns (status:int, text:string). status: 0 = CR_OK (DFHack's command_result convention);
-- any non-zero is DFHack's own failure code, passed through untouched.
--
-- THE HARD LIMITATION (spec 2026-07-13-dfhack-gui-launcher-spec.md section 7, surfaced to the owner and
-- accepted): dfhack.run_command_silent -> internal.runCommand takes its OWN CoreSuspender, so the
-- command runs synchronously with DF's core lock held for its entire duration and CANNOT be
-- interrupted. There is no cooperative cancellation point, hence no server-side timeout can abort a
-- runaway command. Containment is PREVENTION (the C++ blocklist), not recovery -- and the client
-- states this in the panel before you press Run.
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

-- B228 (missions): bring home squads DF stranded. DF has a long-standing bug where a squad sent on
-- a mission ends up on an army whose controller pointer is null (army.controller_id ~= 0 and
-- army.controller == nil) -- those dwarves never come back and the fort keeps counting them.
--
-- We do NOT reimplement the repair. DFHack ships it (scripts/fix/stuck-squad.lua, declared
-- `--@ module=true`), and its unstick_armies() is the only tested code anywhere that touches the
-- squad <-> army <-> army_controller links. reqscript() loads that module and dfhack.run_script
-- runs the very same entry point the `fix/stuck-squad` command runs; scan_fort_armies() is its
-- exported pre-check, so we can tell the player WHY it will refuse instead of running it blind.
--
-- Returns (rescued:int, text:string). rescued >= 0 = how many stranded squads were carried home;
-- rescued < 0 = a refusal, with the script's own reason in `text` (never a message we invented).
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
    -- run_script goes through DFHack's own script runner, so the repair executes exactly as it
    -- does from the console; qerror() inside it surfaces here as a pcall failure, not a crash.
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
