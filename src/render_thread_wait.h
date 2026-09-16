// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Bounded wait for runOnRenderThread marshals: an unbounded future.get() deadlocks plugin_shutdown.
#pragma once

#include <chrono>
#include <future>

namespace dwf {

template <typename T>
inline bool render_future_ready(std::future<T>& fut, int secs = 3) {
    return fut.wait_for(std::chrono::seconds(secs)) == std::future_status::ready;
}

} // namespace dwf
