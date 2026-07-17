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
//
// ===========================================================================
// SPRITE MAP -- parse DF's premium-graphics raws into a token -> sprite-cell
// lookup for the browser renderer. Pure text parsing of the user's own DF
// install (read at plugin runtime, NOT bundled -- the PNGs stay proprietary).
// ===========================================================================

#include "sprite_map.h"
#include "diagnostics.h"

#include "DataDefs.h"
#include "df/tiletype.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

using namespace DFHack;

namespace dwf {
namespace {

// DF graphics raw directories to parse, relative to the plugin CWD (DF root).
// Environment is the primary (terrain floors/walls/ramps/stairs/liquids); plants
// adds shrubs/saplings/tree cells. Both use the SAME token grammar.
const char* kGraphicsDirs[] = {
    "data/vanilla/vanilla_environment/graphics",
    "data/vanilla/vanilla_plants_graphics/graphics",
};

struct FrameCell {
    int col = 0;
    int row = 0;
};

// A token's primary (first-binding) cell, plus -- WC-10 -- any additional
// animation frames the SAME token re-binds to later in the raws. DF encodes
// per-tiletype animation two ways (verified against the vanilla raws):
//   (a) frame number baked into the TOKEN NAME (WINDMILL_S_1/_2, ...) -- these
//       are already distinct map keys and need no handling here.
//   (b) the identical TOKEN repeated with a numeric trailing param, e.g.
//       [TILE_GRAPHICS:EVENT_FLOWS:0:0:FLOW_MIASMA:1] .. `:4]` (frame index
//       only), or [TILE_GRAPHICS:FLOWS:0:0:BROOK_TO_NW:1:1] .. `:1:16]` then
//       `:2:1]` .. (a GROUP id followed by a 16-frame index -- DF ships 4
///      alternate 16-frame groups per BROOK/RIVER direction on separate
//       pages; only one group is the live animation series, the rest are
//       unused alternates). The LAST extra param is always the frame's sort
//       key; everything before it is the "series key" that must match the
//       token's first frame binding for a later binding to join the series
//       (this is what keeps BROOK_TO_NW's frames at 16, not 64). A token
//       whose trailing param(s) are non-numeric (e.g. spatter shape codes
//       like `FULL_NSWE_A`) is NOT a frame series -- untouched, first-binding
///      -wins as before (that grammar is WC-11/12 territory).
struct Cell {
    std::string sheet;   // png basename, e.g. "floors.png"
    int col = 0;
    int row = 0;

    bool has_frames = false;         // true once >=2 frames are confirmed
    std::vector<int> series_key;     // extras minus the trailing frame index
    std::vector<std::pair<int, FrameCell>> frame_pool;  // (frame index, cell)
};

// List "<dir>/*.txt" (non-recursive). Returns [] if the dir is absent.
std::vector<std::string> list_txt_files(const std::string& dir) {
    std::vector<std::string> out;
#ifdef _WIN32
    std::string pattern = dir + "/*.txt";
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pattern.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE)
        return out;
    do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
            out.push_back(dir + "/" + fd.cFileName);
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#endif
    return out;
}

std::string read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f)
        return std::string();
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Basename after the last '/' or '\\' (DF FILE fields use "images/foo.png").
std::string basename_of(const std::string& p) {
    size_t s = p.find_last_of("/\\");
    return (s == std::string::npos) ? p : p.substr(s + 1);
}

// Split "A:B:C" into ["A","B","C"].
std::vector<std::string> split_colon(const std::string& s) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == ':') { out.push_back(cur); cur.clear(); }
        else cur.push_back(c);
    }
    out.push_back(cur);
    return out;
}

// Call `fn(fields)` for every [ ... ] bracket group in text, fields = colon-split.
template <typename F>
void for_each_bracket(const std::string& text, F fn) {
    size_t i = 0;
    while (true) {
        size_t open = text.find('[', i);
        if (open == std::string::npos) break;
        size_t close = text.find(']', open + 1);
        if (close == std::string::npos) break;
        fn(split_colon(text.substr(open + 1, close - open - 1)));
        i = close + 1;
    }
}

bool parse_int(const std::string& s, int& out) {
    if (s.empty()) return false;
    size_t i = 0;
    if (s[0] == '-') i = 1;
    if (i >= s.size()) return false;
    for (; i < s.size(); ++i)
        if (!std::isdigit((unsigned char)s[i])) return false;
    out = std::atoi(s.c_str());
    return true;
}

