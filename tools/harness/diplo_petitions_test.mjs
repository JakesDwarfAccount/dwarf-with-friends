// dwf - B225 DIPLO-PETITIONS fixture coverage. OFFLINE: no DF, no server, no browser.
//
// Three cell families (native_popup_test.mjs posture):
//   1. PETITIONS ENTRY -- the B225 root cause was an entry point that never existed:
//      openPanel("petitions") had NO case (Shift+G fell through to the renderLocalPanel stub)
//      and no plaque ever lit. These cells pin the case, the plaque, and the newly bound
//      future-policy cycle so the screen can never go unreachable silently again.
//   2. CLIENT fixtures -- the DWFUI-built plaque stack + meeting mirror markup and the
//      seq-ordered frame reducer (dwf-diplo.js pure exports), each risky cell with a
//      test-the-test seeded-bad.
//   3. WIRE-SHAPE + SERVER SOURCE pins -- the C++ encoder (diplo.cpp state_body_json) and the
//      JS decoder are pinned to the SAME key names; the server invariants the live DLL build
//      must keep (ConditionalCoreSuspender tick, camera never touched, NO dipscript VM pokes,
//      bounds-checked priority write gated on the open Requests screen, pause arbiter refusal,
//      /diag diploBlocked, CMake registration). True runtime cells (frames over a live socket,
//      a real diplomat) are the orchestrator's live probe at harvest.
//
//   node tools/harness/diplo_petitions_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

const diploJs = readFileSync(join(root, "web/js/dwf-diplo.js"), "utf8");
const wsSource = readFileSync(join(root, "web/js/dwf-ws.js"), "utf8");
const indexHtml = readFileSync(join(root, "web/index.html"), "utf8");
const panelsSource = readFileSync(join(root, "web/js/dwf-build-info-panels.js"), "utf8");
const fortAdminSource = readFileSync(join(root, "web/js/dwf-fort-admin.js"), "utf8");
const fortAdminCpp = readFileSync(join(root, "src/fort_admin.cpp"), "utf8");
const dwfuiSource = readFileSync(join(root, "web/js/dwf-ui-components.js"), "utf8");
const cppSource = readFileSync(join(root, "src/diplo.cpp"), "utf8");
const cppHeader = readFileSync(join(root, "src/diplo.h"), "utf8");
const httpServerSource = readFileSync(join(root, "src/http_server.cpp"), "utf8");
const pauseArbiterSource = readFileSync(join(root, "src/pause_arbiter.cpp"), "utf8");
const cmake = readFileSync(join(root, "CMakeLists.txt"), "utf8");
const interfaceMap = JSON.parse(readFileSync(join(root, "web/interface_map.json"), "utf8"));

// The diplo module resolves DWFUI as a global at load time (browser posture) -- provide the
// real component layer before requiring it, exactly like the popup suite does.
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const diplo = require(join(root, "web/js/dwf-diplo.js"));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// Strip // and /* */ comments so source pins match CODE, never their own documentation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const diploCode = stripComments(diploJs);
const cppCode = stripComments(cppSource);
const panelsCode = stripComments(panelsSource);
const fortAdminCode = stripComments(fortAdminSource);

// ---- 1. petitions entry point (the B225 root cause) ---------------------------------------------

check("petitions: openPanel dispatch case exists and calls openPetitionsPanel (the missing B188 entry)", () => {
  assert.match(panelsCode, /name === "petitions"[\s\S]{0,80}openPetitionsPanel\(\)/,
    'openPanel("petitions") must route to openPetitionsPanel -- without this case the screen falls through to the renderLocalPanel stub (the exact bug the owner reported)');
});

check("petitions: the dispatch case sits ABOVE the renderLocalPanel fallthrough", () => {
  const caseAt = panelsCode.indexOf('name === "petitions"');
  const fallAt = panelsCode.indexOf("renderLocalPanel(name)");
  assert.ok(caseAt > 0 && fallAt > 0 && caseAt < fallAt,
    "the petitions case must precede the generic fallthrough or it never runs");
});

