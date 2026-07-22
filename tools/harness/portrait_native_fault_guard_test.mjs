#!/usr/bin/env node
// Regression guard for the native portrait generator's safety boundary.
//
// History this file defends against (see docs/stabilization/CRASH-2026-07-19-PORTRAIT.md):
//  - a recursive view-sheet generator corrupted native state (0xc0000005),
//  - a widget-grid fallback served 32x32 map sprites as "native" portraits,
//  - a cross-frame SDL render target wedged world_stream within 15 seconds,
//  - the normal-lifecycle generator visibly flashed character sheets in the Steam client.
// The restored mechanism is a direct, exe-pinned call to DF's own one-argument portrait
// generator on the render thread. These assertions fail if any rejected mechanism returns or
// if the pin/fault containment is weakened.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const portrait = readFileSync(new URL("../../src/unit_portrait.cpp", import.meta.url), "utf8");
const header = readFileSync(new URL("../../src/unit_portrait.h", import.meta.url), "utf8");
const sweep = readFileSync(new URL("../../src/portrait_sweep.cpp", import.meta.url), "utf8");
const plugin = readFileSync(new URL("../../src/dwf.cpp", import.meta.url), "utf8");
const client = readFileSync(new URL("../../web/js/dwf-unit-hud-notifications.js", import.meta.url), "utf8");

// --- rejected mechanisms stay deleted -------------------------------------------------------
assert.doesNotMatch(portrait, /generate_unit_portrait_with_view_sheet|main_interface\.view_sheets/,
  "the crash-prone recursive view-sheet generator stays removed");
assert.doesNotMatch(sweep, /viewscreen->logic|viewscreen->render|main_interface\.view_sheets/,
  "the sweep never calls DF screen logic or touches sheet state");

// --- the exe pin: never call an unverified address ------------------------------------------
assert.match(portrait, /NATIVE_PORTRAIT_GEN_RVA = 0x1b9610/,
  "the generator address is a named, documented constant");
assert.match(portrait, /NATIVE_PORTRAIT_GEN_SIG\[32\]/,
  "the generator prologue signature is pinned (32 bytes)");
assert.match(portrait, /NATIVE_PORTRAIT_COMPOSITOR_SIG\[32\]/,
  "the compositor prologue is pinned as a second anchor");
assert.match(portrait, /GetModuleHandleA\(nullptr\)/,
  "the pin resolves against the live game module base (ASLR-safe)");
assert.match(portrait, /std::memcmp\(base \+ NATIVE_PORTRAIT_GEN_RVA/,
  "the signature is byte-compared before the address is ever callable");
assert.match(portrait, /unsupported Dwarf Fortress binary/,
  "a signature mismatch reports unavailability instead of calling anyway");

// --- SEH + fault latch ----------------------------------------------------------------------
assert.match(portrait, /call_native_portrait_generator_seh[\s\S]{0,200}__try/,
  "the native call is SEH-wrapped");
assert.match(portrait, /g_native_gen_faulted\.store\(true\)[\s\S]{0,400}latched OFF/,
  "any native fault permanently latches generation off for the session");
assert.match(portrait, /if \(g_native_gen_faulted\.load\(\)\)[\s\S]{0,300}Faulted/,
  "a latched fault refuses all further generation");

// --- truthful outcomes ----------------------------------------------------------------------
assert.match(header, /Generated,[\s\S]*AlreadyExists,[\s\S]*NoPortraitArt,[\s\S]*Blocked,[\s\S]*Unavailable,[\s\S]*Faulted,/,
  "outcomes distinguish generated, existing, no-art, blocked, unavailable, and faulted");
assert.match(portrait, /DF has no portrait art for this creature/,
  "a clean run without art is an explicit non-success");

// --- 32x32 map sprites can never pass as portraits ------------------------------------------
assert.match(portrait, /if \(texpos <= 0\)\s*\n\s*return false;/,
  "texpos 0 is DF's unset sentinel; serving raws[0] as a portrait is rejected");
assert.match(portrait, /A portrait endpoint must return a real DF portrait texture or fail/,
  "portrait mode never falls through to the widget-grid icon");
assert.match(client, /falseNativeSprite[\s\S]*naturalWidth < 64[\s\S]*naturalHeight < 64/,
  "the client rejects sub-64px responses mislabeled as native portraits");

// --- save-window and lifecycle safety -------------------------------------------------------
assert.match(portrait, /save_barrier_active\(\)[\s\S]{0,300}NativePortraitOutcome::Blocked/,
  "generation refuses to run during a save window");
assert.match(plugin, /plugin_save_site_data[\s\S]*portrait_sweep_abort_active\(\)[\s\S]*save_barrier_begin\(\)/,
  "the save hook fires before DF serializes world memory");

// --- icon path stays an honest icon ---------------------------------------------------------
assert.match(portrait, /capture_unit_icon_with_widget\(/,
  "the widget-grid icon fallback remains available for icon requests only");
const widgetStart = portrait.indexOf("bool capture_unit_icon_with_widget");
const widgetEnd = portrait.indexOf("struct RenderThreadPortraitRequest", widgetStart);
assert(widgetStart >= 0 && widgetEnd > widgetStart, "standalone icon widget path exists");
const widget = portrait.slice(widgetStart, widgetEnd);
assert.match(widget, /source = "widget-grid"/,
  "the icon fallback reports its real source");
assert.doesNotMatch(widget, /TemporaryRenderTarget/,
  "the icon path does not repeat the blank SDL readback");

console.log("PASS portrait native fault guard (exe-pinned SEH call, fault latch, no recursion, no flash, no false 32x32 success)");
