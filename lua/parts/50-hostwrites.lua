-- ================================================================================================
-- HOST-WRITES (B226 browser barter / B227 justice convict+interrogate)
--
-- Design principle: THE PLUGIN NEVER HAND-WRITES a trade or conviction record. Both write-sets
-- are DF-native object graphs (item ownership/trader flags + caravan value counters + entity
-- resources + history events for barter; crime.punishment + plotinfo.punishments + a
-- history_event_hf_convictedst for conviction) that even DFHack itself never reconstructs --
-- its own trade UI (scripts/internal/caravan/trade.lua) only flips selection bits and leaves the
-- barter to the native button, and no DFHack API convicts anyone. Instead we drive the NATIVE
-- code through the same channels a local player uses:
--
--   * selection state (trade.goodflag[side][idx].selected, widget cursor_idx, scroll) is plain
--     UI state -- DFHack's caravan/sort/confirm tools write these exact fields routinely;
--   * the commits (barter confirm, conviction) are delivered by calling the native viewscreen's
--     feed() with the real interface keys / enabler mouse state -- the byte-identical path a
--     local keyboard+mouse takes (gui.simulateInput; precedent: DFHack ci/test.lua clicks
--     native title-screen buttons, scripts/hide-tutorials.lua clicks native popups).
--
-- So every record written during a barter or conviction is written BY DWARF FORTRESS, with all
-- of its invariants. The plugin's failure mode is "nothing happened + an honest error", never a
-- half-written record.
--
-- Runtime guards: risky steps stay OFF until host-side live probes verify them on the
-- host (file dfcapture-hostwrites.json next to the DF exe; see hw_flags below). The guarded
-- endpoints return {"guarded":true} with a plain-English reason until then. The probe list lives
-- in docs/superpowers/specs/2026-07-14-hostwrites-B226-B227.md (internal spec; see docs/NAMING.md).
-- ================================================================================================

local hw_gui = require('gui')
local hw_json = require('json')

-- ---- runtime guard flags -----------------------------------------------------------------------
-- dfcapture-hostwrites.json, next to the DF executable, host-controlled (NOT settable over HTTP;
-- a browser-flippable guard would not be a guard). Orchestrator flips a flag to true after the
-- matching probe passes. Missing file = everything guarded.
--   { "trade_select": true,      -- goodflag selection writes (DFHack-parity; default-on if file exists)
--     "trade_confirm": true,     -- clicking Trade / Offer / Seize on the native trade screen
--     "trade_open": true,        -- opening the native trade screen by state-write (probe P-T1)
--     "justice_convict": true,   -- the full native convict drive (probes P-J1..P-J3)
--     "justice_interrogate": true,
--     "click_without_text_assert": true }  -- only if probe P-T3 finds screen text unreadable
function hw_flags()
    local path = dfhack.getDFPath() .. '/dfcapture-hostwrites.json'
    local f = io.open(path, 'r')
    if not f then return {} end
    local text = f:read('*a')
    f:close()
    local ok, data = pcall(hw_json.decode, text)
    if ok and type(data) == 'table' then return data end
    return {}
end

local function hw_flag(name)
    local flags = hw_flags()
    return flags[name] == true
end

local function hw_err(msg)
    return '{"ok":false,"error":' .. json_string(msg) .. '}\n'
end

local function hw_guarded(flag, what)
    return '{"ok":false,"unsupported":true,"guarded":true,"flag":' .. json_string(flag) ..
        ',"error":' .. json_string(what .. ' is implemented but locked behind the host-side ' ..
        'verification probe (flag "' .. flag .. '" in dfcapture-hostwrites.json). The host ' ..
        'owner runs the probe on the live fort and unlocks it; until then this action ' ..
        'must be done at the host keyboard.') .. '}\n'
end

local function hw_retry(stage)
    return '{"ok":false,"retry":true,"stage":' .. json_string(stage) .. '}\n'
end

-- ---- native input delivery ----------------------------------------------------------------------
-- All of these end in viewscreen::feed() on the DF viewscreen -- the native input path. No OS
-- input is synthesized (no cursor moves, no focus theft; operator-at-keyboard rule intact).

local function hw_screen()
    return dfhack.gui.getDFViewscreen(true)
end

local function hw_feed(key)
    hw_gui.simulateInput(hw_screen(), key)
end

-- Click at UI-grid tile (x, y). Same recipe as DFHack ci/test.lua click_top_title_button and
-- scripts/hide-tutorials.lua: gps mouse tile+pixel coords, then _MOUSE_L through feed().
local function hw_click_at(x, y)
    local gps = df.global.gps
    gps.mouse_x, gps.mouse_y = x, y
    gps.precise_mouse_x = x * gps.tile_pixel_x
    gps.precise_mouse_y = y * gps.tile_pixel_y
    hw_gui.simulateInput(hw_screen(), '_MOUSE_L')
end

local function hw_click_rect_center(x1, y1, x2, y2)
    hw_click_at(math.floor((x1 + x2) / 2), math.floor((y1 + y2) / 2))
end