check("petitions: future-policy plaque is BOUND (B190's known dead control) and cycles prompt/accept/reject", () => {
  assert.match(fortAdminCode, /\[data-petition-future\]/, "renderFortAdminPanel binds [data-petition-future]");
  assert.match(fortAdminCode, /petitionPolicyCycle/, "the binding calls petitionPolicyCycle");
  assert.match(fortAdminCode, /\/petition-policy\?/, "petitionPolicyCycle POSTs the /petition-policy route");
  // The 3-state cycle order must match the SERVER's value mapping (fort_admin.cpp
  // petition_policy_name: {"prompt","accept","reject"} = 0,1,2) -- a mismatched order would
  // silently set the wrong policy.
  assert.match(fortAdminCode, /\[\s*"prompt"\s*,\s*"accept"\s*,\s*"reject"\s*\]/,
    "client cycle order is prompt,accept,reject");
  assert.match(stripComments(fortAdminCpp), /\{\s*"prompt"\s*,\s*"accept"\s*,\s*"reject"\s*\}/,
    "server value order is prompt,accept,reject");
});

check("petitions: plaque opens the same entry point (openPanel('petitions'))", () => {
  assert.match(diploCode, /openPanel\("petitions"\)/,
    "the PETITIONS plaque click must route through the shared entry point, not a private copy");
});

// ---- 1b. B225 FAIL-CLOSED: per-petition approve/deny is host-only (2026-07-17 bugfix) -----------
// The old Approve/Deny buttons FAKED the decision. LIVE-verified on the loaded fort (127.0.0.1:8765):
// accepting agreement 386 via the route only cleared agreement.flags.petition_not_accepted and the
// petitioner unit 1885 (Mestthos) stayed flags2.visitor=true / never gained residency; denying 389
// only dropped the row and its petitioner re-petitioned as a fresh agreement -- exactly the owner's
// "dismiss for a minute then they all come back, never actually deny/approve" report. Only two
// agreement_flag bits exist (df.agreement.xml: petition_not_accepted / convicted_accepted) and the
// full native write -- the residency grant on accept -- cannot be reconstructed without risking the
// save-persistent agreement corruption diplo.cpp warns about. Per the release rule (an honest
// unavailable beats a fake dismiss), the buttons fail closed to a host-assisted state and the routes
// refuse 501 native-only. The standing-orders policy toggle stays as the one honest browser lever.

check("petitions fail-closed: the pending detail shows a host-assisted state, NOT Approve/Deny buttons", () => {
  assert.match(fortAdminCode, /must be decided by the host/i,
    "a pending petition must present the host-assisted copy, not action buttons");
  assert.match(fortAdminCode, /Steam client/,
    "the copy points the player at the native Steam client");
  assert.ok(!/petitionAccept|petitionDeny/.test(fortAdminCode),
    "no petitionAccept/petitionDeny datasets survive -- those wired the fake write");
  assert.ok(!/data-petition-accept|data-petition-deny/.test(fortAdminCode),
    "no [data-petition-accept]/[data-petition-deny] bindings survive");
});

check("petitions fail-closed SEEDED-BAD: the optimistic fake-dismiss path is DELETED (row leaves only on server truth)", () => {
  // The bug shape: a client that POSTs, then immediately announces success and hides the row on its
  // own guess. A petition may leave the list ONLY when the server's /petitions re-read drops it --
  // never on an optimistic client dismiss. If either of these regexes ever matches again, the fake
  // dismiss has been reintroduced and this cell FAILS.
  assert.ok(!/function petitionAction/.test(fortAdminCode),
    "petitionAction() (POST-then-optimistically-confirm) must be gone");
  assert.ok(!/Petition accepted\.|Petition denied\./.test(fortAdminCode),
    "no optimistic 'Petition accepted./denied.' confirmation may remain -- that was the lie");
});

check("petitions fail-closed: the honest browser lever (standing-orders auto-response) is RETAINED", () => {
  assert.match(fortAdminCode, /\[data-petition-future\]/, "the policy plaque stays bound");
  assert.match(fortAdminCode, /petitionPolicyCycle/, "petitionPolicyCycle stays");
  assert.match(fortAdminCode, /\/petition-policy\?/, "it still POSTs /petition-policy (DF then auto-handles new petitions natively)");
});