// SCREAMING_SNAKE token -> PascalCase (candidate df::tiletype enum key).
// "STONE_FLOOR_1" -> "StoneFloor1".
std::string to_pascal(const std::string& tok) {
    std::string out;
    out.reserve(tok.size());
    bool up = true;
    for (char c : tok) {
        if (c == '_') { up = true; continue; }
        out.push_back(up ? (char)std::toupper((unsigned char)c)
                         : (char)std::tolower((unsigned char)c));
        up = false;
    }
    return out;
}

std::string json_escape(const std::string& s) {
    std::string o;
    o.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
        else o.push_back(c);
    }
    return o;
}

// Parse all tile_page_*.txt across the dirs: PAGE name -> sheet png basename.
// A page spans [TILE_PAGE:NAME] ... [FILE:images/x.png] ... [PAGE_DIM/PIXELS:..].
void collect_pages(const std::vector<std::string>& files,
                   std::map<std::string, std::string>& pages) {
    for (const auto& path : files) {
        std::string text = read_file(path);
        if (text.empty()) continue;
        std::string cur_page;
        for_each_bracket(text, [&](const std::vector<std::string>& f) {
            if (f.empty()) return;
            if (f[0] == "TILE_PAGE" && f.size() >= 2) {
                cur_page = f[1];
            } else if (f[0] == "FILE" && f.size() >= 2 && !cur_page.empty()) {
                pages[cur_page] = basename_of(f[1]);
            }
            // TILE_DIM / PAGE_DIM / PAGE_DIM_PIXELS are read past but not needed:
            // each cell's col/row come straight from the TILE_GRAPHICS binding.
        });
    }
}

// Parse all graphics_*.txt: [TILE_GRAPHICS:PAGE:col:row:TOKEN(:extra...)].
// Resolve PAGE -> sheet; first binding of a token wins for the primary cell.
// WC-10: a later binding of the SAME token joins that token's `frames` array
// instead of being silently dropped, provided it continues the same
// animation series (see the Cell comment above). Unknown page -> skip.
void collect_tokens(const std::vector<std::string>& files,
                    const std::map<std::string, std::string>& pages,
                    std::map<std::string, Cell>& tokens) {
    for (const auto& path : files) {
        std::string text = read_file(path);
        if (text.empty()) continue;
        for_each_bracket(text, [&](const std::vector<std::string>& f) {
            if (f.size() < 5 || f[0] != "TILE_GRAPHICS") return;
            const std::string& page = f[1];
            const std::string& token = f[4];
            int col = 0, row = 0;
            if (!parse_int(f[2], col) || !parse_int(f[3], row)) return;
            if (token.empty()) return;
            auto pit = pages.find(page);
            if (pit == pages.end()) return;          // unresolved page -> skip

            // Trailing extra params (everything after TOKEN). Only treated as
            // an animation-frame series when EVERY trailing field is numeric
            // (non-numeric trailing fields are shape/variant qualifiers, not
            // frame indices -- leave those to first-binding-wins).
            std::vector<int> extras;
            bool extras_numeric = f.size() > 5;
            for (size_t i = 5; extras_numeric && i < f.size(); ++i) {
                int v;
                if (!parse_int(f[i], v)) { extras_numeric = false; break; }
                extras.push_back(v);
            }
            bool is_frame_binding = extras_numeric && !extras.empty();

            auto it = tokens.find(token);
            if (it == tokens.end()) {
                // First binding of this token: establishes the primary cell
                // (back-compat: sheet/col/row unchanged from today) and, if
                // numeric extras are present, the animation series key.
                Cell c;
                c.sheet = pit->second;
                c.col = col;
                c.row = row;
                if (is_frame_binding) {
                    c.has_frames = true;
                    c.series_key.assign(extras.begin(), extras.end() - 1);
                    c.frame_pool.emplace_back(extras.back(), FrameCell{col, row});
                }
                tokens.emplace(token, std::move(c));
                return;
            }

            // Re-binding of a known token. Previously dropped unconditionally
            // (the frame-collapse bug); now: join the frames array only if
            // this occurrence continues the SAME series the first binding
            // established (same page-group/series-key) and carries a numeric
            // frame index. A different series (e.g. BROOK_TO_NW's alternate
            // 16-frame groups on FLOWS2/3/4) or a non-numeric re-binding is
            // still dropped -- first-binding-wins for anything outside the
            // established series.
            Cell& existing = it->second;
            if (!existing.has_frames || !is_frame_binding) return;
            std::vector<int> this_series(extras.begin(), extras.end() - 1);
            if (this_series != existing.series_key) return;
            existing.frame_pool.emplace_back(extras.back(), FrameCell{col, row});
        });
    }
}

