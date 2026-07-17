// vote_fixture_test.mjs -- OFFLINE fixture suite for WT14 (fortress-elevation vote).
// No Dwarf Fortress, no server, no browser.
//
// Covers, per the wave brief:
//   1. vote LIFECYCLE through the client's pure reducer: open -> cast -> change -> close -> result
//   2. one-vote-per-player (client reducer dedup + C++ source contract)
//   3. unknown-player rejection (C++ source contract: explicit roster check, no query_player
//      "default" fallback on any vote action route)
//   4. client feature-detect dormancy: zero network calls at load, `supported` only flips on a
//      real vote frame, dormant render carries no action buttons, ws.js routes the frame inertly
//   5. server detection read: the diplomacy_interfacest land-holder popup fields, tier topics,
//      auto open/close edges, ConditionalCoreSuspender + <=1Hz sampling discipline
// plus DWFUI/XSS seeded-bads (test-the-test cells throughout).
//
//   node tools/harness/vote_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const modPath = join(root, "web", "js", "dwf-vote.js");
const cpp = readFileSync(join(root, "src", "vote.cpp"), "utf8");
const cppHeader = readFileSync(join(root, "src", "vote.h"), "utf8");
const wsSrc = readFileSync(join(root, "web", "js", "dwf-ws.js"), "utf8");
const httpSrc = readFileSync(join(root, "src", "http_server.cpp"), "utf8");
const cmake = readFileSync(join(root, "CMakeLists.txt"), "utf8");
const indexHtml = readFileSync(join(root, "web", "index.html"), "utf8");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkGuard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}
function noThrow(name, fn) {
  try { const v = fn(); passed++; console.log(`  ok - ${name} (no throw)`); return v; }
  catch (e) { failed++; console.log(`  FAIL - ${name} threw: ${e.message}`); return undefined; }
}

try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-vote.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

// ---------------- 4a. feature-detect dormancy: ZERO network calls at module load ----------------
console.log("\n# dormancy: loading the module performs no I/O");
let fetchCalls = 0;
globalThis.fetch = (...args) => { fetchCalls++; return Promise.resolve({ ok: false }); };
// DWFUI is loaded for render cells below; loading it must not fetch either.
const DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
globalThis.DWFUI = DWFUI;
const M = require(modPath);
check("module exports the pure shapers",
  ["voteInitialState", "voteReduce", "voteMyChoice", "voteRenderBody", "VOTE_ADVISORY"]
    .every(k => M[k] !== undefined));
check("requiring the module made ZERO fetch calls (dormant boot)", fetchCalls === 0,
  `saw ${fetchCalls}`);
checkGuard("the fetch spy itself works (a probe call is counted)",
  (() => { fetch("/probe"); const hit = fetchCalls === 1; fetchCalls = 0; return hit; })());

// ---------------- 4b. supported only flips on a REAL vote frame ----------------
console.log("\n# dormancy: `supported` requires a vote-shaped frame");
{
  const s0 = M.voteInitialState();
  check("initial state is unsupported / empty",
    s0.supported === false && s0.active === null && s0.lastResult === null);
  check("a foreign frame ({type:'pause'}) does NOT flip supported",
    M.voteReduce(s0, { type: "pause", paused: true }).supported === false);
  check("garbage (null/42/[]) returns the previous state unchanged",
    M.voteReduce(s0, null) === s0 && M.voteReduce(s0, 42) === s0 && M.voteReduce(s0, []) === s0);
  const s1 = M.voteReduce(s0, { type: "vote", seq: 0, active: null, lastResult: null,
    detection: { pending: false, topic: "", titles: [] } });
  check("a real (even empty) vote frame flips supported", s1.supported === true);
  checkGuard("an {active:...}-bearing junk object without vote shape stays unsupported",
    M.voteReduce(s0, { tiles: [], origin: {} }).supported === false);
}

// ---------------- 4c. dormant render: message only, no action buttons ----------------
console.log("\n# dormancy: render");
{
  const html = M.voteRenderBody(M.voteInitialState(), "host");
  check("dormant body says the server needs updating", /newer server/i.test(html));
  check("dormant body has NO cast/start/close affordances",
    !/data-vote-cast|data-vote-start|data-vote-close/.test(html));
}

