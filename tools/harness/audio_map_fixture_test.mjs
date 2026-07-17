// audio_map_fixture_test.mjs -- OFFLINE fixture test for the PURE logic in
// web/js/dwf-audio.js (spec 2026-07-09-audio-director-spec.md). No browser, no DF, no
// server: the module CommonJS-exports its pure core behind `typeof module`, so a require pulls
// the REAL functions without running any DOM/AudioContext code.
//
// Covers: the stinger + track tables against the AUTHORITATIVE raws
// (data/vanilla/vanilla_music/objects/{sound,music}_standard.txt), the DIRECTOR schedule math
// (musicPlan gap/play cycle, circularDeltaMs wrap-straddle regression), the budgeted+hysteretic
// ambience reducer (ambienceCandidates/ambienceStep/ambienceDesired), soundUrl and the mix codec.
//
//   node tools/harness/audio_map_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-audio.js");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

// node --check syntax gate on the real module.
try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-audio.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

const A = require(modPath);
check("module exports the pure core",
  ["soundUrl", "stingerForType", "trackList", "trackFullUrl", "trackLabel", "autoMusicTrack",
   "musicPlan", "circularDeltaMs", "ambienceCandidates", "ambienceStep", "ambienceDesired",
   "baseAmbience", "uiClickUrl", "decodeMix", "encodeMix"].every(k => typeof A[k] === "function"));
const C = A.DIRECTOR_CONST;
check("director constants exported", C && C.GAP_MS > 0 && C.DRIFT_TOLERANCE_MS >= 10000);

// ---------------- soundUrl: per-segment encoding, '/' preserved ----------------
console.log("\n# soundUrl");
check("plain path", A.soundUrl("sounds/megabeast.ogg") === "/sound/sounds/megabeast.ogg");
check("'&' in a dir is percent-encoded",
  A.soundUrl("tracks/drink_&_industry/DI_Full.ogg") === "/sound/tracks/drink_%26_industry/DI_Full.ogg");
check("'!' in a dir is percent-encoded",
  A.soundUrl("tracks/strike_the_earth!/STE_1.ogg") === "/sound/tracks/strike_the_earth!/STE_1.ogg" ||
  A.soundUrl("tracks/strike_the_earth!/STE_1.ogg") === "/sound/tracks/strike_the_earth%21/STE_1.ogg");
check("null-safe", A.soundUrl(null) === null && A.soundUrl(42) === null);

// ---------------- stingerForType: the AUTHORITATIVE 16-key ANNOUNCEMENT matrix ----------------
// Oracle transcribed from data/vanilla/vanilla_music/objects/sound_standard.txt: every
// [SOUND:x]{[ANNOUNCEMENT:k]...} -> sounds/<lowercased x>.ogg. All 16 keys verified present in
// df/announcement_type.h; all 10 target files verified present in data/sound/sounds/.
console.log("\n# stingerForType (full 16-key sound_standard.txt oracle)");
const STINGER_ORACLE = {
  STRUCK_DEEP_METAL: "sounds/adamantine.ogg",
  AMBUSH_THIEF_SUPPORT_SKULKING: "sounds/ambush.ogg",
  AMBUSH_THIEF_SUPPORT_NATURE: "sounds/ambush.ogg",
  AMBUSH_THIEF_SUPPORT: "sounds/ambush.ogg",
  AMBUSH_SNATCHER_SUPPORT: "sounds/ambush.ogg",
  AMBUSH_AMBUSHER_NATURE: "sounds/ambush.ogg",
  AMBUSH_AMBUSHER: "sounds/ambush.ogg",
  MADE_ARTIFACT: "sounds/artifact_created.ogg",
  BIRTH_CITIZEN: "sounds/baby_born.ogg",
  FEATURE_DISCOVERY: "sounds/cavern_break.ogg",
  ENDGAME_EVENT_2: "sounds/demon_attack.ogg",
  MEGABEAST_ARRIVAL: "sounds/megabeast.ogg",
  WEREBEAST_ARRIVAL: "sounds/megabeast.ogg",
  UNDEAD_ATTACK: "sounds/siege.ogg",
  STRANGE_MOOD: "sounds/strange_mood.ogg",
  MARRIAGE: "sounds/wedding.ogg",
};
check("map has EXACTLY the 16 oracle keys (no missing, no extra)",
  Object.keys(A.STINGER_MAP).length === 16 &&
  Object.keys(STINGER_ORACLE).every(k => A.STINGER_MAP[k] === STINGER_ORACLE[k]),
  `got ${Object.keys(A.STINGER_MAP).length} keys`);
