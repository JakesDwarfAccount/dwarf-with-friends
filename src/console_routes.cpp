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

#include "console_routes.h"

#include "console_policy.h"
#include "diagnostics.h"
#include "json_util.h"
#include "lua_bridge.h"
#include "write_guards.h"

#include <sstream>
#include <string>

namespace dwf {

namespace {

// longest command line accepted: a console line is a command + args, never a payload
constexpr size_t kMaxCommandLen = 512;

// DISPLAY ONLY -- the palette greys these out; enforcement is command_denied() on every run.
std::string deny_rules_json() {
    std::ostringstream out;
    out << "[";
    bool first = true;
    for (const auto& rule : console::deny_table()) {
        if (!first) out << ",";
        first = false;
        out << "{\"kind\":"
            << json_string(rule.kind == console::DenyRule::Prefix ? "prefix" : "exact")
            << ",\"token\":" << json_string(rule.token)
            << ",\"reason\":" << json_string(rule.reason) << "}";
    }
    out << "]";
    return out.str();
}

bool console_enabled() {
    return guards::hostwrite_enabled(guards::kConsoleFlag);
}

void refuse_console_off(httplib::Response& res) {
    res.status = 403;
    res.set_content(guards::guarded_refusal_json(
                        guards::kConsoleFlag, "The DFHack command console",
                        "The host has not enabled remote DFHack commands; commands from the "
                        "console can affect the host's machine, so it ships off."),
                    "application/json; charset=utf-8");
}

} // namespace

void register_console_routes(httplib::Server& server) {
    // ---- GET /console/commands -----------------------------------------------------------------
    server.Get("/console/commands", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        if (!console_enabled()) { refuse_console_off(res); return; }
        std::string err;
        std::string catalog = console_catalog_json_via_lua(&err);
        if (catalog.empty()) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"err\":" + json_string(err.empty() ? "catalog unavailable" : err) +
                            "}\n", "application/json; charset=utf-8");
            return;
        }
        const size_t close = catalog.find_last_of('}');
        if (close == std::string::npos) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"err\":\"malformed catalog\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        std::string body = catalog.substr(0, close) + ",\"denyRules\":" + deny_rules_json() + "}\n";
        res.set_content(body, "application/json; charset=utf-8");
    });

    // ---- POST /console/run?cmd=<command line> --------------------------------------------------
    auto run_handler = [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");

        if (!console_enabled()) {
            diagnostics_log("console: REFUSED (dfhack_console is off) from " + req.remote_addr);
            refuse_console_off(res);
            return;
        }

        const std::string cmd = req.has_param("cmd") ? req.get_param_value("cmd") : std::string();
        if (cmd.empty()) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"err\":\"missing cmd\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        if (cmd.size() > kMaxCommandLen) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"err\":\"command too long\"}\n",
                            "application/json; charset=utf-8");
            return;
        }

        console::Denial gate = console::command_denied(cmd);
        if (gate.denied) {
            diagnostics_log("console: DENIED '" + cmd + "': " + gate.reason);
            res.status = 403;
            res.set_content("{\"ok\":false,\"blocked\":true,\"err\":" + json_string(gate.reason) +
                            "}\n", "application/json; charset=utf-8");
            return;
        }

        int status = -1;
        std::string text;
        std::string err;
        if (!console_run_via_lua(cmd, status, text, &err)) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"err\":" + json_string(err.empty() ? "command failed" : err) +
                            "}\n", "application/json; charset=utf-8");
            return;
        }

        std::ostringstream body;
        body << "{\"ok\":true,\"status\":" << status
             << ",\"output\":" << json_string(text) << "}\n";
        res.set_content(body.str(), "application/json; charset=utf-8");
    };
    server.Post("/console/run", run_handler);
}

} // namespace dwf