// ---------------- 1. lifecycle: open -> cast -> change -> close -> result ----------------
console.log("\n# lifecycle through the reducer (the exact frames vote.cpp broadcasts)");
{
  const open = { type: "vote", seq: 1, active: { id: 1, topic: "Become a Barony?",
    kind: "elevation", openedBy: "server", openedMs: 1000, yes: 0, no: 0, votes: [] },
    lastResult: null, detection: { pending: true, topic: "Become a Barony?", titles: ["baron"] } };
  let s = M.voteReduce(M.voteInitialState(), open);
  check("OPEN: active vote with topic + kind elevation",
    s.active && s.active.topic === "Become a Barony?" && s.active.kind === "elevation");
  check("OPEN: detection rides along (pending, titles)",
    s.detection.pending === true && s.detection.titles.join() === "baron");
  check("OPEN: nobody has voted, myChoice null",
    s.active.yes === 0 && s.active.no === 0 && M.voteMyChoice(s, "host") === null);

  const cast = { ...open, active: { ...open.active, yes: 2, no: 0, votes: [
    { player: "host", choice: "yes" }, { player: "mate", choice: "yes" }] } };
  s = M.voteReduce(s, cast);
  check("CAST: tally recomputed from ballots (2 yes / 0 no)",
    s.active.yes === 2 && s.active.no === 0);
  check("CAST: myChoice resolves per player",
    M.voteMyChoice(s, "host") === "yes" && M.voteMyChoice(s, "visitor") === null);

  const change = { ...open, active: { ...open.active, votes: [
    { player: "host", choice: "no" }, { player: "mate", choice: "yes" }] } };
  s = M.voteReduce(s, change);
  check("CHANGE: host flips to no; one ballot each, tally 1/1",
    M.voteMyChoice(s, "host") === "no" && s.active.yes === 1 && s.active.no === 1);
  checkGuard("CHANGE: a change of mind never adds a second ballot",
    s.active.votes.length === 2);

  const close = { type: "vote", seq: 1, active: null, lastResult: { id: 1,
    topic: "Become a Barony?", kind: "elevation", openedBy: "server", closedBy: "server",
    result: "yes", yes: 2, no: 1, openedMs: 1000, closedMs: 9000, votes: [
      { player: "host", choice: "yes" }, { player: "mate", choice: "yes" },
      { player: "visitor", choice: "no" }] },
    detection: { pending: false, topic: "", titles: [] } };
  s = M.voteReduce(s, close);
  check("CLOSE: active gone, result yes with 2/1 tally + closedBy",
    s.active === null && s.lastResult && s.lastResult.result === "yes" &&
    s.lastResult.yes === 2 && s.lastResult.no === 1 && s.lastResult.closedBy === "server");
  // result recompute guard: a wire that LIES about the result is corrected from the ballots
  const lying = { ...close, lastResult: { ...close.lastResult, result: "no" } };
  checkGuard("a lying result field is recomputed from the ballots (yes wins 2/1)",
    M.voteReduce(M.voteInitialState(), lying).lastResult.result === "yes");
  const tie = { ...close, lastResult: { ...close.lastResult, result: "tie", votes: [
    { player: "host", choice: "yes" }, { player: "visitor", choice: "no" }] } };
  check("a 1/1 close is a tie", M.voteReduce(s, tie).lastResult.result === "tie");
}

