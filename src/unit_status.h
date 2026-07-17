// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// ===========================================================================
// B222 -- the ONE shared computation of the per-unit overhead-status bitfield
// `st` (WINDOW #13 + WT29 mood subtype), used by BOTH unit serializers:
//
//   * world_stream.cpp's units scan  -> append_unit_json (aux full + auxd delta)
//   * tile_map_dump.cpp's emit_units -> GET /mapdata + the WS mapdata push
//
// B222 ROOT CAUSE this factoring closes: the predicates lived inline in
// world_stream.cpp only, so emit_units NEVER emitted "st" -- every snapshot /
// fresh-join / window-change path that rebuilds units from the mapdata shape
// dropped all status bubbles until an aux fold change re-shipped the unit
// (which, for a dwarf asleep the whole time, never came: the fold changes on
// wake). The strange-mood bubble survived because moods last long enough for
// aux deltas to re-ship the record. One shared function makes a serializer
// split like that structurally impossible to reintroduce.
//
// Emit contract (BOTH serializers): `"st"` rides the unit JSON ONLY when
// non-zero -- a content unit adds zero bytes. ZERO binary-wire / golden-CRC
// surface. Every landed bit is sourced from a CRISP DF field with NO invented
// numeric threshold, verified against DFHack df-structures canon:
//   sleeping    = current_job->job_type == Sleep OR Rest  (SB-SERVER sel:60-70, NAMED-APPROX; R2)
//   unconscious = counters.unconscious > 0        (knocked out)
//   stressed    = soul->personality.stress >= 10000, no active mood  (SB-SERVER: the overhead
//                 BUBBLE branch, FUN_1402685d0 sel:184 -- raw stress, NOT longterm_stress. B280's
//                 longterm_stress>=20000 is the unit-SHEET threshold and stays there.)
// ===========================================================================
// WT30 -- the FULL overhead-status set. The st int is a 32-bit JSON int; WT30 widens it from
// the original 6 bits + WT29 mood nibble to ALL of DF's overhead UNIT_STATUS bubbles we can
// ground in a CRISP df-structures field. EXISTING BITS KEEP THEIR POSITIONS (old-client compat):
// the new bits begin at 0x200 and stop at bit 28 (0x10000000) so `st|0` in JS stays a positive
// int32 (bit 31 sign never reached). One bubble is shown at a time -- the client owns the priority
// order; the wire ships EVERY active bit.
//
//   bit  mask        name           df-structures source (DFHack canon)
//   ---  ----------  -------------   ------------------------------------------------------------
//    0   0x00000001  SLEEPING        job.current_job->job_type == Sleep OR Rest  (sel:60-70; R2)
//    1   0x00000002  UNCONSCIOUS     counters.unconscious > 0 (knocked out)
//    2   0x00000004  STRESSED        soul->personality.stress >= 10000, no mood  (bubble; sel:184)
//    3   0x00000008  STRANGE_MOOD    flags1.has_mood
//    4   0x00000010  CAGED           flags1.caged            (no overhead cell -> client null)
//    5   0x00000020  CHAINED         flags1.chained          (no overhead cell -> client null)
//   6-8  0x000001C0  MOOD_SUBTYPE    3-bit 1-based code from unit->mood (WT29; see nibble below)
//   -- WT30 additions (each a plain field read under the caller's existing suspend) --
//    9   0x00000200  WINDED          counters.winded > 0 && !flags1.drowning   (sel:159)
//   10   0x00000400  STUNNED         counters.stunned > 0 || counters.dizziness > 0  (sel:156)
//   11   0x00000800  NAUSEA          counters.nausea > 0
//   12   0x00001000  WEBBED          counters.webbed > 9                        (sel:44)
//   13   0x00002000  PARALYZED       counters2.paralysis >= 100                 (sel:78)
//   14   0x00004000  FEVERED         counters2.fever > 0
//   15   0x00008000  GROUNDED        flags1.on_ground (laying on the floor; may be conscious)
//   16   0x00010000  PROJECTILE      flags1.projectile (flung through the air)
//   17   0x00020000  CLIMBING        an active unit_action of type Climb in unit->actions
//   18   0x00040000  MELANCHOLY      unit->mood == Melancholy   (insanity; read direct, NOT
//   19   0x00080000  MADNESS         unit->mood == Raving         has_mood-gated -- matches
//   20   0x00100000  BERSERK         unit->mood == Berserk        Units::isSane's switch)
//   21   0x00200000  MARTIAL_TRANCE  counters.soldier_mood == MartialTrance
//   22   0x00400000  ENRAGED         counters.soldier_mood == Enraged
//   23   0x00800000  TANTRUM         counters.soldier_mood == Tantrum
//   24   0x01000000  DEPRESSION      counters.soldier_mood == Depressed
//   25   0x02000000  OBLIVIOUS       counters.soldier_mood == Oblivious
//   26   0x04000000  HUNGRY          counters2.hunger_timer    >= kUStatHungerTimer  (DF-EXACT)
//   27   0x08000000  THIRSTY         counters2.thirst_timer    >= kUStatThirstTimer  (DF-EXACT)
//   28   0x10000000  DROWSY          counters2.sleepiness_timer>= kUStatSleepTimer   (DF-EXACT)
//
// These three are DF-EXACT, decoded from `Dwarf Fortress.exe`: 50000 is where DF prints "Hungry",
// 25000 where it prints "Thirsty", 57600 where it prints "Drowsy". DF's branches are flat integer
// compares with no creature-size term.
// tools/harness/status_truth_test.mjs re-reads these constants and diffs them against the ladder
// extracted from the game binary, so a future edit that drifts from DF goes RED.
//
// UNSHIPPED (no crisp df-structures predicate -- deliberately NOT guessed, per completeness):
//   MIGRANT(row0), NO_JOB(1), NO_DESTINATION(2), DISTRACTED(7): transient/needs-driven arrival &
//     pathing & focus states with no single authoritative unit field.
//   WRESTLING(23): grappling is a body-part-grab relationship (unit_item_wrestle / wrestle_info),
//     not a single flag -- needs a grab-walk + native oracle.
//   YIELDING(32): only flags3.adv_yield (YIELDED) exists and it is adventure-mode-flavored; unclear
//     it drives the fort overhead bubble.
//   TELLING_A_STORY(34), RECITING_POETRY(35), PERFORMING(36), PLAYING_MAKE_BELIEVE(33): activity-
//     event participation (unit->social_activities -> activity_event_performancest / make_believest);
//     mapping the performance CONTENT type to story-vs-poetry-vs-music needs an activity walk the
//     pause-only probe cannot calibrate. Linkage fields noted for a future window.
// See docs/superpowers/specs/2026-07-09-window13-server-needs.md.
// ===========================================================================
// WT31 (BUBBLE-CAL) -- the SECOND status word `st2`, and the bubbles WT30 could not ground.
//
// WHY A SECOND WORD. WT30 filled `st` to bit 28 and the envelope is HARD: both renderers test bits
// with `st & USTAT_X`, and JS's `&` coerces to int32 -- every bit above 31 is silently LOST, and bit
// 31 would flip `st|0` negative. Bits 29/30 are the only ones left in `st`, and WT31 needs twelve.
// So WT31 adds a SEPARATE additive JSON int `st2` rather than widening `st`. Same emit contract as
// `st`: shipped ONLY when non-zero, so a content unit adds zero bytes and the binary wire / golden
// CRC are untouched. Deploy order is free in BOTH directions: an OLD client ignores `st2` entirely
// and still draws every WT30 bubble; a NEW client fed no `st2` reads it as 0 and draws exactly what
// it drew before. `st2` is folded into s4_unit_fold alongside `st` -- WITHOUT that, a unit whose
// ONLY change is an st2 bit (a dwarf who starts telling a story) would never re-ship on the aux
// delta. That is precisely the B222 bug class, so it is pinned by the test.
//
//   bit  mask        name                  row  df-structures source (DFHack canon)
//   ---  ----------  --------------------  ---  ---------------------------------------------------
//    0   0x00000001  MIGRANT                 0  misc_trait Migrant (TRAVELTIRED) present, value > 0
//    1   0x00000002  NO_JOB                  1  isCitizen && isAdult && Units::isJobAvailable
//    2   0x00000004  NO_DESTINATION          2  *** RESERVED -- SERVER NEVER SETS IT (see below) ***
//    3   0x00000008  DISTRACTED              7  focus% (current_focus*100/undistracted_focus) <= 80,
//                                               no active mood/soldier_mood      (sel:188-198, EXACT)
//    4   0x00000010  TERRIFIED              22  flags3.emotionally_overloaded    (NAMED-APPROX; R1)
//    5   0x00000020  WRESTLING              23  status.wrestle_items has an entry vs a real opponent
//    6   0x00000040  MINOR_INJURY           24  body.wounds non-empty, none of them severe
//    7   0x00000080  MAJOR_INJURY           25  body.wounds has a severe wound       (see the ladder)
//    8   0x00000100  PLAYING_MAKE_BELIEVE   33  main social event = activity_event_make_believest
//    9   0x00000200  TELLING_A_STORY        34  performance role STORYTELLER or PREACHER (sel:130-132)
//   10   0x00000400  RECITING_POETRY        35  performance role POEM_RECITER
//   11   0x00000800  PERFORMING             36  performance role MUSICAL_VOICE / DANCER
//
// GROUNDING NOTES (every bit is a plain field read or a DFHack-exported predicate -- no invented
// numeric threshold anywhere in WT31; the only graded items in the whole status set are the three
// per-need timers, kUStatHungerTimer / kUStatThirstTimer / kUStatSleepTimer -- see B248 below):
//
//  * NO_JOB uses DFHack's OWN Units::isJobAvailable(u,false) -- "unit can be assigned a job", i.e.
//    current_job == nullptr AND not caged/chained AND no ACTIVITY specific_ref AND no unbailable
//    social activity AND no squad orders. That is strictly stronger than a bare current_job null
//    test: a dwarf mid-conversation or mid-drill has no job but is NOT idle, and native does not
//    badge them. Gated on isCitizen && isAdult so an idle animal / visitor / invader / baby never
//    badges (the dispatch's explicit counterexample). Short-circuits on current_job first, so the
//    expensive half runs only for genuinely job-less units.
//
//  * DISTRACTED (SB-SERVER rewrite): the overhead selector FUN_1402685d0 (sel:188-198) does NOT read
//    has_unmet_needs -- that flag is true for most of a busy fort and was the root cause of the
//    mass-yellow-face symptom. Native recomputes focus and fires row 7 on the aggregate focus RATIO
//    current_focus*100/undistracted_focus <= 80 (native `iVar16 < 0x51`), gated on no active
//    mood/soldier_mood. undistracted_focus < 1 forces the ratio to 100 (never distracted). EXACT.
//
//  * MINOR vs MAJOR_INJURY grade the TRANSIENT wound vector body.wounds, NOT the persistent
//    body_part_status flags. This distinction is the whole design: body_part_status.missing stays
//    set FOREVER on a dwarf who lost a finger a decade ago, so grading off it would badge a
//    long-healed veteran as permanently injured. Entries in body.wounds are removed as they heal, so
//    "has an open wound" is exactly `!body.wounds.empty()`. The severe ladder is DF's own wound
//    flags -- unit_wound_flag {severed_part (SEVER), popped_out, infection} and wound_damage_flags1
//    {major_artery, guts_spilled, compound_fracture} -- a CATEGORICAL partition of named flags, not
//    a numeric cut. Any severe flag -> MAJOR; an open wound with none of them -> MINOR. The two bits
//    are mutually exclusive by construction.
//
//  * WRESTLING reads status.wrestle_items, the unit's live grapple relationships
//    (unit_item_wrestle: opponent unit id, the two body parts, state LatchedOn/Grab/JointLock/Choke,
//    advantage +1 grabbing / -1 grabbed). A non-empty vector with a real opponent (`unit != -1`,
//    which screens the item-grab rows) IS the grapple -- no flag exists because DF models wrestling
//    as a relationship, exactly as WT30 suspected. Both the grabber and the grabbed badge, which is
//    what "wrestling" means.
//
//  * The PERFORMANCE set walks DFHack's Units::getMainSocialEvent(u) (the last event of the unit's
//    last social activity -- DFHack's canonical "what is this unit socially doing"). MakeBelieve ->
//    row 33. A Performance event is cast to activity_event_performancest and the unit's OWN row in
//    participant_actions (performance_rolest.unit_id == u->id) gives the role: STORYTELLER -> 34,
//    POEM_RECITER -> 35, MUSICAL_VOICE / DANCER -> 36 PERFORMING. SB-SERVER: PREACHER (role 6) ->
//    row 34 TELLING_A_STORY, matching the native selector (sel:130-132, role 6 returns 0x22 == role
//    0). SPECTATOR / INCIDENTAL_SPECTATOR still badge NOTHING -- a crowd watching a bard is an
//    audience, not performers. Native has no spectator return, confirming the audience rule.
//
// NAMED-APPROXIMATION (TERRIFIED, SB-SERVER; R1): the overhead selector FUN_1402685d0 (sel:262-284)
// reaches row 22 (0x16) as the DEFAULT case of a switch on unit->mood, entered when (mood not in
// {-1,8}) OR flags3.emotionally_overloaded (bit25, 0x2000000). There is NO emotion-type inspection
// whatsoever -- the earlier "dominant unovercome emotion == TERROR" walk was INVENTED (it read
// personality.emotions, which the native path never touches) and is removed. The honest v1 shipped
// here is: fire on flags3.emotionally_overloaded (df original name PERSONALITY_MOOD_PREVENTS_WORK),
// DF's transient "an emotion is currently preventing this unit from working" flag. Worst case this
// badges a unit overloaded by some OTHER strong emotion (grief, rage) as terrified; it cannot spam a
// healthy fort, since the flag is transient. The alternative honest disposition -- DISABLE the bubble
// entirely -- sits behind kUStat2TerrifiedApproxEnabled (flip to false; one-line revert). R1 asks for
// the exact fields DF uses to pick between the mood-switch cases so this can become EXACT.
//
// RESERVED, NOT SET (NO_DESTINATION, row 2): honestly unresolved, and deliberately NOT guessed. The
// bit is allocated and the CLIENT maps it, so the probe's answer is a one-line server enable, but
// unit_status_bits2 never sets it today. Two incompatible readings survive the df-structures dig and
// the pause-only state cannot separate them: (a) a PATHING FAILURE -- the unit holds a goal it cannot
// reach (path.goal != None with an empty path.path); or (b) the animal-side twin of NO_JOB -- an idle
// fort creature that takes no jobs and has nowhere to be (path.goal == None). Reading (b) is
// attractive because rows 1 and 2 sit adjacent and would then partition citizens vs livestock, but a
// bare `path.goal == None` ALSO holds for every dwarf standing still for a tick, so shipping it blind
// would badge most of the fort most of the time -- the exact coincidental-pass trap the completeness
// protocol forbids. Probe P3 discriminates.
//
// SKIPPED (YIELDING, row 32): adventure-mode-flavored, dropped on the explicit scope trim. The only
// candidate field is flags3.adv_yield (df original name YIELDED), which is set by the adventure-mode
// yield command; fort mode has no surrender. Not reserved, not probed.
// ===========================================================================
#pragma once