for (const [k, file] of Object.entries(STINGER_ORACLE)) {
  check(`${k} -> ${file}`, A.stingerForType(k) === "/sound/" + file);
}
// TEST-THE-TEST: a key that DF really emits but is NOT a stinger must NOT fire, and a garbage
// key must NOT fire. (If the map fell back to a default sound, these would return non-null.)
guard("COMBAT (real enum key, no stinger) -> null", A.stingerForType("COMBAT") === null);
guard("JOB_FAILED (real enum key, no stinger) -> null", A.stingerForType("JOB_FAILED") === null);
guard("garbage key -> null", A.stingerForType("NOT_A_REAL_KEY") === null);
guard("non-string -> null", A.stingerForType(null) === null && A.stingerForType(7) === null);

// ---------------- trackList / trackFullUrl ----------------
console.log("\n# track catalog");
const tl = A.trackList();
check("playlist non-empty + shaped {key,label,url}",
  Array.isArray(tl) && tl.length >= 15 && tl[0].key && tl[0].label && tl[0].url);
check("winter track resolves to WEY_Full",
  A.trackFullUrl("winter_entombs_you") === "/sound/tracks/winter_entombs_you/WEY_Full.ogg");
check("unknown track key -> null", A.trackFullUrl("nope") === null);

// ---------------- autoMusicTrack: REFERENCE rule the SERVER mirrors (music_standard.txt) --------
// Not the playback driver (the server owns the canonical decision), but it must stay BYTE-for-
// byte the priority in src/music_sync.h::select_auto_track so the two never diverge.
console.log("\n# autoMusicTrack (reference rule; must match server select_auto_track)");
check("winter season -> winter_entombs_you", A.autoMusicTrack({ season: 3 }, {}) === "winter_entombs_you");
check("siege overrides winter -> vile_force_of_darkness",
  A.autoMusicTrack({ season: 3, siege: true }, {}) === "vile_force_of_darkness");
check("first year -> first_year", A.autoMusicTrack({ season: 1 }, { firstYear: true }) === "first_year");
check("second-year+ -> another_year", A.autoMusicTrack({ season: 1 }, { firstYear: false }) === "another_year");
check("baseline (unknown year, no season) -> hill_dwarf (MAIN)",
  A.autoMusicTrack({}, {}) === "hill_dwarf");
guard("siege beats winter (top priority)",
  A.autoMusicTrack({ siege: true, season: 3 }, { firstYear: true }) === "vile_force_of_darkness");
guard("winter beats firstYear", A.autoMusicTrack({ season: 3 }, { firstYear: true }) === "winter_entombs_you");
guard("summer does NOT pick winter", A.autoMusicTrack({ season: 1 }, {}) !== "winter_entombs_you");
console.log("\n# trackLabel");
check("label resolves", A.trackLabel("winter_entombs_you") === "Winter Entombs You");
check("unknown key -> echoes key", A.trackLabel("zzz") === "zzz");
check("all 17 track keys valid", Object.keys(A.TRACKS).length === 17 &&
  A.isValidTrack("song_game") && !A.isValidTrack("nope"));

