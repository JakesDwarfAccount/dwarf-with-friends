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

#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace dwf {
namespace console {

struct DenyRule {
    enum Kind { Prefix, Exact } kind;
    const char* token;
    const char* reason;
};

struct Denial {
    bool denied = false;
    std::string reason;   // shown to the client; valid only when denied
};

// ---- THE BLOCKLIST (edit here) ---------------------------------------------------------------
inline const std::vector<DenyRule>& deny_table() {
    static const std::vector<DenyRule> kRules = {
        // 1. the plugin's own control commands
        { DenyRule::Prefix, "capture-", "capture-* commands control the server itself and are host-console only" },
        { DenyRule::Exact,  "capture",  "capture commands control the server itself and are host-console only" },

        // 2. stop-the-world / stop-the-server
        { DenyRule::Exact, "die",         "would kill the Dwarf Fortress process" },
        { DenyRule::Exact, "kill-lua",    "would tear down the running Lua state (can crash DF/the plugin)" },
        { DenyRule::Exact, "quicksave",   "save/shutdown commands are disabled in the browser console" },
        { DenyRule::Exact, "save",        "save/shutdown commands are disabled in the browser console" },
        { DenyRule::Exact, "quit",        "would exit Dwarf Fortress" },
        { DenyRule::Exact, "quit!",       "would exit Dwarf Fortress" },
        { DenyRule::Exact, "forcequit",   "would force-exit Dwarf Fortress" },
        //    plugin lifecycle verbs
        { DenyRule::Exact, "disable",     "plugin/feature lifecycle commands are disabled in the browser console" },
        { DenyRule::Exact, "enable",      "plugin/feature lifecycle commands are disabled in the browser console" },
        { DenyRule::Exact, "load",        "plugin-load commands are disabled in the browser console" },
        { DenyRule::Exact, "unload",      "plugin-unload commands are disabled in the browser console" },
        { DenyRule::Exact, "plug",        "plugin management is disabled in the browser console" },
        { DenyRule::Exact, "reload",      "reload commands are disabled in the browser console" },
        { DenyRule::Exact, "restart",     "restart commands are disabled in the browser console" },
        { DenyRule::Exact, "script",      "running arbitrary script files is disabled in the browser console" },
        { DenyRule::Exact, "sc-script",   "running arbitrary script files is disabled in the browser console" },

        // 3. arbitrary code
        { DenyRule::Exact, "lua",         "arbitrary Lua execution is disabled in the browser console" },
        { DenyRule::Prefix, ":lua",       "arbitrary Lua execution is disabled in the browser console" },
        { DenyRule::Exact, "eval",        "arbitrary evaluation is disabled in the browser console" },

        // 4. interactive / screen-pushing
        { DenyRule::Prefix, "gui/",       "interactive gui/ scripts need a native screen the server does not have" },
        { DenyRule::Exact, "command-prompt", "interactive prompt commands are not usable headless" },

        // 5. developer tools
        { DenyRule::Prefix, "devel/",     "devel/ internals are disabled in the browser console" },

        // 6. whole-world scans / mass effects
        { DenyRule::Exact, "reveal",      "map-wide reveal freezes the fort and is disabled" },
        { DenyRule::Exact, "unreveal",    "map-wide unreveal freezes the fort and is disabled" },
        { DenyRule::Exact, "exterminate", "mass-kill commands are disabled in the browser console" },
        { DenyRule::Exact, "extinguish",  "mass-effect commands are disabled in the browser console" },

        // 7. indirection -- DFHack expands these BEFORE dispatch, so each can invoke a denied
        //    command under a name this table never sees.
        { DenyRule::Exact, "alias",       "alias can invoke a denied command under another name" },
        { DenyRule::Exact, "keybinding",  "keybinding can bind a denied command" },
        { DenyRule::Exact, "repeat",      "repeat can schedule a denied command" },
        { DenyRule::Exact, "multicmd",    "multicmd can chain a denied command" },
    };
    return kRules;
}

// ---- helpers (pure) --------------------------------------------------------------------------

inline char to_lower_ascii(char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

inline std::string lower_ascii(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out.push_back(to_lower_ascii(c));
    return out;
}

// Deliberately no quoting semantics: splitting a quoted argument into several tokens can only ADD
// deny matches, never hide one. Teaching this to respect quotes would open a bypass.
inline std::vector<std::string> tokenize(const std::string& line) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : line) {
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            if (!cur.empty()) { out.push_back(cur); cur.clear(); }
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

inline std::string command_head(const std::string& line) {
    auto toks = tokenize(line);
    return toks.empty() ? std::string() : toks.front();
}

// THE GATE. Never give this a host/loopback parameter: caller identity is not an input, which is
// the only reason a friend cannot bypass a rule and the host cannot escape one.
inline Denial command_denied(const std::string& line) {
    Denial d;
    auto toks = tokenize(line);
    if (toks.empty()) {
        d.denied = true;
        d.reason = "empty command";
        return d;
    }
    const std::string head = lower_ascii(toks.front());

    for (const auto& rule : deny_table()) {
        const std::string tok = lower_ascii(rule.token);
        bool hit = (rule.kind == DenyRule::Exact)
            ? (head == tok)
            : (head.size() >= tok.size() && head.compare(0, tok.size(), tok) == 0);
        if (hit) {
            d.denied = true;
            d.reason = rule.reason;
            return d;
        }
    }

    if (head == "prospect") {
        for (size_t i = 1; i < toks.size(); ++i) {
            if (lower_ascii(toks[i]) == "all") {
                d.denied = true;
                d.reason = "`prospect all` scans the whole embark and freezes the fort";
                return d;
            }
        }
    }

    return d;   // allowed
}

}  // namespace console
}  // namespace dwf
