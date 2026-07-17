// camera_identity_transport_test.mjs -- the "camera snaps back to load-in ~1s after every move"
// bug (owner-reported 2026-07-17; a friend named "Your Friend" saw it in every browser; the owner
// named "Jake" never did).
//
// ROOT CAUSE (two compounding server defects, proven from source):
//   1. IDENTITY ENCODING ASYMMETRY. The browser builds every ?player= (and the /ws upgrade URL)
//      with encodeURIComponent(name), so a display name with a SPACE arrives percent-encoded on the
//      wire ("Your Friend" -> "Your%20Friend"). httplib decodes ordinary HTTP query params exactly
//      once, but websocket.cpp's raw /ws parser req_player() did NOT decode -- so the connection (and
//      thus the registry name, presence_json, and hello_ack.player the client then ADOPTS as its
//      player key) registered under the literal "Your%20Friend". The client re-encoded that on every
//      subsequent HTTP ?player= -> "Your%2520Friend", which after httplib's single decode is
//      "Your%20Friend" -- containing a '%', which the old is_safe_player_id() charset ([A-Za-z0-9_-])
//      REJECTED -> query_player silently substituted "default". So POST /camera wrote a PHANTOM
//      "default" camera (HTTP 200!) while world_stream streamed the real per-player camera under
//      "Your%20Friend"; reconcileAuxCam (dwf-tiles.js, CAM_DIVERGENCE_MS=500) then snapped the view
//      back to the unmoved authoritative camera ~1s after every move. "Jake" survived because it has
//      no character encodeURIComponent touches, so its identity round-tripped byte-identically.
//   2. SILENT SECOND CHANNEL. Even absent the encoding bug, camera POSITION rode ONLY a silently-
//      swallowed HTTP POST (try{await fetch}catch(_){}) while everything the user sees rides the WS.
//
// THE FIX (all asserted below):
//   A. req_player() URL-decodes with the SAME rule httplib uses -> one canonical RAW identity on
//      both transports.
//   B. is_safe_player_id() accepts any non-control byte (spaces, '&', UTF-8) so a raw display name
//      round-trips through query_player instead of collapsing to "default".
//   C. PRIMARY TRANSPORT: a WS {type:"cam"} carrying x/y/z is applied to the SAME per-player camera
//      authority POST /camera writes (websocket.cpp cam handler -> set_player_camera), keyed on the
//      connection's raw identity so it can never hit the URL round-trip at all. Client sends it via
//      DwfWS when connected, falling back to the HTTP POST when the socket is down.
//   D. STOP FAILING SILENTLY: non-OK /camera and /zoom responses are logged and a 401 routes into
//      DwfAuth.onAuthFail() instead of being swallowed.
//
// OFFLINE: no DF, no live server, no browser. Models the identity pipeline in pure JS and pins the
// source contracts of the real C++ / web files. Run: node tools/harness/camera_identity_transport_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const ws = read("src/websocket.cpp");
const jsonUtil = read("src/json_util.cpp");
const sessionRoutes = read("src/session_routes.cpp");
const core = read("web/js/dwf-core.js");
const tiles = read("web/js/dwf-tiles.js");

// ---------------------------------------------------------------------------------------------
// PART 1 -- the identity round-trip, modeled end to end. This is the logic the two server defects
// live in; we model the FIXED pipeline and the SEEDED-BAD (pre-fix) pipeline and prove the fixed one
// round-trips a name back to the exact bytes the WS authed under, while the buggy one does not.
// ---------------------------------------------------------------------------------------------

// is_safe_player_id, both eras.
const isSafeFixed = (p) => {
  if (!p || Buffer.byteLength(p, "utf8") > 96) return false;
  for (const ch of p) { const c = ch.codePointAt(0); if (c < 0x20 || c === 0x7f) return false; }
  return true;
};
const isSafeOld = (p) => !!p && p.length <= 96 && /^[A-Za-z0-9_-]+$/.test(p);

// req_player eras:
//   FIXED     = decode once (like httplib) THEN validate, falling back to "guest" on reject (R1).
//   DECODE_ONLY = commit-1 state: decode but do NOT validate -- the R1 regression (a control char
//                 survives into the registered identity).
//   OLD       = original: raw wire bytes, no decode (the space-bug era).
const reqPlayerFixed = (wireParam) => {
  let d; try { d = decodeURIComponent(wireParam); } catch (_) { d = wireParam; }
  return isSafeFixed(d) ? d : "guest";
};
const reqPlayerDecodeOnly = (wireParam) => { try { return decodeURIComponent(wireParam); } catch (_) { return wireParam; } };
const reqPlayerOld = (wireParam) => wireParam;

