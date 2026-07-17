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

#include "tile_dump.h"
#include "camera.h"
#include "diagnostics.h"
#include "frame.h"
#include "image_encoder.h"
#include "sdl_capture.h"

#include "DataDefs.h"
#include "Core.h"
#include "modules/DFSDL.h"
#include "df/enabler.h"
#include "df/global_objects.h"
#include "df/world.h"

#include <SDL_surface.h>   // SDL2_INCLUDE_DIRS added in CMakeLists (Step 1)

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <future>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#endif

using namespace DFHack;

namespace dwf {
namespace {

#ifdef _WIN32
int dwf_seh_filter_local(struct _EXCEPTION_POINTERS*) { return EXCEPTION_EXECUTE_HANDLER; }
#endif

void mkdirs(const std::string& p) {
#ifdef _WIN32
    std::string cur;
    for (char c : p) {
        cur.push_back(c);
        if (c == '/' || c == '\\') _mkdir(cur.c_str());
    }
    _mkdir(p.c_str());
#endif
}

void put_u32(std::vector<uint8_t>& b, uint32_t v) {
    b.push_back(v & 0xff); b.push_back((v >> 8) & 0xff);
    b.push_back((v >> 16) & 0xff); b.push_back((v >> 24) & 0xff);
}
void put_i32(std::vector<uint8_t>& b, int32_t v) { put_u32(b, (uint32_t)v); }

// Object-owning worker for dump_atlas. Kept separate from the SEH wrapper because MSVC
// forbids __try in a function that owns C++ objects requiring unwinding (C2712).
// NOTE: the dwf plugin does not link SDL at build time; it reaches SDL through
// DFHack's DFSDL wrapper module (modules/DFSDL.h). So we normalise via
// DFSDL_AllocFormat + DFSDL_ConvertSurface + DFSDL_FreeSurface rather than the direct
// SDL_ConvertSurfaceFormat (which would be an unresolved external at link).
bool dump_atlas_impl(const std::string& atlas_dir, std::string* err) {
    auto en = df::global::enabler;
    if (!en) { if (err) *err = "no enabler"; return false; }
    auto& raws = en->textures.raws;   // std::vector<void*>, each a SDL_Surface*
    // Allocate the target format once (no DFSDL_FreeFormat is exported; one-shot leak ok).
    SDL_PixelFormat* fmt = DFHack::DFSDL::DFSDL_AllocFormat(SDL_PIXELFORMAT_ABGR8888);
    std::string index = "{\"wire\":1,\"tiles\":{";
    bool first = true;
    int written = 0;
    for (size_t i = 0; i < raws.size(); ++i) {
        SDL_Surface* s = reinterpret_cast<SDL_Surface*>(raws[i]);
        if (!s || !s->pixels || s->w <= 0 || s->h <= 0) continue;   // null slots -> skip
        // Normalise to RGBA8888 (byte order R,G,B,A on little-endian) so the offline/JS
        // side never needs per-surface format math.
        SDL_Surface* conv = fmt ? DFHack::DFSDL::DFSDL_ConvertSurface(s, fmt, 0) : nullptr;
        SDL_Surface* use = conv ? conv : s;
        std::string path = atlas_dir + "/tex_" + std::to_string(i) + ".rgba";
        std::ofstream f(path, std::ios::binary);
        for (int y = 0; y < use->h; ++y)
            f.write(reinterpret_cast<const char*>(use->pixels) + (size_t)y * use->pitch,
                    (std::streamsize)use->w * 4);
        f.close();
        if (!first) index += ",";
        first = false;
        index += "\"" + std::to_string(i) + "\":{\"w\":" + std::to_string(use->w) +
                 ",\"h\":" + std::to_string(use->h) + "}";
        ++written;
        if (conv) DFHack::DFSDL::DFSDL_FreeSurface(conv);
    }
    index += "}}";
    std::ofstream idx(atlas_dir + "/index.json", std::ios::binary);
    idx << index;
    if (written == 0) { if (err) *err = "atlas: 0 non-null surfaces in enabler->textures.raws"; return false; }
    return true;
}

// Runs on the render thread. SEH wrapper only (no unwindable locals) around dump_atlas_impl.
bool dump_atlas(const std::string& atlas_dir, std::string* err) {
    bool ok = false;
#ifdef _WIN32
    __try {
#endif
        ok = dump_atlas_impl(atlas_dir, err);
#ifdef _WIN32
    } __except (dwf_seh_filter_local(GetExceptionInformation())) {
        if (err) *err = "SEH fault dumping atlas";
        ok = false;
    }
#endif
    return ok;
}

// Marshals dump_atlas onto the render thread. The atlas (enabler->textures.raws) is the
// persistent tileset table and does NOT depend on the viewport render, so this runs as its
// own hop, independent of (and unconditionally after) the frame/layer capture.
bool dump_atlas_rt(const std::string& atlas_dir, std::string* err) {
    auto prom = std::make_shared<std::promise<bool>>();
    auto fut = prom->get_future();
    std::string local_err;
    DFHack::runOnRenderThread([&, prom]() {
        prom->set_value(dump_atlas(atlas_dir, &local_err));
    });
    // The atlas is ~129k surfaces (~500MB of .rgba files); the render thread is busy for the
    // whole write. 10s was a spurious-timeout trap -- allow the full one-time export.
    if (fut.wait_for(std::chrono::seconds(300)) != std::future_status::ready) {
        if (err) *err = "atlas dump timed out on render thread";
        return false;
    }
    if (!fut.get()) { if (err) *err = local_err.empty() ? "atlas dump failed" : local_err; return false; }
    return true;
}

} // namespace

bool dump_tile_frame_ex(const std::string& out_dir, const TileDumpOptions& opt, std::string* err) {
    diagnostics_log("tiledump: BEGIN dir=" + out_dir +
                    (opt.have_camera ? (" cam=" + std::to_string(opt.x) + "," +
                                        std::to_string(opt.y) + "," + std::to_string(opt.z))
                                     : std::string(" cam=host")) +
                    (opt.with_atlas ? " +atlas" : "") + (opt.with_ground_truth ? " +gt" : ""));
    mkdirs(out_dir);
    if (opt.with_atlas)
        mkdirs(out_dir + "/atlas");

    Camera cam;
    if (opt.have_camera) {
        // Explicit camera (calibration sweep / per-player-viewport probe). Seed the rest of
        // the struct from the host camera so zoom/placement fields stay defaults (no
        // ViewportZoomGuard activation), then override the position.
        if (!read_host_camera(cam, err)) return false;
        cam.x = opt.x; cam.y = opt.y; cam.z = opt.z;
    } else {
        if (!read_host_camera(cam, err)) return false;
    }

    // ONE guarded render-thread capture: same-tick ground-truth frame + VALID layer arrays.
    // capture_frame_with_tile_layers reuses the live stream's capture_shifted path (live-fort
    // gate + window setup + ViewportZoomGuard + render_map_for_current_window) and copies the
    // 26 layer arrays only AFTER the map has been rendered -- never cold. This is the fix for
    // the SIGSEGV that the previous cold read produced.
    diagnostics_log("tiledump: camera ok (" + std::to_string(cam.x) + "," +
                    std::to_string(cam.y) + "," + std::to_string(cam.z) + "); capturing");
    auto t0 = std::chrono::steady_clock::now();
    CapturedFrame gt;
    TileLayerDump layers;
    if (!capture_frame_with_tile_layers(cam, gt, layers, err)) return false;
    auto capture_ms = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count());
    diagnostics_log("tiledump: capture ok " + std::to_string(layers.dim_x) + "x" +
                    std::to_string(layers.dim_y) + " in " + std::to_string(capture_ms) + "ms");