// ---------------- musicPlan: the deterministic play/silence schedule (spec §3.1) ----------------
console.log("\n# musicPlan (sparse schedule math)");
const DUR = 282700;             // FY_Full.ogg, the live-measured duration
const GAP = C.GAP_MS;
const CYCLE = DUR + GAP;
{
  const p = A.musicPlan(5000, DUR, false);
  check("early elapsed -> play at elapsed", p.mode === "play" && p.posMs === 5000 && p.cycleMs === CYCLE);
}
{
  const p = A.musicPlan(DUR + 1000, DUR, false);
  check("elapsed just past dur -> gap", p.mode === "gap" && p.cycleMs === CYCLE);
  check("gap reports time to resume", Math.abs(p.resumeInMs - (GAP - 1000)) < 1);
}
{
  const p = A.musicPlan(CYCLE + 42, DUR, false);   // second cycle
  check("cycle wrap -> play near 0", p.mode === "play" && Math.abs(p.posMs - 42) < 1);
}
{
  // the live-observed server state: first_year at elapsed 2,400,700 ms
  const p = A.musicPlan(2400700, DUR, false);
  const phase = 2400700 % CYCLE;
  check("late joiner lands mid-cycle deterministically",
    (phase < DUR) === (p.mode === "play"), `phase=${phase}`);
}
{
  const p = A.musicPlan(DUR + 1000, DUR, true);
  check("MANUAL mode never gaps (host jukebox)", p.mode === "play" && p.cycleMs === DUR);
  check("manual wraps modulo dur", Math.abs(p.posMs - 1000) < 1);
}
{
  const p = A.musicPlan(999999, null, false);
  check("pre-metadata (dur unknown) -> play, cycle null (placed at loadedmetadata)",
    p.mode === "play" && p.cycleMs === null && p.posMs === 999999);
}
guard("negative/garbage elapsed treated as 0",
  A.musicPlan(-5, DUR, false).posMs === 0 && A.musicPlan(NaN, DUR, false).posMs === 0);
guard("determinism: same inputs -> same plan (lockstep across clients)", (() => {
  const a = A.musicPlan(1234567, DUR, false), b = A.musicPlan(1234567, DUR, false);
  return a.mode === b.mode && a.posMs === b.posMs;
})());

// ---------------- circularDeltaMs: the wrap-straddle regression (spec §1 S2) ----------------
console.log("\n# circularDeltaMs (wrap-straddle fix)");
check("plain distance inside the cycle", A.circularDeltaMs(10000, 14000, CYCLE) === 4000);
// THE observed live regression: element ct=282.4s, server phase=0.1s, dur 282.7s (manual cycle).
// Old code read |282400-100| = 282300 ms "drift" and seeked; true circular error is 400 ms.
check("observed straddle (ct 282.4s vs phase 0.1s) reads as 400ms, not 282.3s",
  A.circularDeltaMs(282400, 100, DUR) === 400);
check("symmetric", A.circularDeltaMs(100, 282400, DUR) === 400);
check("straddle in AUTO cycle: end-of-track vs cycle-start = the gap-width error (real desync)",
  A.circularDeltaMs(282400, 100, CYCLE) === Math.min(282300, CYCLE - 282300));
check("no cycle -> raw distance", A.circularDeltaMs(5000, 1000, null) === 4000);
guard("a true large desync still reads large",
  A.circularDeltaMs(0, DUR / 2, DUR) === DUR / 2);

