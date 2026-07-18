// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2025 - 2026 Gabriel Rios
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

#include "Core.h"
#include "Export.h"
#include "PluginManager.h"
#include "modules/DFSDL.h"

#include "auth.h"
#include "bake_sweep.h"
#include "chat.h"
#include "diagnostics.h"
#include "http_server.h"
#include "image_encoder.h"
#include "overlay_control.h"
#include "pause_arbiter.h"
#include "portrait_sweep.h"
#include "sdl_capture.h"
#include "tile_dump.h"
#include "tile_map_dump.h"
#include "unit_sprites.h"
#include "web_assets.h"
#include "wire_v1.h"

#include "df/global_objects.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

using namespace DFHack;

DFHACK_PLUGIN("dwf");

namespace {

bool parse_port(const std::string& text, int& port) {
    char* end = nullptr;
    long value = std::strtol(text.c_str(), &end, 10);
    if (!end || *end != '\0' || value < 1 || value > 65535)
        return false;
    port = static_cast<int>(value);
    return true;
}

void print_line(color_ostream& out, const std::string& text) {
    out.print("%s", text.c_str());
}

// JOIN SECURITY (ship-blocker): the host's shared join passphrase. Sourced (in priority order)
// from an explicit `capture-join-password` command, else the config file dfcapture_join_password.txt
// in the DF working directory (first non-blank line). No file / empty => auth stays DISABLED
// (dev-friendly open behavior) and we log a LOUD warning -- the SHIP default should be a password.
const char* kJoinPasswordFile = dwf::auth::kPasswordFile;   // single source of truth (auth.h)

void load_join_password_from_file(color_ostream& out) {
    std::ifstream f(kJoinPasswordFile);
    std::string pass;
    if (f) {
        std::string line;
        while (std::getline(f, line)) {
            // trim
            size_t b = 0, e = line.size();
            while (b < e && (unsigned char)line[b] <= ' ') ++b;
            while (e > b && (unsigned char)line[e - 1] <= ' ') --e;
            std::string t = line.substr(b, e - b);
            if (!t.empty() && t[0] != '#') { pass = t; break; }
        }
    }
    dwf::auth::set_password(pass);
    if (dwf::auth::enabled()) {
        dwf::diagnostics_log("join security ENABLED (passphrase set from " +
                                   std::string(kJoinPasswordFile) + ")");
        print_line(out, "dwf: join security ON (shared passphrase set).\n");
    } else {
        dwf::diagnostics_log("WARNING: no join password set -- server is OPEN to anyone who "
                                   "can reach the port. Set one in " + std::string(kJoinPasswordFile) +
                                   " (or via capture-join-password) before sharing publicly.");
        print_line(out, "dwf: WARNING -- no join password set; the server is OPEN. Create " +
                        std::string(kJoinPasswordFile) + " (one line = the shared passphrase) or run "
                        "`capture-join-password <pass>` before sharing beyond your own machine.\n");
    }
}

command_result cmd_join_password(color_ostream& out, std::vector<std::string>& args) {
    if (args.empty()) {
        print_line(out, std::string("dwf: join security is ") +
                        (dwf::auth::enabled() ? "ON (a passphrase is set)."
                                                    : "OFF (server is open).") + "\n");
        print_line(out, "usage: capture-join-password <passphrase> | off | reload\n");
        return CR_OK;
    }
    if (args[0] == "off" || args[0] == "none" || args[0] == "clear") {
        dwf::auth::set_password("");
        dwf::diagnostics_log("join security DISABLED via command");
        print_line(out, "dwf: join security OFF (server is now open).\n");
        return CR_OK;
    }
    if (args[0] == "reload") {
        load_join_password_from_file(out);
        return CR_OK;
    }
    // The rest of the line (allows spaces in the passphrase).
    std::string pass = args[0];
    for (size_t i = 1; i < args.size(); ++i) pass += " " + args[i];
    dwf::auth::set_password(pass);
    dwf::diagnostics_log("join security ENABLED via command");
    print_line(out, dwf::auth::enabled()
                        ? "dwf: join security ON (passphrase set).\n"
                        : "dwf: passphrase was blank; join security still OFF.\n");
    return CR_OK;
}

void write_debug_capture(dwf::Camera camera, const char* path) {
    dwf::CapturedFrame frame;
    std::string err;
    if (!dwf::capture_camera_frame(camera, frame, &err)) {
        dwf::diagnostics_log(std::string("debug capture failed: ") + err);
        return;
    }
    if (!dwf::write_bmp(path, frame, &err))
        dwf::diagnostics_log(std::string("debug BMP write failed: ") + err);
}

void write_current_debug_capture() {
    if (!df::global::window_x || !df::global::window_y || !df::global::window_z) {
        dwf::diagnostics_log("debug capture failed: DF window coordinates are unavailable");
        return;
    }
    dwf::Camera camera;
    camera.x = *df::global::window_x;
    camera.y = *df::global::window_y;
    camera.z = *df::global::window_z;
    write_debug_capture(camera, "dwf_test.bmp");
}

command_result cmd_capture(color_ostream& out, std::vector<std::string>&) {
    dwf::diagnostics_log("--- capture requested ---");
    DFHack::runOnRenderThread([]() { write_current_debug_capture(); });
    out.print("dwf: queued; check dwf_test.bmp / dwf.log in the DF folder.\n");
    return CR_OK;
}

command_result cmd_capture_at(color_ostream& out, std::vector<std::string>& args) {
    if (args.size() < 3) {
        out.printerr("usage: capture-at <x> <y> <z>\n");
        return CR_WRONG_USAGE;
    }
    dwf::Camera camera;
    camera.x = std::atoi(args[0].c_str());
    camera.y = std::atoi(args[1].c_str());
    camera.z = std::atoi(args[2].c_str());
    dwf::diagnostics_log("--- capture-at requested ---");
    DFHack::runOnRenderThread([camera]() { write_debug_capture(camera, "dwf_at.bmp"); });
    out.print("dwf: queued capture-at; check dwf_at.bmp / dwf.log.\n");
    return CR_OK;
}

command_result cmd_tiledump(color_ostream& out, std::vector<std::string>& args) {
#ifdef _WIN32
    // usage: capture-tiledump [x y z] [dir=NAME] [noatlas] [nogt]
    //   no args        -> host camera, full dump (atlas + ground truth), dir dwf_tiledump
    //   x y z          -> render THAT camera's viewport (render-buffer feasibility probe)
    //   dir=NAME       -> output directory (relative to DF root)
    //   noatlas / nogt -> skip the ~129k-file atlas / the ground-truth PNG (sweep dumps)
    dwf::TileDumpOptions opt;
    std::string dir = "dwf_tiledump";
    std::vector<int> nums;
    for (const auto& a : args) {
        if (a == "noatlas")               opt.with_atlas = false;
        else if (a == "nogt")             opt.with_ground_truth = false;
        else if (a.rfind("dir=", 0) == 0) dir = a.substr(4);
        else                              nums.push_back(std::atoi(a.c_str()));
    }
    if (!nums.empty()) {
        if (nums.size() != 3) {
            out.printerr("usage: capture-tiledump [x y z] [dir=NAME] [noatlas] [nogt]\n");
            return CR_WRONG_USAGE;
        }
        opt.have_camera = true;
        opt.x = nums[0]; opt.y = nums[1]; opt.z = nums[2];
    }
    if (dir.empty() || dir.find("..") != std::string::npos) {
        out.printerr("capture-tiledump: bad dir\n");
        return CR_WRONG_USAGE;
    }
    // DEADLOCK GUARD (2026-07-07): console commands run with the core suspended; waiting on
    // the render-thread capture from here wedges DF permanently (the native map re-render
    // blocks against the suspended main thread — observed full-process hang, dwf.log
    // 01:23 "camera ok; capturing" then nothing). So the console command is FIRE-AND-FORGET
    // on a detached worker; the HTTP GET /tiledump route is the synchronous interface (it
    // runs on an httplib worker thread, the same proven context as /frame.jpg).
    std::thread([dir, opt]() {
        std::string err;
        if (!dwf::dump_tile_frame_ex(dir, opt, &err))
            dwf::diagnostics_log("capture-tiledump (async) FAILED: " + err);
    }).detach();
    out.print("capture-tiledump: queued (async); poll %s/meta.json + dwf.log, "
              "or use GET /tiledump for a synchronous run.\n", dir.c_str());
    return CR_OK;
#else
    out.printerr("capture-tiledump is Windows-only.\n");
    return CR_FAILURE;
#endif
}

command_result cmd_mapdump(color_ostream& out, std::vector<std::string>& args) {
    // WS2 map-data pivot: crash-safe read of the current host viewport window via
    // the stable Maps/MapCache/units/buildings APIs (NOT render-buffer scraping).
    // usage: capture-mapdump [width] [height]   (0/omitted => auto from screen grid)
    int width = 0, height = 0;
    if (args.size() >= 1) width = std::atoi(args[0].c_str());
    if (args.size() >= 2) height = std::atoi(args[1].c_str());
    dwf::diagnostics_log("--- capture-mapdump requested ---");
    std::string err;
    if (!dwf::dump_map_window("dwf_mapdump", width, height, &err)) {
        out.printerr("capture-mapdump: %s\n", err.c_str());
        return CR_FAILURE;
    }
    out.print("capture-mapdump: wrote dwf_mapdump/map.json\n");
    return CR_OK;
}

command_result cmd_start(color_ostream& out, std::vector<std::string>& args) {
#ifdef _WIN32
    int port = dwf::DEFAULT_STREAM_PORT;
    std::string bind_address = dwf::DEFAULT_BIND_ADDRESS;

    if (!args.empty() && !parse_port(args[0], port)) {
        out.printerr("capture-stream-start: invalid port: %s\n", args[0].c_str());
        return CR_FAILURE;
    }
    if (args.size() >= 2)
        bind_address = args[1];

    std::string missing;
    if (!dwf::web_assets_ok(&missing)) {
        out.printerr("dwf: web UI not found: %s\n", missing.c_str());
        out.printerr("deploy the plugin's web/ folder to <Dwarf Fortress>/%s/ and retry.\n",
                     dwf::web_root());
        dwf::diagnostics_log("web assets missing: " + missing);
        return CR_FAILURE;
    }

    if (dwf::server_running()) {
        out.printerr("dwf: stream server is already running\n");
        return CR_FAILURE;
    }

    std::string overlay_note;
    if (!dwf::disable_overlay_for_stream(out, &overlay_note)) {
        out.printerr("dwf: cannot stream -- %s\n", overlay_note.c_str());
        dwf::diagnostics_log("stream start failed: overlay could not be disabled: " +
                                          overlay_note);
        return CR_FAILURE;
    }

    // JOIN SECURITY: load the shared passphrase (file) unless one was already set via command.
    if (dwf::auth::enabled())
        print_line(out, "dwf: join security ON (passphrase set earlier this session).\n");
    else
        load_join_password_from_file(out);

    // Restore the host's durable pause flags (hostUnpauseOnly / autopause) from the prior session
    // (item 5). No-op when the file is absent -> compiled defaults (hostunpause off, autopause on).
    dwf::pause_load_persisted_flags();

    std::string err;
    if (!dwf::start_server(port, bind_address, &err)) {
        dwf::restore_overlay_after_stream(&out);
        out.printerr("dwf: %s\n", err.c_str());
        return CR_FAILURE;
    }

    dwf::bake_sweep_arm_auto();
    // WE-1/WE-2 (issue #1 "naked dwarves"): the per-unit clothed composites shipped with BOTH
    // feature flags default-OFF and no production path ever enabled them, so every fort fell
    // back to the static base creature art. The copy path is SEH-guarded with fault caps now;
    // enable with the stream. capture-unit-census / capture-unit-sprites stay as kill switches.
    dwf::set_unit_census_enabled(true);
    dwf::set_unit_sprite_export_enabled(true);
    dwf::diagnostics_log("server started " +
                                      dwf::server_url(bind_address, port));
    print_line(out, "dwf: stream server at " +
                    dwf::server_url(bind_address, port) + "\n");
    if (!overlay_note.empty())
        print_line(out, "dwf: " + overlay_note + "\n");
    return CR_OK;
#else
    out.printerr("dwf streaming is currently Windows-only.\n");
    return CR_FAILURE;
#endif
}

command_result cmd_stop(color_ostream& out, std::vector<std::string>&) {
#ifdef _WIN32
    dwf::stop_server();
    dwf::restore_overlay_after_stream(&out);
    dwf::diagnostics_log("server stopped");
    out.print("dwf: stream server stopped.\n");
    return CR_OK;
#else
    out.printerr("dwf streaming is currently Windows-only.\n");
    return CR_FAILURE;
#endif
}

command_result cmd_diag_verbose(color_ostream& out, std::vector<std::string>& args) {
    // Toggle the verbose WS-transport tracing (connection lifecycle, writer/push-loop
    // counters) that is compiled in but gated OFF by default -- each trace line is a
    // mutex-serialized file open/write/close of dwf.log, so it stays off unless
    // actively diagnosing. Usage: capture-diag-verbose [on|off]  (no arg = show state).
    if (!args.empty()) {
        const std::string& a = args[0];
        if (a == "on" || a == "1" || a == "true")       dwf::set_diagnostics_verbose(true);
        else if (a == "off" || a == "0" || a == "false") dwf::set_diagnostics_verbose(false);
        else {
            out.printerr("usage: capture-diag-verbose [on|off]\n");
            return CR_WRONG_USAGE;
        }
    }
    print_line(out, std::string("dwf: verbose transport tracing is ") +
                    (dwf::diagnostics_verbose() ? "ON" : "off") + "\n");
    return CR_OK;
}

command_result cmd_bake_sweep(color_ostream& out, std::vector<std::string>&) {
    dwf::bake_sweep_arm_manual();
    out.print("capture-bake-sweep: armed; the next stream tick will plan visible units and render one box per tick.\n");
    return CR_OK;
}

command_result cmd_portrait_sweep(color_ostream& out, std::vector<std::string>& args) {
    // PORTRAITS-ROOT (B128): the sweep arms itself from the unit scan; this command is
    // for observability (`status`, the default) and recovery (`rearm` forgets dropped
    // units so the next scan re-offers everything still at portrait_texpos 0).
    if (!args.empty() && args[0] == "rearm") {
        dwf::portrait_sweep_rearm();
        out.print("capture-portrait-sweep: rearmed; next stream tick re-offers all units without portraits.\n");
        return CR_OK;
    }
    if (!args.empty() && args[0] != "status") {
        out.printerr("usage: capture-portrait-sweep [status|rearm]\n");
        return CR_WRONG_USAGE;
    }
    out.print("%s\n", dwf::portrait_sweep_status().c_str());
    return CR_OK;
}

command_result cmd_unit_census(color_ostream& out, std::vector<std::string>& args) {
    // WE-1: toggle the per-unit texture census + dirty tracker (unit_sprites.h/.cpp).
    // Default OFF -- a no-op read pass compiled in but gated, same pattern as
    // capture-diag-verbose. Usage: capture-unit-census [on|off]  (no arg = show state).
    if (!args.empty()) {
        const std::string& a = args[0];
        if (a == "on" || a == "1" || a == "true")       dwf::set_unit_census_enabled(true);
        else if (a == "off" || a == "0" || a == "false") dwf::set_unit_census_enabled(false);
        else {
            out.printerr("usage: capture-unit-census [on|off]\n");
            return CR_WRONG_USAGE;
        }
    }
    print_line(out, std::string("dwf: unit texture census is ") +
                    (dwf::unit_census_enabled() ? "ON" : "off") + "\n");
    return CR_OK;
}

command_result cmd_unit_sprites(color_ostream& out, std::vector<std::string>& args) {
    // WE-2: toggle the per-unit composite export worker (unit_sprites.h/.cpp). Consumes
    // WE-1's dirty queue -- also enable `capture-unit-census on` for this to do anything.
    // Default OFF. Usage: capture-unit-sprites [on|off]  (no arg = show state).
    if (!args.empty()) {
        const std::string& a = args[0];
        if (a == "on" || a == "1" || a == "true")       dwf::set_unit_sprite_export_enabled(true);
        else if (a == "off" || a == "0" || a == "false") dwf::set_unit_sprite_export_enabled(false);
        else {
            out.printerr("usage: capture-unit-sprites [on|off]\n");
            return CR_WRONG_USAGE;
        }
    }
    print_line(out, std::string("dwf: unit composite export is ") +
                    (dwf::unit_sprite_export_enabled() ? "ON" : "off") + "\n");
    return CR_OK;
}

command_result cmd_wire_selftest(color_ostream& out, std::vector<std::string>&) {
    // WA-8: encode the deterministic synthetic 2-block fixture (void, water 7, magma 3,
    // hidden, all desig bits, item/plant/spatter tails, plant id "OAK"/"", clamp, negative
    // mats, u16 bx>255) via the PURE wire codec -- no DF world needed, runs at the title
    // screen. Writes dwf_wire_fixture.bin next to dwf.log and asserts its CRC32
    // against the embedded golden constant (which the JS generator gen_wire_fixture.mjs +
    // the node decode test share). PASS proves the C++ + JS encoders agree byte-for-byte.
    uint32_t world_seq = 0;
    std::vector<uint8_t> frame = dwf::wire::build_selftest_fixture(&world_seq);
    uint32_t crc = dwf::wire::crc32(frame.data(), frame.size());
    bool ok = (crc == dwf::wire::kSelftestFixtureCrc);
    {
        std::ofstream f("dwf_wire_fixture.bin", std::ios::binary);
        if (f) f.write(reinterpret_cast<const char*>(frame.data()), (std::streamsize)frame.size());
    }
    char msg[160];
    std::snprintf(msg, sizeof(msg),
                  "capture-wire-selftest: %s crc=0x%08X expected=0x%08X bytes=%zu world_seq=%u\n",
                  ok ? "PASS" : "FAIL", crc, dwf::wire::kSelftestFixtureCrc,
                  frame.size(), world_seq);
    print_line(out, msg);
    dwf::diagnostics_log(std::string("wire-selftest ") + (ok ? "PASS" : "FAIL") +
                              " crc=" + std::to_string(crc));
    return ok ? CR_OK : CR_FAILURE;
}

command_result cmd_chat_selftest(color_ostream& out, std::vector<std::string>&) {
    // WP-D: exercise chat_sanitize (trim, empty-reject, XSS-seed passthrough, overlong clamp,
    // UTF-8 boundary) with NO DF/world access -- runs at the title screen. PASS proves the
    // server-side chat text validation matches the client-side offline test's expectations.
    bool ok = dwf::chat_selftest();
    print_line(out, std::string("capture-chat-selftest: ") + (ok ? "PASS\n" : "FAIL\n"));
    return ok ? CR_OK : CR_FAILURE;
}

command_result cmd_itemdef_dump(color_ostream& out, std::vector<std::string>&) {
    // WC-1: build the ITEMDEF_DICT (14 raw itemdef subcategories -> id/token pairs, Items.cpp
    // ITEMDEF_VECTORS order) from the CURRENTLY LOADED world's raws and write both the raw
    // wire bytes (dwf_itemdef_dict.bin, byte-identical to what world_stream.cpp sends
    // each v1 connection once) and a greppable "SUBCAT_INDEX ID TOKEN" listing
    // (dwf_itemdef_dict.txt) -- the acceptance-gate artifact for
    // `grep -c ITEM_WEAPON_ dwf_itemdef_dict.txt` (WC-1 spec §2, "Item check").
    // Requires a loaded world (itemdef raws are per-save); title screen -> no world -> error.
    dwf::wire::ItemDefSubcat subcats[dwf::wire::kItemDefSubcatCount];
    {
        CoreSuspender suspend;
        auto world = df::global::world;
        if (!world) {
            out.printerr("capture-itemdef-dump: no world loaded\n");
            return CR_FAILURE;
        }
        dwf::wire::read_itemdef_dict(world, subcats);
    }
    static const char* kSubcatName[dwf::wire::kItemDefSubcatCount] = {
        "WEAPON", "TRAPCOMP", "TOY", "TOOL", "INSTRUMENT", "ARMOR", "AMMO",
        "SIEGEAMMO", "GLOVES", "SHOES", "SHIELD", "HELM", "PANTS", "FOOD"
    };
    std::vector<uint8_t> payload = dwf::wire::assemble_itemdef_dict(subcats);
    {
        std::ofstream f("dwf_itemdef_dict.bin", std::ios::binary);
        if (f) f.write(reinterpret_cast<const char*>(payload.data()), (std::streamsize)payload.size());
    }
    size_t total = 0;
    {
        std::ofstream tf("dwf_itemdef_dict.txt");
        for (size_t sc = 0; sc < dwf::wire::kItemDefSubcatCount; ++sc) {
            for (const auto& e : subcats[sc]) {
                tf << kSubcatName[sc] << " " << e.id << " " << e.token << "\n";
                ++total;
            }
        }
    }
    char msg[160];
    std::snprintf(msg, sizeof(msg),
                  "capture-itemdef-dump: wrote %zu entries across %zu subcats, payload=%zu bytes\n",
                  total, dwf::wire::kItemDefSubcatCount, payload.size());
    print_line(out, msg);
    return CR_OK;
}

command_result cmd_status(color_ostream& out, std::vector<std::string>&) {
#ifdef _WIN32
    if (dwf::server_running())
        print_line(out, "dwf: stream server running at " +
                        dwf::server_url() + "\n");
    else
        out.print("dwf: stream server stopped.\n");
    return CR_OK;
#else
    out.printerr("dwf streaming is currently Windows-only.\n");
    return CR_FAILURE;
#endif
}

} // namespace