#include <climits>

#include "DataDefs.h"
#include "modules/Units.h"

#include "df/activity_event.h"
#include "df/activity_event_make_believest.h"
#include "df/activity_event_performancest.h"
#include "df/activity_event_type.h"
#include "df/emotion_type.h"
#include "df/job.h"
#include "df/job_type.h"
#include "df/misc_trait_type.h"
#include "df/mood_type.h"
#include "df/performance_participant_type.h"
#include "df/performance_rolest.h"
#include "df/personality_moodst.h"
#include "df/soldier_mood_type.h"
#include "df/unit.h"
#include "df/unit_action.h"
#include "df/unit_action_type.h"
#include "df/unit_item_wrestle.h"
#include "df/unit_misc_trait.h"
#include "df/unit_personality.h"
#include "df/unit_soul.h"
#include "df/unit_wound.h"
#include "df/unit_wound_layerst.h"

constexpr int kUStatSleeping    = 0x01;  // current_job && job_type == Sleep
constexpr int kUStatUnconscious = 0x02;  // counters.unconscious > 0 (knocked out)
constexpr int kUStatStressed    = 0x04;  // personality.stress >= 10000, no active mood (overhead bubble, sel:184)
constexpr int kUStatStrangeMood = 0x08;  // flags1.bits.has_mood (strange mood)
constexpr int kUStatCaged       = 0x10;  // flags1.bits.caged
constexpr int kUStatChained     = 0x20;  // flags1.bits.chained
// WT30 additions (0x200+). Each maps 1:1 to a graphics_interface.txt UNIT_STATUS row.
constexpr int kUStatWinded        = 0x00000200;  // winded>0 && !flags1.drowning   (row 29, sel:159)
constexpr int kUStatStunned       = 0x00000400;  // stunned>0 || dizziness>0       (row 27, sel:156)
constexpr int kUStatNausea        = 0x00000800;  // counters.nausea > 0            (row 28)
constexpr int kUStatWebbed        = 0x00001000;  // counters.webbed > 9            (row 39, sel:44)
constexpr int kUStatParalyzed     = 0x00002000;  // counters2.paralysis >= 100     (row 26, sel:78)
constexpr int kUStatFevered       = 0x00004000;  // counters2.fever > 0            (row 31)
constexpr int kUStatGrounded      = 0x00008000;  // flags1.on_ground               (row 38)
constexpr int kUStatProjectile    = 0x00010000;  // flags1.projectile             (row 37)
constexpr int kUStatClimbing      = 0x00020000;  // active Climb unit_action       (row 40)
constexpr int kUStatMelancholy    = 0x00040000;  // mood == Melancholy             (row 18)
constexpr int kUStatMadness       = 0x00080000;  // mood == Raving                 (row 17)
constexpr int kUStatBerserk       = 0x00100000;  // mood == Berserk                (row 19)
constexpr int kUStatMartialTrance = 0x00200000;  // soldier_mood == MartialTrance  (row 21)
constexpr int kUStatEnraged       = 0x00400000;  // soldier_mood == Enraged        (row 20)
constexpr int kUStatTantrum       = 0x00800000;  // soldier_mood == Tantrum        (row 14)
constexpr int kUStatDepression    = 0x01000000;  // soldier_mood == Depressed      (row 16)
constexpr int kUStatOblivious     = 0x02000000;  // soldier_mood == Oblivious      (row 15)
constexpr int kUStatHungry        = 0x04000000;  // counters2.hunger_timer    >= kUStatHungerTimer (row 3)
constexpr int kUStatThirsty       = 0x08000000;  // counters2.thirst_timer    >= kUStatThirstTimer (row 4)
constexpr int kUStatDrowsy        = 0x10000000;  // counters2.sleepiness_timer>= kUStatSleepTimer  (row 5)
// B248 -- the graded needs get THREE thresholds, not one.
//
// WT30 shipped a single flat kUStatNeedTimer=50000 for hunger AND thirst AND sleepiness. That is
// wrong in both directions and it is why the owner saw no THIRSTY droplet in the browser while native
// showed one: DF's three needs do not fire anywhere near each other, and every DFHack source that
// grades them puts THIRST far below hunger and SLEEPINESS above it:
//   dfhack/plugins/siege-engine.cpp:1471-1473  thirst>=25000, hunger>=50000, sleepiness>=57600
//   dfhack/plugins/autolabor/labormanager.cpp:1144  hunger>60000, thirst>40000
//   dfhack/scripts/internal/notify/notifications.lua:87-89  hunger>75000, thirst>50000, sleep>150000
// A flat 50000 therefore sat ABOVE the point native starts showing the droplet (thirst never fired)
// and BELOW the point a dwarf is actually drowsy (drowsiness over-fired).
//
// The values below are siege-engine's set, chosen because it is one internally-consistent DFHack
// triple AND its hunger value (50000) independently lands inside the 40108..56907 window in which
// this project OBSERVED native's hungry bubble fire (STATUS-ICONS-GRADED history). 57600 is DF's
// canonical must-sleep tick count. These three are DF's exact ladder, decoded from
// `Dwarf Fortress.exe` (tools/harness/df_status_ladder.py): the unit sheet's Overview box prints
// "Hungry" at hunger_timer >= 50000, "Thirsty" at thirst_timer >= 25000, "Drowsy" at
// sleepiness_timer >= 57600. They are flat integer compares in DF's own code, with no creature-size
// term in the branch. tools/harness/status_truth_test.mjs re-reads these very lines and fails if
// they ever drift from DF's.
constexpr int kUStatHungerTimer   = 50000;   // == DF's "Hungry"
constexpr int kUStatThirstTimer   = 25000;   // == DF's "Thirsty"
constexpr int kUStatSleepTimer    = 57600;   // == DF's "Drowsy"
// B280 -- the STRESSED bubble reads longterm_stress, not stress. Which field, and why:
//
// The STRESSED bubble used to fire on DFHack's Units::getStressCategory(u) <= 1. That reads
// `soul->personality.stress` and cuts at 25000 (DFHack's stress_cutoffs = {50000, 25000, ...}).
//
// DF's own unit sheet prints "Stressed" / "Haggard" / "Harrowed" from
// `soul->personality.LONGTERM_STRESS`, at 20000 / 50000 / 100000. Decoded out of the game binary:
// the branch is  unit+0xa98 -> deref current_soul -> +0x248 (offsetof personality)
//                            -> +0x180 (offsetof longterm_stress) -> cmp 20000
// and +0x180 is longterm_stress, not stress (which sits at +0x120) -- see the layout in
// df_status_ladder.py. DF added longterm_stress in v0.50.01 when it reworked the stress system;
// `stress` is the raw accumulator, longterm_stress is what the game actually calls the dwarf by.
// DFHack's bucket table was never updated for it.
//
// So we were reading a different number than DF, and comparing it to a different cutoff than DF.
// Both are fixed here. NOTE the honest limit: DF's OVERHEAD-ICON path was not decoded (the icon is
// drawn from a texpos array, not a string literal, so it has no anchor to decode from). The sheet
// is therefore the authority -- which is what B280 asked for: where the bubble and the sheet
// disagree, the sheet wins.
constexpr int kUStatStressLevel   = 20000;   // == DF's SHEET "Stressed" (Haggard 50000, Harrowed 100000).
// SB-SERVER (2026-07-16): kUStatStressLevel/longterm_stress is the unit-SHEET threshold and is left
// as the sheet authority (status_harvest / unit_status_words / status_truth_test cross-check it).
// The overhead STRESSED *bubble* is a DIFFERENT native branch: FUN_1402685d0 sel:184 fires the row-6
// droplet on personality.stress (the raw accumulator, personality+0x120 == soul+0x368) >= 10000,
// gated on no active mood/soldier_mood. Decoded EXACT from the graphics selector; distinct field AND
// boundary from the sheet, hence a separate constant so the two never conflate.
constexpr int kUStatBubbleStress  = 10000;   // overhead STRESSED bubble: personality.stress >= 10000 (sel:184)
// TERRIFIED (row 22) disposition toggle (recording request R1). FUN_1402685d0 sel:262-284 reaches
// row 22 as the DEFAULT of the mood switch, entered when (mood not in {-1,8}) OR
// flags3.emotionally_overloaded (bit25 0x2000000) -- with NO emotion-type inspection. The prior
// dominant-emotion==TERROR walk was INVENTED. true  -> ship the honest NAMED-APPROXIMATION
// (emotionally_overloaded alone); false -> DISABLE the bubble entirely. Trivially revertable: this
// one bool is the only edit needed to switch dispositions.
constexpr bool kUStat2TerrifiedApproxEnabled = true;
// WT29 -- overhead strange-mood SUBTYPE, shipped in the first reserved bits (0x40..0x100) as a
// 3-bit code (mask 0x1C0). 0x08 STRANGE_MOOD stays set for EVERY mood, unchanged, so an old
// client (which masks only 0x08) keeps drawing row 9 and never sees these high bits. The code
// is 1-BASED so 0 == "no subtype / old DLL / non-overhead mood", which makes the fallback
// identical in both directions: a new client fed 0 falls back to STRANGE_MOOD's row-9 default,
// so server and client can deploy in either order. df mood_type (df.d_basics.xml): Fey=0
// Secretive=1 Possessed=2 Macabre=3 Fell=4. graphics_interface.txt rows: FEY_MOOD:9
// POSSESSED:10 SECRETIVE_MOOD:11 FELL_MOOD:12 MACABRE_MOOD:13.
constexpr int kUStatMoodShift = 6;                       // 0x40 -- low bit of the mood nibble
constexpr int kUStatMoodMask  = 0x7 << kUStatMoodShift;  // 0x1C0 -- 3-bit subtype field
constexpr int kUMoodNone      = 0;  // no subtype / old DLL / non-overhead mood -> client row-9 fallback
constexpr int kUMoodFey       = 1;  // -> UNIT_STATUS FEY_MOOD row 9
constexpr int kUMoodPossessed = 2;  // -> UNIT_STATUS POSSESSED row 10
constexpr int kUMoodSecretive = 3;  // -> UNIT_STATUS SECRETIVE_MOOD row 11
constexpr int kUMoodFell      = 4;  // -> UNIT_STATUS FELL_MOOD row 12
constexpr int kUMoodMacabre   = 5;  // -> UNIT_STATUS MACABRE_MOOD row 13