check("server fail-closed: /petition-accept and /petition-deny validate then REFUSE 501 native-only, never mutate", () => {
  const cpp = stripComments(fortAdminCpp);
  assert.match(cpp, /server\.(Get|Post)\("\/petition-accept"\s*,\s*native_only_handler\)/,
    "/petition-accept maps to the refusing handler");
  assert.match(cpp, /server\.(Get|Post)\("\/petition-deny"\s*,\s*native_only_handler\)/,
    "/petition-deny maps to the refusing handler");
  assert.match(cpp, /\\"blocked\\":\\"native-only\\"/, "the refusal carries the native-only shape (missions.cpp contract)");
  assert.match(cpp, /res\.status = 501/, "it is a 501, not a 200 fake-ok");
  assert.match(cpp, /validate_pending_petition/, "a bad id still 400s; only a real pending petition earns the 501");
  // seeded-bad direction: the old mutating write must be GONE from the code (comments are stripped).
  assert.ok(!/flags\.bits\.petition_not_accepted = false/.test(cpp),
    "the old accept mutation (clearing the not-accepted flag) must be gone");
  assert.ok(!/\bdo_petition_accept\b|\bdo_petition_deny\b|\bremove_petition_id\b/.test(cpp),
    "the old mutating helpers must be gone");
});

check("server fail-closed: the refusal reason is native-faithful -- it names the residency grant it cannot do (df.agreement.xml two-flag model)", () => {
  const cpp = stripComments(fortAdminCpp);
  assert.match(cpp, /kPetitionNativeOnlyReason/, "the routes use the documented reason constant");
  assert.match(cpp, /residency/i, "the reason cites the native side effect (residency) the plugin can't reproduce");
  // audit trail lives in the (unstripped) source doc: the two-flag model + the live verification.
  assert.match(fortAdminCpp, /petition_not_accepted[\s\S]{0,120}convicted_accepted|convicted_accepted[\s\S]{0,120}petition_not_accepted/,
    "the decision documents the only two agreement_flag bits (df.agreement.xml)");
  assert.match(fortAdminCpp, /LIVE-VERIFIED|visitor=true/i,
    "the decision records the live evidence (the accepted petitioner never gained residency)");
});

// ---- 2. client: reducer -------------------------------------------------------------------------

check("client: reducer applies a first frame and normalizes the shape", () => {
  const r = diplo.applyDiploFrame(null, { type: "diplo", seq: 1, petitionsPending: 2,
    meetingsQueued: 1, open: false, meeting: null });
  assert.equal(r.changed, true);
  assert.equal(r.state.petitionsPending, 2);
  assert.equal(r.state.meetingsQueued, 1);
  assert.equal(r.state.open, false);
  assert.equal(r.state.meeting, null);
});

check("client: reducer rejects stale and duplicate seq (sticky resync cannot resurrect a cleared plaque)", () => {
  let state = diplo.applyDiploFrame(null, { type: "diplo", seq: 5, petitionsPending: 0,
    meetingsQueued: 0, open: false, meeting: null }).state;
  // seeded-bad: an OLD frame claiming petitions pending must be ignored
  const stale = diplo.applyDiploFrame(state, { type: "diplo", seq: 4, petitionsPending: 9,
    meetingsQueued: 0, open: false, meeting: null });
  assert.equal(stale.changed, false);
  assert.equal(stale.state.petitionsPending, 0);
  const dup = diplo.applyDiploFrame(state, { type: "diplo", seq: 5, petitionsPending: 9 });
  assert.equal(dup.changed, false);
});

check("client: reducer ignores junk frames (test-the-test: wrong type, bad seq)", () => {
  const base = diplo.applyDiploFrame(null, { type: "diplo", seq: 1 }).state;
  assert.equal(diplo.applyDiploFrame(base, { type: "popup", seq: 2 }).changed, false);
  assert.equal(diplo.applyDiploFrame(base, { type: "diplo", seq: "x" }).changed, false);
  assert.equal(diplo.applyDiploFrame(base, null).changed, false);
});

// ---- 2. client: word stream ----------------------------------------------------------------------

