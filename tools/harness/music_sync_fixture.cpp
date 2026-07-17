// music_sync_fixture.cpp -- OFFLINE proof of the SERVER-AUTHORITATIVE music sync DECISION logic
// (PARITY V2 correction #1), completeness rules 1-3.
//
// Includes the REAL header-only pure functions from src/music_sync.h (select_auto_track,
// advance_auto, set_manual, set_auto, state_json, is_valid_track) -- NOT a mirror -- and drives
// the whole SYNC MATRIX with a SEEDED clock (no real time, no DF, no httplib):
//   { host, non-host, late-join, host-leaves, track-end, siege-interrupt } -> ONE canonical state.
// Plus SEEDED-BAD cases (rule 3, "test the test").
//
// ZERO DF / httplib contact: music_sync.h forward-declares httplib::Server only for the register
// decl; the pure functions used here need <string>/<cstdint> only. The runtime wrappers
// (now_ms/frame_json/apply_*) are declared-not-defined here -- never called -- so no link need.
//
// Build+run (from repo root; any C++17 compiler):
//   cl /std:c++17 /EHsc /I src /Fe:musicfix.exe tools\harness\music_sync_fixture.cpp && musicfix.exe
//   g++ -std=c++17 -O2 -I src -o musicfix tools/harness/music_sync_fixture.cpp && ./musicfix
// Exit: 0 all pass, 1 any fail.

#include "music_sync.h"

#include <cstdio>
#include <string>

using dwf::music::select_auto_track;
using dwf::music::advance_auto;
using dwf::music::set_manual;
using dwf::music::set_auto;
using dwf::music::state_json;
using dwf::music::is_valid_track;
using dwf::music::State;

static int g_pass = 0, g_fail = 0;
static void ok(bool cond, const char* what) {
    if (cond) { ++g_pass; std::printf("  ok   - %s\n", what); }
    else      { ++g_fail; std::printf("  FAIL - %s\n", what); }
}

int main() {
    // ---- select_auto_track: DF music_standard.txt priority (siege>winter>firstYear>another>MAIN) --
    std::printf("# select_auto_track (context priority; mirrors dwf-audio.js autoMusicTrack)\n");
    ok(select_auto_track(false, 1, -1) == "hill_dwarf", "summer, unknown year -> MAIN hill_dwarf");
    ok(select_auto_track(false, 3, -1) == "winter_entombs_you", "winter -> winter_entombs_you");
    ok(select_auto_track(true, 3, 1) == "vile_force_of_darkness", "siege overrides everything");
    ok(select_auto_track(false, 1, 1) == "first_year", "first year -> first_year");
    ok(select_auto_track(false, 1, 0) == "another_year", "established -> another_year");
    // TEST-THE-TEST: winter must NOT win when a siege is active; summer must NOT pick winter.
    ok(select_auto_track(true, 3, -1) != "winter_entombs_you", "(ttt) siege is not winter");
    ok(select_auto_track(false, 1, -1) != "winter_entombs_you", "(ttt) summer is not winter");

    // ---- SYNC MATRIX: advance_auto / set_manual / set_auto with a SEEDED clock -------------------
    std::printf("\n# sync matrix (seeded clock)\n");
    // AUTO baseline: first advance from a default state at t=1000.
    State s0; s0.track = "hill_dwarf"; s0.start_ms = 1000; s0.manual = false;

    // (a) stable selection keeps its start (elapsed keeps counting up -- non-host / late-join read
    //     the SAME growing elapsed, so two tabs are in lockstep).
    State s1 = advance_auto(s0, "hill_dwarf", 5000);
    ok(s1.track == "hill_dwarf" && s1.start_ms == 1000 && !s1.manual,
       "stable auto selection keeps start_ms (no reset)");

    // (b) SIEGE-INTERRUPT: an auto selection change resets start at the change instant.
    State s2 = advance_auto(s1, "vile_force_of_darkness", 8000);
    ok(s2.track == "vile_force_of_darkness" && s2.start_ms == 8000 && !s2.manual,
       "siege-interrupt: track swaps + start resets to now");

    // (c) HOST: manual override takes control (start resets so everyone restarts together).
    State s3 = set_manual("mountainhome", 9000);
    ok(s3.track == "mountainhome" && s3.start_ms == 9000 && s3.manual,
       "host set_manual -> manual state everyone hears");

    // (d) HOST-LEAVES / manual persistence: an auto trigger (even a siege) does NOT override manual.
    State s4 = advance_auto(s3, "vile_force_of_darkness", 12000);
    ok(s4.track == "mountainhome" && s4.start_ms == 9000 && s4.manual,
       "manual is frozen against auto triggers (host in control; server persists if host leaves)");

    // (e) host hands control back to AUTO.
    State s5 = set_auto("winter_entombs_you", 15000);
    ok(s5.track == "winter_entombs_you" && s5.start_ms == 15000 && !s5.manual,
       "set_auto resumes trigger-driven selection");

    // ---- state_json: LATE-JOIN elapsed + TRACK-END (loop wrap is client-side; server counts up) --
    std::printf("\n# state_json (elapsed / late-join / clamp)\n");
    ok(state_json(s5, 15000) == "\"music\":{\"track\":\"winter_entombs_you\",\"elapsedMs\":0,\"manual\":false}",
       "elapsed 0 at start instant");
    ok(state_json(s5, 20000) ==
         "\"music\":{\"track\":\"winter_entombs_you\",\"elapsedMs\":5000,\"manual\":false}",
       "late-joiner reads elapsed 5000ms (seeks mid-track)");
    // TRACK-END: server never wraps -- elapsed just keeps growing; the CLIENT takes elapsed % dur.
    ok(state_json(s5, 15000 + 999999).find("\"elapsedMs\":999999") != std::string::npos,
       "track-end handled by client modulo: server elapsed keeps growing (no server wrap)");
    // manual flag surfaces for the now-playing UI.
    ok(state_json(s3, 9500).find("\"manual\":true") != std::string::npos, "manual flag emitted");
    // (ttt) a backwards clock must clamp elapsed to 0, never emit a negative seek.
    ok(state_json(s5, 14000).find("\"elapsedMs\":0") != std::string::npos,
       "(ttt) backwards clock clamps elapsed to 0");

    // ---- is_valid_track: the POST /music whitelist (17 keys) -------------------------------------
    std::printf("\n# is_valid_track (POST /music validation)\n");
    const char* valid[] = { "hill_dwarf", "winter_entombs_you", "vile_force_of_darkness",
                            "song_game", "dwarf_fortress", "nabidas" };
    for (const char* k : valid) ok(is_valid_track(k), (std::string("accept ") + k).c_str());
    ok(!is_valid_track("nope"), "(ttt) unknown key rejected (no 404 music channel)");
    ok(!is_valid_track(""), "(ttt) empty key rejected");
    ok(!is_valid_track("../../etc/passwd"), "(ttt) traversal-shaped key rejected");

    std::printf("\n%d checks, %d failed\n", g_pass + g_fail, g_fail);
    return g_fail ? 1 : 0;
}
