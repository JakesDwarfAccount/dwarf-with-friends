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

// The fold primitive behind world_stream.cpp's block_signature() -- the map-block
// dirty-detection hash. Split out of world_stream.cpp so it is reachable from a standalone
// harness with no DFHack, no DF install, and no plugin link (the same reason
// unit_activity_logic.h exists; see tools/harness/block_sig_hash_test.cpp).
//
// WHY THIS IS A FREE CHOICE. The signature is dirty-DETECTION only. Its values never cross
// the wire, the flight recorder, or disk: g_gms.sig entries are only ever compared against
// each other in-process, and only .size() is ever reported (one diagnostics_log line). The
// golden CRC surface is therefore unaffected by the hash function -- the same property the
// occupancy-mask narrowing in block_signature() already relies on. g_gms is a plain global
// with no persistence, so a plugin reload starts from an empty map and re-signs everything
// regardless; changing this hash needs no migration and forces no extra re-ship.
//
// WHY NOT fnv1a. block_signature() runs on one quarter of the interest union every push tick,
// INSIDE the CoreSuspender hold, and folds ~2.5 KB per block (tiletype 512B + designation
// 1024B + occupancy 1024B, before events and items). fnv1a is byte-at-a-time with a serial
// multiply dependency chain -- one multiply per BYTE, each waiting on the previous -- so it
// ran at a few cycles per byte for a fold whose only requirement is "different bytes produce
// different values with high probability".
//
// WHY UNSEEDED XXH3 PLUS A MIXER, rather than XXH3_64bits_withSeed(data, n, h): for inputs
// over 240 bytes (XXH3_MIDSIZE_MAX) the seeded form re-derives its 192-byte internal secret
// on every call. That is precisely the tiletype and designation folds -- the two biggest and
// most frequent -- so the seeded form would have spent most of the win. Hashing each buffer
// unseeded and mixing the result into the running state keeps the per-call cost proportional
// to the buffer and preserves order dependence.

#pragma once

#include <cstddef>
#include <cstdint>

// Header-only, everything static: no new translation unit and no link surface. Guarded so a
// TU that already defined it (or that includes xxhash.h by another path) still compiles.
#ifndef XXH_INLINE_ALL
#define XXH_INLINE_ALL
#endif
#include "xxhash.h"

namespace dwf {

// The running signature's starting value. Historically the FNV-1a offset basis; now simply an
// arbitrary non-zero seed, kept at its original value so the constant in block_signature()
// did not change meaning when the fold underneath it did.
constexpr uint64_t kBlockSigSeed = 1469598103934665603ull;

// Mix one already-avalanched 64-bit value into the running state. Order-dependent by
// construction (not a bare XOR), so two folded fields swapping values changes the result.
inline uint64_t sig_mix(uint64_t h, uint64_t v) {
    h ^= v;
    h *= 0x9E3779B97F4A7C15ull;
    h ^= h >> 29;
    return h;
}

// Fold a contiguous buffer into the running signature. Deliberately keeps fnv1a's exact
// (h, data, n) shape so block_signature()'s call sites read identically to before.
inline uint64_t sig_buf(uint64_t h, const void* data, size_t n) {
    return sig_mix(h, XXH3_64bits(data, n));
}

}   // namespace dwf
