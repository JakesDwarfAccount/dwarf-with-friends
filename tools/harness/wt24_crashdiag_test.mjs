// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// WT24 CRASH-EVIDENCE DIAGNOSTICS. OFFLINE: no DF, no server, no browser.
//
// On 2026-07-13 DF died with STATUS_HEAP_CORRUPTION and dwf.log was silent for 32 minutes
// around the death. Heap corruption is *detected* at an arbitrary later free, so the log timeline
// is the only thing that can bound the window -- and there was no timeline. This suite guards the
// three marks that fix that, plus the cost rules that keep them safe to ship:
//
//   1. a ~60 s heartbeat from the push loop (uptime, DF tick, players, WS frames, thread liveness)
//   2. ENTER/EXIT marks for every plugin thread + a phase breadcrumb naming the push-loop stage
//   3. a clean-shutdown mark, so the tail of the log distinguishes "DF quit" from "DF died"
//
// The cost rules are the reason this is a diagnostic and not a performance bug: the breadcrumb is
// atomics only (no logging, no locking, no allocation on the 30 Hz path), the heartbeat writes ONE
// line per minute, and nothing here takes CoreSuspender.
//
//   node tools/harness/wt24_crashdiag_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = rel => readFileSync(join(root, rel), "utf8");

const http = read("src/http_server.cpp");
const diagH = read("src/diagnostics.h");
const diagC = read("src/diagnostics.cpp");
const ws = read("src/websocket.cpp");
const plugin = read("src/dwf.cpp");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// Body of ws_push_loop() -- the 30 Hz hot path everything below is judged against.
function pushLoopBody() {
  const at = http.indexOf("void ws_push_loop()");
  assert.ok(at > 0, "ws_push_loop() not found");
  const open = http.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < http.length; i++) {
    if (http[i] === "{") depth++;
    else if (http[i] === "}") { depth--; if (depth === 0) return http.slice(open, i + 1); }
  }
  throw new Error("unbalanced ws_push_loop()");
}

// Comments in this file DISCUSS CoreSuspender at length ("same lock order as /mapdata (capture
// mutex -> CoreSuspender)"). A cost assertion that greps raw text would be graded by the prose, so
// strip line + block comments before asking what the CODE does.
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---- 1. the heartbeat ------------------------------------------------------------------------

