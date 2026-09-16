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

#include "menu_oracle.h"

#include "http_server.h"
#include "json_util.h"

#include "Core.h"
#include "DataDefs.h"
#include "modules/DFSDL.h"

#include "df/building_interfacest.h"
#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/inorganic_raw.h"
#include "df/interface_button.h"
#include "df/interface_button_buildingst.h"
#include "df/interface_button_building_category_selectorst.h"
#include "df/interface_button_building_custom_category_selectorst.h"
#include "df/interface_button_building_material_selectorst.h"
#include "df/interface_button_building_new_jobst.h"
#include "df/interface_category_building.h"
#include "df/item_type.h"
#include "df/job_details_context_type.h"
#include "df/job_details_interfacest.h"
#include "df/job_details_option_type.h"
#include "df/job_type.h"
#include "df/main_interface.h"
#include "df/material.h"
#include "df/matter_state.h"
#include "df/view_sheets_interfacest.h"
#include "df/world.h"

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <excpt.h>   // EXCEPTION_EXECUTE_HANDLER for the SEH backstop
#endif

namespace dwf {

using namespace DFHack;

namespace {

std::string inorganic_solid_name(int32_t matgloss) {
    auto world = df::global::world;
    if (!world || matgloss < 0)
        return std::string();
    auto& all = world->raws.inorganics.all;
    if (matgloss >= static_cast<int32_t>(all.size()))
        return std::string();
    auto* raw = all[matgloss];
    if (!raw)
        return std::string();
    return raw->material.state_name[df::matter_state::Solid];
}

std::string button_text(df::interface_button* btn) {
    std::string s;
    btn->text(&s);
    return s;
}

std::string type_string(df::interface_button* btn) {
    auto id = DFHack::virtual_identity::get(btn);
    std::string name = id ? id->getName() : "?";
    return "<type: " + name + ">";
}

void dump_button(std::ostringstream& body, df::interface_button* btn, bool call_text) {
    body << "{";
    body << "\"class\":" << json_string(type_string(btn));
    body << ",\"filter_str\":" << json_string(btn->filter_str);
    body << ",\"alpha_order\":" << btn->alpha_order;
    body << ",\"hotkey\":" << json_string(DFHack::enum_item_key(btn->hotkey));
    body << ",\"leave_button\":" << (btn->leave_button ? "true" : "false");
    if (call_text)
        body << ",\"text\":" << json_string(button_text(btn));

    int32_t material = 1;
    int32_t matgloss = 1;
    bool have_material = false;

    if (auto* jb = virtual_cast<df::interface_button_building_new_jobst>(btn)) {
        body << ",\"jobtype\":" << json_string(DFHack::enum_item_key(jb->jobtype));
        body << ",\"mstring\":" << json_string(jb->mstring);
        body << ",\"itemtype\":" << static_cast<int32_t>(jb->itemtype);
        body << ",\"subtype\":" << jb->subtype;
        body << ",\"material\":" << jb->material;
        body << ",\"matgloss\":" << jb->matgloss;
        body << ",\"job_item_flag\":" << json_string(DFHack::bitfield_to_string(jb->job_item_flag, ","));
        body << ",\"objection\":" << json_string(jb->objection);
        body << ",\"info\":" << json_string(jb->info);
        body << ",\"add_building_location\":" << (jb->add_building_location ? "true" : "false");
        body << ",\"show_help_instead\":" << (jb->show_help_instead ? "true" : "false");
        material = jb->material;
        matgloss = jb->matgloss;
        have_material = true;
    } else if (auto* ms = virtual_cast<df::interface_button_building_material_selectorst>(btn)) {
        body << ",\"material\":" << ms->material;
        body << ",\"matgloss\":" << ms->matgloss;
        body << ",\"job_item_flag\":" << json_string(DFHack::bitfield_to_string(ms->job_item_flag, ","));
        material = ms->material;
        matgloss = ms->matgloss;
        have_material = true;
    } else if (auto* cs = virtual_cast<df::interface_button_building_category_selectorst>(btn)) {
        body << ",\"category\":" << json_string(DFHack::enum_item_key(cs->category));
    } else if (auto* cc = virtual_cast<df::interface_button_building_custom_category_selectorst>(btn)) {
        body << ",\"custom_category_token\":" << json_string(cc->custom_category_token);
    }

    if (have_material && material >= 0 && matgloss >= 0) {
        std::string nm = inorganic_solid_name(matgloss);
        if (!nm.empty())
            body << ",\"material_name\":" << json_string(nm);
    }

    body << "}";
}

void dump_button_vec(std::ostringstream& body,
                     const std::vector<df::interface_button*>& vec, bool call_text) {
    body << "[";
    bool first = true;
    for (auto* btn : vec) {
        if (!btn)
            continue;
        if (!first)
            body << ",";
        first = false;
        dump_button(body, btn, call_text);
    }
    body << "]";
}

// Run ONLY inside menu_oracle_quiesced_read's window (render thread parked AND sim thread
// suspended): it iterates live button vectors and calls vmethods, which a mutating DF thread frees.
std::string build_menu_oracle_json(bool call_text) {
    std::ostringstream body;
    auto game = df::global::game;
    if (!game) {
        body << "{\"schema\":\"truemenu-oracle-v1\","
             << "\"generated_by\":\"src/menu_oracle.cpp\","
             << "\"call_text\":" << (call_text ? "true" : "false") << ",";
        body << "\"building\":{\"n_button\":0,\"n_filtered_button\":0,\"n_press_button\":0,"
             << "\"button\":[],\"filtered_button\":[]},";
        body << "\"in_transition\":false,";
        body << "\"open\":false}\n";
        return body.str();
    }

    auto& mi = game->main_interface;
    auto& b = mi.building;

    body << "{\"schema\":\"truemenu-oracle-v1\","
         << "\"generated_by\":\"src/menu_oracle.cpp\","
         << "\"call_text\":" << (call_text ? "true" : "false") << ",";

    // building.* --------------------------------------------------------------------------------
    body << "\"building\":{";
    body << "\"category\":" << json_string(DFHack::enum_item_key(b.category));
    body << ",\"selected\":" << b.selected;
    body << ",\"material\":" << b.material;
    body << ",\"matgloss\":" << b.matgloss;
    body << ",\"job\":" << json_string(DFHack::enum_item_key(b.job));
    body << ",\"job_item_flag\":" << json_string(DFHack::bitfield_to_string(b.job_item_flag, ","));
    body << ",\"current_custom_category_token\":" << json_string(b.current_custom_category_token);
    body << ",\"n_button\":" << b.button.size();
    body << ",\"n_filtered_button\":" << b.filtered_button.size();
    body << ",\"n_press_button\":" << b.press_button.size();
    body << ",\"button\":";
    dump_button_vec(body, b.button, call_text);
    body << ",\"filtered_button\":";
    dump_button_vec(body, b.filtered_button, call_text);
    body << "}";

    // view_sheets.* -----------------------------------------------------------------------------
    auto& vs = mi.view_sheets;
    body << ",\"view_sheets\":{";
    body << "\"open\":" << (vs.open ? "true" : "false");
    body << ",\"active_sub_tab\":" << vs.active_sub_tab;
    body << ",\"active_id\":" << vs.active_id;
    body << ",\"building_job_filter_str\":" << json_string(vs.building_job_filter_str);
    body << ",\"entering_building_job_filter\":" << (vs.entering_building_job_filter ? "true" : "false");
    body << ",\"scroll_position_building_job\":" << vs.scroll_position_building_job;
    body << "}";

    // job_details.* (details/material sub-layer) ------------------------------------------------
    auto& jd = mi.job_details;
    body << ",\"job_details\":{";
    body << "\"open\":" << (jd.open ? "true" : "false");
    body << ",\"context\":" << json_string(DFHack::enum_item_key(jd.context));
    body << ",\"current_option\":" << json_string(DFHack::enum_item_key(jd.current_option));
    body << ",\"material_filter\":" << json_string(jd.material_filter);
    body << ",\"materials\":[";
    {
        size_t n = jd.material_master.size();
        if (jd.matgloss_master.size() < n) n = jd.matgloss_master.size();
        for (size_t i = 0; i < n; ++i) {
            if (i) body << ",";
            int16_t mt = jd.material_master[i];
            int32_t mg = jd.matgloss_master[i];
            body << "{\"mat_type\":" << mt << ",\"matgloss\":" << mg << ",\"count\":";
            if (i < jd.material_count_master.size())
                body << jd.material_count_master[i];
            else
                body << "null";
            body << ",\"name\":";
            if (mt == 0 && mg >= 0) {
                std::string nm = inorganic_solid_name(mg);
                body << (nm.empty() ? std::string("null") : json_string(nm));
            } else {
                body << "null";
            }
            body << "}";
        }
    }
    body << "]}";

    // sheet already closed but its button rows not yet cleared by the next interface frame
    bool in_transition = (vs.active_id == -1) && !b.button.empty();
    body << ",\"in_transition\":" << (in_transition ? "true" : "false");

    bool open = !b.button.empty();
    body << ",\"open\":" << (open ? "true" : "false");
    body << "}\n";
    return body.str();
}

void build_menu_oracle_json_into(bool call_text, std::string& out) {
    out = build_menu_oracle_json(call_text);
}

bool build_menu_oracle_json_seh(bool call_text, std::string& out) {
#ifdef _WIN32
    __try {
        build_menu_oracle_json_into(call_text, out);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
#else
    build_menu_oracle_json_into(call_text, out);
    return true;
#endif
}

constexpr int PARK_WAIT_MS = 1500;
constexpr int SUSPEND_ATTEMPTS = 10;       // ConditionalCoreSuspender retries before a 503
constexpr int RENDER_WATCHDOG_MS = 8000;

struct MenuOracleQuiesce {
    std::mutex m;
    std::condition_variable cv;
    bool render_parked = false;
    bool release_render = false;
};

struct MenuOracleResult {
    bool ok = false;
    int http_status = 200;
    std::string error;
    std::string json;
    int park_wait_ms = -1;
    int suspend_attempts = 0;
    int suspend_wait_ms = -1;
    int hold_ms = -1;          // suspension hold: the sim-pause cost of this read
};

// PARK the render thread BEFORE taking the core suspension. Waiting on a runOnRenderThread hop
// while core-suspended wedges DF: the hop queues behind work that itself blocks on the sim thread.
MenuOracleResult menu_oracle_quiesced_read(bool call_text) {
    using clock = std::chrono::steady_clock;
    auto ms_since = [](clock::time_point t) {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            clock::now() - t).count());
    };