// ---------------- ambienceCandidates: budgeted layers (spec §3.2) ----------------
console.log("\n# ambienceCandidates (1 bed + 1 feature + 1 weather; danger override)");
const layers = v => Object.fromEntries(A.ambienceCandidates(v).map(c => [c.layer, c.url]));
check("empty view -> no candidates (silence)", A.ambienceCandidates({}).length === 0);
check("underground -> Cavern bed", layers({ cavern: true }).bed === "/sound/ambience/Cavern.ogg");
check("neutral surface -> Outside bed", layers({ outside: true, evil: 1 }).bed === "/sound/ambience/Outside.ogg");
check("evil surface -> Evil bed", layers({ outside: true, evil: 2 }).bed === "/sound/ambience/Evil.ogg");
check("evil+savage -> Terrifying", layers({ outside: true, evil: 2, savage: true }).bed === "/sound/ambience/Terrifying.ogg");
check("good surface -> Good", layers({ outside: true, evil: 0 }).bed === "/sound/ambience/Good.ogg");
check("workshop -> Workshop feature", layers({ workshop: true }).feature === "/sound/ambience/Workshop.ogg");
check("magma near beats workshop (weight)", layers({ workshop: true, magmaDist: 3 }).feature === "/sound/ambience/Magma_Close.ogg");
check("magma mid -> Magma_Far", layers({ magmaDist: 12 }).feature === "/sound/ambience/Magma_Far.ogg");
check("magma distant -> Magma_Low", layers({ magmaDist: 40 }).feature === "/sound/ambience/Magma_Low.ogg");
check("river high flow -> River_High", layers({ riverFlow: 6 }).feature === "/sound/ambience/River_High.ogg");
check("river mid flow -> River_Medium", layers({ riverFlow: 3 }).feature === "/sound/ambience/River_Medium.ogg");
check("river low flow -> River_Low", layers({ riverFlow: 1 }).feature === "/sound/ambience/River_Low.ogg");
check("snow -> Blizzard weather layer", layers({ weather: 2 }).weather === "/sound/ambience/Blizzard.ogg");
check("rain -> Thunderstorm", layers({ weather: 1, season: 1 }).weather === "/sound/ambience/Thunderstorm.ogg");
check("rain+winter -> Blizzard", layers({ weather: 1, season: 3 }).weather === "/sound/ambience/Blizzard.ogg");
// THE BUDGET (the "all at once" regression, M2): everything on at once -> exactly 3 candidates.
const heavy = { workshop: true, tradeDepot: true, magmaDist: 2, riverFlow: 6, outside: true, weather: 1, season: 1 };
check("heavy view -> EXACTLY one feature (top weight wins)", (() => {
  const cs = A.ambienceCandidates(heavy);
  return cs.filter(c => c.layer === "feature").length === 1 &&
         layers(heavy).feature === "/sound/ambience/Magma_Close.ogg";
})());
check("heavy view -> at most 3 candidates total (bed+feature+weather)",
  A.ambienceCandidates(heavy).length === 3);
check("siege danger override -> only Siege + weather", (() => {
  const cs = A.ambienceCandidates({ siege: true, workshop: true, magmaDist: 1, outside: true, weather: 1, season: 1 });
  return cs.length === 2 && cs.some(c => c.url === "/sound/ambience/Siege.ogg" && c.layer === "danger") &&
         !cs.some(c => /Workshop|Magma/.test(c.url));
})());
check("ambience gains sit under music (all <= 0.9, bed 0.35)", (() => {
  const cs = A.ambienceCandidates(heavy);
  return cs.every(c => c.gain <= 0.9) && cs.find(c => c.layer === "bed").gain === 0.35;
})());
guard("no magmaDist -> no magma loop at all",
  !A.ambienceCandidates({ cavern: true }).some(c => /Magma/.test(c.url)));
guard("neutral surface is not Good/Evil", (() => {
  const cs = A.ambienceCandidates({ outside: true, evil: 1 });
  return !cs.some(c => /Good|Evil/.test(c.url));
})());

