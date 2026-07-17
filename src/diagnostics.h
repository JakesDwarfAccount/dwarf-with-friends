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

#include "camera.h"

#include <cstdint>
#include <string>

namespace dwf {

struct CaptureDiagnostics {
    uint64_t attempts = 0;
    uint64_t successes = 0;
    uint64_t failures = 0;
    uint64_t last_frame_bytes = 0;
    int last_width = 0;
    int last_height = 0;
    int last_duration_ms = 0;
    Camera last_camera;
    std::string last_error;
    std::string last_event_utc;
};

struct HostState {
    bool world_loaded = false;
    bool map_loaded = false;
    bool viewscreen_ready = false;
    bool paused = false;
    Camera window;
    int map_w = 0;
    int map_h = 0;
    int map_z = 0;
    int gps_w = 0;
    int gps_h = 0;
    int viewport_w = 0;
    int viewport_h = 0;
};

struct ViewportProbe {
    bool has_gps = false;
    bool has_viewport = false;
    bool has_renderer = false;
    Camera window;
    int gps_dim_x = 0;
    int gps_dim_y = 0;
    int tile_pixel_x = 0;
    int tile_pixel_y = 0;
    int screen_pixel_x = 0;
    int screen_pixel_y = 0;
    int viewport_zoom_factor = 0;
    int viewport_dim_x = 0;
    int viewport_dim_y = 0;
    int viewport_screen_x = 0;
    int viewport_screen_y = 0;
    int viewport_clip_x0 = 0;
    int viewport_clip_x1 = 0;
    int viewport_clip_y0 = 0;
    int viewport_clip_y1 = 0;
    uint32_t viewport_flag = 0;
};

void diagnostics_log(const std::string& line);
// Verbose transport tracing (WS connection lifecycle, writer/push-loop counters).
// Default OFF: every diagnostics_log() is a global mutex + file open/write/close,
// which is real per-frame cost on the hot push path (it measurably added pan jitter).
// Toggle at runtime with the `capture-diag-verbose on|off` DFHack command.
bool diagnostics_verbose();
void set_diagnostics_verbose(bool on);
// Log only when verbose tracing is on. Checks the flag BEFORE any locking or I/O,
// so a disabled call site costs one relaxed atomic load (plus building the string
// argument -- keep heavyweight formatting out of hot paths regardless).
void diagnostics_log_v(const std::string& line);

// --- WT24: crash-evidence breadcrumbs ------------------------------------------------
// After the 2026-07-13 STATUS_HEAP_CORRUPTION death we could not tell from dwf.log
// whether the plugin's threads were even alive at the moment DF died. Heap corruption is
// detected at an arbitrary LATER free, so the log timeline is the only thing that bounds
// the window -- and the log was silent for 32 minutes.
//
// The breadcrumb records WHICH stage of the push tick we are inside right now. It is pure
// atomics: a couple of relaxed stores per enter/exit, no allocation, no locking, NO I/O --
// safe to call on the 30 Hz push path (unlike diagnostics_log, which is a global mutex plus
// a file open/write/close and has measurably added pan jitter before).
//
// The breadcrumb is FLUSHED to the log only by the 60 s heartbeat, the stall watchdog, and
// the shutdown mark. `name` must be a string LITERAL -- the pointer is stored, not the bytes.
long long diag_steady_ms();
void diag_phase_enter(const char* name);
void diag_phase_exit();

struct PhaseSnapshot {
    const char* name = "none";   // last phase entered
    uint64_t seq = 0;            // phase enters since plugin load (proves the loop advances)
    long long entered_ms = 0;    // diag_steady_ms() at that enter
    bool inside = false;         // true => we are still inside it (a stuck phase never exits)
};
PhaseSnapshot diag_phase_snapshot();

// RAII guard for a push-loop stage. Exits on any path, including an exception.
struct DiagPhase {
    explicit DiagPhase(const char* name) { diag_phase_enter(name); }
    ~DiagPhase() { diag_phase_exit(); }
    DiagPhase(const DiagPhase&) = delete;
    DiagPhase& operator=(const DiagPhase&) = delete;
};

void diagnostics_capture_attempt(const Camera& camera);
void diagnostics_capture_success(const Camera& camera, int width, int height,
                                 uint64_t bytes, int duration_ms);
void diagnostics_capture_failure(const Camera& camera, const std::string& err,
                                 int duration_ms);
void diagnostics_reset();

CaptureDiagnostics diagnostics_snapshot();
std::string diagnostics_json(const std::string& player, const Camera& camera,
                             const CaptureDiagnostics& stats);

bool host_state_on_render_thread(HostState& state, std::string* err = nullptr);
std::string host_state_json(const HostState& state);

bool viewport_probe_on_render_thread(ViewportProbe& probe, std::string* err = nullptr);
std::string viewport_probe_json(const ViewportProbe& probe);

} // namespace dwf
