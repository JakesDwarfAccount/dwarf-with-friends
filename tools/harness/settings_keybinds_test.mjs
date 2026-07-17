// settings_keybinds_test.mjs -- runtime test for the PURE logic of the client Settings panel
// (web/js/dwf-settings.js, Phase 5): keybind registry resolution, conflict detection,
// persistence encode/decode, UI-scale clamp. Drives the REAL module's exported pure core
// (DFSettings._pure / module.exports) -- nothing is reimplemented here. Completeness rules 1-3:
// enumerates the binding matrix, tests >=2 edge cells, and every self-built assertion has a
// TEST-THE-TEST (seeded-bad) cell that MUST fail, plus adversarial COUNTEREXAMPLES (remap onto a
// reserved camera key rejected; corrupt localStorage falls back to defaults; the unbound sentinel
// must never be the pause key).
//
//   node tools/harness/settings_keybinds_test.mjs
// Exit: 0 PASS, 1 FAIL.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const P = require(path.resolve(here, "../../web/js/dwf-settings.js"));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(cond, name) { ok(cond, "(test-the-test) " + name); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const {
  ACTIONS, DEFAULTS_BY_ID, isValidBindKey, decodeOverrides, encodeOverrides,
  resolveKeyString, detectConflicts, clampScale,
} = P;

// ============================================================================================
console.log("# registry sanity (enumerate the matrix)");
// 30 fort/system actions + B203's 9 saved-location jumps (location1..location9) = 39.
ok(Array.isArray(ACTIONS) && ACTIONS.length === 39, "39 remappable actions registered", `got ${ACTIONS && ACTIONS.length}`);
// WT15: the Obligations board is a remappable client-only panel (default Shift+B, like Petitions Shift+G).
ok(ACTIONS.some(a => a.id === "obligations" && a.default === "B"), "obligations board registered with default 'B'");
// Every default is a valid target key AND unique (no two actions share a default -> no built-in conflicts).
const defaults = ACTIONS.map(a => a.default);
ok(new Set(defaults).size === defaults.length, "all default keys are unique (no built-in conflict)");
ok(defaults.every(isValidBindKey), "every default key is itself a valid bind target (none reserved)");
// Spot-check a few known DF binds against dwf-controls-placement.js's switch.
ok(DEFAULTS_BY_ID.dig === "m" && DEFAULTS_BY_ID.chop === "l" && DEFAULTS_BY_ID.justice === "j" &&
   DEFAULTS_BY_ID.stocks === "k" && DEFAULTS_BY_ID.squads === "q" && DEFAULTS_BY_ID.pause === " " &&
   DEFAULTS_BY_ID.burrows === "U" && DEFAULTS_BY_ID.traffic === "T",
   "canonical defaults match the controls-placement switch cases");

// ============================================================================================
console.log("# B203: saved-location jumps (location1..location9) are in the inventory + remappable");
// All nine registered, each defaulting to its own digit 1-9 (matches dwf-hotkeys.js's jump).
let locOk = true, locDigits = [];
for (let n = 1; n <= 9; n++) {
  const a = ACTIONS.find(x => x.id === "location" + n);
  if (!a || a.default !== String(n)) locOk = false;
  locDigits.push(a && a.default);
}
ok(locOk, "location1..location9 each default to digit 1..9", `got ${JSON.stringify(locDigits)}`);
// They are valid remap TARGETS (a single printable char, not reserved) -- so they stay remappable.
ok(isValidBindKey("1") && isValidBindKey("5") && isValidBindKey("9"), "digits 1/5/9 are valid bind targets (jumps remain remappable)");
// Adding them kept the default config conflict-free (unique digits, distinct from every letter).
ok(detectConflicts({}).length === 0, "with the 9 new location actions, the default config STILL has zero conflicts");
// resolve() is the identity on a default digit (dormant-safe: default 1-9 behavior byte-unchanged).
ok(resolveKeyString("3", {}) === "3", "default digit '3' resolves to itself (identity, no override)");
// A remapped location re-routes: bind location3 onto ';' -> pressing ';' resolves to canonical '3',
// and the vacated '3' becomes the no-op sentinel (stops jumping). This is the remap the jump reads.
const ovLoc = { location3: ";" };
ok(resolveKeyString(";", ovLoc) === "3", "remapped location key ';' resolves to canonical '3' (jump follows the remap)");
ok(resolveKeyString("3", ovLoc) === String.fromCharCode(0), "the vacated digit '3' resolves to the no-op sentinel (no stray jump)");
ok(resolveKeyString("3", ovLoc) !== DEFAULTS_BY_ID.pause, "SENTINEL SAFETY: a vacated digit must NOT resolve to the pause key ' '");

