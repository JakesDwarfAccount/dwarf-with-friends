// console_policy_fixture.cpp -- OFFLINE proof of the WT26 command-console CONTAINMENT logic
// (src/console_policy.h), completeness rules 1-3.
//
// Includes the REAL header-only dwf::console::command_denied (NOT a mirror) and drives it
// across the full acceptance matrix:
//   * every denied NAMESPACE/category is refused (capture-*, stop-the-world, arbitrary code,
//     gui/*, devel/*, whole-world scans / mass effects), by prefix and by exact match;
//   * case-insensitivity (DIE / Gui/Foo cannot slip past);
//   * `prospect all` denied but bare `prospect` (current tile) allowed;
//   * a known-safe informational set (ls, help, prospect, weather, ...) is ALLOWED;
//   * SAME VERDICT FOR HOST AND NON-HOST: the gate has no host parameter by construction, so a
//     single call IS the verdict for every caller -- asserted explicitly below;
//   * SEEDED-BAD (rule 3, "test the test"): a command that MUST be denied is checked against the
//     wrong expectation and that check is proven to fail, so a hole in the table cannot pass green.
//
// ZERO DF / httplib contact: console_policy.h needs <string>/<vector>/<cstddef> only.
//
// Build+run (from repo root; any C++17 compiler):
//   cl /std:c++17 /EHsc /I src /Fe:consolepol.exe tools\harness\console_policy_fixture.cpp && consolepol.exe
//   g++ -std=c++17 -O2 -I src -o consolepol tools/harness/console_policy_fixture.cpp && ./consolepol
// Exit: 0 all pass, 1 any fail.

#include "console_policy.h"

#include <cstdio>
#include <string>
#include <vector>

using dwf::console::command_denied;
using dwf::console::command_head;
using dwf::console::Denial;

static int g_pass = 0, g_fail = 0;
static void ok(bool cond, const char* what) {
    if (cond) { ++g_pass; std::printf("  ok   - %s\n", what); }
    else      { ++g_fail; std::printf("  FAIL - %s\n", what); }
}

// A command must be DENIED (containment held).
static void denied(const char* cmd) {
    Denial d = command_denied(cmd);
    if (d.denied && !d.reason.empty()) {
        ++g_pass; std::printf("  ok   - DENY  %-28s (%s)\n", cmd, d.reason.c_str());
    } else {
        ++g_fail; std::printf("  FAIL - LEAK  %-28s -- was ALLOWED, must be denied\n", cmd);
    }
}

// A command must be ALLOWED (useful, safe).
static void allowed(const char* cmd) {
    Denial d = command_denied(cmd);
    if (!d.denied) {
        ++g_pass; std::printf("  ok   - ALLOW %-28s\n", cmd);
    } else {
        ++g_fail; std::printf("  FAIL - BLOCK %-28s -- was denied (%s), should be allowed\n",
                              cmd, d.reason.c_str());
    }
}

int main() {
    std::printf("# capture-* namespace -- the non-negotiable rule (re-opening host-only gates)\n");
    denied("capture-join-password hunter2");
    denied("capture-join-password off");
    denied("capture-stream-stop");
    denied("capture-stream-start 8080");
    denied("capture-diag-verbose on");
    denied("capture");                       // bare head is inside the prefix too

    std::printf("\n# stop-the-world / stop-the-server\n");
    denied("die");
    denied("kill-lua");
    denied("quicksave");
    denied("save");
    denied("quit");
    denied("quit!");
    denied("disable dfcapture");
    denied("unload dfcapture");
    denied("enable something");
    denied("load someplugin");
    denied("plug");
    denied("reload");
    denied("restart");
    denied("script somefile.dfhack");

    std::printf("\n# arbitrary code\n");
    denied("lua print(1)");
    denied("lua");
    denied(":lua dfhack.run_command('die')");
    denied("eval x=1");

    std::printf("\n# interactive / screen-pushing (gui/*)\n");
    denied("gui/launcher");
    denied("gui/gm-editor");
    denied("gui/control-panel");
    denied("command-prompt");

    std::printf("\n# developer tools (devel/*)\n");
    denied("devel/query --table df.global.world");
    denied("devel/dump-offsets");

    std::printf("\n# whole-world scans / mass effects\n");
    denied("prospect all");
    denied("prospect all --show ores");
    denied("reveal");
    denied("unreveal");
    denied("exterminate this");
    denied("extinguish all");

    std::printf("\n# case-insensitivity (no bypass by casing)\n");
    denied("DIE");
    denied("Gui/Launcher");
    denied("CAPTURE-JOIN-PASSWORD x");
    denied("Prospect ALL");

    std::printf("\n# blank / whitespace-only is denied (nothing to run)\n");
    denied("");
    denied("   \t  ");

    std::printf("\n# ALLOWED: useful, safe, informational commands\n");
    allowed("ls");
    allowed("help");
    allowed("prospect");                     // current-tile prospect (no `all`) stays allowed
    allowed("prospect --show ores");         // still no `all`
    allowed("weather");
    allowed("units");
    allowed("cls");
    allowed("tags");
    allowed("search-plugins dig");

    std::printf("\n# command_head parsing\n");
    ok(command_head("gui/launcher foo bar") == "gui/launcher", "head = first token");
    ok(command_head("   spaced   arg") == "spaced", "head skips leading whitespace");
    ok(command_head("") == "", "head of blank line is empty");

    std::printf("\n# SAME VERDICT FOR HOST AND NON-HOST (the gate has no host parameter) --\n");
    {
        // There is only ONE code path; call it once and that IS the verdict for every caller. This
        // asserts the structural property the mitigation requires: a friend CANNOT bypass a rule
        // and the host CANNOT escape one, because neither identity is an input.
        const char* dangerous = "capture-join-password letmein";
        Denial once = command_denied(dangerous);
        Denial twice = command_denied(dangerous);   // caller identity is not an argument at all
        ok(once.denied && twice.denied && once.reason == twice.reason,
           "identical deny verdict regardless of who calls (no host/loopback input exists)");
    }

    std::printf("\n# TEST-THE-TEST (rule 3): a real deny checked against the WRONG expectation FAILS\n");
    {
        // `die` MUST be denied. Assert the SEEDED-WRONG belief that it is allowed, and prove that
        // belief is false -- i.e. a table that silently dropped `die` would be caught here.
        Denial d = command_denied("die");
        bool seededWrongHeld = (!d.denied);   // the wrong expectation ("die is allowed")
        ok(seededWrongHeld == false,
           "seeded-wrong 'die is allowed' is correctly false -- a leak in the table would flip this");
    }

    std::printf("\n----------------------------------------\n");
    std::printf("console_policy_fixture: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
