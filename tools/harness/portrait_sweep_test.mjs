#!/usr/bin/env node
// Regression guard for the restored native-portrait sweep (PORTRAITS-ROOT / B128).
//
// The sweep generates portraits by calling DF's OWN lazy portrait generator directly on the
// render thread (exe-pinned, SEH-latched). Each assertion below can fail for a real regression:
// mislabeled fallbacks, recursive native UI calls, renderer deadlocks, save-window races, or a
// silent return of the rejected mechanisms.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sweep = readFileSync(new URL("../../src/portrait_sweep.cpp", import.meta.url), "utf8");
const portrait = readFileSync(new URL("../../src/unit_portrait.cpp", import.meta.url), "utf8");
const stream = readFileSync(new URL("../../src/world_stream.cpp", import.meta.url), "utf8");
const plugin = readFileSync(new URL("../../src/dwf.cpp", import.meta.url), "utf8");
const cmake = readFileSync(new URL("../../CMakeLists.txt", import.meta.url), "utf8");
const core = readFileSync(new URL("../../web/js/dwf-core.js", import.meta.url), "utf8");

// --- honest accounting: fallbacks and skips can never be reported as generated portraits ----
assert.match(sweep, /generated=.*existing=.*no-art=.*failed=.*pending=.*attempted=/s,
  "status separates generated, existing, no-art, failed, and pending counts");
assert.match(sweep, /NativePortraitOutcome::NoPortraitArt:\s*\n\s*g_no_art\.insert/,
  "a clean run without portrait art is recorded as no-art, never as generated");
assert.match(sweep, /NativePortraitOutcome::Generated:\s*\n\s*g_done\.insert\(unit_id\);\s*\n\s*\+\+g_generated/,
  "only a genuine Generated outcome increments the generated counter");
assert.doesNotMatch(sweep, /widget-grid|allow_icon_fallbacks\s*=\s*true|sheet_icon/,
  "the sweep never counts an icon/sprite fallback as portrait generation");

// --- the rejected mechanisms stay rejected --------------------------------------------------
assert.doesNotMatch(sweep,
  /main_interface\.view_sheets|viewscreen->|SetRenderTarget|TemporaryRenderTarget/,
  "sweep cannot flash sheets, recursively enter DF screen logic, or hold a render target");
assert.match(sweep, /unit_portrait_generate_native_on_render\(df::unit::find\(unit_id\)/,
  "generation goes through the exe-pinned direct call and re-resolves the unit by id");
assert.match(portrait, /A portrait endpoint must return a real DF portrait texture or fail/,
  "portrait mode cannot return a 32x32 map sprite as native art");

// --- deadlock guards ------------------------------------------------------------------------
assert.match(sweep, /std::try_to_lock/,
  "the render callback try-locks capture state; a blocking lock can deadlock behind an HTTP " +
  "thread that holds the mutex while waiting on its own queued render callback");
assert.doesNotMatch(sweep, /\.get\(\)|std::future|std::promise/,
  "portrait_sweep_tick never blocks DF's update thread waiting for render work");
assert.match(sweep, /g_in_flight/,
  "at most one generation callback is in flight at a time");
assert.match(sweep, /MIN_DISPATCH_GAP/,
  "generation is paced by a minimum wall-clock gap");

// --- save/unload safety ---------------------------------------------------------------------
assert.match(sweep, /save_barrier_active\(\)/,
  "the sweep gates on the save barrier");
assert.match(portrait, /save_barrier_active\(\)[\s\S]{0,300}Blocked/,
  "the generator itself refuses to run during a save window");
assert.match(plugin, /plugin_save_site_data[\s\S]*portrait_sweep_abort_active\(\)[\s\S]*save_barrier_begin\(\)/,
  "the save hook still notifies the sweep before serialization begins");
assert.match(plugin, /plugin_onupdate[\s\S]*portrait_sweep_tick\(\)/,
  "the sweep advances only from DF's normal update hook");

// --- fault containment ----------------------------------------------------------------------
assert.match(portrait, /g_native_gen_faulted\.store\(true\)/,
  "a native fault latches generation off");
assert.match(sweep, /unit_portrait_native_generator_faulted\(\)/,
  "the sweep stops dispatching after a fault");
assert.match(sweep, /FAULT-LATCHED-OFF/,
  "status reports the fault latch honestly");

// --- canary controls ------------------------------------------------------------------------
assert.match(sweep, /g_limit > 0 && g_attempted >= g_limit/,
  "a session attempt limit exists for canarying fresh deployments");
assert.match(plugin, /capture-portrait-sweep \[status\|on\|off\|limit N\|rearm\]/,
  "the console command exposes on/off/limit/rearm");

// --- plumbing -------------------------------------------------------------------------------
assert.match(stream, /portrait_sweep_note_unit\(u->id, Units::isFortControlled\(u\)\)/,
  "the stream feeds portrait-less units to the sweep");
assert.doesNotMatch(stream, /portrait_sweep_tick\(\);/,
  "the streaming worker never drives native portrait state");
assert.match(cmake, /src\/portrait_sweep\.cpp/,
  "the sweep compiles into the plugin");
assert.match(core, /localStorage\.getItem\("dfplex\.unitImages"\) !== "0"/,
  "unit imagery still defaults on for real portraits and explicit sprite fallbacks");

console.log("PASS portrait sweep (native direct-call generation: honest counts, no recursion, no deadlock, save-safe, fault-latched)");