    MenuOracleResult out;
    auto q = std::make_shared<MenuOracleQuiesce>();

    DFHack::runOnRenderThread([q]() {
        std::unique_lock<std::mutex> lk(q->m);
        q->render_parked = true;
        q->cv.notify_all();
        q->cv.wait_for(lk, std::chrono::milliseconds(RENDER_WATCHDOG_MS),
                       [&]() { return q->release_render; });
        q->render_parked = false;
    });

    auto t0 = clock::now();
    std::unique_lock<std::mutex> lk(q->m);
    bool parked = q->cv.wait_for(lk, std::chrono::milliseconds(PARK_WAIT_MS),
                                 [&]() { return q->render_parked; });
    out.park_wait_ms = ms_since(t0);
    if (!parked) {
        q->release_render = true;
        q->cv.notify_all();
        out.http_status = 503;
        out.error = "render thread did not park within " + std::to_string(PARK_WAIT_MS) +
                    "ms; no snapshot taken (retry)";
        return out;
    }

    // Holding lk is what keeps the render thread captive in the park callback; never release early.
    auto t1 = clock::now();
    bool read_done = false;
    bool seh_fault = false;
    for (int i = 0; i < SUSPEND_ATTEMPTS && !read_done; ++i) {
        out.suspend_attempts = i + 1;
        DFHack::ConditionalCoreSuspender suspend;
        if (!suspend)
            continue;
        out.suspend_wait_ms = ms_since(t1);
        auto t2 = clock::now();
        if (build_menu_oracle_json_seh(call_text, out.json)) {
            out.ok = true;
        } else {
            seh_fault = true;
        }
        out.hold_ms = ms_since(t2);
        read_done = true;
    }

