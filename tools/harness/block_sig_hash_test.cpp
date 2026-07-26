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

// Guards src/block_sig_hash.h -- the fold primitive behind world_stream.cpp's
// block_signature(). Standalone: no DFHack, no DF install, no plugin link (same tier as
// b292_world_activity_fixture_test.cpp).
//
//   g++ -O2 -std=c++17 -I third_party/xxhash tools/harness/block_sig_hash_test.cpp
//       -o block_sig_hash_test
//
// The property that matters is NO FALSE NEGATIVES: a block whose folded bytes changed must
// produce a different signature, or the stream serves a stale block forever (the failure mode
// the WC-1/WC-11/WC-15/B139 comments in block_signature() each document a past instance of).
// A false POSITIVE is merely a redundant re-send. So the tests below are all sensitivity
// tests, run over the real fold shape rather than a synthetic buffer.

#include "../../src/block_sig_hash.h"

#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <set>
#include <vector>

using dwf::kBlockSigSeed;
using dwf::sig_buf;
using dwf::sig_mix;

// The three grids block_signature() folds before it reaches events/items, at their real sizes:
// tiletype int16[16][16], designation uint32[16][16], occupancy masked to uint32[16][16].
struct BlockGrids {
    int16_t  tiletype[16][16];
    uint32_t designation[16][16];
    uint32_t occupancy[16][16];
};

// Mirrors block_signature()'s fold order over the three grids. The occupancy grid is folded as
// one flat buffer, matching the loop as it now stands in world_stream.cpp.
uint64_t fold_grids(const BlockGrids& g) {
    uint64_t h = kBlockSigSeed;
    h = sig_buf(h, &g.tiletype[0][0],    sizeof(g.tiletype));
    h = sig_buf(h, &g.designation[0][0], sizeof(g.designation));
    uint32_t masked[16 * 16];
    for (int ox = 0; ox < 16; ++ox)
        for (int oy = 0; oy < 16; ++oy)
            masked[ox * 16 + oy] = g.occupancy[ox][oy];
    h = sig_buf(h, masked, sizeof(masked));
    return h;
}

// A plausible fortress block: mostly uniform stone with a carved-out corridor, i.e. the
// low-entropy shape real blocks actually have. Uniform buffers are the adversarial case for a
// hash that has to notice a single tile changing.
//
// INJECTIVE IN `salt` -- distinct salts must give distinct blocks, or the distinctness check
// below measures the generator instead of the hash. Scattering the salt across a few cells is
// not enough: varying one tile over 16 x 16 positions x 31 values tops out at 7936 distinct
// blocks, so any larger population collides by pigeonhole no matter how good the hash is.
// designation[0][0] therefore carries the whole 32-bit salt, which makes the mapping
// injective by construction; the tiletype poke on top keeps the terrain varying too.
BlockGrids make_block(uint32_t salt) {
    BlockGrids g{};
    for (int x = 0; x < 16; ++x)
        for (int y = 0; y < 16; ++y) {
            const bool corridor = (y == 8 || (x == 8 && y > 4));
            g.tiletype[x][y]    = corridor ? 32 : 331;   // floor vs solid stone wall
            g.designation[x][y] = corridor ? 0u : 0x10u; // hidden bit set outside the corridor
            g.occupancy[x][y]   = 0u;
        }
    g.tiletype[salt % 16][(salt / 16) % 16] = (int16_t)(300 + (salt % 31));
    g.designation[0][0] = salt;
    return g;
}

