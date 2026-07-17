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

// Resolve an inorganic (metal) matgloss index to DF's own Solid state name, e.g. "iron".
// Mirrors menu_oracle.lua: world.raws.inorganics.all[matgloss].material.state_name.Solid.
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

// DF's own composed button label, via the text() vmethod. Only called from inside the fully
// quiesced snapshot window (render thread parked + sim thread core-suspended -- see
// menu_oracle_quiesced_read below), where executing DF's own composition code cannot race any
// widget mutation. Same basis as every CoreSuspender-guarded vmethod call in DFHack tools.
std::string button_text(df::interface_button* btn) {
    std::string s;
    btn->text(&s);
    return s;
}

// "<type: interface_button_building_new_jobst>" -- byte-identical to lua's tostring(btn._type).
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

    // Concrete-subclass fields, gated by downcast so absent fields are simply omitted (matching
    // menu_oracle.lua's per-field nil-guard behavior exactly).
    int32_t material = 1;   // sentinel < 0 check below only fires when a real field was read
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

    // Resolve inorganic metal name when this row carries a concrete material+matgloss (the metal
    // rows and materialized job leaves) -- same guard as the lua tool (material>=0 && matgloss>=0).
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

// Build the truemenu-oracle-v1 snapshot. MUST only run inside the fully quiesced window
// established by menu_oracle_quiesced_read (render thread parked AND sim thread core-suspended);
// it iterates the live vectors and calls vmethods, which is only safe when no DF thread can be
// mutating them. Returns the JSON body; never throws out (all reads are pointer/bounds guarded).
std::string build_menu_oracle_json(bool call_text) {
    std::ostringstream body;
    auto game = df::global::game;
    if (!game) {
        // No game loaded -> clean closed snapshot (callers treat open=false as CANNOT-RUN).
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

    // in_transition (ADDITIVE field, 2026-07-08 fix requirement #2): with the snapshot itself now
    // race-free, `active_id == -1 while button rows exist` can no longer be a TORN read -- but it
    // remains a real, legitimately observable cross-frame game state (sheet closed, buttons not
    // yet cleared by the next interface frame). Tag it so consumers (menuwalk recorder) can skip
    // transition states instead of banking them as menu ground truth.
    bool in_transition = (vs.active_id == -1) && !b.button.empty();
    body << ",\"in_transition\":" << (in_transition ? "true" : "false");

    // A menu is actually open iff the button vector is non-empty (callers must treat open=false as
    // CANNOT-RUN, never as PASS) -- identical rule to menu_oracle.lua.
    bool open = !b.button.empty();
    body << ",\"open\":" << (open ? "true" : "false");
    body << "}\n";
    return body.str();
}

// SEH backstop for the snapshot body: converts any residual access violation into an error
// result instead of killing DF (same trivial-filter pattern as tile_dump.cpp's dump_atlas).
// The wrapped function keeps all unwindable C++ locals in the callee (MSVC C2712 rule).
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

// ------------------------------------------------------------------------------------------------
// THREADING TRUTH (2026-07-08; fix-batch item #0; full dossier:
// docs/superpowers/specs/2026-07-08-menuwalk-report.md section 1).
//
// Which thread mutates main_interface.building.{button,filtered_button}? Established from
// crash forensics + the DFHack fork source (<DFHACK_ROOT>), NOT assumed:
//
//   * DF exposes exactly two threads to DFHack (library/Hooks.cpp): the SIMULATION thread
//     (dfhooks_update -> Core::Update, Hooks.cpp:75-80) and the RENDER/"main" thread
//     (dfhooks_sdl_event / dfhooks_sdl_loop, Hooks.cpp:90-105). runOnRenderThread callbacks
//     drain on the render thread at DFH_SDL_Loop (Core.cpp:2041-2043) via
//     runRenderThreadCallbacks (modules/DFSDL.cpp:318-328), which holds ONLY its own
//     render_cb_lock -- ZERO synchronization against the simulation thread.
//   * A CoreSuspender parks the SIMULATION thread at its inter-frame boundary: Core::Update
//     ends with `CoreWakeup.wait(MainThread::suspend(), [toolCount==0])` (Core.cpp:1651-1652),
//     which is the only point the sim thread releases CoreSuspendMutex.
//   * Evidence leg 1 -- the B37 RPC-lua crashes (2026-07-08 06:57 + 07:32) ran WITH the sim
//     thread parked: dfhack-run RPC commands execute under `CoreSuspender suspend;`
//     (RemoteServer.cpp:353-361, no SF_DONT_SUSPEND on RunCommand) and the lua script body runs
//     under a second, recursive CoreSuspender inside Lua::RunCoreQueryLoop (LuaTools.cpp:1210
//     via runLuaScript, Core.cpp:327-336). The buttons were STILL freed mid-read
//     => a mutation window exists OFF the simulation thread.
//   * Evidence leg 2 -- crashes #4/#5 (this route's previous shape): the reader ran ON the
//     render thread (inside a runOnRenderThread callback) and still hit freed-and-reused button
//     memory mid-iteration (stderr `Class not in symbols.xml: 'std::_Associated_state<int>'` /
//     `'dummy'` = virtual_cast on garbage) => a mutation window exists OFF the render thread,
//     i.e. on the simulation thread (click-driven sheet teardown/rebuild). The old comment
//     "the render thread is the SAME thread that mutates these vectors -- safe by construction"
//     is empirically FALSE.
//   => Mutation windows exist on BOTH threads. No single-context read is safe; the snapshot
//      must exclude both DF threads simultaneously.
//
// FIX SHAPE: "park the render thread, THEN core-suspend the sim thread, THEN read on the HTTP
// worker thread". Chosen over the superficially simpler "hold CoreSuspender + wait on a
// runOnRenderThread hop" because that inverted order violates this repo's hard-won LAW
// ("never wait on a render hop while core-suspended" -- hud.cpp:327, placement.cpp:713-714,
// after the observed 2026-07-07 01:23 full-process wedge documented at http_server.cpp:1031-1035
// and dwf.cpp:138-143): while we hold the suspension, our callback can be queued BEHIND
// another route's render-thread work (e.g. /tiledump's capture) that itself blocks on the
// suspended sim thread -> permanent three-way deadlock. The park-first order cannot wedge:
//
//   1. Queue a render-thread callback whose ONLY job is to PARK: flag render_parked, then wait
//      on the request cv until released (bounded watchdog). It touches no DF state and takes no
//      DFHack lock, so unlike the tiledump callback it cannot block on the sim thread.
//   2. The HTTP worker waits (bounded) for render_parked, then HOLDS request->m for the entire
//      read. While m is held, the parked callback cannot return from cv.wait_for -- even after
//      its watchdog expires it must reacquire m first -- so the park PROVABLY spans the read.
//   3. With the render thread captive, acquire the core suspension with BOUNDED attempts
//      (ConditionalCoreSuspender = toolCount++ then try_lock_for(100ms); Core.h:376-381 +
//      505-511). Bounded matters: IF DF's sim thread ever needed the (currently parked) render
//      thread to finish a frame, an unbounded CoreSuspender here would wedge DF permanently;
//      bounded attempts degrade to an HTTP 503 instead, and the recorder simply retries.
//   4. Read + serialize on the HTTP worker thread. Sim thread: parked at Core.cpp:1651
//      (CoreSuspender held). Render thread: captive inside our park callback. Neither DF thread
//      can execute ANY DF code during the read, so the vectors cannot be torn down mid-iteration
//      and calling the text() vmethod is safe. SEH backstop converts any residual fault into a
//      500 instead of a dead DF.
//   5. Release: set release_render + notify AFTER the suspender scope closes. We never block on
//      the render thread while suspended (release is a non-blocking notify), keeping the LAW.
//
// COST (route is polled at 2-4 Hz): each successful read parks the sim thread for the suspender
// hold (~sub-ms JSON build; acquisition typically <= one sim frame) and holds the render thread
// for park-to-release (typically ~10-30 ms total: one render frame to reach the drain point +
// the suspend acquisition). Per-read quiesce timings are exported in the X-Menu-Oracle-Quiesce
// response header so the stress harness can bound this empirically.
// ------------------------------------------------------------------------------------------------

constexpr int PARK_WAIT_MS = 1500;         // HTTP worker's wait for the render thread to park
constexpr int SUSPEND_ATTEMPTS = 10;       // x try_lock_for(100ms) => <= ~1s suspend budget
constexpr int RENDER_WATCHDOG_MS = 8000;   // park self-release backstop (only reachable if the
                                           // HTTP worker abandoned before ever locking m)

struct MenuOracleQuiesce {
    std::mutex m;
    std::condition_variable cv;
    bool render_parked = false;
    bool release_render = false;
};

struct MenuOracleResult {
    bool ok = false;
    int http_status = 200;
    std::string error;         // set when !ok
    std::string json;          // set when ok
    int park_wait_ms = -1;     // time until the render thread was observed parked
    int suspend_attempts = 0;  // ConditionalCoreSuspender tries used
    int suspend_wait_ms = -1;  // time to acquire the core suspension
    int hold_ms = -1;          // suspension hold (the sim-pause cost of this read)
};

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
        // Park DF's render thread here until the HTTP worker finishes its quiesced read (or
        // until the watchdog, which can only actually fire while the worker does NOT hold m --
        // i.e. only when the worker already gave up and set release_render, or vanished).
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
        // Render thread never reached our callback (busy/wedged, e.g. a long atlas dump). No
        // snapshot was taken and none will be: when the callback eventually runs it sees
        // release_render and exits immediately without a read.
        q->release_render = true;
        q->cv.notify_all();
        out.http_status = 503;
        out.error = "render thread did not park within " + std::to_string(PARK_WAIT_MS) +
                    "ms; no snapshot taken (retry)";
        return out;
    }

    // From here until we release m, the render thread is captive inside the park callback.
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
    // GET /menu-oracle[?call_text=0] -> crash-safe QUIESCED snapshot of the currently-open
    // workshop add-task sheet (building.button / filtered_button rows with class discrimination,
    // filter_str, hotkey, objection, info, and DF's composed label via text()). Emits a clean
    // {open:false} snapshot when no sheet is open. Schema = truemenu-oracle-v1 (menu_oracle.lua)
    // + additive "in_transition" flag. On a missed quiesce window returns 503 with a JSON error
    // body (no snapshot was attempted -- callers just retry); per-read quiesce timings are in the
    // X-Menu-Oracle-Quiesce header.
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