// ---------------------------------------------------------------------------
// WT31 -- the SECOND status word. Ships as the additive JSON int `st2` (only when non-zero).
// Bits start again at 0: this is a fresh word, not a continuation of `st`. See the banner above.
// ---------------------------------------------------------------------------
constexpr int kUStat2Migrant        = 0x00000001;  // row 0   misc_trait Migrant, value > 0
constexpr int kUStat2NoJob          = 0x00000002;  // row 1   idle adult citizen (isJobAvailable)
constexpr int kUStat2NoDestination  = 0x00000004;  // row 2   RESERVED -- server never sets it (P3)
constexpr int kUStat2Distracted     = 0x00000008;  // row 7   focus% <= 80, no mood (sel:188-198)
constexpr int kUStat2Terrified      = 0x00000010;  // row 22  emotionally_overloaded (NAMED-APPROX, R1)
constexpr int kUStat2Wrestling      = 0x00000020;  // row 23  status.wrestle_items vs a real opponent
constexpr int kUStat2MinorInjury    = 0x00000040;  // row 24  open wound, none severe
constexpr int kUStat2MajorInjury    = 0x00000080;  // row 25  open wound, at least one severe
constexpr int kUStat2MakeBelieve    = 0x00000100;  // row 33  activity_event_make_believest
constexpr int kUStat2TellingStory   = 0x00000200;  // row 34  performance role STORYTELLER or PREACHER (sel:130-132)
constexpr int kUStat2RecitingPoetry = 0x00000400;  // row 35  performance role POEM_RECITER
constexpr int kUStat2Performing     = 0x00000800;  // row 36  performance role MUSICAL_VOICE / DANCER