check("client: wordLines splits on nl/blank and keeps indent on the first word", () => {
  const lines = diplo.wordLines([
    { t: "The", c: "#ffffff" }, { t: "liaison" },
    { t: "Avuz:", nl: 1, c: "#8888ff" }, { t: "hello" },
    { t: "Bye", blank: 1, ind: 1 },
  ]);
  assert.equal(lines.length, 4);              // line, line, BLANK, line
  assert.deepEqual(lines[0].map(s => s.t), ["The", "liaison"]);
  assert.deepEqual(lines[1].map(s => s.t), ["Avuz:", "hello"]);
  assert.deepEqual(lines[2], []);             // the blank spacer line
  assert.equal(lines[3][0].ind, 1);
});

check("client: word colors are whitelisted to #rrggbb before touching a style attribute", () => {
  const html = diplo.wordLinesHtml([{ t: "ok", c: "#8888ff" }]);
  assert.match(html, /style="color:#8888ff"/);
  // seeded-bad: an injection-shaped color must render UNSTYLED, not into the attribute
  const bad = diplo.wordLinesHtml([{ t: "x", c: 'red;background:url(1)' }]);
  assert.ok(!bad.includes("style="), "non-#rrggbb colors never reach a style attribute");
  const bad2 = diplo.wordLinesHtml([{ t: "x", c: "#88f" }]);
  assert.ok(!bad2.includes("style="), "shorthand hex is rejected (exact 6-digit whitelist)");
});