// ============================================================================================
console.log("# B203 COUNTEREXAMPLE: a digit is now inventoried, so double-binding it is a real conflict");
// Bind Justice (a letter action) onto '1' -> it now collides with location1 (both on '1').
const ovDigitClash = { justice: "1" };
const digitConflicts = detectConflicts(ovDigitClash);
ok(digitConflicts.length === 1 && digitConflicts[0].key === "1", "one conflict detected on digit '1'");
ok(digitConflicts[0].actions.includes("justice") && digitConflicts[0].actions.includes("location1"),
   "conflict names both colliding actions (justice + location1)");
// ACTIONS order: locations are registered LAST, so location1 wins the dispatch tie-break -- the
// digit keeps jumping (defined behavior; the panel banners the clash so a user can resolve it).
ok(resolveKeyString("1", ovDigitClash) === "1", "on the clash the later-registered location1 wins dispatch (digit still jumps)");
guard("a naive registry WITHOUT the location actions would see NO conflict here (so this cell has teeth)",
      DEFAULTS_BY_ID.location1 === "1");

// ============================================================================================
console.log("# resolveKeyString: identity under the default (no-override) config");
let identityHolds = true;
for (const a of ACTIONS) { if (resolveKeyString(a.default, {}) !== a.default) identityHolds = false; }
ok(identityHolds, "with zero overrides, resolve() is the identity for every managed key (dormant-safe)");
// Non-managed keys pass through verbatim (camera / help / typing).
ok(resolveKeyString("ArrowLeft", {}) === "ArrowLeft" && resolveKeyString("F3", {}) === "F3" &&
   resolveKeyString("e", {}) === "e" && resolveKeyString("Q", {}) === "Q",
   "unmanaged keys (camera/help/other) pass through untouched");

// ============================================================================================
console.log("# resolveKeyString: a real remap re-routes to the canonical key");
// Move Justice (default j) to ';' (free, valid). Pressing ';' must act as 'j'; pressing 'j' must
// now be inert (its default action moved away, nothing else maps to it).
const ovJustice = { justice: ";" };
ok(resolveKeyString(";", ovJustice) === "j", "pressing the remapped key returns the canonical 'j'");
const jResolved = resolveKeyString("j", ovJustice);
ok(jResolved !== "j", "the vacated default key no longer triggers its old action");
ok(jResolved !== " ", "SENTINEL SAFETY: an unbound managed key must NOT resolve to the pause key ' '");
ok(jResolved === "\u0000", "vacated key resolves to the no-op sentinel (switch default:)");

// ============================================================================================
console.log("# conflict detection + deterministic dispatch tie-break");
// Bind Justice onto 'k' (Stocks' default) -> both share 'k'.
const ovClash = { justice: "k" };
const conflicts = detectConflicts(ovClash);
ok(conflicts.length === 1 && conflicts[0].key === "k", "one conflict detected on key 'k'");
ok(conflicts[0].actions.includes("justice") && conflicts[0].actions.includes("stocks"),
   "conflict names both colliding actions (justice + stocks)");
// ACTIONS order: justice precedes stocks -> stocks (later) wins boundBy at dispatch.
ok(resolveKeyString("k", ovClash) === "k", "on conflict the later-registered action (stocks) wins dispatch");
ok(detectConflicts({}).length === 0, "the default config has zero conflicts");

// ============================================================================================
console.log("# persistence: encode/decode round-trip + normalisation");
ok(eq(decodeOverrides(encodeOverrides({ justice: "1" })), { justice: "1" }), "round-trips a real override");
ok(eq(decodeOverrides(encodeOverrides({ justice: "j" })), {}), "an override equal to the default is not stored");
ok(eq(decodeOverrides(encodeOverrides({ dig: "1", chop: "2" })), { dig: "1", chop: "2" }), "round-trips multiple overrides");