// query_player: httplib decodes the HTTP param once, then the safety gate runs.
const queryPlayer = (wireParam, isSafe) => {
  let decoded; try { decoded = decodeURIComponent(wireParam); } catch (_) { decoded = wireParam; }
  return isSafe(decoded) ? decoded : "default";
};

// hello_ack.player emit. BYTE-CLEAN (chat_escape) hands the client back the exact registered bytes;
// DF2UTF (json_escape) re-interprets each raw UTF-8 byte as CP437 and re-encodes -> any non-ASCII
// name comes back MANGLED, so the client adopts a different string than the WS registered under.
const emitByteClean = (s) => s;
const emitDf2utf = (s) => {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) out += (b < 0x80) ? String.fromCharCode(b) : ("Ã" + String.fromCharCode(b & 0x7f | 0x40));
  return out; // ASCII passes through unchanged; any byte >=0x80 expands -> guaranteed != input
};

// Full trip: a person picks `name`; the WS URL + the HTTP /camera URL are both built with a SINGLE
// encodeURIComponent (the client's actual behavior). hello_ack hands the emitted WS identity back and
// the client adopts it as its player key for HTTP. Returns whether the HTTP camera-write key matches
// the WS streaming key (match == the camera moves; mismatch == the phantom snap-back).
function roundTrip(name, { reqPlayer, isSafe, emit }) {
  const wsIdentity = reqPlayer(encodeURIComponent(name));       // WS registry + streaming key
  const adopted = emit(wsIdentity);                             // hello_ack.player -> __dwfAdoptName
  const httpWriteKey = queryPlayer(encodeURIComponent(adopted), isSafe); // POST /camera target
  return { wsIdentity, adopted, httpWriteKey, matches: httpWriteKey === wsIdentity };
}

const fixed = { reqPlayer: reqPlayerFixed, isSafe: isSafeFixed, emit: emitByteClean };
const buggy = { reqPlayer: reqPlayerOld, isSafe: isSafeOld, emit: emitDf2utf };

// FIXED pipeline round-trips every legal name -- spaces, '&', UNICODE, control-free -- to a matching key.
for (const name of ["Your Friend", "Jake", "a b&c", "Café", "Zoë", "z-9_x"]) {
  const r = roundTrip(name, fixed);
  assert.equal(r.wsIdentity, name, `FIXED: WS identity for ${JSON.stringify(name)} must be the RAW name`);
  assert.equal(r.adopted, name, `FIXED: adopted hello_ack.player for ${JSON.stringify(name)} must EQUAL the raw registered identity (byte-clean emit)`);
  assert.ok(r.matches, `FIXED: camera write key must match the WS streaming key for ${JSON.stringify(name)} (got ${JSON.stringify(r.httpWriteKey)})`);
}

// SEEDED-BAD (space, original era): un-decoded req_player mis-registers the once-encoded form the
// lobby displayed, and the doubly-encoded '%'-bearing name fails the old charset -> phantom "default".
{
  const r = roundTrip("Your Friend", buggy);
  assert.equal(r.wsIdentity, "Your%20Friend", "seeded-bad: un-decoded req_player registers the encoded name (the '%20' the lobby showed)");
  assert.equal(r.httpWriteKey, "default", "seeded-bad: the doubly-encoded, %-bearing name fails the old charset -> 'default'");
  assert.ok(!r.matches, "seeded-bad: pre-fix pipeline MUST mis-target a spacey name (this is the bug)");
}
// "Jake" round-trips even under the buggy pipeline -- exactly why the owner never reproduced it.
assert.ok(roundTrip("Jake", buggy).matches, "control: a space-free name round-trips even pre-fix");

// SEEDED-BAD (R2 unicode): decode+validate is fine, but a DF2UTF emit mangles the adopted name so the
// client keys HTTP on a string the WS never registered -> the pan (WS raw key) / zoom (HTTP mojibake
// key) half-working split. Must FAIL.
{
  const r = roundTrip("Zoë", { reqPlayer: reqPlayerFixed, isSafe: isSafeFixed, emit: emitDf2utf });
  assert.notEqual(r.adopted, r.wsIdentity, "seeded-bad: DF2UTF emit mangles a unicode name -> adopted != registered identity");
  assert.ok(!r.matches, "seeded-bad: a mojibake adopted name MUST mis-target (the R2 split) -- byte-clean emit is required");
}

