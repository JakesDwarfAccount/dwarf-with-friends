// sound_route_fixture.cpp -- OFFLINE proof of the P1 /sound route DECISION logic
// (spec 2026-07-09-audio-music-spec.md §3), completeness rules 1-3.
//
// Includes the REAL header-only functions from src/sound_route.h (resolve_sound_path,
// remote_allowed) -- NOT a mirror -- and drives them across the full acceptance matrix
// (extension whitelist x traversal vectors x gate loopback/remote x config on/off), plus
// SEEDED-BAD cases (rule 3, "test the test") that MUST be rejected, plus the exact byte-slice a
// correct 206 range response owes (the httplib 206 behavior itself is code-read-verified in the
// spec §5b + banked as a live curl oracle for window #12 -- this proves the slice arithmetic).
//
// ZERO DF / httplib contact: sound_route.h only forward-declares httplib::Server for the
// register decl; the pure functions used here need <string>/<cstddef> only.
//
// Build+run (from repo root; any C++17 compiler):
//   cl /std:c++17 /EHsc /I src /Fe:soundfix.exe tools\harness\sound_route_fixture.cpp && soundfix.exe
//   g++ -std=c++17 -O2 -I src -o soundfix tools/harness/sound_route_fixture.cpp && ./soundfix
// Exit: 0 all pass, 1 any fail.

#include "sound_route.h"

#include <cstdio>
#include <string>
#include <vector>

using dwf::sound::resolve_sound_path;
using dwf::sound::remote_allowed;
using dwf::sound::request_is_local_host;
using dwf::sound::host_header_is_local;
using dwf::sound::scan_audio_remote;
using dwf::sound::PathResolve;

static int g_pass = 0, g_fail = 0;
static void ok(bool cond, const char* what) {
    if (cond) { ++g_pass; std::printf("  ok   - %s\n", what); }
    else      { ++g_fail; std::printf("  FAIL - %s\n", what); }
}

