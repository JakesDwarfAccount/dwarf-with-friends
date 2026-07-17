-- b35_djobs_oracle.lua -- B35 read-side ORACLE. Enumerates the live job list applying the
-- EXACT SAME predicate + kind mapping the server uses in src/world_stream.cpp's B35 block,
-- so its output is the ground truth the additive AUX `djobs:[{x,y,z,k}]` array must match
-- tile-for-tile. Run under dfhack:  dfhack-run lua -f <absolute path to this file>
-- (per the truemenu ops note: lua -f + ABSOLUTE path; inline multi-statement lua fails).
--
-- Server contract (world_stream.cpp): job_type -> kind
--   SmoothWall, SmoothFloor            -> 1 (smooth)
--   DetailWall, DetailFloor            -> 2 (engrave)
--   CarveFortification                 -> 3 (fortify)
--   CarveTrack                         -> 4 (track)
--   EVERYTHING ELSE (incl. EngraveSlab=item engrave, Carve up/down stairs & ramps=dig bits)
--                                      -> EXCLUDED
--
-- ORACLE USE: diff the "DJOB ..." lines below against the AUX frame's djobs array (same
-- x,y,z,k). The BOUNDARY section proves the filter excludes the look-alike job types
-- (seeded-bad: EngraveSlab / Carve stairs must NOT appear as djobs).

local JT = df.job_type
-- kind map keyed by the numeric enum value (nil-safe: enum members always exist in v50).
local KIND = {
  [JT.SmoothWall] = 1, [JT.SmoothFloor] = 1,
  [JT.DetailWall] = 2, [JT.DetailFloor] = 2,
  [JT.CarveFortification] = 3,
  [JT.CarveTrack] = 4,
}
-- look-alike job types the server DELIBERATELY excludes -- the boundary the oracle checks.
local EXCLUDED = {
  [JT.EngraveSlab] = "EngraveSlab(item engrave)",
  [JT.CarveUpwardStaircase] = "CarveUpwardStaircase(dig bit)",
  [JT.CarveDownwardStaircase] = "CarveDownwardStaircase(dig bit)",
  [JT.CarveUpDownStaircase] = "CarveUpDownStaircase(dig bit)",
  [JT.CarveRamp] = "CarveRamp(dig bit)",
}

print("=== B35 djobs oracle: live job list vs server predicate ===")
local matched, excluded_seen = 0, 0
local link = df.global.world.jobs.list.next
while link do
  local job = link.item
  if job then
    local jt = job.job_type
    local k = KIND[jt]
    if k then
      matched = matched + 1
      local p = job.pos
      print(string.format("DJOB x=%d y=%d z=%d k=%d  (job_type=%s)",
        p.x, p.y, p.z, k, tostring(df.job_type[jt])))
    elseif EXCLUDED[jt] then
      excluded_seen = excluded_seen + 1
      local p = job.pos
      print(string.format("BOUNDARY-EXCLUDED x=%d y=%d z=%d  %s -> NOT a djob (correct)",
        p.x, p.y, p.z, EXCLUDED[jt]))
    end
  end
  link = link.next
end
print(string.format("TOTAL djobs expected in AUX = %d ; boundary/excluded look-alikes seen = %d",
  matched, excluded_seen))
if matched == 0 then
  print("NOTE: no smooth/engrave/detail/carve JOBS active right now. To exercise B35, mark a")
  print("      wall/floor for Smooth (or Engrave) and wait for a mason/engraver to CLAIM it")
  print("      (the map designation bit clears at that moment -- that is the B35 window).")
end