// SEEDED-BAD (R1 control char): decode-but-don't-validate registers a NEWLINE-bearing identity that
// HTTP maps to "default" (phantom split) and would forge newlines into diagnostics_log. Must FAIL;
// the validated pipeline instead registers "guest" so both transports converge.
{
  const hostile = "x\nINJECTED";
  const bad = roundTrip(hostile, { reqPlayer: reqPlayerDecodeOnly, isSafe: isSafeFixed, emit: emitByteClean });
  assert.equal(bad.wsIdentity, hostile, "seeded-bad: decode-only req_player registers the raw newline identity");
  assert.equal(bad.httpWriteKey, "default", "seeded-bad: a control-char name fails query_player's gate -> 'default'");
  assert.ok(!bad.matches, "seeded-bad: an unvalidated control-char WS identity MUST be unmatchable by HTTP (R1)");

  const good = roundTrip(hostile, fixed);
  assert.equal(good.wsIdentity, "guest", "FIXED: req_player rejects a control-char name to 'guest' (agrees with HTTP's rejection)");
  assert.ok(good.matches, "FIXED: after both transports reject to a safe id, the camera key still matches");
}

// '%' is a legal identity byte post-fix, but a directly double-encoded name is NOT the raw name -- the
// round-trip asserts above are what prove single-encoding matters.
assert.ok(!isSafeOld("Your%20Friend"), "seeded-bad: the old charset rejected the '%'-bearing double-encoded name");

// ---------------------------------------------------------------------------------------------
// PART 2 -- source contracts on the real fix sites.
// ---------------------------------------------------------------------------------------------