// ---------------- 2. one-vote-per-player ----------------
console.log("\n# one vote per player");
{
  const dup = { type: "vote", seq: 2, active: { id: 2, topic: "T", kind: "custom",
    openedBy: "host", openedMs: 0, yes: 9, no: 9, votes: [
      { player: "host", choice: "yes" }, { player: "host", choice: "no" },
      { player: "mate", choice: "no" }] }, lastResult: null,
    detection: { pending: false, topic: "", titles: [] } };
  const s = M.voteReduce(M.voteInitialState(), dup);
  check("duplicate ballots for one name collapse to one (2 voters, 1/1)",
    s.active.votes.length === 2 && s.active.yes === 1 && s.active.no === 1);
  checkGuard("wire-claimed 9/9 tally is ignored in favour of real ballots",
    s.active.yes !== 9 && s.active.no !== 9);
  // C++ side: the cast handler finds an existing ballot by name and REPLACES it.
  check("vote.cpp: recast replaces the same slot (find_if + it->second = yes)",
    /find_if\(g_vote\.votes\.begin\(\)[\s\S]*?it->second = yes;[\s\S]*?emplace_back\(player, yes\)/.test(cpp));
}

// ---------------- 3. unknown-player rejection (server source contract) ----------------
console.log("\n# unknown-player rejection (vote.cpp)");
{
  check("vote_query_player requires the param, validates, and checks the live roster",
    /vote_query_player[\s\S]*?missing player[\s\S]*?is_safe_player_id[\s\S]*?invalid player[\s\S]*?roster_has\(player\)[\s\S]*?unknown player/.test(cpp));
  check("roster check uses ws_roster_players (disconnect-grace truth)",
    /roster_has[\s\S]*?ws_roster_players\(\)/.test(cpp));
  check("all three action routes gate on vote_query_player",
    (cpp.match(/if \(!vote_query_player\(req, player, &err\)\)/g) || []).length === 3);
  checkGuard("no vote action route falls back to query_player's 'default' player",
    !/query_player\(req\)/.test(cpp));
  check("cast validates choice as yes|no", /choice != "yes" && choice != "no"/.test(cpp));
  check("cast/close reject when no vote is open; start rejects a double-open (409)",
    (cpp.match(/no vote is open/g) || []).length === 2 && /a vote is already open/.test(cpp));
}

// ---------------- 5. detection: the reliable native read (source contract) ----------------
console.log("\n# native land-holder offer detection (vote.cpp / vote.h)");
{
  check("reads game->main_interface.diplomacy open + selecting_land_holder_position",
    /main_interface\.diplomacy/.test(cpp) && /dip\.open \|\| !dip\.selecting_land_holder_position/.test(cpp));
  check("resolves offered land_holder_pos_id against child civ, parent civ fallback",
    /land_holder_pos_id/.test(cpp) && /land_holder_child_civ, pos_id/.test(cpp) &&
    /land_holder_parent_civ, pos_id/.test(cpp));
  check("tier topics: 1=Barony, 2=County, 3=Duchy, else generic",
    /case 1: return "Become a Barony\?"/.test(cpp) && /case 2: return "Become a County\?"/.test(cpp) &&
    /case 3: return "Become a Duchy\?"/.test(cpp) && /default: return "Elevate the fortress\?"/.test(cpp));
  check("sampling runs under ConditionalCoreSuspender (never a raw read off-thread)",
    /ConditionalCoreSuspender suspend;[\s\S]*?if \(suspend\)[\s\S]*?sample_native_offer_suspended/.test(cpp));
  check("sampling is rate-limited (<=1Hz) inside the ~30Hz push loop",
    /now - last_pass < 1000/.test(cpp));
  check("rising edge auto-opens; falling edge auto-closes ONLY an auto-opened vote",
    /fresh\.pending && !was_pending && !g_active/.test(cpp) &&
    /!fresh\.pending && was_pending && g_active && g_vote\.auto_opened/.test(cpp));
  check("every position walk is null-guarded (petitions-walk discipline)",
    /if \(!ent\)\s*\n?\s*return nullptr;/.test(cpp) && /if \(pos && pos->id == pos_id\)/.test(cpp));
  check("GET /vote never takes CoreSuspender (serves the cached detection)",
    /GET \/vote -> full state \+ cached detection\. Mutex-only/.test(cpp));
  check("the mountainhome gap is stated honestly (letter, not detectable; manual start covers it)",
    /mountainhome/i.test(cpp) && /vote-start/.test(cpp));
  check("vote.h documents the df-structures source of the read",
    /diplomacy_interfacest/.test(cppHeader) && /land_holder/.test(cppHeader));
}

// ---------------- server wiring ----------------
console.log("\n# server wiring");
{
  check("http_server.cpp registers the vote routes", /register_vote_routes\(server\);/.test(httpSrc));
  check("ws_push_loop ticks vote_push_tick after pause_push_tick",
    /pause_push_tick\(\);[\s\S]{0,400}vote_push_tick\(\);/.test(httpSrc));
  check("CMakeLists compiles src/vote.cpp", /src\/vote\.cpp/.test(cmake));
  check("broadcast frame is typed vote and shares the GET /vote body",
    /\\"type\\":\\"vote\\"/.test(cpp) && /state_json_locked/.test(cpp));
  check("late joiners are synced (g_synced pruned to the live roster)",
    /g_synced/.test(cpp) && /ws_connected_players\(\)/.test(cpp));
}

// ---------------- client wiring: ws routing + index.html ----------------
console.log("\n# client wiring");
{
  check("dwf-ws.js routes {\"type\":\"vote\"} to DwfVote.onVote, inert if absent",
    /msg\.type === "vote"[\s\S]{0,200}window\.DwfVote\) window\.DwfVote\.onVote\(msg\)/.test(wsSrc));
  check("index.html loads dwf-vote.js after dwf-ui-components.js",
    indexHtml.indexOf("dwf-ui-components.js") >= 0 &&
    indexHtml.indexOf("dwf-vote.js") > indexHtml.indexOf("dwf-ui-components.js"));
  check("topbar #voteBtn ships hidden (display:none) until the wire proves itself",
    /id="voteBtn"[^>]*style="display:none"/.test(indexHtml));
}