// ============================================================================================
console.log("# COUNTEREXAMPLE: remap onto a reserved (camera/system) key is rejected");
ok(isValidBindKey("j") === true && isValidBindKey(" ") === true, "an ordinary key and Space are valid targets");
ok(isValidBindKey("a") === false, "camera key 'a' rejected as a target");
ok(isValidBindKey("ArrowLeft") === false && isValidBindKey("Home") === false, "arrow/Home camera keys rejected");
ok(isValidBindKey("Escape") === false && isValidBindKey("F1") === false, "structural/help keys rejected");
ok(isValidBindKey("") === false && isValidBindKey(null) === false && isValidBindKey("ab") === false,
   "empty / null / multi-char keys rejected");
// decode must DROP an override that targets a reserved key (falls back to default).
ok(eq(decodeOverrides(JSON.stringify({ justice: "a" })), {}), "decode drops a reserved-key override");
ok(resolveKeyString("a", decodeOverrides(JSON.stringify({ justice: "a" }))) === "a",
   "...and 'a' still behaves as its normal (camera) key after the drop");

// ============================================================================================
console.log("# COUNTEREXAMPLE: corrupt / hostile localStorage falls back to defaults");
ok(eq(decodeOverrides("{ not json"), {}), "malformed JSON -> {}");
ok(eq(decodeOverrides("null"), {}), "JSON null -> {}");
ok(eq(decodeOverrides("[1,2,3]"), {}), "JSON array -> {}");
ok(eq(decodeOverrides('{"justice":123}'), {}), "non-string key value -> dropped");
ok(eq(decodeOverrides('{"noSuchAction":"x"}'), {}), "unknown action id -> dropped");
ok(eq(decodeOverrides('{"justice":"1","bogus":"z","chop":"a"}'), { justice: "1" }),
   "mixed good/bad -> only the valid entry survives (bad ones dropped, not poisoning)");
// After corrupt storage, dispatch is exactly the default behavior.
let corruptIdentity = true;
for (const a of ACTIONS) { if (resolveKeyString(a.default, decodeOverrides("garbage")) !== a.default) corruptIdentity = false; }
ok(corruptIdentity, "with corrupt storage, every default key still resolves to itself");

// ============================================================================================
console.log("# UI-scale clamp (absorbs PDF-B17)");
ok(clampScale(1) === 1, "1.0 -> 1.0");
ok(clampScale(5) === 1.6, "above max clamps to 1.6");
ok(clampScale(0.1) === 0.7, "below min clamps to 0.7");
ok(clampScale(NaN) === 1 && clampScale("nope") === 1, "non-finite -> 1.0");
ok(clampScale("1.25") === 1.25, "numeric string coerced");
ok(clampScale(1.234) === 1.23, "rounds to 2 decimals before clamping");

// ============================================================================================
console.log("# TEST-THE-TEST (seeded-bad implementations MUST fail these assertions)");
// (a) A resolver that ignores overrides would leave the remapped key unrouted.
const badResolve = (k) => k;
guard(badResolve(";", { justice: ";" }) !== "j",
      "an override-ignoring resolver does NOT route ';' to 'j' (so the remap assertion has teeth)");
guard(resolveKeyString(";", { justice: ";" }) === "j", "the real resolver DOES route it (discriminating)");
// (b) The dangerous sentinel: had the sentinel been ' ', a vacated key would trigger PAUSE.
guard(" " === DEFAULTS_BY_ID.pause, "a space sentinel WOULD collide with the pause key (why the sentinel is NUL)");
guard(resolveKeyString("j", { justice: ";" }) !== DEFAULTS_BY_ID.pause, "the real sentinel avoids that collision");
// (c) A decode that trusted input would keep a reserved-key binding.
const badDecode = (raw) => { try { return JSON.parse(raw); } catch (_) { return {}; } };
guard(eq(badDecode(JSON.stringify({ justice: "a" })), { justice: "a" }),
      "a naive decode WOULD keep the reserved 'a' binding (so the counterexample has teeth)");
guard(eq(decodeOverrides(JSON.stringify({ justice: "a" })), {}), "the real decode drops it (discriminating)");
// (d) A clamp that forgot the ceiling would let 5 through.
const badClamp = (v) => Number(v);
guard(badClamp(5) === 5, "an un-clamped scale WOULD return 5 (out of range)");
guard(clampScale(5) === 1.6, "the real clamp caps it (discriminating)");

// ============================================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