// A. req_player() decodes the /ws player param (symmetric with httplib's HTTP decode) AND validates
//    it with the same gate HTTP uses, so a control-char name can't register a WS-only identity (R1).
{
  const m = ws.match(/std::string req_player\([\s\S]*?\n\}/);
  assert.ok(m, "req_player must exist");
  assert.match(m[0], /decode_url\(\s*p\s*,/,
    "req_player MUST URL-decode the extracted player param (seeded-bad: an un-decoded req_player mis-registers a percent-encoded name)");
  assert.match(m[0], /!is_safe_player_id\(p\)/,
    "R1: req_player MUST validate the DECODED identity (seeded-bad: decode-but-don't-validate lets a control char register a WS identity HTTP maps to 'default')");
  assert.match(m[0], /return std::string\("guest"\)/,
    "R1: a rejected WS identity MUST fall back to a safe value both transports agree on");
}

// A2. player NAMES the client adopts/keys on are emitted BYTE-CLEAN (chat_escape), never through
//     json_escape/json_string's DF2UTF transcode that would mojibake a unicode name (R2).
{
  assert.match(read("src/chat.h"), /std::string chat_escape\(const std::string& raw\);/,
    "chat_escape must be exported so the name-emit sites can reuse it");
  // hello_ack.player: byte-clean emit, no DF2UTF json_escape of the name.
  assert.ok(ws.includes("chat_escape(conn->player())"),
    "R2: hello_ack.player MUST use chat_escape (seeded-bad: json_escape's DF2UTF mangles a unicode name the client then adopts)");
  assert.ok(!ws.includes("json_escape(conn->player())"), "R2: hello_ack.player must NOT go through DF2UTF json_escape");
  // presence name: byte-clean emit too (was json_string(name) -> DF2UTF).
  const httpServer = read("src/http_server.cpp");
  assert.ok(httpServer.includes("chat_escape(name)"),
    "R2: presence name MUST use chat_escape so a unicode roster name matches the adopted identity");
  assert.ok(!/\{\\"name\\":" << json_string\(name\)/.test(httpServer),
    "R2: presence name must NOT go through DF2UTF json_string");
}

// B. is_safe_player_id() accepts any non-control byte (spaces/&/UTF-8 are legal identities now).
{
  const m = jsonUtil.match(/bool is_safe_player_id\([\s\S]*?\n\}/);
  assert.ok(m, "is_safe_player_id must exist");
  assert.match(m[0], /0x20|0x7f/, "is_safe_player_id MUST gate on control chars, not an alnum whitelist");
  assert.doesNotMatch(m[0], /isalnum/,
    "seeded-bad: the old [A-Za-z0-9_-] whitelist collapsed every spacey name to 'default' -- it must be gone");
}

// C. the WS cam handler applies a carried position to the per-player camera authority, mirroring
//    POST /camera's absolute-set semantics. Seeded-bad: parse the position but never route it.
{
  const camHandler = ws.match(/json_has_type\(payload, "cam"\)[\s\S]*?return;\n\s*\}/);
  assert.ok(camHandler, "the WS cam handler must exist");
  const h = camHandler[0];
  assert.match(h, /has_pos/, "cam handler still parses position");
  assert.match(h, /set_player_camera\(player,\s*camera\)/,
    "cam handler MUST route a carried position into set_player_camera (seeded-bad: position parsed-but-ignored is the original bug)");
  assert.match(h, /camera_for_player\(player,\s*camera/, "must seed from the current camera to preserve zoom_factor/placement (mirrors POST /camera)");
  assert.match(h, /clamp_camera\(camera/, "must clamp exactly like POST /camera");
  assert.match(h, /forget_player_follow\(player\)/, "must break follow exactly like POST /camera");
  assert.match(h, /notify_player_input\(\)/, "must wake the push loop exactly like POST /camera");
  // z drift: POST /camera leaves the seeded z untouched when `z` is absent; the WS path must too.
  assert.match(h, /bool has_z = json_number\(payload, "z", cz\)/, "cam handler must track whether z was carried");
  assert.match(h, /if \(has_z\)\s*\n\s*camera\.z = \(int\)cz;/,
    "seeded-bad: unconditionally forcing camera.z = cz would zero z on a z-omitted message (POST preserves it)");
}

// the POST /camera route we are mirroring still writes the authority via set_player_camera -- the
// contract the WS path duplicates. (Guards against the mirror drifting from its source.)
assert.match(sessionRoutes, /server\.Post\("\/camera"[\s\S]*?set_player_camera\(player, camera\)/,
  "POST /camera must still be the reference implementation the WS path mirrors");

// C(client). dwf-core sends the camera over the WS when connected, falling back to the POST; and the
// renderer exposes the authoritative optimistic camera for it to send.
assert.match(core, /function sendCameraWS\(\)/, "dwf-core must have the WS camera sender");
assert.match(core, /DwfWS\.send\(\s*\{\s*type:\s*"cam",\s*x:/,
  "sendCameraWS MUST send a {type:'cam', x,y,z} message over DwfWS");
assert.match(core, /DwfWS\.isConnected\(\)/, "the WS send MUST be gated on an open socket (POST is the fallback)");
assert.match(tiles, /getDesiredCam:\s*\(\)\s*=>/, "dwf-tiles MUST expose getDesiredCam for the WS send");
// flushMove: WS-primary, POST only when the socket is down. Seeded-bad: the old bare silent swallow.
{
  const fm = core.match(/async function flushMove\(\)[\s\S]*?\n  \}/);
  assert.ok(fm, "flushMove must exist");
  assert.match(fm[0], /if \(!sendCameraWS\(\)\)/, "flushMove MUST try the WS first and POST only as fallback");
  assert.doesNotMatch(fm[0], /catch \(_\) \{\}\s*\n\s*\/\/ Pull the post-move map/,
    "seeded-bad: flushMove's silently-swallowed camera POST catch must be gone");
}

// D. non-OK /camera and /zoom responses are surfaced, and 401 routes into onAuthFail.
assert.match(core, /function noteCameraHttpResult\(/, "dwf-core must surface non-OK camera/zoom responses");
assert.match(core, /console\.warn\([\s\S]*?HTTP \$\{r\.status\}/, "a non-OK response MUST be logged with its status");
assert.match(core, /status === 401[\s\S]*?onAuthFail\(\)/,
  "a 401 from /camera or /zoom MUST route into the same re-auth path the WS uses");
// zoom no longer swallows silently.
assert.match(core, /\/zoom\?player=[\s\S]*?noteCameraHttpResult\(r, "zoom"\)/, "sendZoom MUST surface failures");
assert.doesNotMatch(core, /\/zoom\?player=[\s\S]*?\.catch\(\(\) => \{\}\)/, "seeded-bad: sendZoom's silent .catch(()=>{}) swallow must be gone");

// back-compat: a stored name that still looks percent-encoded is normalized back to raw on read.
assert.match(core, /function normalizeStoredName\(/, "dwf-core must normalize a legacy percent-encoded stored name");
assert.equal((() => { // model it
  const v = "Your%20Friend";
  return /%[0-9A-Fa-f]{2}/.test(v) ? decodeURIComponent(v) : v;
})(), "Your Friend", "normalizeStoredName must decode a legacy stored name once");

console.log("camera_identity_transport_test: OK");