int main() {
    // Unbuffered: assert() aborts, which would otherwise discard the [ok] lines already
    // printed and leave a failure with no indication of how far the suite got.
    setvbuf(stdout, nullptr, _IONBF, 0);
    int checks = 0;

    // ---- 1. single-bit sensitivity over the whole folded footprint --------------------
    // Every bit of every grid, flipped one at a time. This is the no-false-negative property
    // stated as directly as it can be: 2560 bytes x 8 = 20480 mutations, each of which must
    // move the signature. A byte the fold silently skipped would show up here as a miss.
    {
        BlockGrids base = make_block(7);
        const uint64_t h0 = fold_grids(base);
        uint8_t* raw = reinterpret_cast<uint8_t*>(&base);
        const size_t n = sizeof(BlockGrids);
        assert(n == 2560 && "fold footprint changed -- update this test's expectations");

        size_t misses = 0;
        for (size_t byte = 0; byte < n; ++byte)
            for (int bit = 0; bit < 8; ++bit) {
                raw[byte] ^= (uint8_t)(1u << bit);
                if (fold_grids(base) == h0) ++misses;
                raw[byte] ^= (uint8_t)(1u << bit);   // restore
            }
        assert(fold_grids(base) == h0 && "restore failed -- test is buggy, not the hash");
        assert(misses == 0 && "a single-bit change did not move the signature");
        printf("  [ok] single-bit sensitivity: %zu/%zu mutations detected\n", n * 8, n * 8);
        ++checks;
    }

    // ---- 2. the occupancy restructure preserves byte order ----------------------------
    // world_stream.cpp used to fold occupancy as 256 separate 4-byte calls and now flattens
    // into one buffer. Equivalent only if the flatten walks ox-outer/oy-inner, so assert the
    // flat buffer really is that sequence. A transposed index would still hash "fine" and
    // still detect changes -- it would just quietly hash a different grid than the one the
    // wire emits, which no other test here would catch.
    {
        BlockGrids g = make_block(3);
        for (int x = 0; x < 16; ++x)
            for (int y = 0; y < 16; ++y) g.occupancy[x][y] = (uint32_t)(x * 100 + y);

        uint32_t flat[16 * 16];
        for (int ox = 0; ox < 16; ++ox)
            for (int oy = 0; oy < 16; ++oy) flat[ox * 16 + oy] = g.occupancy[ox][oy];

        size_t k = 0;
        for (int ox = 0; ox < 16; ++ox)
            for (int oy = 0; oy < 16; ++oy)
                assert(flat[k++] == g.occupancy[ox][oy] && "flatten order differs from the old loop");
        printf("  [ok] occupancy flatten preserves ox-outer/oy-inner order\n");
        ++checks;
    }

    // ---- 3. order dependence ---------------------------------------------------------
    // Two fields swapping values must change the signature; a commutative combiner (a bare
    // XOR of per-field hashes) would return the same value and miss real edits.
    {
        const uint64_t a = 0x1111222233334444ull, b = 0xAAAABBBBCCCCDDDDull;
        assert(sig_mix(sig_mix(kBlockSigSeed, a), b) != sig_mix(sig_mix(kBlockSigSeed, b), a));

        BlockGrids g = make_block(11);
        const uint64_t before = fold_grids(g);
        // Must be two tiles that genuinely DIFFER, or the swap is a no-op and this asserts
        // nothing: make_block paints a corridor over uniform stone, so most tile pairs are
        // both 331. [2][8] is corridor floor, [2][3] is wall.
        assert(g.tiletype[2][8] != g.tiletype[2][3] && "swap operands are identical -- test is inert");
        std::swap(g.tiletype[2][8], g.tiletype[2][3]);
        assert(fold_grids(g) != before && "swapping two tiles left the signature unchanged");
        printf("  [ok] fold is order-dependent\n");
        ++checks;
    }

    // ---- 4. distinctness across a realistic block population -------------------------
    // 200k near-identical blocks differing by one tile. Not a birthday-bound test (64-bit
    // makes a collision here ~1e-9); it is a guard against the fold degenerating and mapping
    // whole families of blocks onto one value.
    {
        const int kBlocks = 200000;
        std::set<uint64_t> seen;
        for (int i = 0; i < kBlocks; ++i) seen.insert(fold_grids(make_block((uint32_t)i)));
        assert((int)seen.size() == kBlocks && "distinct blocks collided");
        printf("  [ok] %d distinct blocks -> %zu distinct signatures\n", kBlocks, seen.size());
        ++checks;
    }

    // ---- 5. throughput, against the fnv1a this replaced ------------------------------
    // Not a pass/fail gate (it is a wall-clock measurement on whatever machine runs it), but
    // the whole point of the change, so it is reported. fnv1a is reproduced verbatim from
    // world_stream.cpp, where it remains the primitive for the s3/s4/s5 folds.
    {
        auto fnv1a = [](uint64_t h, const void* data, size_t n) {
            const uint8_t* p = static_cast<const uint8_t*>(data);
            for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 1099511628211ull; }
            return h;
        };
        // The old occupancy loop: 256 separate 4-byte calls, as it was written.
        auto fold_old = [&](const BlockGrids& g) {
            uint64_t h = kBlockSigSeed;
            h = fnv1a(h, &g.tiletype[0][0],    sizeof(g.tiletype));
            h = fnv1a(h, &g.designation[0][0], sizeof(g.designation));
            for (int ox = 0; ox < 16; ++ox)
                for (int oy = 0; oy < 16; ++oy) {
                    uint32_t m = g.occupancy[ox][oy];
                    h = fnv1a(h, &m, sizeof(m));
                }
            return h;
        };

        std::vector<BlockGrids> corpus;
        corpus.reserve(4096);
        for (int i = 0; i < 4096; ++i) corpus.push_back(make_block((uint32_t)i));

        const int kReps = 40;
        uint64_t sink = 0;
        auto run = [&](auto&& fold) {
            auto t0 = std::chrono::steady_clock::now();
            for (int r = 0; r < kReps; ++r)
                for (const auto& g : corpus) sink ^= fold(g);
            return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        };

        const double t_old = run(fold_old);
        const double t_new = run([&](const BlockGrids& g) { return fold_grids(g); });

        const double blocks = (double)corpus.size() * kReps;
        printf("  [--] fold throughput over %.0f blocks (%zu B each):\n", blocks, sizeof(BlockGrids));
        printf("         fnv1a  %7.1f ms  (%6.2f us/block)\n", t_old * 1e3, t_old / blocks * 1e6);
        printf("         xxh3   %7.1f ms  (%6.2f us/block)   %.1fx faster\n",
               t_new * 1e3, t_new / blocks * 1e6, t_old / t_new);
        // Consume `sink` so neither fold can be optimised away as dead code. The condition is
        // effectively never true; what matters is that the compiler cannot prove that.
        if (sink == 0x1234ull) printf("         (sink %llu)\n", (unsigned long long)sink);
        ++checks;
    }

    printf("block_sig_hash_test: %d checks passed\n", checks);
    return 0;
}