DFhackCExport command_result plugin_init(color_ostream& out, std::vector<PluginCommand>& commands) {
    commands.push_back(PluginCommand(
        "capture",
        "Path-2 test: render the current view offscreen and save dwf_test.bmp",
        cmd_capture));
    commands.push_back(PluginCommand(
        "capture-at",
        "Path-2 test: render an arbitrary camera <x> <y> <z> offscreen -> dwf_at.bmp",
        cmd_capture_at));
    commands.push_back(PluginCommand(
        "capture-tiledump",
        "WS2 gate: dump one frame's tile arrays + texpos atlas + a ground-truth PNG",
        cmd_tiledump));
    commands.push_back(PluginCommand(
        "capture-mapdump",
        "WS2 pivot: crash-safe dump of the current viewport's map data (tiles/liquids/units/buildings) -> dwf_mapdump/map.json; usage: capture-mapdump [width] [height]",
        cmd_mapdump));
    commands.push_back(PluginCommand(
        "capture-stream-start",
        "Start the premium MJPEG stream server; usage: capture-stream-start [port] [bind-address]",
        cmd_start));
    commands.push_back(PluginCommand(
        "capture-stream-stop",
        "Stop the premium MJPEG stream server",
        cmd_stop));
    commands.push_back(PluginCommand(
        "capture-stream-status",
        "Show the premium stream server status",
        cmd_status));
    commands.push_back(PluginCommand(
        "capture-diag-verbose",
        "Toggle verbose WS-transport tracing to dwf.log (per-connection lifecycle + per-second counters); usage: capture-diag-verbose [on|off]",
        cmd_diag_verbose));
    commands.push_back(PluginCommand(
        "capture-bake-sweep",
        "Queue a paced host-camera portrait bake sweep for visible units; it never unpauses DF",
        cmd_bake_sweep));
    commands.push_back(PluginCommand(
        "capture-portrait-sweep",
        "B128: paced native unit-portrait generation for every streamed unit (auto-armed at world load; new arrivals join automatically); usage: capture-portrait-sweep [status|rearm]",
        cmd_portrait_sweep));
    commands.push_back(PluginCommand(
        "capture-unit-census",
        "WE-1: toggle the per-unit texture census + dirty tracker (read-pass tracker feeding the future per-unit composite exporter); usage: capture-unit-census [on|off]",
        cmd_unit_census));
    commands.push_back(PluginCommand(
        "capture-unit-sprites",
        "WE-2: toggle the per-unit composite export worker (drains WE-1's dirty queue, exports "
        "content-addressed PNGs served at /unit-sprite/<hash>.png); requires capture-unit-census "
        "on too; usage: capture-unit-sprites [on|off]",
        cmd_unit_sprites));
    commands.push_back(PluginCommand(
        "capture-wire-selftest",
        "WA-8: encode the synthetic protocol-v1 BLOCK_SET fixture, write dwf_wire_fixture.bin, and assert its CRC32 (title screen OK, no world needed)",
        cmd_wire_selftest));
    commands.push_back(PluginCommand(
        "capture-join-password",
        "JOIN SECURITY: set/clear the shared join passphrase friends must enter to connect; "
        "usage: capture-join-password <passphrase> | off | reload (reload re-reads "
        "dfcapture_join_password.txt). No args prints current state.",
        cmd_join_password));
    commands.push_back(PluginCommand(
        "capture-chat-selftest",
        "WP-D: assert the chat text sanitizer (trim / empty-reject / XSS-seed passthrough / "
        "overlong clamp / UTF-8 boundary) offline (title screen OK, no world needed)",
        cmd_chat_selftest));
    commands.push_back(PluginCommand(
        "capture-itemdef-dump",
        "WC-1: dump the ITEMDEF_DICT (14 itemdef subcats -> id/token pairs) from the loaded "
        "world's raws to dwf_itemdef_dict.bin (wire bytes) + .txt (greppable listing); "
        "requires a loaded save",
        cmd_itemdef_dump));

    out.print("dwf: loaded. Start browser streaming after a fort is loaded with: capture-stream-start\n");
    return CR_OK;
}

DFhackCExport command_result plugin_shutdown(color_ostream&) {
#ifdef _WIN32
    dwf::diagnostics_log("plugin shutdown");
    dwf::stop_server();
    dwf::restore_overlay_after_stream();
    dwf::shutdown_image_encoder();
    dwf::unit_sprite_export_shutdown();  // WE-2: join the background export worker
    // WT24: THE clean-exit mark, and deliberately the LAST thing dwf ever writes.
    // DFHack calls plugin_shutdown when the plugin is unloaded and when DF exits normally, so:
    //   tail ends with SHUTDOWN-CLEAN  -> DF (or the plugin) stopped on purpose.
    //   tail ends with anything else   -> DF was killed or crashed; the last HEARTBEAT bounds
    //                                     the time of death to a <=60 s window, and the phase /
    //                                     STALL lines say which stage the threads were in.
    dwf::diagnostics_log("SHUTDOWN-CLEAN dwf unloaded (DF exiting or plugin "
                               "unloaded) -- a log that does NOT end here ended in a crash/kill");
#endif
    return CR_OK;
}