int main() {
    std::printf("# resolve_sound_path -- ACCEPT (valid .ogg under data/sound)\n");
    struct Good { const char* path; };
    const std::vector<Good> good = {
        {"tracks/koganusan/KG_Full.ogg"},
        {"tracks/winter_entombs_you/WEY_Full.ogg"},
        {"tracks/drink_&_industry/DI_Full.ogg"},          // literal '&' in a dir name
        {"tracks/strike_the_earth!/STE_1.ogg"},            // literal '!' in a dir name
        {"sounds/megabeast.ogg"},
        {"ambience/Blizzard.ogg"},
        {"audio/ui/clicks/generic/click-001.ogg"},
        {"song_game.ogg"},                                 // top-level file
    };
    for (const auto& g : good) {
        PathResolve r = resolve_sound_path(g.path);
        ok(r.ok && r.rel == g.path && r.status == 200,
           (std::string("accept ") + g.path).c_str());
    }
    // Case-insensitive .ogg suffix.
    ok(resolve_sound_path("song_TITLE.OGG").ok, "accept uppercase .OGG");
    ok(resolve_sound_path("x.OgG").ok, "accept mixed-case .OgG");

    std::printf("\n# resolve_sound_path -- REJECT (each must be {ok:false, status:404})\n");
    struct Bad { const char* path; const char* why; };
    const std::vector<Bad> bad = {
        {"", "empty"},
        {"foo.png", "non-ogg extension"},
        {"foo", "no extension"},
        {"foo.ogg.txt", "extension not the tail"},
        {"tracks/koganusan/KG_Full.mp3", "wrong codec ext"},
        {"../../hack/plugins/x.ogg", "leading parent traversal"},
        {"tracks/../../../secret.ogg", "embedded traversal"},
        {"tracks/..%2f..%2fx.ogg", "literal .. even if encode-looking"},
        {"/etc/passwd.ogg", "absolute path"},
        {"C:/Windows/win.ogg", "drive-letter colon"},
        {"tracks/a:stream.ogg", "NTFS ADS colon"},
        {"tracks\\koganusan\\KG_Full.ogg", "backslash separator"},
    };
    for (const auto& b : bad) {
        PathResolve r = resolve_sound_path(b.path);
        ok(!r.ok && r.status == 404, (std::string("reject ") + b.why).c_str());
    }
    // Control byte / embedded NUL (constructed so the compiler keeps the NUL).
    { std::string p = "foo"; p.push_back('\0'); p += "bar.ogg";
      ok(!resolve_sound_path(p).ok, "reject embedded NUL"); }
    { std::string p = "a"; p.push_back('\n'); p += ".ogg";
      ok(!resolve_sound_path(p).ok, "reject control char (newline)"); }
    // Oversize.
    { std::string p(600, 'a'); p += ".ogg"; ok(!resolve_sound_path(p).ok, "reject > 512 bytes"); }

    std::printf("\n# TEST-THE-TEST (rule 3): the guard is load-bearing\n");
    // If the ".." guard were removed, this classic escape would ACCEPT. The suite passes iff the
    // real function REJECTS it -- proving the assertion can discriminate the broken case.
    {
        PathResolve escape = resolve_sound_path("tracks/../../../../hack/dfcapture-web/index.html.ogg");
        ok(!escape.ok, "seeded escape stays rejected (traversal guard load-bearing)");
        // And a genuinely valid sibling still accepts (the guard isn't over-broad).
        ok(resolve_sound_path("tracks/koganusan/KG_Full.ogg").ok,
           "valid path still accepted (guard not over-broad)");
    }

    std::printf("\n# remote_allowed -- licensing gate matrix (host-tab x audio_remote cfg)\n");
    ok(remote_allowed(true,  false) == true,  "host tab + cfg off  -> allowed (host owns the game)");
    ok(remote_allowed(true,  true)  == true,  "host tab + cfg on   -> allowed");
    ok(remote_allowed(false, true)  == true,  "remote   + cfg on   -> allowed (host opted in)");
    ok(remote_allowed(false, false) == false, "remote   + cfg off  -> DENIED (explicit opt-out)");

    std::printf("\n# scan_audio_remote -- DEFAULT ON, opt-OUT only (item 6, the owner 2026-07-09)\n");
    // The whole config posture inverted: remote audio ships ON out of the box; ONLY an explicit
    // `"audio_remote": false` disables it. (audio_remote_enabled()'s file-IO fallback mirrors this:
    // a MISSING or unreadable file leaves val=true -- the "no file -> ON" case, code-read-verified
    // in sound_route.cpp; the scanner cells below cover every readable-content branch.)
    ok(scan_audio_remote("") == true,                             "empty file body -> ON (no key)");
    ok(scan_audio_remote("{}") == true,                           "no audio_remote key -> ON");
    ok(scan_audio_remote("{\"other\":1}") == true,                "unrelated key only -> ON");
    ok(scan_audio_remote("{\"audio_remote\": true}") == true,     "explicit true -> ON");
    ok(scan_audio_remote("{\"audio_remote\":true}") == true,      "explicit true (no space) -> ON");
    ok(scan_audio_remote("{\"audio_remote\": false}") == false,   "explicit false -> OFF (opt out)");
    ok(scan_audio_remote("{\"audio_remote\":false}") == false,    "explicit false (no space) -> OFF");
    ok(scan_audio_remote("{ \"audio_remote\" : false }") == false,"explicit false (padded) -> OFF");
    ok(scan_audio_remote("garbage not json at all") == true,      "malformed text -> ON");
    ok(scan_audio_remote("{\"audio_remote\" 0}") == true,         "key but no colon -> ON (malformed)");
    ok(scan_audio_remote("{\"audio_remote\": ") == true,          "key+colon but truncated -> ON");
    // TEST-THE-TEST (rule 3): the default-ON inversion is load-bearing. Under the OLD default-off
    // scanner, "empty body" and "no key" both returned FALSE; the two cells above are exactly the
    // ones that flip, so this suite discriminates the pre-inversion behavior.
    ok(scan_audio_remote("{\"audio_remote\": false}") != scan_audio_remote("{}"),
       "(test-the-test) explicit-false and default disagree -> the opt-out is the ONLY off path");

    std::printf("\n# request_is_local_host -- tunnel-aware host detection (adversarial finding #1)\n");
    // The host's own tab: loopback peer, no forwarding header, loopback-ish Host header.
    ok(request_is_local_host(true,  false, "localhost:8765") == true,  "host tab (localhost:8765)");
    ok(request_is_local_host(true,  false, "127.0.0.1:8765") == true,  "host tab (127.0.0.1:8765)");
    ok(request_is_local_host(true,  false, "[::1]:8765")     == true,  "host tab ([::1]:8765)");
    ok(request_is_local_host(true,  false, "LOCALHOST")      == true,  "host tab (Host case-insensitive)");
    // THE HOLE THIS CLOSES: cloudflared terminates ON the host -> accept() sees 127.0.0.1 for a
    // REMOTE friend. But their request carries the tunnel Host + proxy forwarding headers.
    ok(request_is_local_host(true, true,  "xyz.trycloudflare.com") == false,
       "tunneled remote (loopback peer + fwd hdr + tunnel Host) -> NOT host");
    ok(request_is_local_host(true, false, "xyz.trycloudflare.com") == false,
       "tunneled remote, fwd headers hypothetically stripped -> Host still betrays it");
    ok(request_is_local_host(true, true,  "localhost:8765") == false,
       "a forwarding header alone marks the request proxied, even with a local Host");
    // A genuinely non-loopback (LAN) peer is never the host, whatever headers it sends.
    ok(request_is_local_host(false, false, "localhost:8765") == false, "LAN peer forging local Host -> NOT host");
    ok(request_is_local_host(false, true,  "192.168.1.5:8765") == false, "plain LAN peer -> NOT host");
    // host_header_is_local edge shapes.
    ok(host_header_is_local("127.5.5.5") == true,  "127/8 IP-literal Host accepted");
    ok(host_header_is_local("") == false,          "empty Host -> not local");
    // TEST-THE-TEST: a DOMAIN that merely STARTS with "127." must not slip past the IP-literal
    // check (if the prefix test lacked the digits-and-dots pass, this would wrongly return true).
    ok(host_header_is_local("127.evil.com") == false,
       "(test-the-test) '127.evil.com' domain does NOT count as loopback");
    ok(host_header_is_local("localhost.evil.com") == false,
       "(test-the-test) 'localhost.evil.com' does NOT count as loopback");

    std::printf("\n# 206 byte-slice oracle (arithmetic the live 206 curl-check relies on)\n");
    // A correct `Range: bytes=0-99` over a 256-byte body owes EXACTLY 100 bytes [0..99] and a
    // `Content-Range: bytes 0-99/256`. httplib slices this itself when the handler leaves
    // res.status unset (spec §5b, httplib.h:3698); this proves the boundary math the window-#12
    // live oracle asserts against. (Seeded-bad: an off-by-one would yield 99 or 101 bytes.)
    {
        std::string body; body.reserve(256);
        for (int i = 0; i < 256; ++i) body.push_back((char)i);
        const long total = (long)body.size();
        const long start = 0, end = 99;                 // inclusive range
        const long len = end - start + 1;               // == 100
        std::string slice = body.substr(start, len);
        ok(total == 256, "fixture body is 256 bytes");
        ok(len == 100, "bytes=0-99 spans exactly 100 bytes (inclusive)");
        ok((long)slice.size() == 100, "sliced body is 100 bytes");
        ok((unsigned char)slice[0] == 0 && (unsigned char)slice[99] == 99,
           "slice covers byte 0..99 exactly (no off-by-one)");
        std::printf("  note - window#12 live oracle: curl -H 'Range: bytes=0-99' -> 206, "
                    "Content-Range: bytes 0-99/%ld, 100 bytes\n", total);
    }

    std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