    q->release_render = true;
    q->cv.notify_all();

    if (!read_done) {
        out.http_status = 503;
        out.error = "core suspension not acquired within budget (" +
                    std::to_string(SUSPEND_ATTEMPTS) + "x100ms); no snapshot taken (retry)";
    } else if (seh_fault) {
        out.http_status = 500;
        out.error = "quiesced snapshot faulted (SEH); caught, DF unharmed";
    }
    return out;
}

} // namespace

// DELIBERATE RELEASE-BINARY TEST ORACLE -- KEEP. No browser module calls /menu-oracle; the
// endpoint exists for gate_truemenu.py, menuwalk_recorder.py, and menu_oracle_stress.py to
// compare our menu model with DF's live building-menu state and to stress the quiesced reader.
// Removing this registration or its snapshot implementation leaves menu parity without a native
// differential oracle and removes the transition-overlap safety test, while product UI appears
// unaffected -- which is precisely why this code can otherwise look disposable.
void register_menu_oracle_routes(httplib::Server& server) {
    server.Get("/menu-oracle", [](const httplib::Request& req, httplib::Response& res) {
        bool call_text = true;
        if (req.has_param("call_text")) {
            std::string v = req.get_param_value("call_text");
            if (v == "0" || v == "false" || v == "no")
                call_text = false;
        }
        MenuOracleResult r = menu_oracle_quiesced_read(call_text);
        res.set_header("Cache-Control", "no-store");
        res.set_header("X-Menu-Oracle-Quiesce",
                       "park_ms=" + std::to_string(r.park_wait_ms) +
                       ";attempts=" + std::to_string(r.suspend_attempts) +
                       ";suspend_ms=" + std::to_string(r.suspend_wait_ms) +
                       ";hold_ms=" + std::to_string(r.hold_ms));
        if (!r.ok) {
            res.status = r.http_status;
            res.set_content("{\"schema\":\"truemenu-oracle-v1\",\"open\":false,\"error\":" +
                                json_string(r.error) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content(r.json, "application/json; charset=utf-8");
    });
}

} // namespace dwf