check("heartbeat: the push loop emits a HEARTBEAT line on a ~60 s cadence", () => {
  const body = pushLoopBody();
  assert.match(http, /constexpr int kHeartbeatSecs = 60;/, "the 60 s cadence is not a named constant");
  assert.match(body, /std::chrono::seconds\(kHeartbeatSecs\)/, "the heartbeat does not gate on the cadence");
  assert.match(body, /diagnostics_log\("HEARTBEAT /, "the push loop never writes a HEARTBEAT line");
});

check("heartbeat: it carries uptime, DF tick, players, WS frames, and per-thread liveness", () => {
  for (const field of ["up=", "tick=", "paused=", "players=", "wsFrames=+", "pushIters=+",
                       "cursorIters=+", "httpReqs=+", "phase="])
    assert.ok(http.includes('"' + " " + field.trim()) || http.includes(field),
              `the heartbeat line is missing ${field}`);
  assert.match(http, /http=" << http_thread_liveness\(\)/,
               "the heartbeat does not report whether the HTTP thread is alive");
  assert.match(http, /push=" << \(push_delta > 0 \? "alive" : "STALLED"\)/,
               "the heartbeat does not report whether the push loop advanced");
});

check("heartbeat: the HTTP-thread liveness probe is a zero-timeout wait, never a blocking one", () => {
  const at = http.indexOf("const char* http_thread_liveness()");
  assert.ok(at > 0, "http_thread_liveness() missing");
  const fn = http.slice(at, at + 900);
  assert.match(fn, /WaitForSingleObject\(.*,\s*0\)/, "the liveness probe must not be able to block");
});

// ---- 2. the breadcrumb (and its cost rules) --------------------------------------------------

check("breadcrumb: every push-loop stage is wrapped in a DiagPhase, so a wedge names its stage", () => {
  const body = pushLoopBody();
  for (const stage of ["world_stream_tick", "pause_push_tick", "vote_push_tick",
                       "popup_push_tick", "burrow_push_tick", "diplo_push_tick"])
    assert.ok(new RegExp(`DiagPhase\\s+_p\\("${stage}"\\)`).test(body),
              `push-loop stage ${stage} has no DiagPhase breadcrumb`);
});

check("breadcrumb: DiagPhase is atomics-only -- it never logs, locks, or allocates", () => {
  const at = diagC.indexOf("void diag_phase_enter(");
  const fn = diagC.slice(at, diagC.indexOf("PhaseSnapshot diag_phase_snapshot("));
  assert.ok(at > 0 && fn.length > 0, "diag_phase_enter/exit not found");
  assert.equal(/diagnostics_log|lock_guard|unique_lock|std::string|new /.test(fn), false,
    "the breadcrumb does I/O, locking or allocation -- it runs 5x per frame at 30 Hz and must not");
  assert.match(fn, /memory_order_relaxed/, "the breadcrumb should use relaxed atomics");
  assert.match(diagH, /struct DiagPhase/, "the RAII guard is gone -- an early return would leak a phase");
});

check("cost: the heartbeat does not suspend DF just to print a line", () => {
  const body = stripComments(pushLoopBody());
  assert.equal(/CoreSuspender|ConditionalCoreSuspender/.test(body), false,
    "ws_push_loop took a suspender directly -- DF reads belong inside the existing stages");
  const fn = stripComments(http.slice(http.indexOf("std::string heartbeat_line("),
                                      http.indexOf("void ws_push_loop()")));
  assert.equal(/CoreSuspender/.test(fn), false, "the heartbeat suspends the DF sim thread");
  assert.match(fn, /df_frame_counter_unsafe\(\)/, "the heartbeat stopped reporting the DF tick");
});

check("cost: the WS frame counter is one relaxed add, not a log line, on the send path", () => {
  const at = ws.indexOf("bool WsConnection::send_frame(");
  const fn = ws.slice(at, ws.indexOf("bool WsConnection::send_text("));
  assert.match(fn, /g_ws_frames_sent\.fetch_add\(1, std::memory_order_relaxed\)/,
               "send_frame does not count frames");
  assert.equal(/diagnostics_log\("(?!send )/.test(fn), false,
    "an unconditional log line was added to the per-frame send path (the 2026-07-05 jitter bug)");
});

// ---- 3. thread marks + the shutdown mark -----------------------------------------------------

check("threads: push, cursor and http-listen each write an ENTER and an EXIT mark", () => {
  for (const t of ["push-loop", "cursor-loop", "http-listen"]) {
    assert.ok(http.includes(`THREAD-ENTER ${t}`), `no ENTER mark for ${t}`);
    assert.ok(http.includes(`THREAD-EXIT ${t}`), `no EXIT mark for ${t}`);
  }
});

check("stall watchdog: it lives on the cursor loop -- the thread that never takes CoreSuspender", () => {
  const at = http.indexOf("void ws_cursor_loop()");
  const body = http.slice(at, http.indexOf("} // namespace", at));
  assert.match(body, /push_stall_watchdog_tick\(\);/,
    "the stall watchdog is not called from the cursor loop; on the push loop it could not report a wedged push loop");
  assert.match(http, /constexpr int kStallSecs = 15;/, "the stall threshold is not a named constant");
  assert.ok(http.includes("STALL push-loop has not advanced") && http.includes("STALL-CLEARED"),
    "a stall must be reported once AND cleared with its duration (an autosave looks like a stall)");
});

check("shutdown: SHUTDOWN-CLEAN is the last thing the plugin ever writes", () => {
  assert.match(plugin, /SHUTDOWN-CLEAN/, "plugin_shutdown does not write a clean-exit mark");
  const at = plugin.indexOf("plugin_shutdown");
  const fn = plugin.slice(at);
  const clean = fn.indexOf("SHUTDOWN-CLEAN");
  const stop = fn.indexOf("stop_server()");
  assert.ok(stop > 0 && clean > stop,
    "the clean mark must come AFTER stop_server, or the tail of the log is not the last word");
  assert.match(http, /SERVER-STOP all threads joined/, "stop_server does not record the run's totals");
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
