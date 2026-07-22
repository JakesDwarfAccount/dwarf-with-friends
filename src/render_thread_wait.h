// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Bounded wait for runOnRenderThread marshals. During DF teardown the render thread stops
// draining its task queue, so an unbounded future.get() deadlocks: observed on Linux as an
// HTTP worker stuck in notifications_on_render_thread while plugin_shutdown -> stop_server
// joined the worker pool -- DF could never exit (SIGABRT after ~55s). Every marshal that a
// route or worker can reach MUST use a bounded wait; 3s matches clamp_camera's precedent.
#pragma once

#include <chrono>
#include <future>

namespace dwf {

template <typename T>
inline bool render_future_ready(std::future<T>& fut, int secs = 3) {
    return fut.wait_for(std::chrono::seconds(secs)) == std::future_status::ready;
}

} // namespace dwf