// All reads are plain field/bitfield accesses on the already-held unit -- callers invoke this
// under their EXISTING CoreSuspender hold; no map access, no new suspension. current_job is a
// plain pointer on the unit. Belt-and-braces: status icons never describe a non-living unit
// (ghosts pass both serializers' visibility filters but are not "alive" -> st stays 0), even
// if a caller's visibility filter changes in the future.
inline int unit_status_bits(df::unit* u) {
    if (!u || !DFHack::Units::isAlive(u)) return 0;
    int st = 0;
    // SLEEPING (row 8, sel:60-70). NAMED-APPROXIMATION. Native gates on counters.unconscious>0 AND
    // (current_job job_type==Sleep OR an occupied bed/hospital ref (unit+0x4d8) subtype in {0x17,0x32}).
    // Those ref subtypes are exactly job_type Sleep(0x17=23)/Rest(0x32=50), so the honest v1 predicate
    // is current_job job_type == Sleep OR Rest. Exact bed/building codes + the unconscious gate =
    // recording request R2.
    if (u->job.current_job
        && (u->job.current_job->job_type == df::job_type::Sleep
            || u->job.current_job->job_type == df::job_type::Rest))
        st |= kUStatSleeping;
    if (u->counters.unconscious > 0)   st |= kUStatUnconscious;
    // STRESSED bubble (row 6, sel:184). EXACT. The overhead droplet fires on the RAW stress
    // accumulator personality.stress >= 10000 (NOT longterm_stress, which is the unit-sheet field),
    // gated on no active mood/soldier_mood (mood==-1 && soldier_mood==-1). See kUStatBubbleStress.
    if (df::unit_soul* stress_soul = u->status.current_soul)
        if (stress_soul->personality.stress >= kUStatBubbleStress
            && u->mood == df::mood_type::None
            && u->counters.soldier_mood == df::soldier_mood_type::None)
            st |= kUStatStressed;
    // WT30 physical counters (plain int fields; same semantics DFHack reads for skill penalties).
    // WINDED (row 29, sel:159): NAMED-APPROXIMATION. Native = winded>0 AND NOT flags1.drowning (0x20);
    // the drowning split is exact. WINDED is an ORDINARY-ladder row (shown in the >=5001 phase
    // window); the physical sub-window group is exactly rows 37/38/39/40 (see finding 2, selector
    // 0x1402685d0). Cadence is client-side.
    if (u->counters.winded > 0 && !u->flags1.bits.drowning) st |= kUStatWinded;
    // STUNNED (row 27, sel:156): EXACT. Native = counters.stunned>0 OR counters.dizziness>0.
    if (u->counters.stunned > 0 || u->counters.dizziness > 0) st |= kUStatStunned;
    if (u->counters.nausea > 0)        st |= kUStatNausea;
    // WEBBED (row 39, sel:44): NAMED-APPROXIMATION. Native boundary is > 9 (>=10), not > 0; native
    // only shows it inside the per-unit physical sub-window (cadence not modeled here).
    if (u->counters.webbed > 9)        st |= kUStatWebbed;
    // PARALYZED (row 26, sel:78): EXACT. Native boundary is >= 100 (full paralysis), not any nonzero.
    if (u->counters2.paralysis >= 100) st |= kUStatParalyzed;
    if (u->counters2.fever > 0)        st |= kUStatFevered;
    // WT30 physical flags.
    if (u->flags1.bits.on_ground)      st |= kUStatGrounded;
    if (u->flags1.bits.projectile)     st |= kUStatProjectile;
    // WT30 climbing: an active Climb movement action on the unit's action queue.
    for (df::unit_action* act : u->actions)
        if (act && act->type == df::unit_action_type::Climb) { st |= kUStatClimbing; break; }
    // WT30 insanity: read unit->mood DIRECTLY (NOT has_mood-gated). These three are exactly the
    // moods DFHack's Units::isSane treats as insane, and they never coincide with a strange mood
    // (a strange-mood unit has one of Fey/Secretive/Possessed/Macabre/Fell instead).
    switch (u->mood) {
        case df::mood_type::Melancholy: st |= kUStatMelancholy; break;
        case df::mood_type::Raving:     st |= kUStatMadness;    break;
        case df::mood_type::Berserk:    st |= kUStatBerserk;    break;
        default: break;
    }
    // WT30 soldier mood (counters.soldier_mood enum): the five combat/temperament trance states.
    switch (u->counters.soldier_mood) {
        case df::soldier_mood_type::MartialTrance: st |= kUStatMartialTrance; break;
        case df::soldier_mood_type::Enraged:       st |= kUStatEnraged;       break;
        case df::soldier_mood_type::Tantrum:       st |= kUStatTantrum;       break;
        case df::soldier_mood_type::Depressed:     st |= kUStatDepression;    break;
        case df::soldier_mood_type::Oblivious:     st |= kUStatOblivious;     break;
        default: break;
    }
    // WT30 graded needs, B248-corrected: ONE THRESHOLD PER NEED (a single flat cut is provably
    // wrong -- DF's three needs fire at very different points; see the constants above).
    if (u->counters2.hunger_timer     >= kUStatHungerTimer) st |= kUStatHungry;
    if (u->counters2.thirst_timer     >= kUStatThirstTimer) st |= kUStatThirsty;
    if (u->counters2.sleepiness_timer >= kUStatSleepTimer)  st |= kUStatDrowsy;
    if (u->flags1.bits.has_mood) {
        st |= kUStatStrangeMood;   // 0x08 stays set for EVERY mood (old-client contract)
        // WT29: also ship WHICH strange mood in the 0x1C0 subtype nibble. A mood with no
        // overhead cell (Melancholy/Raving/Berserk/Baby/Traumatized) or the None sentinel
        // leaves the code at 0 -> client falls back to FEY_MOOD's row 9 just like an old DLL.
        int mood_code = kUMoodNone;
        switch (u->mood) {
            case df::mood_type::Fey:       mood_code = kUMoodFey;       break;
            case df::mood_type::Possessed: mood_code = kUMoodPossessed; break;
            case df::mood_type::Secretive: mood_code = kUMoodSecretive; break;
            case df::mood_type::Fell:      mood_code = kUMoodFell;      break;
            case df::mood_type::Macabre:   mood_code = kUMoodMacabre;   break;
            default: break;
        }
        st |= (mood_code << kUStatMoodShift) & kUStatMoodMask;
    }
    if (u->flags1.bits.caged)          st |= kUStatCaged;
    if (u->flags1.bits.chained)        st |= kUStatChained;
    return st;
}