// ---------------- render cells (DWFUI-built, XSS-safe) ----------------
console.log("\n# render");
{
  const active = M.voteReduce(M.voteInitialState(), { type: "vote", seq: 3, active: {
    id: 3, topic: "Become a County?", kind: "elevation", openedBy: "server", openedMs: 0,
    yes: 0, no: 0, votes: [{ player: "mate", choice: "yes" }, { player: "host", choice: "no" }] },
    lastResult: null, detection: { pending: true, topic: "Become a County?", titles: ["count"] } });
  const html = M.voteRenderBody(active, "host");
  check("active body: topic, YES/NO cast plaques, close affordance",
    html.includes("Become a County?") && /data-vote-cast="yes"/.test(html) &&
    /data-vote-cast="no"/.test(html) && /data-vote-close/.test(html));
  check("who-voted lists both names", html.includes("mate") && html.includes("host"));
  check("my NO ballot is highlighted (selected on the no plaque)",
    /vt-cast-no selected/.test(html) && !/vt-cast-yes selected/.test(html));
  check("footer carries the advisory contract verbatim", html.includes(M.VOTE_ADVISORY) &&
    /advises the overseer/.test(M.VOTE_ADVISORY));
  check("uses DWFUI grammar (dwfui-plaque + dwfui-row + dwfui-bar) -- not hand-rolled",
    /dwfui-plaque/.test(html) && /dwfui-row/.test(html) && /dwfui-bar-row/.test(html));

  // XSS: a hostile topic + player name must render escaped.
  const evil = M.voteReduce(M.voteInitialState(), { type: "vote", seq: 4, active: {
    id: 4, topic: `<img src=x onerror=alert(1)>`, kind: "custom", openedBy: `<b>h4x</b>`,
    openedMs: 0, yes: 0, no: 0, votes: [{ player: "safe", choice: "yes" }] },
    lastResult: null, detection: { pending: false, topic: "", titles: [] } });
  const evilHtml = M.voteRenderBody(evil, "safe");
  checkGuard("hostile topic/openedBy are HTML-escaped (no raw <img>/<b> in output)",
    !evilHtml.includes("<img src=x") && !evilHtml.includes("<b>h4x</b>") &&
    evilHtml.includes("&lt;img"));

  const closed = M.voteReduce(M.voteInitialState(), { type: "vote", seq: 3, active: null,
    lastResult: { id: 3, topic: "Become a County?", kind: "elevation", openedBy: "server",
      closedBy: "server", result: "no", yes: 1, no: 2, openedMs: 0, closedMs: 5,
      votes: [{ player: "a", choice: "no" }, { player: "b", choice: "no" }, { player: "c", choice: "yes" }] },
    detection: { pending: false, topic: "", titles: [] } });
  const closedHtml = M.voteRenderBody(closed, "host");
  check("closed banner shows the verdict + tally and offers Call a vote",
    /NO wins/.test(closedHtml) && /1 yes \/ 2 no/.test(closedHtml) && /data-vote-start/.test(closedHtml));
  check("no active vote -> no cast plaques", !/data-vote-cast/.test(closedHtml));
}
noThrow("voteRenderBody(null)", () => M.voteRenderBody(null, "host"));
noThrow("voteReduce(undefined, undefined)", () => M.voteReduce(undefined, undefined));
noThrow("voteMyChoice({}, '')", () => M.voteMyChoice({}, ""));

// ---------------- summary ----------------
console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
