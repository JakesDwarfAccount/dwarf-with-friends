// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// WT28/B218 native-popup-mirror fixture coverage. OFFLINE: no DF, no server, no browser.
// Spec: docs/superpowers/specs/2026-07-13-native-popup-browser-mirror.md.
//
// Three cell families:
//   1. CLIENT fixtures -- the DWFUI-built modal markup + the seq-ordered frame reducer
//      (dwf-popup.js pure exports), each risky cell with a test-the-test seeded-bad.
//   2. WIRE-SHAPE pins -- the C++ encoder (native_popup.cpp state_json_locked) and the JS
//      decoder are pinned to the SAME key names, so neither side can drift silently.
//   3. SERVER source pins -- the invariants the live DLL build must keep: dismissal performs
//      the native mega transition (MTB_clean/parse/set_width; never ESC injection), the route
//      lives in the domain module (not http_server.cpp), camera is never touched, the tick uses
//      ConditionalCoreSuspender, the pause arbiter refuses unpause while popupBlocked, and
//      /diag carries popupBlocked. (True runtime cells -- POPUP_SET over a live socket, native
//      modal confirmed closed -- are the orchestrator's live probe at harvest; see the spec §6.)
//
//   node tools/harness/native_popup_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

const popupSource = readFileSync(join(root, "web/js/dwf-popup.js"), "utf8");
const wsSource = readFileSync(join(root, "web/js/dwf-ws.js"), "utf8");
const indexHtml = readFileSync(join(root, "web/index.html"), "utf8");
const cppSource = readFileSync(join(root, "src/native_popup.cpp"), "utf8");
const cppHeader = readFileSync(join(root, "src/native_popup.h"), "utf8");
const httpServerSource = readFileSync(join(root, "src/http_server.cpp"), "utf8");
const pauseArbiterSource = readFileSync(join(root, "src/pause_arbiter.cpp"), "utf8");
const cmake = readFileSync(join(root, "CMakeLists.txt"), "utf8");

// The popup module resolves DWFUI as a global at load time (browser posture) -- provide the real
// component layer before requiring it, exactly like the panels the other suites load.
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const popup = require(join(root, "web/js/dwf-popup.js"));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// Strip // and /* */ comments so source pins match CODE, never their own documentation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ---- 1. client: modal markup -------------------------------------------------------------------

const megaPopup = {
  id: 7, kind: "mega", typeKey: "",
  text: ["The Forgotten Beast Ngoso Cinderclutches has come!", "", "A gigantic hairy toad."],
  pauses: true,
};

check("markup: built from DWFUI pieces (modalHtml + scrollHtml + plaqueBtnHtml)", () => {
  const html = popup.popupModalMarkup(megaPopup, 0);
  assert.match(html, /class="dwfui-modal df-native-popup"/, "modalHtml chassis + screen cls hook");
  assert.match(html, /role="dialog"/);
  assert.match(html, /class="dwfui-scroll df-popup-text"/, "scrollHtml body (wheel contract, B216)");
  assert.match(html, /dwfui-plaque/, "plaqueBtnHtml dismiss");
  assert.match(html, /data-popup-dismiss="7"/, "dismiss button carries the popup id");
  assert.match(html, /data-popup-id="7"/);
  assert.match(html, /The Forgotten Beast Ngoso Cinderclutches has come!/);
});