// WT31 -- the SECOND status word (`st2`). Same contract and same caller discipline as
// unit_status_bits: plain field reads plus DFHack-exported predicates on the already-held unit,
// under the caller's EXISTING CoreSuspender hold, and the same isAlive() belt-and-braces so a ghost
// never badges. Every branch short-circuits on a cheap emptiness/flag test BEFORE any vector walk,
// because this runs for every visible unit on every frame:
//   * the NO_JOB half runs only when current_job is already null,
//   * the TERRIFIED emotion walk runs only when DF has raised emotionally_overloaded,
//   * the wound / wrestle walks are guarded by .empty().
inline int unit_status_bits2(df::unit* u) {
    if (!u || !DFHack::Units::isAlive(u)) return 0;
    int st2 = 0;

    // MIGRANT (row 0) -- DF's own misc_trait, decremented away as the migrant settles in.
    if (df::unit_misc_trait* mt = DFHack::Units::getMiscTrait(u, df::misc_trait_type::Migrant, false))
        if (mt->value > 0) st2 |= kUStat2Migrant;

    // NO_JOB (row 1) -- an IDLE adult citizen. current_job first (the cheap screen), then DFHack's
    // own "can this unit be assigned a job" predicate, which also rules out a dwarf who is busy in a
    // conversation / drill / squad order despite holding no job.
    if (!u->job.current_job
        && DFHack::Units::isCitizen(u)
        && DFHack::Units::isAdult(u)
        && DFHack::Units::isJobAvailable(u, false))
        st2 |= kUStat2NoJob;

    // NO_DESTINATION (row 2) -- RESERVED, intentionally NOT set. See the banner: two incompatible
    // readings survive the df-structures dig and the pause-only state cannot separate them. Probe P3
    // decides; enabling it is then a one-line change here.

    df::unit_soul* soul = u->status.current_soul;

    // DISTRACTED (row 7, sel:188-198). EXACT -- and the fix for the mass false-yellow-face symptom.
    // Native IGNORES has_unmet_needs entirely (that flag is true for most of a working fort, which
    // is why the old read badged everyone). Instead it recomputes focus (FUN_140e25ab0) and fires
    // when the aggregate focus RATIO current_focus*100/undistracted_focus <= 80 (native: iVar16 <
    // 0x51), gated on no active mood/soldier_mood. undistracted_focus < 1 -> ratio forced to 100
    // (never distracted), matching the native (soul+0x3d0 < 1) guard.
    if (soul
        && u->mood == df::mood_type::None
        && u->counters.soldier_mood == df::soldier_mood_type::None) {
        const int32_t undistracted = soul->personality.undistracted_focus;
        const int32_t focus_pct = undistracted < 1
            ? 100
            : (soul->personality.current_focus * 100) / undistracted;
        if (focus_pct <= 80) st2 |= kUStat2Distracted;
    }

    // TERRIFIED (row 22, sel:262-284). NAMED-APPROXIMATION (R1). Native reaches row 22 as the DEFAULT
    // of the mood switch, entered when (mood not in {-1,8}) OR flags3.emotionally_overloaded, with NO
    // emotion-type inspection. The prior dominant-emotion==TERROR walk was INVENTED and is removed.
    // Shipped default fires on emotionally_overloaded alone; set kUStat2TerrifiedApproxEnabled=false
    // to DISABLE the bubble instead (the reviewer's other honest option). See the toggle above.
    if (kUStat2TerrifiedApproxEnabled && u->flags3.bits.emotionally_overloaded)
        st2 |= kUStat2Terrified;

    // WRESTLING (row 23) -- a live grapple relationship against a real opponent unit. `unit == -1`
    // rows describe an item grab rather than a creature grapple, so they are screened out.
    for (const auto& w : u->status.wrestle_items) {
        if (w && w->unit != -1) { st2 |= kUStat2Wrestling; break; }
    }

    // MINOR / MAJOR_INJURY (rows 24 / 25) -- graded off the TRANSIENT wound vector (wounds are
    // removed as they heal), never off the permanent body_part_status flags. Mutually exclusive.
    if (!u->body.wounds.empty()) {
        bool severe = false;
        for (df::unit_wound* w : u->body.wounds) {
            if (!w) continue;
            if (w->flags.bits.severed_part || w->flags.bits.popped_out || w->flags.bits.infection) {
                severe = true; break;
            }
            for (df::unit_wound_layerst* p : w->parts) {
                if (!p) continue;
                if (p->flags1.bits.major_artery || p->flags1.bits.guts_spilled
                    || p->flags1.bits.compound_fracture) { severe = true; break; }
            }
            if (severe) break;
        }
        st2 |= severe ? kUStat2MajorInjury : kUStat2MinorInjury;
    }

    // PERFORMANCE set (rows 33..36) -- the unit's main social event. Spectators badge nothing.
    if (df::activity_event* ev = DFHack::Units::getMainSocialEvent(u)) {
        const df::activity_event_type et = ev->getType();
        if (et == df::activity_event_type::MakeBelieve) {
            st2 |= kUStat2MakeBelieve;
        } else if (et == df::activity_event_type::Performance) {
            if (auto* perf = virtual_cast<df::activity_event_performancest>(ev)) {
                for (df::performance_rolest* role : perf->participant_actions) {
                    if (!role || role->unit_id != u->id) continue;
                    switch (role->type) {
                        // PREACHER (role 6) maps to row 34 TELLING_A_STORY, same as STORYTELLER
                        // (role 0): sel:130-132, native role 6 and role 0 both return 0x22. EXACT.
                        case df::performance_participant_type::PREACHER:
                        case df::performance_participant_type::STORYTELLER:
                            st2 |= kUStat2TellingStory;   break;
                        case df::performance_participant_type::POEM_RECITER:
                            st2 |= kUStat2RecitingPoetry; break;
                        case df::performance_participant_type::MUSICAL_VOICE:
                        case df::performance_participant_type::DANCER:
                            st2 |= kUStat2Performing;     break;
                        default: break;  // SPECTATOR / INCIDENTAL_SPECTATOR -> no bubble
                    }
                    break;  // a unit holds at most one role in a performance
                }
            }
        }
    }
    return st2;
}