-- DFHack's `confirm` overlay intercepts exactly the inputs we feed (convict SELECT/_MOUSE_L,
-- trade-confirm/offer/seize clicks) and would swallow them into a dialog no remote player can
-- see. Temporarily disable the named specs around fn, restoring after. If confirm isn't
-- installed/enabled this is a no-op.
local function hw_with_confirms_disabled(ids, fn)
    local ok_req, confirm = pcall(dfhack.reqscript, 'confirm')
    local restore = {}
    if ok_req and confirm and confirm.get_conf_data and confirm.set_enabled then
        local want = {}
        for _, id in ipairs(ids) do want[id] = true end
        local ok_data, data = pcall(confirm.get_conf_data)
        if ok_data and type(data) == 'table' then
            for _, conf in pairs(data) do
                if type(conf) == 'table' and want[conf.id] and conf.enabled then
                    restore[#restore + 1] = conf.id
                    pcall(confirm.set_enabled, conf.id, false)
                end
            end
        end
    end
    local ok, err = pcall(fn)
    for _, id in ipairs(restore) do
        pcall(confirm.set_enabled, id, true)
    end
    if not ok then error(err) end
end

-- ---- screen geometry + text ---------------------------------------------------------------------

-- Replicates DFHack gui.get_interface_rect() (library/lua/gui.lua:124): the UI grid area the
-- native interface (and the confirm plugin's intercept frames) are laid out against.
local function hw_interface_rect()
    local sw, sh = dfhack.screen.getWindowSize()
    local l, w = 0, sw
    local pct = df.global.init.display.max_interface_percentage
    if pct < 100 then
        local iw = math.max(114, sw * pct / 100)
        l = math.ceil((sw - iw) / 2)
        w = math.floor(iw)
    end
    return l, 0, w, sh
end

-- Native trade-screen button rects, replicated from DFHack's confirm plugin intercept frames
-- (scripts/internal/confirm/specs.lua: trade-confirm-trade / trade-offer / trade-seize), which
-- ship as correct for DF 53.15. Frame spec semantics per gui.compute_frame_rect: l&r both set ->
-- horizontally centered in [l, W-r]; only b set -> bottom-anchored.
local HW_TRADE_BUTTONS = {
    trade = { l = 0, r = 23, b = 4, w = 11, h = 3, label = 'trade' },
    offer = { l = 40, r = 5, b = 4, w = 19, h = 3, label = 'offer' },
    seize = { l = 0, r = 73, b = 4, w = 11, h = 3, label = 'seize' },
}

local function hw_button_rect(spec)
    local il, it, iw, ih = hw_interface_rect()
    local sw = iw - spec.l - spec.r
    local sh = ih - (spec.t or 0) - spec.b
    local rqw = math.min(sw, spec.w)
    local rqh = math.min(sh, spec.h)
    local ax = math.floor((sw - rqw) * 0.5) -- l and r both present -> centered
    local ay = sh - rqh                     -- b only -> bottom
    local x1 = il + spec.l + ax
    local y1 = it + (spec.t or 0) + ay
    return x1, y1, x1 + rqw - 1, y1 + rqh - 1
end

local function hw_rect_text(x1, y1, x2, y2)
    local lines = {}
    for y = y1, y2 do
        local chars = {}
        for x = x1, x2 do
            local ok, pen = pcall(dfhack.screen.readTile, x, y)
            local c = ok and pen and pen.ch or 0
            chars[#chars + 1] = (c >= 32 and c < 127) and string.char(c) or ' '
        end
        lines[#lines + 1] = table.concat(chars)
    end
    return table.concat(lines, '\n')
end

-- Find a word on the interface grid (case-insensitive); returns center tile or nil.
local function hw_find_screen_text(word, y_from, y_to)
    local il, it, iw, ih = hw_interface_rect()
    y_from = y_from or it
    y_to = y_to or (ih - 1)
    local needle = word:lower()
    for y = y_from, y_to do
        local row = hw_rect_text(il, y, il + iw - 1, y):lower()
        local s = row:find(needle, 1, true)
        if s then
            return il + s - 1 + math.floor(#needle / 2), y
        end
    end
    return nil
end

-- ---- widget-tree helpers (DF 53.15 widget UI) ----------------------------------------------------

local function hw_widget_visible(w)
    -- Gui.cpp get_visible_child parity: ACTIVE + VISIBLE = actually visible.
    local ok, vis = pcall(function()
        return w.flag.VISIBILITY_ACTIVE and w.flag.VISIBILITY_VISIBLE
    end)
    return ok and vis or false
end

local function hw_visible_child(container)
    local ok, n = pcall(function() return #container.children end)
    if not ok then return nil end
    for i = 0, n - 1 do
        local c = container.children[i]
        if c and hw_widget_visible(c) then return c end
    end
    return nil
end

-- Depth-first hunt for the first widget_scroll_rows in a subtree, skipping subtrees rooted at a
-- widget named skip_name (used to find the open-cases case list without wandering into the
-- Right panel's own scroll lists).
local function hw_find_scroll_rows(w, skip_name, depth)
    depth = depth or 0
    if not w or depth > 8 then return nil end
    if skip_name and w.name == skip_name then return nil end
    if df.widget_scroll_rows and df.widget_scroll_rows:is_instance(w) then return w end
    -- widget_radio_rows carries its scroll_rows as a compound field, not a child.
    if df.widget_radio_rows and df.widget_radio_rows:is_instance(w) then return w.rows end
    local ok, n = pcall(function() return #w.children end)
    if ok then
        for i = 0, n - 1 do
            local found = hw_find_scroll_rows(w.children[i], skip_name, depth + 1)
            if found then return found end
        end
    end
    return nil
end

local function hw_widget_json(w, depth, max_depth)
    if not w then return 'null' end
    depth = depth or 0
    local parts = {}
    local function put(k, v) parts[#parts + 1] = '"' .. k .. '":' .. v end
    put('name', json_string(w.name or ''))
    put('type', json_string(tostring(w._type):gsub('^<type: ', ''):gsub('>$', '')))
    local ok_rect, rect = pcall(function() return w.rect end)
    if ok_rect and rect then
        put('rect', string.format('[%d,%d,%d,%d]', rect.x1, rect.y1, rect.x2, rect.y2))
    end
    put('visible', json_bool(hw_widget_visible(w)))
    local ok_cur, cur = pcall(function() return w.cursor_idx end)
    if ok_cur and cur ~= nil then put('cursorIdx', tostring(cur)) end
    local ok_scroll, scroll = pcall(function() return w.scroll end)
    if ok_scroll and scroll ~= nil then put('scroll', tostring(scroll)) end
    local ok_hk, hk = pcall(function()
        local keys = {}
        for _, k in ipairs(w.activation_hotkeys) do keys[#keys + 1] = json_string(df.interface_key[k] or tostring(k)) end
        return keys
    end)
    if ok_hk and hk and #hk > 0 then put('hotkeys', '[' .. table.concat(hk, ',') .. ']') end
    local ok_n, n = pcall(function() return #w.children end)
    if ok_n and n > 0 then
        if depth >= (max_depth or 8) then
            put('children', tostring(n))
        else
            local kids = {}
            for i = 0, math.min(n, 60) - 1 do
                kids[#kids + 1] = hw_widget_json(w.children[i], depth + 1, max_depth)
            end
            put('children', '[' .. table.concat(kids, ',') .. ']')
        end
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

-- Probe instrument: dump a named widget tree as JSON. GET /justice-convict?widgets=1 serves this.
function hw_widget_dump(which)
    local mi = df.global.game.main_interface
    local root
    if which == 'justice' then root = mi.info.justice
    elseif which == 'info' then root = mi.info
    else return hw_err('unknown widget root: ' .. tostring(which)) end
    return '{"ok":true,"root":' .. json_string(which) .. ',"tree":' .. hw_widget_json(root, 0, 8) .. '}\n'
end

-- ================================================================================================
-- B226: the native trade screen (game.main_interface.trade, df.d_interface.xml:871)
-- ================================================================================================

local function hw_trade()
    return df.global.game.main_interface.trade
end

local function hw_trade_focus_ok()
    return dfhack.gui.matchFocusString('dwarfmode/Trade', hw_screen())
end

-- B226 trade-screen enrichment (all reads, all pcall-guarded, all ADDITIVE -- an older client
-- ignores the extra keys; a newer client falls back gracefully when a key is absent):
--   * per-row weight (mirrors src/interaction.cpp item_weight_text: weight_computed -> whole /
--     "<1" fraction, else getBaseWeight; the fraction is served so the client can do the
--     footer Allowed/Excess-Weight arithmetic the native bottom bar shows),
--   * per-row group = the df.item_type key (native's panel group headers -- Bars / Cut gems /
--     ... -- follow item-type runs in the native list order),
--   * per-row spriteRef in the same four-field shape the stock-item wire ships (interaction.cpp
--     stock_item_action_json), so DWFUI.iconHtml({item}) paints the native item tile,
--   * caravan capacity (caravan_state.total_capacity, massst kg/mg -- df.plotinfo.xml:442) for
--     the native Allowed Weight / Excess Weight footer line,
--   * the native screen's own display strings (trade_interfacest title/talker/fortname/place,
--     df.d_interface.xml) + the merchant negotiator's name -- header parity without inventing
--     copy. Their live contents are unprobed (P-T1 notes them); the client must treat each as
--     optional.
local function hw_item_weight(item)
    -- returns whole_kg, fraction_mg, text ("", "<1", "N") -- item_weight_text parity.
    local ok, w, f = pcall(function()
        if item.flags.weight_computed then return item.weight.whole, item.weight.fraction end
        return item:getBaseWeight(), 0
    end)
    if not ok then return 0, 0, '' end
    w, f = w or 0, f or 0
    if w > 0 then return w, f, tostring(w) end
    if f > 0 then return 0, f, '<1' end
    return 0, 0, ''
end

-- Full trade-session state, including both goods tables. side 0 = caravan, 1 = fort (native
-- ordering, same as trade.good/goodflag). Values are caravan-adjusted when DFHack can compute
-- them (Items::getValue(item, caravan) -- the same call DFHack's trade UI uses).
function hw_trade_state()
    local tr = hw_trade()
    local parts = { '"ok":true' }
    local function put(k, v) parts[#parts + 1] = '"' .. k .. '":' .. v end
    put('open', json_bool(tr.open))
    local flags = hw_flags()
    put('guards', string.format(
        '{"tradeSelect":%s,"tradeConfirm":%s,"tradeOpen":%s}',
        json_bool(flags.trade_select == true), json_bool(flags.trade_confirm == true),
        json_bool(flags.trade_open == true)))
    if not tr.open then
        return '{' .. table.concat(parts, ',') .. '}\n'
    end
    put('choosingMerchant', json_bool(tr.choosing_merchant))
    put('stillUnloading', tostring(tr.stillunloading))
    put('haveTalker', tostring(tr.havetalker))
    put('counterOffer', json_bool(tr.counter_offer))
    put('depotId', tostring(tr.bld and tr.bld.id or -1))
    local civ = ''
    if tr.civ then
        local ok, name = pcall(function() return dfhack.translation.translateName(tr.civ.name, true) end)
        if ok then civ = name or '' end
    end
    put('merchantCiv', json_string(civ))
    local mood = -1
    if tr.mer then
        local ok, m = pcall(function() return tr.mer.mood end)
        if ok then mood = m end
    end
    put('merchantMood', tostring(mood))
    local talk = ''
    local ok_talk, talk_name = pcall(function() return df.talk_line_type[tr.talkline] end)
    if ok_talk and talk_name then talk = talk_name end
    put('talkLine', json_string(talk))
    -- Native header/footer strings straight from the struct -- never composed here.
    local function put_str(key, fn)
        local ok, s = pcall(fn)
        put(key, json_string(ok and s or ''))
    end
    put_str('screenTitle', function() return tr.title end)
    put_str('talkerName', function() return tr.talker end)
    put_str('fortName', function() return tr.fortname end)
    put_str('placeName', function() return tr.place end)
    put_str('merchantName', function()
        return tr.merchant_trader and dfhack.units.getReadableName(tr.merchant_trader) or ''
    end)
    -- The oracle footer shows the caravan civ's NATIVE-language name ("Merchants from
    -- Sarvabôk"); merchantCiv above is the translated form. Serve both, invent neither.
    put_str('merchantCivNative', function()
        return tr.civ and dfhack.translation.translateName(tr.civ.name, false) or ''
    end)
    local ok_mid, mid = pcall(function() return tr.merchant_trader and tr.merchant_trader.id or -1 end)
    put('merchantTraderId', tostring(ok_mid and mid or -1))
    local ok_ha, ha = pcall(function() return tr.handle_appraisal end)
    put('handleAppraisal', tostring(ok_ha and ha or 0))
    -- Caravan carrying capacity (massst: whole=kg, fraction=mg) for the Allowed/Excess
    -- Weight footer. -1 = unavailable (client omits the weight line rather than faking one).
    local ok_cap, cap_w, cap_f = pcall(function()
        return tr.mer.total_capacity.whole, tr.mer.total_capacity.fraction
    end)
    put('capacity', tostring(ok_cap and cap_w or -1))
    put('capacityFr', tostring(ok_cap and cap_f or 0))
    for side = 0, 1 do
        local rows = {}
        local n = #tr.good[side]
        for i = 0, n - 1 do
            local item = tr.good[side][i]
            local gf = tr.goodflag[side][i]
            local desc = ''
            local ok_d, d = pcall(dfhack.items.getReadableDescription, item)
            if ok_d then desc = d or '' end
            local value = 0
            local ok_v, v = pcall(dfhack.items.getValue, item, tr.mer)
            if ok_v then value = v or 0 end
            local w, wf, wtext = hw_item_weight(item)
            local group, sprite = '', 'null'
            local ok_t, t = pcall(function() return item:getType() end)
            if ok_t then
                group = df.item_type[t] or ''
                local ok_s, sub, mat, mi = pcall(function()
                    return item:getSubtype(), item:getMaterial(), item:getMaterialIndex()
                end)
                if ok_s then
                    sprite = string.format(
                        '{"itemType":%s,"itemSubtype":%d,"materialType":%d,"materialIndex":%d}',
                        json_string(group), sub or -1, mat or -1, mi or -1)
                end
            end
            rows[#rows + 1] = string.format(
                '{"id":%d,"idx":%d,"desc":%s,"value":%d,"selected":%s,"contained":%s,' ..
                '"weight":%d,"weightFr":%d,"weightText":%s,"group":%s,"spriteRef":%s}',
                item.id, i, json_string(desc), value,
                json_bool(gf.selected), json_bool(gf.contained),
                w, wf, json_string(wtext), json_string(group), sprite)
        end
        put(side == 0 and 'caravanGoods' or 'fortGoods', '[' .. table.concat(rows, ',') .. ']')
    end
    if tr.counter_offer then
        local rows = {}
        for i = 0, #tr.counter_offer_item - 1 do
            local item = tr.counter_offer_item[i]
            local ok_d, d = pcall(dfhack.items.getReadableDescription, item)
            rows[#rows + 1] = string.format('{"id":%d,"desc":%s}', item.id, json_string(ok_d and d or ''))
        end
        put('counterOfferItems', '[' .. table.concat(rows, ',') .. ']')
    end
    -- Button rects (probe evidence + text-assert transparency).
    local btns = {}
    for name, spec in pairs(HW_TRADE_BUTTONS) do
        local x1, y1, x2, y2 = hw_button_rect(spec)
        btns[#btns + 1] = string.format('"%s":{"rect":[%d,%d,%d,%d],"text":%s}',
            name, x1, y1, x2, y2, json_string(hw_rect_text(x1, y1, x2, y2)))
    end
    put('buttons', '{' .. table.concat(btns, ',') .. '}')
    return '{' .. table.concat(parts, ',') .. '}\n'
end

-- Set/clear the native selection bit on items by id. EXACTLY what DFHack's trade UI writes
-- (scripts/internal/caravan/trade.lua toggle_item_base: trade.goodflag[side][idx].selected).
local function hw_trade_select(side, ids_csv, on)
    local tr = hw_trade()
    if not tr.open then return hw_err('no trade session is open') end
    side = tonumber(side)
    if side ~= 0 and side ~= 1 then return hw_err('side must be 0 (caravan) or 1 (fort)') end
    local want = {}
    for id in tostring(ids_csv or ''):gmatch('[-%d]+') do want[tonumber(id)] = true end
    if not next(want) then return hw_err('no item ids given') end
    local hit, missing = 0, 0
    local n = #tr.good[side]
    for i = 0, n - 1 do
        local item = tr.good[side][i]
        if item and want[item.id] then
            tr.goodflag[side][i].selected = (on and true or false)
            want[item.id] = nil
            hit = hit + 1
        end
    end
    for _ in pairs(want) do missing = missing + 1 end
    return string.format('{"ok":true,"changed":%d,"missing":%d}\n', hit, missing)
end

-- Count selected items per side (container contents follow their selected bin -- native
-- for_selected_item semantics, mirrored from caravan/trade.lua).
local function hw_trade_selected_count(side)
    local tr = hw_trade()
    local count, in_selected_container = 0, false
    for i = 0, #tr.good[side] - 1 do
        local gf = tr.goodflag[side][i]
        if not gf.contained then in_selected_container = gf.selected end
        if gf.selected or in_selected_container then count = count + 1 end
    end
    return count
end

-- Click one of the native trade-screen commit buttons. Belt and suspenders: the click only
-- fires if the replicated confirm-plugin rect ALSO carries the expected label on screen (unless
-- the host explicitly set click_without_text_assert after probe P-T3 found text unreadable).
local function hw_trade_confirm(which)
    if not hw_flag('trade_confirm') then return hw_guarded('trade_confirm', 'the barter commit') end
    local spec = HW_TRADE_BUTTONS[which]
    if not spec then return hw_err('unknown trade button: ' .. tostring(which)) end
    local tr = hw_trade()
    if not tr.open then return hw_err('no trade session is open') end
    if not hw_trade_focus_ok() then return hw_err('the host screen is not on the trade view') end
    if tr.choosing_merchant then return hw_err('merchant selection is still open on the host screen') end
    if tr.counter_offer then return hw_err('the merchant made a counter-offer; accept or decline it first') end
    if tr.stillunloading ~= 0 then return hw_err('the merchants are still unloading') end
    if tr.havetalker == 0 then return hw_err('no merchant negotiator is at the depot') end
    if which == 'trade' and hw_trade_selected_count(1) == 0 and hw_trade_selected_count(0) == 0 then
        return hw_err('nothing is selected on either side of the table')
    end
    if which == 'offer' and hw_trade_selected_count(1) == 0 then
        return hw_err('no fort goods are selected to offer')
    end
    if which == 'seize' and hw_trade_selected_count(0) == 0 then
        return hw_err('no caravan goods are selected to seize')
    end
    local x1, y1, x2, y2 = hw_button_rect(spec)
    local seen = hw_rect_text(x1, y1, x2, y2)
    if not seen:lower():find(spec.label, 1, true) and not hw_flag('click_without_text_assert') then
        return hw_err(('the "%s" button is not where expected (saw %q at [%d,%d]-[%d,%d]); ' ..
            'refusing to click blind. Probe P-T3 pins this.'):format(which, seen, x1, y1, x2, y2))
    end
    local before0, before1 = #hw_trade().good[0], #hw_trade().good[1]
    hw_with_confirms_disabled({ 'trade-confirm-trade', 'trade-offer', 'trade-seize' }, function()
        hw_click_rect_center(x1, y1, x2, y2)
    end)
    local talk = ''
    local ok_talk, talk_name = pcall(function() return df.talk_line_type[tr.talkline] end)
    if ok_talk and talk_name then talk = talk_name end
    return string.format(
        '{"ok":true,"clicked":%s,"open":%s,"counterOffer":%s,"talkLine":%s,' ..
        '"goodsBefore":[%d,%d],"goodsAfter":[%d,%d]}\n',
        json_string(which), json_bool(tr.open), json_bool(tr.counter_offer), json_string(talk),
        before0, before1, #tr.good[0], #tr.good[1])
end

-- Merchant counter-offer: native draws Accept/Refuse controls on the trade screen. Their frames
-- are not in confirm's specs, so we locate the label text on the live grid and refuse to act if
-- it isn't found. Probe P-T4 pins the real labels/positions.
local function hw_trade_counter(accept)
    if not hw_flag('trade_confirm') then return hw_guarded('trade_confirm', 'the counter-offer reply') end
    local tr = hw_trade()
    if not tr.open then return hw_err('no trade session is open') end
    if not tr.counter_offer then return hw_err('there is no counter-offer to answer') end
    local words = accept and { 'accept' } or { 'refuse', 'reject', 'decline' }
    local cx, cy
    for _, word in ipairs(words) do
        cx, cy = hw_find_screen_text(word)
        if cx then break end
    end
    if not cx then
        return hw_err('could not locate the counter-offer buttons on screen (probe P-T4 pins them)')
    end
    hw_with_confirms_disabled({ 'trade-confirm-trade' }, function() hw_click_at(cx, cy) end)
    return string.format('{"ok":true,"accepted":%s,"counterOffer":%s,"open":%s}\n',
        json_bool(accept), json_bool(tr.counter_offer), json_bool(tr.open))
end

-- Open the native trade screen without the host keyboard. HYPOTHESIS (guarded until probe P-T1
-- diffs a native open): the depot sheet's Trade button seeds the fields below and the native
-- logic builds the goods lists when `buildlists` is set. Everything here is interface state --
-- no save-owned structure is touched; if the hypothesis is wrong the native logic closes the
-- screen or leaves it empty, and the caller reports that honestly.
local function hw_trade_open(depot_id)
    if not hw_flag('trade_open') then return hw_guarded('trade_open', 'opening the trade screen remotely') end
    local tr = hw_trade()
    if tr.open then return '{"ok":true,"already":true}\n' end
    if not dfhack.world.isFortressMode() then return hw_err('not in fortress mode') end
    local depot = df.building.find(tonumber(depot_id) or -1)
    if not depot or not df.building_tradedepotst:is_instance(depot) then
        return hw_err('not a trade depot')
    end
    local caravan
    for _, car in ipairs(df.global.plotinfo.caravans) do
        if car.trade_state == df.caravan_state.T_trade_state.AtDepot and car.time_remaining > 0 then
            caravan = car
            break
        end
    end
    if not caravan then return hw_err('no caravan is at the depot') end
    tr.bld = depot
    tr.mer = caravan
    tr.civ = df.historical_entity.find(caravan.entity)
    tr.st = df.world_site.find(df.global.plotinfo.site_id)
    tr.choosing_merchant = false
    tr.counter_offer = false
    tr.stillunloading = 1 -- native logic recomputes; start pessimistic
    tr.havetalker = 0
    for side = 0, 1 do
        tr.scroll_position_item[side] = 0
        tr.item_filter[side] = ''
        tr.entering_item_filter[side] = false
    end
    tr.buildlists = 1
    tr.open = true
    return '{"ok":true,"opened":true,"pendingBuild":true}\n'
end

local function hw_trade_close()
    local tr = hw_trade()
    if not tr.open then return '{"ok":true,"already":true}\n' end
    hw_with_confirms_disabled({ 'trade-cancel' }, function() hw_feed('LEAVESCREEN') end)
    return string.format('{"ok":true,"open":%s}\n', json_bool(tr.open))
end

-- Single dispatch entry for the C++ bridge. `arg1/arg2/arg3` meaning depends on action.
function hw_trade_action(action, arg1, arg2, arg3)
    if action == 'select' then return hw_trade_select(tonumber(arg1), arg2, tonumber(arg3) ~= 0) end
    if action == 'trade' or action == 'offer' or action == 'seize' then return hw_trade_confirm(action) end
    if action == 'counter-accept' then return hw_trade_counter(true) end
    if action == 'counter-decline' then return hw_trade_counter(false) end
    if action == 'open' then return hw_trade_open(tonumber(arg1)) end
    if action == 'close' then return hw_trade_close() end
    return hw_err('unknown trade action: ' .. tostring(action))
end

-- ================================================================================================
-- B227: justice convict / interrogate (game.main_interface.info.justice, widgetized in 53.15)
-- ================================================================================================

local function hw_justice()
    return df.global.game.main_interface.info.justice
end

local function hw_justice_widget(...)
    local ok, w = pcall(dfhack.gui.getWidget, hw_justice(), ...)
    if ok then return w end
    return nil
end

-- The widget paths below are the ones DFHack itself ships against DF 53.15:
--   Tabs / 'Open cases' / 'Right panel' / 'Convict'  + 'Unit List'/1 rows whose child 0 is a
--   widget_unit_portrait carrying .u  -- scripts/internal/confirm/specs.lua (convict spec) and
--   plugins/lua/sort/info.lua (JusticeOverlay), library/modules/Gui.cpp (focus strings).

local function hw_case_rows()
    local tab = hw_justice_widget('Tabs', 'Open cases')
    if not tab then return nil end
    local rows_container = hw_find_scroll_rows(tab, 'Right panel')
    if not rows_container then return nil end
    return rows_container
end

local function hw_pane_unit_rows(pane_name)
    local pane = hw_justice_widget('Tabs', 'Open cases', 'Right panel', pane_name)
    if not pane then return nil, nil end
    local ok, rows = pcall(dfhack.gui.getWidget, pane, 'Unit List', 1)
    if not ok then rows = nil end
    return pane, rows
end

-- Row -> unit resolution, indexing THROUGH the container exactly like confirm/specs.lua does
-- (`dfhack.gui.getWidget(scroll_rows, pos, 0).u` -- child 0 is a widget_unit_portrait,
-- df.widgets.unit_list.xml).
local function hw_unit_row_index(rows, unit_id)
    local ok_n, n = pcall(function() return #rows.children end)
    if not ok_n then return nil, 0 end
    for i = 0, n - 1 do
        local ok_u, u = pcall(function()
            local cell = dfhack.gui.getWidget(rows, i, 0)
            return cell and cell.u or nil
        end)
        if ok_u and u and u.id == unit_id then return i, n end
    end
    return nil, n
end

-- State snapshot: the GET side of /justice-convict, and probe P-J1's instrument.
function hw_justice_state()
    local mi = df.global.game.main_interface
    local j = hw_justice()
    local parts = { '"ok":true' }
    local function put(k, v) parts[#parts + 1] = '"' .. k .. '":' .. v end
    local flags = hw_flags()
    put('guards', string.format('{"justiceConvict":%s,"justiceInterrogate":%s}',
        json_bool(flags.justice_convict == true), json_bool(flags.justice_interrogate == true)))
    put('infoOpen', json_bool(mi.info.open))
    put('justiceMode', json_bool(mi.info.open and
        mi.info.current_mode == df.info_interface_mode_type.JUSTICE))
    put('currentTab', json_string(df.justice_interface_mode_type[j.current_mode] or ''))
    put('convicting', json_bool(j.convicting))
    put('interrogating', json_bool(j.interrogating))
    local crimes = {}
    for i = 0, #j.convict_crime - 1 do
        local c = j.convict_crime[i]
        if c then crimes[#crimes + 1] = tostring(c.id) end
    end
    put('convictCrimeIds', '[' .. table.concat(crimes, ',') .. ']')
    local rows_container = hw_case_rows()
    local ok_rows, case_rows = pcall(function() return #rows_container.children end)
    put('caseRows', tostring(rows_container and ok_rows and case_rows or 0))
    for _, pane_name in ipairs({ 'Convict', 'Interrogate' }) do
        local pane, rows = hw_pane_unit_rows(pane_name)
        if pane and rows then
            local ids = {}
            local ok_n, n = pcall(function() return #rows.children end)
            for i = 0, (ok_n and math.min(n, 200) or 0) - 1 do
                local ok_u, u = pcall(function()
                    local cell = dfhack.gui.getWidget(rows, i, 0)
                    return cell and cell.u or nil
                end)
                ids[#ids + 1] = tostring(ok_u and u and u.id or -1)
            end
            local cursor = -1
            local ok_c, c = pcall(function() return pane.cursor_idx end)
            if ok_c and c ~= nil then cursor = c end
            put(pane_name == 'Convict' and 'convictPane' or 'interrogatePane', string.format(
                '{"unitIds":[%s],"cursorIdx":%d}', table.concat(ids, ','), cursor))
        end
    end
    return '{' .. table.concat(parts, ',') .. '}\n'
end

-- Per-drive session (module-global; the C++ side serializes drives behind a mutex and calls
-- hw_justice_action repeatedly, sleeping between calls so native frames can run).
hw_justice_session = hw_justice_session or nil

local function hw_session_for(kind, crime_id, unit_id)
    local s = hw_justice_session
    if not s or s.kind ~= kind or s.crime ~= crime_id or s.unit ~= unit_id then
        s = { kind = kind, crime = crime_id, unit = unit_id, row_attempt = 0,
              open_feeds = 0, tab_fixes = 0, key = kind == 'convict' and 'JUSTICE_CONVICT'
                                                  or 'JUSTICE_INTERROGATE',
              pane = kind == 'convict' and 'Convict' or 'Interrogate' }
        hw_justice_session = s
    end
    return s
end

-- One step of the native convict/interrogate drive. Returns done-json, retry-json (caller sleeps
-- a few frames and calls again), or error-json. EVERY game-record write in here is performed by
-- native DF code reacting to fed input; the only direct writes are widget cursor/scroll state
-- and (rarely) the tab-visibility trio, all pure interface state.
function hw_justice_action(action, crime_id, unit_id, final)
    crime_id, unit_id = tonumber(crime_id) or -1, tonumber(unit_id) or -1
    final = tonumber(final) == 1
    if action ~= 'convict' and action ~= 'interrogate' then
        return hw_err('unknown justice action: ' .. tostring(action))
    end
    local flag = action == 'convict' and 'justice_convict' or 'justice_interrogate'
    if not hw_flag(flag) then
        hw_justice_session = nil
        return hw_guarded(flag, action == 'convict' and 'the native conviction drive'
                                 or 'the native interrogation drive')
    end
    if not dfhack.world.isFortressMode() then return hw_err('not in fortress mode') end

    local crime = df.crime.find(crime_id)
    if not crime then return hw_err('no crime with id ' .. crime_id) end
    if crime.flags.sentenced then return hw_err('this case is already closed (sentenced)') end
    if not crime.flags.discovered then
        return hw_err('this is a cold (undiscovered) case; v1 drives open cases only')
    end
    local unit = df.unit.find(unit_id)
    if not unit then return hw_err('no unit with id ' .. unit_id) end

    local s = hw_session_for(action, crime_id, unit_id)
    local function step_retry(stage)
        if final then
            hw_justice_session = nil
            return hw_err('timed out at stage: ' .. stage)
        end
        return hw_retry(stage)
    end

    local mi = df.global.game.main_interface
    if mi.trade.open then return hw_err('a trade session is open on the host screen; finish it first') end

    -- Stage 1: the justice screen.
    if not (mi.info.open and mi.info.current_mode == df.info_interface_mode_type.JUSTICE) then
        if s.open_feeds >= 3 then
            hw_justice_session = nil
            return hw_err('could not open the justice screen (another native window may be blocking it)')
        end
        -- Precedent for closing a blocking view sheet by state-write: gui/teleport.lua:54.
        if mi.view_sheets.open then mi.view_sheets.open = false end
        s.open_feeds = s.open_feeds + 1
        hw_feed('D_JUSTICE')
        return step_retry('opening justice screen')
    end

    -- Stage 2: the Open cases tab (the default tab; direct visibility write is the fallback).
    local tabs = hw_justice_widget('Tabs')
    if not tabs then return step_retry('waiting for justice widgets') end
    local visible_tab = hw_visible_child(tabs)
    if not visible_tab then return step_retry('waiting for a visible tab') end
    if visible_tab.name ~= 'Open cases' then
        if s.tab_fixes >= 2 then
            hw_justice_session = nil
            return hw_err('could not switch to the Open cases tab')
        end
        s.tab_fixes = s.tab_fixes + 1
        local ok_fix = pcall(function()
            local n = #tabs.children
            for i = 0, n - 1 do
                local c = tabs.children[i]
                local on = (c.name == 'Open cases')
                c.flag.VISIBILITY_ACTIVE = on
                c.flag.VISIBILITY_VISIBLE = on
                if on then tabs.cur_idx = i end
            end
            hw_justice().current_mode = df.justice_interface_mode_type.OPEN_CASES
        end)
        if not ok_fix then
            hw_justice_session = nil
            return hw_err('tab switch failed (widget layout differs; probe P-J1 dumps it)')
        end
        return step_retry('switching to Open cases tab')
    end

    local j = hw_justice()

    -- Stage 3: get the right case selected and enter convict/interrogate mode natively.
    local in_mode = (action == 'convict') and j.convicting or j.interrogating
    if in_mode then
        -- Verify the native mode is aimed at OUR crime before touching a unit.
        local found = false
        for i = 0, #j.convict_crime - 1 do
            if j.convict_crime[i] and j.convict_crime[i].id == crime_id then found = true end
        end
        if action == 'interrogate' and #j.convict_crime == 0 then
            -- convict_crime is the convict-mode vector; interrogate mode may not fill it. The
            -- case identity was already checked when we entered the mode below (same click),
            -- so accept interrogate mode as-is only if this session did the entering.
            found = s.entered_mode == true
        end
        if not found then
            -- Back out of a mode aimed at the wrong case. The row counter advances in the
            -- not-in-mode branch below (pending_backout), NOT here: LEAVESCREEN may need more
            -- than one frame to exit the mode, and incrementing per backout attempt would skip
            -- case rows.
            hw_feed('LEAVESCREEN')
            s.pending_backout = true
            s.entered_mode = false
            return step_retry('backing out of wrong case (row ' .. s.row_attempt .. ')')
        end

        -- Stage 4: the unit list (rows build deferred -- widget_unit_list.deferred_units_builds).
        local pane, rows = hw_pane_unit_rows(s.pane)
        if not pane or not rows then return step_retry('waiting for the ' .. s.pane .. ' pane') end
        local idx, count = hw_unit_row_index(rows, unit_id)
        if not idx then
            if count == 0 then return step_retry('waiting for suspect rows to build') end
            hw_feed('LEAVESCREEN')
            hw_justice_session = nil
            return hw_err(('unit %d is not among the %d candidates DF lists for this case')
                :format(unit_id, count))
        end
        local ok_cursor = pcall(function() pane.cursor_idx = idx end)
        if not ok_cursor then
            hw_justice_session = nil
            return hw_err('the ' .. s.pane .. ' pane has no cursor_idx (widget layout differs)')
        end

        local punishments_before = #df.global.plotinfo.punishments
        local reports_before = #crime.reports
        hw_with_confirms_disabled({ 'convict' }, function() hw_feed('SELECT') end)

        if action == 'convict' then
            if crime.flags.sentenced then
                hw_justice_session = nil
                if j.convicting then hw_feed('LEAVESCREEN') end
                return string.format(
                    '{"ok":true,"convicted":true,"crimeId":%d,"unitId":%d,"prisonTime":%d,' ..
                    '"hammerstrikes":%d,"beating":%s,"exiled":%s,"deathSentence":%s,' ..
                    '"punishmentsDelta":%d}\n',
                    crime_id, unit_id, crime.punishment.prison_time, crime.punishment.hammerstrikes,
                    json_bool(crime.punishment.flags.beating), json_bool(crime.punishment.flags.exiled),
                    json_bool(crime.punishment.flags.death_sentence),
                    #df.global.plotinfo.punishments - punishments_before)
            end
            hw_justice_session = nil
            if j.convicting then hw_feed('LEAVESCREEN') end
            return hw_err('SELECT was delivered but the case did not close (sentenced flag ' ..
                'unchanged); nothing was written. Probe P-J3 pins the final activation.')
        else
            hw_justice_session = nil
            return string.format(
                '{"ok":true,"toggled":true,"crimeId":%d,"unitId":%d,"reportsDelta":%d}\n',
                crime_id, unit_id, #crime.reports - reports_before)
        end
    end

    -- Not in mode yet: click the next candidate case row, then feed the mode hotkey.
    if s.pending_backout then
        -- The backout above has completed (we are provably out of the mode) -> next row.
        s.pending_backout = false
        s.row_attempt = s.row_attempt + 1
    end
    local rows_container = hw_case_rows()
    if not rows_container then return step_retry('waiting for the case list') end
    local ok_n, case_count = pcall(function() return #rows_container.children end)
    if not ok_n or case_count == 0 then return step_retry('waiting for case rows') end
    if s.row_attempt >= case_count then
        hw_justice_session = nil
        return hw_err(('crime %d was not found among the %d listed open cases')
            :format(crime_id, case_count))
    end
    local row = rows_container.children[s.row_attempt]
    -- Ensure the row is scrolled into view so its rect is live, then click it.
    local ok_scroll = pcall(function()
        local scroll, visible = rows_container.scroll, rows_container.num_visible
        if visible > 0 and (s.row_attempt < scroll or s.row_attempt >= scroll + visible) then
            rows_container.scroll = s.row_attempt
            error('scrolled') -- surface as retry below
        end
    end)
    if not ok_scroll then return step_retry('scrolling the case list') end
    local ok_rect, rx1, ry1, rx2, ry2 = pcall(function()
        return row.rect.x1, row.rect.y1, row.rect.x2, row.rect.y2
    end)
    if not ok_rect or rx2 < rx1 or ry2 < ry1 then return step_retry('waiting for row layout') end
    hw_click_rect_center(rx1, ry1, rx2, ry2)
    hw_feed(s.key)
    s.entered_mode = true
    return step_retry('entering ' .. action .. ' mode (case row ' .. s.row_attempt .. ')')
end

hw_trade_state = safe_json(hw_trade_state)
hw_trade_action = safe_json(hw_trade_action)
hw_justice_state = safe_json(hw_justice_state)
hw_justice_action = safe_json(hw_justice_action)
hw_widget_dump = safe_json(hw_widget_dump)

return _ENV
