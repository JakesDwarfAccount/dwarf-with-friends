-- cage_diag.lua: B111 cage-50 differential (read-only)
local function snap(id)
    local b = df.building.find(id)
    if not b then print(('#%d: NOT FOUND'):format(id)) return end
    local t = df.building_type[b:getType()] or tostring(b:getType())
    local out = {('#%d type=%s pos=(%d,%d,%d) stage=%s'):format(
        id, t, b.centerx, b.centery, b.z,
        tostring(b.construction_stage))}
    out[#out+1] = ('  jobs=%d items=%d'):format(#b.jobs, #b.contained_items)
    for i = 0, #b.contained_items - 1 do
        local ci = b.contained_items[i]
        local it = ci.item
        out[#out+1] = ('  item[%d] use_mode=%d id=%s type=%s in_building=%s holder_ref=%s'):format(
            i, ci.use_mode,
            it and it.id or 'nil',
            it and df.item_type[it:getType()] or '?',
            it and tostring(it.flags.in_building) or '?',
            it and tostring((function()
                for _, r in ipairs(it.general_refs) do
                    if df.general_ref_building_holderst:is_instance(r) then return r.building_id end
                end
                return 'NONE'
            end)()) or '?')
    end
    if df.building_cagest:is_instance(b) then
        out[#out+1] = ('  CAGE assigned_units=%d assigned_items=%d flags=%s fill_timer=%d'):format(
            #b.assigned_units, #b.assigned_items,
            tostring(b.cage_flags.whole), b.fill_timer)
    end
    print(table.concat(out, '\n'))
end
print('=== cage/building differential ===')
snap(50)
snap(99)
snap(100)
-- find one native-ish cage for comparison: first cage that is not 50/99/100
for _, b in ipairs(df.global.world.buildings.all) do
    if df.building_cagest:is_instance(b) and b.id ~= 50 and b.id ~= 99 and b.id ~= 100 then
        snap(b.id)
        break
    end
end
