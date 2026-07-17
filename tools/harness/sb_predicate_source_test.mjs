// sb_predicate_source_test.mjs -- native-table SERVER predicate pins for src/unit_status.h. This is
// the C++ side of the fixtures: nativePredicate (sb_predicate_ref.mjs) is a JS mirror of the table;
// these regexes prove the shipped C++ uses the SAME fields + boundaries, so the two cannot drift.
// Run: node tools/harness/sb_predicate_source_test.mjs
//
// POST-MERGE-ONLY: these predicates live on the sb-server branch. On the bare base src/unit_status.h
// still has the invented rules (has_unmet_needs distraction, stress-level bubble, paralysis>0, no
// dizziness/Rest), so this suite is RED until the server branch merges -- by design. Each pin cites
// the table row it enforces. Disjoint from wt30 §6 / wt29 §8 / b222 (the server branch's own pins).

import assert from "node:assert/strict";
import { read } from "./sb_renderers.mjs";

const S = read("src", "unit_status.h");
const pin = (re, why) => assert.match(S, re, `unit_status.h: ${why}`);
const forbid = (re, why) => assert.doesNotMatch(S, re, `unit_status.h: ${why}`);

// ---- constants (table boundaries) --------------------------------------------------------------
pin(/kUStatBubbleStress\s*=\s*10000/, "STRESSED bubble threshold = raw stress >= 10000 (sel:184)");
pin(/kUStatStressLevel\s*=\s*20000/, "kUStatStressLevel = 20000 stays as the unit-SHEET anchor (NOT the bubble)");
pin(/kUStat2TerrifiedApproxEnabled\s*=\s*true/, "TERRIFIED ships as an explicit named-approximation toggle (R1)");
pin(/kUStatHungerTimer\s*=\s*50000/, "hunger threshold 50000");
pin(/kUStatThirstTimer\s*=\s*25000/, "thirst threshold 25000");
pin(/kUStatSleepTimer\s*=\s*57600/, "sleepiness threshold 57600");

// ---- danger-tier boundary corrections ----------------------------------------------------------
pin(/counters2\.paralysis\s*>=\s*100\)\s*st \|= kUStatParalyzed/, "PARALYZED requires full paralysis >= 100 (sel:78)");
pin(/counters\.stunned\s*>\s*0\s*\|\|\s*u->counters\.dizziness\s*>\s*0\)\s*st \|= kUStatStunned/, "STUNNED covers the dizziness branch (sel:156)");
pin(/counters\.winded\s*>\s*0\s*&&\s*!u->flags1\.bits\.drowning\)\s*st \|= kUStatWinded/, "WINDED gains the !drowning split (sel:159)");
pin(/counters\.webbed\s*>\s*9\)\s*st \|= kUStatWebbed/, "WEBBED native boundary is > 9 (sel:44)");

// ---- SLEEPING: Sleep OR Rest (v1 named-approx, R2) ----------------------------------------------
pin(/job_type::Sleep[\s\S]{0,80}?job_type::Rest[\s\S]{0,40}?st \|= kUStatSleeping/, "SLEEPING = job_type Sleep OR Rest (sel:60-70)");

// ---- STRESSED bubble: raw personality.stress, NOT longterm_stress ------------------------------
pin(/personality\.stress\s*>=\s*kUStatBubbleStress[\s\S]{0,240}?st \|= kUStatStressed/, "STRESSED bubble fires on raw personality.stress >= 10000, gated on no mood (sel:184)");
pin(/personality\.stress\s*>=\s*kUStatBubbleStress[\s\S]{0,240}?soldier_mood == df::soldier_mood_type::None/, "STRESSED bubble self-gated on mood==None && soldier_mood==None (sel:184)");

// ---- DISTRACTED: aggregate focus RATIO <= 80, NOT has_unmet_needs ------------------------------
pin(/current_focus\s*\*\s*100\)\s*\/\s*undistracted/, "DISTRACTED uses the focus RATIO current_focus*100/undistracted (sel:188-198)");
pin(/undistracted\s*<\s*1/, "DISTRACTED: undistracted_focus < 1 forces the ratio to 100 (never distracted)");
pin(/focus_pct\s*<=\s*80\)\s*st2 \|= kUStat2Distracted/, "DISTRACTED fires when focus% <= 80");
forbid(/has_unmet_needs\)\s*st2 \|= kUStat2Distracted/, "the mass-yellow has_unmet_needs DISTRACTED predicate is GONE");

// ---- TERRIFIED: emotionally_overloaded alone (named-approx), no emotion-type walk --------------
pin(/kUStat2TerrifiedApproxEnabled\s*&&\s*u->flags3\.bits\.emotionally_overloaded[\s\S]{0,60}?st2 \|= kUStat2Terrified/, "TERRIFIED fires on emotionally_overloaded alone, behind the approx toggle (R1)");
forbid(/emotion_type::TERROR\)\s*st2 \|= kUStat2Terrified/, "the invented dominant-emotion==TERROR walk is REMOVED");

// ---- PREACHER (role 6) -> row 34 TELLING_A_STORY -----------------------------------------------
pin(/performance_participant_type::PREACHER:[\s\S]{0,120}?kUStat2TellingStory/, "PREACHER role maps to row 34 TELLING_A_STORY (sel:130-132)");

// ---- needs still graded per-timer (unchanged, verify intact) -----------------------------------
pin(/hunger_timer\s*>=\s*kUStatHungerTimer\)\s*st \|= kUStatHungry/, "HUNGRY graded on hunger_timer");
pin(/thirst_timer\s*>=\s*kUStatThirstTimer\)\s*st \|= kUStatThirsty/, "THIRSTY graded on thirst_timer");
pin(/sleepiness_timer\s*>=\s*kUStatSleepTimer\)\s*st \|= kUStatDrowsy/, "DROWSY graded on sleepiness_timer");

console.log("sb_predicate_source_test: PASS (src/unit_status.h implements the native predicate table: " +
  "focus-ratio DISTRACTED, raw-stress bubble, paralysis>=100, +dizziness, Sleep|Rest, WINDED !drowning, " +
  "WEBBED>9, PREACHER->34, emotionally_overloaded TERRIFIED approx)");