// Sort each token's accumulated frame_pool by frame index, drop duplicate
// indices (keep the first occurrence in raw-file order), and demote
// single-frame "series" (nothing actually repeated) back to a plain cell so
// the JSON output stays back-compat for the common case.
void finalize_frames(std::map<std::string, Cell>& tokens) {
    for (auto& kv : tokens) {
        Cell& c = kv.second;
        if (!c.has_frames) continue;
        std::stable_sort(c.frame_pool.begin(), c.frame_pool.end(),
                          [](const std::pair<int, FrameCell>& a,
                             const std::pair<int, FrameCell>& b) {
                              return a.first < b.first;
                          });
        std::vector<std::pair<int, FrameCell>> deduped;
        deduped.reserve(c.frame_pool.size());
        for (auto& p : c.frame_pool) {
            if (!deduped.empty() && deduped.back().first == p.first) continue;
            deduped.push_back(p);
        }
        c.frame_pool = std::move(deduped);
        if (c.frame_pool.size() <= 1) {
            c.has_frames = false;
            c.frame_pool.clear();
        }
    }
}

std::string build_sprite_map_json() {
    try {
        std::map<std::string, std::string> pages;   // PAGE name -> png basename
        std::map<std::string, Cell> tokens;         // TOKEN -> sheet/col/row

        std::vector<std::string> all_files;
        for (const char* dir : kGraphicsDirs) {
            auto files = list_txt_files(dir);
            all_files.insert(all_files.end(), files.begin(), files.end());
        }
        // Two passes: pages first (a token may reference a page declared in
        // another file), then the token bindings.
        collect_pages(all_files, pages);
        collect_tokens(all_files, pages, tokens);
        finalize_frames(tokens);

        // Add enum-key aliases so the client's wire "ttname" (a df::tiletype enum
        // key) resolves directly for the tokens whose PascalCase form is a real
        // tiletype. The graphics-token namespace is mostly disjoint from the
        // tiletype enum (the live-tile -> token choice is hardcoded in DF), so
        // only a handful alias; the rest stay reachable by their raw token key.
        std::vector<std::pair<std::string, Cell>> aliases;
        for (const auto& kv : tokens) {
            std::string enum_key = to_pascal(kv.first);
            if (enum_key.empty() || enum_key == kv.first) continue;
            df::tiletype tt;
            if (!find_enum_item(&tt, enum_key)) continue;
            if (tokens.find(enum_key) != tokens.end()) continue;
            aliases.emplace_back(enum_key, kv.second);
        }
        for (auto& a : aliases)
            tokens.emplace(a.first, a.second);

        std::ostringstream js;
        js << "{";
        bool first = true;
        for (const auto& kv : tokens) {
            if (!first) js << ",";
            first = false;
            const Cell& c = kv.second;
            js << "\"" << json_escape(kv.first) << "\":{\"sheet\":\""
               << json_escape(c.sheet) << "\",\"col\":" << c.col
               << ",\"row\":" << c.row;
            if (c.has_frames && !c.frame_pool.empty()) {
                js << ",\"frames\":[";
                bool ffirst = true;
                for (const auto& fr : c.frame_pool) {
                    if (!ffirst) js << ",";
                    ffirst = false;
                    js << "{\"col\":" << fr.second.col << ",\"row\":" << fr.second.row << "}";
                }
                js << "]";
            }
            js << "}";
        }
        js << "}";

        std::ostringstream note;
        note << "sprite-map: " << tokens.size() << " entries from "
             << all_files.size() << " raw files (" << pages.size() << " pages)";
        diagnostics_log(note.str());
        return js.str();
    }
    catch (const std::exception& e) {
        diagnostics_log(std::string("sprite-map exception: ") + e.what());
        return "{}";
    }
    catch (...) {
        diagnostics_log("sprite-map: unknown exception");
        return "{}";
    }
}

} // namespace

const std::string& sprite_map_json() {
    // Magic static: parsed exactly once, thread-safe, cached for the plugin's life.
    static const std::string cached = build_sprite_map_json();
    return cached;
}

} // namespace dwf