check("markup: text lines are ESCAPED (a hostile announcement cannot script the modal)", () => {
  const html = popup.popupModalMarkup({ id: 3, kind: "mega", text: ['<script>alert(1)</script>&'] }, 0);
  assert.ok(!html.includes("<script>"), "raw <script> must not survive");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

check("markup: blank line placeholder + empty-text fallback render", () => {
  const html = popup.popupModalMarkup(megaPopup, 0);
  assert.match(html, /df-popup-line-blank/, "the [B] blank line stays a visible break");
  const empty = popup.popupModalMarkup({ id: 4, kind: "alert", typeKey: "TRADE", text: [] }, 0);
  assert.match(empty, /df-popup-line-empty/, "no text still renders an honest placeholder");
});

check("markup: queue counter appears only when popups are queued behind the front", () => {
  assert.ok(!popup.popupModalMarkup(megaPopup, 0).includes("df-popup-queued"));
  assert.match(popup.popupModalMarkup(megaPopup, 2), /\+2 more/);
});

check("header line: mega is a plain Announcement; alert humanizes its announcement_alert_type key", () => {
  assert.equal(popup.headerLine({ kind: "mega" }), "Announcement");
  assert.equal(popup.headerLine({ kind: "alert", typeKey: "TRADE" }), "Alert: Trade");
  assert.equal(popup.headerLine({ kind: "alert", typeKey: "UNDEAD_ATTACK" }), "Alert: Undead attack");
  assert.equal(popup.headerLine({ kind: "alert", typeKey: "" }), "Alerts");
});

// ---- 1b. client: frame reducer -----------------------------------------------------------------

check("reducer: applies advancing seq, ignores stale/duplicate seq (sticky resync can't resurrect)", () => {
  let state = { seq: -1, popups: [] };
  const open = { type: "popup", seq: 5, blocked: true, popups: [{ id: 1, kind: "mega", text: ["hi"] }] };
  let r = popup.applyPopupFrame(state, open);
  assert.equal(r.changed, true);
  assert.equal(r.state.popups.length, 1);
  state = r.state;

  const clear = { type: "popup", seq: 6, blocked: false, popups: [] };
  r = popup.applyPopupFrame(state, clear);
  assert.equal(r.changed, true);
  assert.equal(r.state.popups.length, 0);
  state = r.state;

  // TEST-THE-TEST seeded-bad: a REPLAYED older frame (the exact wedge a late-join resync could
  // cause) must be rejected -- if the reducer ever applies it, this cell fails.
  r = popup.applyPopupFrame(state, open);
  assert.equal(r.changed, false, "stale seq 5 after seq 6 must not resurrect the popup");
  r = popup.applyPopupFrame(state, clear);
  assert.equal(r.changed, false, "duplicate seq must be a no-op");
});

check("reducer: malformed frames + entries without a numeric id are rejected, not crashed on", () => {
  const state = { seq: 2, popups: [] };
  assert.equal(popup.applyPopupFrame(state, null).changed, false);
  assert.equal(popup.applyPopupFrame(state, { type: "vote", seq: 9 }).changed, false);
  assert.equal(popup.applyPopupFrame(state, { type: "popup", seq: "x" }).changed, false);
  const r = popup.applyPopupFrame(state, {
    type: "popup", seq: 3, popups: [{ kind: "mega" }, { id: 8, kind: "mega", text: [] }, null],
  });
  assert.equal(r.changed, true);
  assert.equal(r.state.popups.length, 1, "only the entry with a numeric id survives");
  assert.equal(r.state.popups[0].id, 8);
});

// ---- 1c. client: drift hygiene ------------------------------------------------------------------

check("drift R2: the popup module never string-builds DWFUI's own markup classes", () => {
  const code = stripComments(popupSource);
  assert.ok(!/class="dwfui-(?:modal|plaque|scroll|row|tabs|head)/.test(code),
    "dwfui-* chassis classes must come from the factories, never hand-rolled");
});

check("drift R1 hygiene: the injected style block resolves colors through --dwfui-* tokens", () => {
  const code = stripComments(popupSource);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code.replace(/#df[A-Za-z]+/g, "")),
    "no hex color literals (ids like #dfPopupMirror excluded)");
  assert.match(code, /var\(--dwfui-text-body\)/, "text color rides the token layer");
});

// ---- 2. wire-shape pins (C++ encoder <-> JS decoder) --------------------------------------------

check("wire: the C++ encoder emits exactly the keys the client reducer/markup consume", () => {
  for (const key of ['\\"type\\":\\"popup\\"', '\\"seq\\":', '\\"blocked\\":', '\\"popups\\":[',
                     '\\"id\\":', '\\"kind\\":', '\\"typeKey\\":', '\\"title\\":',
                     '\\"text\\":', '\\"pauses\\":']) {
    assert.ok(cppSource.includes(key.replace(/\\\\/g, "\\")),
      `state_json_locked must emit ${key}`);
  }
  // TEST-THE-TEST: the matcher itself must fail on a key the encoder does not emit.
  assert.ok(!cppSource.includes('\\"definitely_not_a_key\\":'.replace(/\\\\/g, "\\")));
});

check("wire: ws.js routes {type:'popup'} to DwfPopup.onPopup, throw-safely", () => {
  assert.match(wsSource, /msg\.type === "popup"/);
  assert.match(wsSource, /DwfPopup\.onPopup\(msg\)/);
  const branch = wsSource.slice(wsSource.indexOf('msg.type === "popup"'));
  assert.match(branch.slice(0, 300), /try \{/, "render errors must not kill the socket");
});

check("camera: core.js's capture-phase wheel handler yields over the popup overlay (B216)", () => {
  const coreSource = readFileSync(join(root, "web/js/dwf-core.js"), "utf8");
  const yieldLine = coreSource.split("\n").find(l => l.includes("#alertPopup") && l.includes(".dwfui-scroll"));
  assert.ok(yieldLine, "the B216 wheel yield selector exists");
  assert.ok(yieldLine.includes("#dfPopupMirror"),
    "wheel over the popup mirror must never fall through to map zoom");
});

check("wire: index.html loads dwf-popup.js with a cache buster and a CLOSED tag (B202)", () => {
  const m = indexHtml.match(/<script src="\/js\/dwf-popup\.js\?v=[^"]+"><\/script>/);
  assert.ok(m, "versioned, properly closed script tag");
});

// ---- 3. server source pins ----------------------------------------------------------------------

const cppCode = stripComments(cppSource);
const httpCode = stripComments(httpServerSource);

check("server: /popup + /popup/dismiss live in the domain module, NOT http_server.cpp (B212)", () => {
  assert.match(cppCode, /server\.Get\("\/popup"/);
  assert.match(cppCode, /server\.Post\("\/popup\/dismiss"/);
  assert.ok(!/"\/popup/.test(httpCode.replace(/register_popup_routes\(server\);?/g, "")),
    "http_server.cpp must only call register_popup_routes()");
  assert.match(httpCode, /register_popup_routes\(server\)/);
});

check("server: dismissal performs the native mega transition (Gui.cpp inverse), never ESC injection", () => {
  assert.match(cppCode, /popups\.erase\(popups\.begin\(\)\)/, "pop the FRONT of the queue");
  assert.match(cppCode, /MTB_clean/);
  assert.match(cppCode, /MTB_parse/, "next queued popup re-parsed into mega_text");
  assert.match(cppCode, /MTB_set_width/);
  assert.match(cppCode, /mega_portrait_hfid/);
  for (const forbidden of ["feed_key", "LEAVESCREEN", "SDL_KEYDOWN", "SDLK_ESCAPE", "keybd_event"]) {
    assert.ok(!cppCode.includes(forbidden), `forbidden input injection: ${forbidden}`);
  }
});

check("server: camera is never touched by detection or dismissal (B216 rule)", () => {
  for (const forbidden of ["window_x", "window_y", "window_z", "recenter", "Recenter"]) {
    assert.ok(!cppCode.includes(forbidden), `camera surface referenced: ${forbidden}`);
  }
  // TEST-THE-TEST: the comment-stripper must not hide real code -- a seeded source containing a
  // live window_x write must be caught by this exact matcher.
  const seededBad = 'void f() { *df::global::window_x = 3; } // ok\n';
  assert.ok(stripComments(seededBad).includes("window_x"), "matcher must see code, not only comments");
});

check("server: tick samples under ConditionalCoreSuspender; dismiss applies under capture mutex + CoreSuspender", () => {
  assert.match(cppCode, /ConditionalCoreSuspender/, "the <=1 Hz sample must skip while save-blocked");
  const mega = cppCode.slice(cppCode.indexOf("apply_dismiss_mega"), cppCode.indexOf("apply_dismiss_alert"));
  assert.match(mega, /capture_state_mutex\(\)/, "lock order: capture mutex before suspender");
  assert.match(mega, /CoreSuspender suspend/);
  assert.match(mega, /front->text != match_text/, "TOCTOU re-verification before mutating");
});

check("server: dismissal is idempotent per id (ring memory + already:true no-op)", () => {
  assert.match(cppCode, /id_dismissed_locked/);
  assert.match(cppCode, /remember_dismissed_locked/);
  assert.match(cppSource, /"already":true/);
});

check("server: fresh monotonic ids -- a dismissed or re-fired popup can never resurrect an id", () => {
  assert.match(cppCode, /g_next_id\+\+/);
  assert.ok(!cppCode.includes("g_next_id--"), "the counter only moves forward");
});

check("server: pause arbiter refuses unpause while a popup is mirrored, with a client-visible reason", () => {
  const code = stripComments(pauseArbiterSource);
  assert.match(code, /popup_blocked\(\)/);
  assert.match(pauseArbiterSource, /a native announcement popup is open - dismiss it first/);
  const gate = code.slice(code.indexOf("popup_blocked()") - 200, code.indexOf("popup_blocked()") + 300);
  assert.match(gate, /!desired/, "only the UNPAUSE direction is gated; pausing stays open");
});

check("server: /diag exposes popupBlocked", () => {
  assert.ok(httpCode.includes('\\"popupBlocked\\":'), "/diag JSON body carries popupBlocked");
  assert.match(httpCode, /popup_blocked\(\)/);
});

check("server: push loop runs popup_push_tick; CMakeLists builds native_popup.cpp", () => {
  assert.match(httpCode, /popup_push_tick\(\);/);
  assert.match(cmake, /src\/native_popup\.cpp/);
});

check("server: late joiners are synced with the CURRENT (possibly empty) set once seq > 0", () => {
  assert.match(cppCode, /g_seq > 0/, "empty-set resync so a reconnecting tab never keeps a stale modal");
  assert.match(cppCode, /g_synced/);
});

check("server header: world.status.popups is the mirrored surface; the Alerts window is documented as NOT mirrored", () => {
  assert.match(cppHeader, /world\.status\.popups|world->status\.popups/);
  assert.match(cppHeader, /announcement_alert/, "the header still documents the excluded surface");
  assert.match(cppHeader, /NOT MIRRORED/i, "the Alerts window is explicitly called out as excluded");
  assert.match(cppHeader, /ReadPauseState/, "the ReadPauseState misread is explained, not relied on");
});

// ---- 4. B-popup regression: the host's Alerts window is LOCAL UI, never a browser popup --------
// The bug: the sampler combined world.status.popups (genuine game-wide BOX modals) with
// game.main_interface.announcement_alert.open (the host's LOCAL Alerts/report/combat-log reader).
// The host merely opening a combat report broadcast a bogus "Alerts / (no text)" modal to every
// browser, wrongly blocked browser unpause, and let any browser close the host's window. These
// cells pin that only the BOX queue is mirrored, and that the Alerts window is untouchable.
// (C++ cannot be compiled here; these are source/contract pins, the same posture as section 3.)

const samplerStart = cppCode.indexOf("sample_native_popups_suspended() {");
const samplerBody = cppCode.slice(samplerStart, cppCode.indexOf("reconcile_locked", samplerStart));

check("regression: the sampler mirrors world.status.popups and ONLY that (a real mega vs a bare Alerts window)", () => {
  assert.ok(samplerStart > 0, "the sampler is defined");
  assert.match(samplerBody, /world->status\.popups/, "the BOX/mega queue is the mirrored surface");
  assert.match(samplerBody, /kind = "mega"/, "mega entries are produced");
  // A bare-open Alerts window (announcement_alert.open, viewing_alert, viewing_unit) must
  // contribute NOTHING: the sampler must not read any of the alert-window state to build an entry.
  for (const forbidden of ["announcement_alert", "viewing_alert", "viewing_unit", 'kind = "alert"']) {
    assert.ok(!samplerBody.includes(forbidden),
      `the sampler must not sample the host Alerts window: ${forbidden}`);
  }
  // TEST-THE-TEST seeded-bad: a reconstruction of the OLD behavior (alert-window state entering
  // the mirrored set) must be caught by the exact tokens this cell forbids.
  const seededBad =
    'std::vector<RawPopup> sample_native_popups_suspended() {\n' +
    '  if (game->main_interface.announcement_alert.open) {\n' +
    '    RawPopup p; p.kind = "alert"; out.push_back(std::move(p));\n' +
    '  }\n}\n';
  const seeded = stripComments(seededBad);
  assert.ok(seeded.includes("announcement_alert") && seeded.includes('kind = "alert"'),
    "the seeded-bad old sampler must trip this cell's guard (test-the-test)");
});

check("regression: no code path anywhere produces an alert entry (viewing_alert / viewing_unit / open flag stay off the wire)", () => {
  assert.ok(!/kind\s*=\s*"alert"/.test(cppCode), 'kind "alert" is never assigned');
  assert.ok(!cppCode.includes("announcement_alert"), "announcement_alert is never referenced in code");
  assert.ok(!cppCode.includes("viewing_alert"), "viewing_alert is never read in code");
  assert.ok(!cppCode.includes("viewing_unit"), "viewing_unit is never read in code");
  assert.ok(!cppCode.includes("df::global::game"), "the sampler no longer needs the game global at all");
});

check("regression: a genuine mega/BOX popup still mirrors its text and stays dismissable", () => {
  assert.match(samplerBody, /scrub_markup_lines\(popup->text\)/, "mega text still scrubbed onto the wire");
  assert.match(samplerBody, /pauses = true/, "BOX popups still flagged pausing");
  assert.match(cppCode, /apply_dismiss_mega\(/, "mega dismissal apply still present");
  // client still renders the mega body
  const html = popup.popupModalMarkup(megaPopup, 0);
  assert.match(html, /A gigantic hairy toad\./, "mega body still renders in the modal");
});

check("regression: the browser dismissal route can NEVER close the host Alerts window", () => {
  assert.ok(!cppCode.includes("apply_dismiss_alert"), "the alert dismissal apply is gone entirely");
  assert.ok(!cppCode.includes("announcement_alert"), "announcement_alert is never referenced in code");
  assert.ok(!/\.open\s*=\s*false/.test(cppCode), "no code path sets any .open flag to false");
  // TEST-THE-TEST seeded-bad: the old alert-close route (alias + ai.open = false) must be caught.
  const seededBad =
    'auto& ai = game->main_interface.announcement_alert;\n' +
    'ai.open = false;\n';
  const seeded = stripComments(seededBad);
  assert.ok(seeded.includes("announcement_alert") && /\.open\s*=\s*false/.test(seeded),
    "the seeded old alert-close route must trip these guards (test-the-test)");
});

check("regression: an open host Alerts window does not set popupBlocked (g_blocked tracks only the mirrored BOX set)", () => {
  // popup_blocked() returns g_blocked; g_blocked is only ever stored from !g_current.empty(); and
  // g_current is only ever filled by reconcile_locked over the sampler output -- which now samples
  // ONLY world.status.popups. So a bare open Alerts window leaves g_current empty and
  // popup_blocked() false, and the pause arbiter's unpause gate never fires for it.
  assert.match(cppCode, /g_blocked\.store\(!g_current\.empty\(\)\)/,
    "popupBlocked is derived from the mirrored-set size, nothing else");
  assert.ok(!samplerBody.includes("announcement_alert"),
    "the Alerts window contributes nothing to the mirrored set, so it cannot raise popupBlocked");
});

process.exit(failed ? 1 : 0);
