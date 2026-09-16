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
// Parses the user's own DF graphics raws into a token -> sprite-cell lookup for the browser.

#include "sprite_map.h"
#include "diagnostics.h"
#include "json_util.h"

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

// DF graphics raw directories, relative to the plugin CWD (the DF root).
const char* kGraphicsDirs[] = {
    "data/vanilla/vanilla_environment/graphics",
    "data/vanilla/vanilla_plants_graphics/graphics",
};

struct FrameCell {
    int col = 0;
    int row = 0;
};

// A token's primary (first-binding) cell, plus later re-bindings of the SAME token that continue
// its animation series. Of a binding's trailing extras, the LAST is the frame index.
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

// Name exposed by the PNG-only /sprites/img/ route. floors.bmp is vanilla's one legacy
// exception; the host-side sprite bake converts that bitmap to floors_alt.png.
std::string served_sheet_name(const std::string& name) {
    if (name == "floors.bmp") return "floors_alt.png";
    if (name.size() > 4 && name.compare(name.size() - 4, 4, ".png") == 0) return name;
    return std::string();
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
                std::string sheet = basename_of(f[1]);
                std::string served = served_sheet_name(sheet);
                if (served.empty()) {
                    diagnostics_log("sprite-map: skipping page " + cur_page + " -> " + sheet +
                                    " (the /sprites/img/ route serves .png only)");
                    return;
                }
                pages[cur_page] = served;
            }
        });
    }
}

// Parse all graphics_*.txt: [TILE_GRAPHICS:PAGE:col:row:TOKEN(:extra...)]. First binding of a
// token wins the primary cell; a later binding joins `frames` only within the same series.
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

            // Trailing extras are a frame series only when EVERY one is numeric: non-numeric
            // trailing fields are shape/variant qualifiers and stay first-binding-wins.
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
                // First binding: the primary cell, plus the series key when extras are numeric.
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

            // Re-binding of a known token: joins `frames` only when it continues the SAME series
            // the first binding established. Any other re-binding is dropped.
            Cell& existing = it->second;
            if (!existing.has_frames || !is_frame_binding) return;
            std::vector<int> this_series(extras.begin(), extras.end() - 1);
            if (this_series != existing.series_key) return;
            existing.frame_pool.emplace_back(extras.back(), FrameCell{col, row});
        });
    }
}

// Sort each token's frame_pool by frame index, drop duplicate indices, and demote a
// single-frame "series" back to a plain cell.
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

ApiResult<std::string> build_sprite_map_json() {
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

        // Alias every token whose PascalCase form is a real df::tiletype key, so the client's
        // wire "ttname" resolves directly; the rest stay reachable by their raw token.
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
        return ApiResult<std::string>::success(js.str());
    }
    catch (const std::exception& e) {
        diagnostics_log(std::string("sprite-map exception: ") + e.what());
        return ApiResult<std::string>::failure(500, "sprite_map_unavailable", e.what());
    }
    catch (...) {
        diagnostics_log("sprite-map: unknown exception");
        return ApiResult<std::string>::failure(500, "sprite_map_unavailable",
                                               "unknown exception parsing the graphics raws");
    }
}

} // namespace

const ApiResult<std::string>& sprite_map_json() {
    static const ApiResult<std::string> cached = build_sprite_map_json();
    return cached;
}

} // namespace dwf