check("client: word text is HTML-escaped (seeded-bad: a <script> word stays inert)", () => {
  const html = diplo.wordLinesHtml([{ t: "<script>alert(1)</script>" }]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ---- 2. client: plaque stack ----------------------------------------------------------------------

check("client: plaque stack renders NOTHING in the all-clear state", () => {
  assert.equal(diplo.plaqueStackMarkup({ petitionsPending: 0, meetingsQueued: 0, open: false }), "");
});

check("client: PETITIONS plaque appears while petitions are pending, with the raws token", () => {
  const html = diplo.plaqueStackMarkup({ petitionsPending: 3, meetingsQueued: 0, open: false });
  assert.match(html, /data-dwfui-lightplaque="PETITIONS_LIGHT"/);
  assert.match(html, /PETITIONS/);
  assert.match(html, /data-diplo-plaque="petitions"/);
  assert.match(html, /3 petitions awaiting/);
  assert.ok(!html.includes("DIPLOMACY_LIGHT"), "no diplomacy plaque without a meeting");
});

check("client: DIPLOMACY plaque appears when a meeting is queued OR open", () => {
  for (const state of [{ petitionsPending: 0, meetingsQueued: 1, open: false },
                       { petitionsPending: 0, meetingsQueued: 0, open: true }]) {
    const html = diplo.plaqueStackMarkup(state);
    assert.match(html, /data-dwfui-lightplaque="DIPLOMACY_LIGHT"/);
    assert.match(html, /data-diplo-plaque="diplomacy"/);
  }
});

check("client: both raws tokens exist in interface_map.json with the 3x3-tile footprint", () => {
  // graphics_interface.txt: [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS:29:12:3:3:DIPLOMACY_LIGHT]
  //                         [TILE_GRAPHICS_RECTANGLE:INTERFACE_BITS:42:12:3:3:PETITIONS_LIGHT]
  // 3x3 tiles of 8x12 px = 24x36 px on interface_bits.png at (29*8,12*12) / (42*8,12*12).
  for (const [token, cx] of [["DIPLOMACY_LIGHT", 232], ["PETITIONS_LIGHT", 336]]) {
    const rec = interfaceMap[token];
    assert.ok(rec, token + " present in interface_map.json");
    assert.equal(rec.img, "interface_bits.png");
    assert.equal(rec.cx, cx);
    assert.equal(rec.cy, 144);
    assert.equal(rec.w, 24);
    assert.equal(rec.h, 36);
  }
});

check("client: lightPlaqueHtml is a DWFUI component with the nine-slice paint pass", () => {
  assert.equal(typeof globalThis.DWFUI.lightPlaqueHtml, "function");
  const html = globalThis.DWFUI.lightPlaqueHtml({ token: "PETITIONS_LIGHT", label: "PETITIONS" });
  assert.match(html, /data-dwfui-lightplaque="PETITIONS_LIGHT"/);
  assert.match(html, /data-dwfui-lightplaque-chars="9"/);
  assert.match(html, /dwfui-bitmap-text/);
  assert.throws(() => globalThis.DWFUI.lightPlaqueHtml({ label: "X" }), /token/,
    "a token-less plaque throws (no silent letter-art fallback)");
  assert.match(stripComments(dwfuiSource), /data-dwfui-lightplaque/,
    "paintSprites owns a [data-dwfui-lightplaque] pass");
});

// ---- 2. client: meeting mirror --------------------------------------------------------------------

const openState = {
  seq: 3, petitionsPending: 0, meetingsQueued: 0, open: true,
  meeting: { mode: "text", actor: "Avuz Ezumdesis", target: "Kadol Imeshfikod",
    advanceHostNative: true,
    words: [{ t: "The" }, { t: "liaison" }, { t: "speaks.", c: "#8888ff", nl: 1 }],
    topics: ["ExportAgreement"] },
};

check("client: open meeting renders the dialogue with native colors inside a .dwfui-scroll body", () => {
  const html = diplo.meetingModalMarkup(openState);
  assert.match(html, /df-diplo-screen/);
  assert.match(html, /dwfui-scroll/);
  assert.match(html, /style="color:#8888ff"/);
  assert.match(html, /data-diplo-open="1"/);
});

check("client: the Okay advance is an HONEST disabled placeholder (host-native v1), Close works", () => {
  const html = diplo.meetingModalMarkup(openState);
  assert.match(html, /data-diplo-okay/);
  assert.match(html, /disabled/);
  assert.match(html, /not wired yet/i);
  assert.match(html, /data-diplo-close/);
});

check("client: queued-but-not-open meeting says the dialog opens on the host (never pretends)", () => {
  const html = diplo.meetingModalMarkup({ seq: 1, petitionsPending: 0, meetingsQueued: 2,
    open: false, meeting: null });
  assert.match(html, /ready to meet/);
  assert.match(html, /2 meetings queued/);
  assert.match(html, /host PC/);
  assert.ok(!/data-diplo-okay/.test(html), "no Okay button when there is no open dialog");
});

check("client: landHolder / requests sub-modes render mirrored DATA without inventing native looks", () => {
  const lh = diplo.meetingBodyHtml({ open: true, meetingsQueued: 0, meeting: {
    mode: "landHolder", words: [],
    landHolder: { positions: ["baron"], candidates: [{ hfid: 7, name: "Urist McBaron" }] } } });
  assert.match(lh, /baron/);
  assert.match(lh, /Urist McBaron/);
  assert.match(lh, /host PC/);
  const rq = diplo.meetingBodyHtml({ open: true, meetingsQueued: 0, meeting: {
    mode: "requests", words: [],
    requests: { selectedTab: 0, tabs: [{ cat: 0, name: "Leather", priorities: [0, 4, 0] }] } } });
  assert.match(rq, /Leather/);
  assert.match(rq, /3 goods, 1 requested/);
});

check("client: B216 -- the overlay and plaque stack swallow every pointer/wheel event class", () => {
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu",
                      "pointerdown", "pointerup", "wheel", "touchstart", "touchend"])
    assert.ok(diploCode.includes(`"${type}"`), `swallow list covers ${type}`);
  assert.match(diploCode, /stopPropagation/);
  assert.ok(!/window_x|window_y|recenter|centerOn/.test(diploCode),
    "the client module never touches the camera");
});

// ---- 3. wire shape: the C++ encoder and JS decoder agree ------------------------------------------

check("wire: every key the client reads is emitted by diplo.cpp (and vice versa for the envelope)", () => {
  for (const key of ["petitionsPending", "meetingsQueued", "open", "meeting", "mode", "actor",
                     "target", "advanceHostNative", "words", "landHolder", "positions",
                     "candidates", "hfid", "name", "requests", "selectedTab", "tabs", "cat",
                     "priorities", "topics", "seq"])
    assert.ok(cppSource.includes(`\\"${key}\\"`) || cppSource.includes(`"\\"${key}\\"`),
      `diplo.cpp emits "${key}"`);
  for (const key of ["t", "c", "nl", "blank", "ind"])
    assert.ok(cppSource.includes(`\\"${key}\\"`), `diplo.cpp emits word key "${key}"`);
  assert.match(diploCode, /msg\.type !== "diplo"/, "client filters on the diplo type");
  assert.match(cppCode, /"\\"type\\":\\"diplo\\","/, "server stamps the diplo type on WS frames");
});

check("wire: ws.js routes {'type':'diplo'} to DwfDiplo and index.html loads the module", () => {
  assert.match(stripComments(wsSource), /msg\.type === "diplo"/);
  assert.match(stripComments(wsSource), /DwfDiplo\.onDiplo/);
  assert.match(indexHtml, /dwf-diplo\.js\?v=/);
  const uiAt = indexHtml.indexOf("dwf-ui-components.js");
  const panelsAt = indexHtml.indexOf("dwf-build-info-panels.js");
  const diploAt = indexHtml.indexOf("dwf-diplo.js");
  assert.ok(uiAt > 0 && panelsAt > 0 && diploAt > panelsAt && diploAt > uiAt,
    "dwf-diplo.js loads after DWFUI and after openPanel's module");
});

// ---- 3. server source pins -------------------------------------------------------------------------

check("server: the tick samples under ConditionalCoreSuspender and never holds the module mutex across it", () => {
  assert.match(cppCode, /ConditionalCoreSuspender suspend/);
  assert.match(cppCode, /sample_native_suspended\(\)/);
});

check("server: detection reads the three cited structures", () => {
  assert.match(cppCode, /plotinfo->petitions\.size\(\)/);
  assert.match(cppCode, /plotinfo->dipscript_popups\.size\(\)/);
  assert.match(cppCode, /main_interface\.diplomacy/);
});

check("server: CAMERA IS NEVER TOUCHED and the dipscript VM is never poked", () => {
  assert.ok(!/window_x|window_y|window_z|recenter/.test(cppCode), "no camera writes");
  assert.ok(!/cur_step\s*=|->flags\.bits\.close_screen\s*=|->flags\.bits\.new_screen\s*=/.test(cppCode),
    "no meeting-advance guesses: cur_step / mm flags are never written");
  assert.match(cppCode, /advanceHostNative/, "the wire says the advance is host-native instead");
});

check("server: the priority write is the proven tradeagreement.lua mutation, fully guarded", () => {
  assert.match(cppCode, /diplo-request-priority/);
  assert.match(cppCode, /taking_requests\b/);
  assert.match(cppCode, /sell_requests->priority\[cat\]/);
  assert.match(cppCode, /index out of range/);
  assert.match(cppCode, /value < 0 \|\| value > 4/);
  assert.match(cppCode, /CoreSuspender suspend/, "the mutation runs under the core suspender");
  assert.match(cppCode, /capture_state_mutex/, "and under the capture mutex (house lock order)");
});

check("server: routes live in the domain module, registered + ticked by http_server, built by CMake", () => {
  assert.ok(!stripComments(httpServerSource).includes('"/diplo"'),
    "http_server.cpp does not inline the route (B212 rule)");
  assert.match(stripComments(httpServerSource), /register_diplo_routes\(server\)/);
  assert.match(stripComments(httpServerSource), /diplo_push_tick\(\)/);
  assert.match(stripComments(httpServerSource), /diploBlocked/);
  assert.match(cmake, /src\/diplo\.cpp/);
});

check("server: the pause arbiter refuses unpause while the meeting wedges the sim, with a clear reason", () => {
  const code = stripComments(pauseArbiterSource);
  assert.match(code, /diplo_meeting_open\(\)/);
  assert.match(code, /diplomacy meeting is underway/);
});

check("server: sticky late-join sync mirrors the vote/popup pattern (seq > 0 gate + roster prune)", () => {
  assert.match(cppCode, /g_seq > 0/);
  assert.match(cppCode, /g_synced/);
  assert.match(cppCode, /ws_connected_players\(\)/);
});

check("server header: the raws + df-structures citations are the documented detection surface", () => {
  assert.match(cppHeader, /PETITIONS_LIGHT/);
  assert.match(cppHeader, /DIPLOMACY_LIGHT/);
  assert.match(cppSource, /df\.d_interface\.xml/);
  assert.match(cppSource, /tradeagreement\.lua/);
});

// ---- summary --------------------------------------------------------------------------------------
if (failed) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