    if (opt.with_ground_truth) {
        std::vector<uint8_t> png;
        if (!encode_png(gt, png, err)) return false;
        std::ofstream f(out_dir + "/ground_truth.png", std::ios::binary);
        f.write(reinterpret_cast<const char*>(png.data()), (std::streamsize)png.size());
    }

    // frame.bin = header (magic 'DFTD', WIRE_VERSION 1, dims, origin) + the 26-block body the
    // capture hook already serialized (per-layer [u8 elem_size][dim_x*dim_y raw LE elements]).
    std::vector<uint8_t> out;
    put_u32(out, 0x44544644u);        // 'DFTD' little-endian
    put_u32(out, 1u);                 // WIRE_VERSION
    put_i32(out, layers.dim_x); put_i32(out, layers.dim_y);
    put_i32(out, layers.origin_x); put_i32(out, layers.origin_y); put_i32(out, layers.z);
    out.insert(out.end(), layers.bytes.begin(), layers.bytes.end());
    { std::ofstream f(out_dir + "/frame.bin", std::ios::binary);
      f.write(reinterpret_cast<const char*>(out.data()), (std::streamsize)out.size()); }

    // meta.json sidecar: the camera the dump was rendered for (frame.bin's origin fields are
    // viewport clip values, NOT world coords), plus dims/tick/timing for sweep indexing.
    {
        int32_t tick = -1;
        if (auto world = df::global::world) tick = world->frame_counter;
        std::ofstream m(out_dir + "/meta.json", std::ios::binary);
        m << "{\"camera\":{\"x\":" << cam.x << ",\"y\":" << cam.y << ",\"z\":" << cam.z << "}"
          << ",\"dim_x\":" << layers.dim_x << ",\"dim_y\":" << layers.dim_y
          << ",\"clip_x\":" << layers.origin_x << ",\"clip_y\":" << layers.origin_y
          << ",\"tick\":" << tick
          << ",\"capture_ms\":" << capture_ms
          << ",\"frame_w\":" << gt.width << ",\"frame_h\":" << gt.height << "}";
    }

    if (opt.with_atlas) {
        // Atlas: separate render-thread hop, run unconditionally (independent of the frame
        // capture, so a frame issue can never suppress it -- the failure mode seen in run 1).
        diagnostics_log("tiledump: atlas dump starting (render thread will be busy)");
        std::string atlas_err;
        if (!dump_atlas_rt(out_dir + "/atlas", &atlas_err)) {
            if (err) *err = "frame.bin written, but atlas dump failed: " + atlas_err;
            diagnostics_log("tiledump: atlas FAILED: " + atlas_err);
            return false;
        }
        diagnostics_log("tiledump: atlas done");
    }
    diagnostics_log("tiledump: DONE " + out_dir);
    return true;
}

bool dump_tile_frame(const std::string& out_dir, std::string* err) {
    TileDumpOptions opt;   // defaults: host camera + atlas + ground truth
    return dump_tile_frame_ex(out_dir, opt, err);
}

} // namespace dwf