// ---------------- ambienceStep: hysteresis reducer (spec §3.2, kills churn M3) ----------------
console.log("\n# ambienceStep (per-layer hysteresis)");
const cavernBed = [{ url: "/sound/ambience/Cavern.ogg", gain: 0.35, layer: "bed" }];
const workshopFeat = cavernBed.concat([{ url: "/sound/ambience/Workshop.ogg", gain: 0.5, layer: "feature" }]);
{
  let st = null;
  st = A.ambienceStep(st, cavernBed);
  check("scan 1: new bed NOT yet active (needs 2 scans)", A.ambienceDesired(st)["/sound/ambience/Cavern.ogg"] == null);
  st = A.ambienceStep(st, cavernBed);
  check("scan 2: bed fades in", A.ambienceDesired(st)["/sound/ambience/Cavern.ogg"] === 0.35);
  // a 1-scan flicker of a feature must NOT enter
  st = A.ambienceStep(st, workshopFeat);
  st = A.ambienceStep(st, cavernBed);
  check("1-scan feature flicker never enters", A.ambienceDesired(st)["/sound/ambience/Workshop.ogg"] == null);
  // a persistent feature enters after 2 scans
  st = A.ambienceStep(st, workshopFeat);
  st = A.ambienceStep(st, workshopFeat);
  check("persistent feature enters", A.ambienceDesired(st)["/sound/ambience/Workshop.ogg"] === 0.5);
  // absence must persist OUT_SCANS before the loop drops
  st = A.ambienceStep(st, cavernBed);
  st = A.ambienceStep(st, cavernBed);
  check("2-scan absence keeps the loop (no churn)", A.ambienceDesired(st)["/sound/ambience/Workshop.ogg"] === 0.5);
  st = A.ambienceStep(st, cavernBed);
  check("3-scan absence drops it", A.ambienceDesired(st)["/sound/ambience/Workshop.ogg"] == null);
  check("bed survives throughout", A.ambienceDesired(st)["/sound/ambience/Cavern.ogg"] === 0.35);
}
{
  // danger enters in ONE scan and force-clears bed+feature
  let st = null;
  st = A.ambienceStep(st, workshopFeat);
  st = A.ambienceStep(st, workshopFeat);
  const siege = [{ url: "/sound/ambience/Siege.ogg", gain: 0.9, layer: "danger" }];
  st = A.ambienceStep(st, siege);
  const des = A.ambienceDesired(st);
  check("siege enters in one scan", des["/sound/ambience/Siege.ogg"] === 0.9);
  check("siege force-clears bed+feature immediately",
    des["/sound/ambience/Cavern.ogg"] == null && des["/sound/ambience/Workshop.ogg"] == null);
  guard("budget after siege = danger only", Object.keys(des).length === 1);
}
{
  // the "all at once" regression cell: desired set NEVER exceeds 3 urls, whatever the sequence
  let st = null;
  const seqs = [A.ambienceCandidates(heavy), A.ambienceCandidates({ ...heavy, weather: 2 }),
    A.ambienceCandidates({ ...heavy, magmaDist: null }), A.ambienceCandidates(heavy)];
  let maxN = 0;
  for (let i = 0; i < 24; i++) {
    st = A.ambienceStep(st, seqs[i % seqs.length]);
    maxN = Math.max(maxN, Object.keys(A.ambienceDesired(st)).length);
  }
  check("desired set never exceeds 3 loops under churny sequences (M2 regression)", maxN <= 3, `max=${maxN}`);
}

// ---------------- decodeMix / encodeMix (persistence codec) ----------------
console.log("\n# mix codec");
const d = A.decodeMix(null);
check("defaults: music 0.85, rest 1, unmuted",
  d.master === 1 && d.music === 0.85 && d.ambient === 1 && d.sfx === 1 && d.ui === 1 && d.muted === false);
check("UI clicks default OFF", d.uiClicks === false && A.decodeMix({}).uiClicks === false);
check("UI clicks opt-in round-trips", A.decodeMix(A.encodeMix({ uiClicks: true })).uiClicks === true);
check("clamps out-of-range", (() => { const m = A.decodeMix({ master: 5, music: -3 }); return m.master === 1 && m.music === 0; })());
check("coerces muted string/num", A.decodeMix({ muted: "true" }).muted === true && A.decodeMix({ muted: 1 }).muted === true);
check("round-trip stable", (() => {
  const s = A.encodeMix({ master: 0.5, music: 0.2, ambient: 0.9, sfx: 0.1, ui: 0.3, muted: true });
  const back = A.decodeMix(s);
  return back.master === 0.5 && back.music === 0.2 && back.muted === true;
})());
guard("garbage JSON string -> defaults (never throws)", (() => {
  const m = A.decodeMix("{not json");
  return m.music === 0.85 && m.muted === false;
})());

// ---------------- uiClickUrl ----------------
console.log("\n# uiClickUrl");
check("generic click rotates within its set",
  A.uiClickUrl("click", 0) === "/sound/audio/ui/clicks/generic/click-001.ogg" &&
  A.uiClickUrl("click", 1) === "/sound/audio/ui/clicks/generic/click-002.ogg" &&
  A.uiClickUrl("click", 2) === A.uiClickUrl("click", 0));
check("confirm click resolves", A.uiClickUrl("confirm", 0) === "/sound/audio/ui/clicks/confirm/click-001.ogg");

console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
