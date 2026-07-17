// wt12_locations_hotkey_test.mjs -- offline fixture acceptance for WT12 (number hotkeys 1-9 map
// to entries on the Locations list so you can jump without clicking).
//
// Exercises the PURE slotForDigit() mapping in web/js/dwf-hotkeys.js: digit 1-9 -> the
// saved location in list slot 1-9 (or null when that slot is empty / the digit is out of range).
// The keydown handler (onLocationsDigitKey) is a thin wrapper that recenters on slotForDigit's
// result. B203 made it GLOBAL -- it fires from the map view whether or not the panel is open (the
// old `if (!open) return;` gate is gone), still skipping modifiers + focused text fields, and it
// resolves the pressed key through DFKeybinds.resolve() so the jump stays remappable. The
// addressing logic that determines WHICH location a key jumps to is entirely in slotForDigit, and
// that is what the pure cells test; the structural cells below pin the B203 wiring.
//
// Run: node tools/harness/wt12_locations_hotkey_test.mjs        (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-hotkeys.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-hotkeys.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
check("exports slotForDigit", typeof M.slotForDigit === "function");
const sf = M.slotForDigit;

// A realistic 16-slot list (as GET /hotkeys returns): some set, some empty.
const slots = [];
for (let i = 0; i < 16; i++) slots.push({ slot: i, set: false, name: "", x: 0, y: 0, z: 0 });
slots[0] = { slot: 0, set: true, name: "Tavern", x: 10, y: 20, z: 5 };
slots[2] = { slot: 2, set: true, name: "Temple", x: 30, y: 40, z: 3 };
slots[8] = { slot: 8, set: true, name: "Depot", x: 55, y: 60, z: 1 }; // digit 9 -> slot index 8

// digit N addresses slot index N-1
check("digit 1 -> slot 1 (Tavern)", sf(slots, 1) === slots[0]);
check("digit 3 -> slot 3 (Temple)", sf(slots, 3) === slots[2]);
check("digit 9 -> slot 9 (Depot, index 8)", sf(slots, 9) === slots[8]);
check("jump target carries the saved coords", sf(slots, 1).x === 10 && sf(slots, 1).y === 20 && sf(slots, 1).z === 5);

// empty / invalid never jumps
check("digit 2 (empty slot) -> null", sf(slots, 2) === null);
guard("digit 0 is out of range -> null", sf(slots, 0) === null);
guard("digits above 9 unaddressable -> null (slots 10-16 stay click-only)", sf(slots, 10) === null && sf(slots, 16) === null);
guard("non-numeric / junk -> null", sf(slots, "x") === null && sf(slots, null) === null && sf(slots, NaN) === null);
guard("missing list -> null (no crash)", sf(null, 1) === null && sf(undefined, 3) === null);
guard("a set slot with the flag off is NOT jumped", sf([{ slot: 0, set: false, x: 1, y: 2, z: 3 }], 1) === null);

// structural: the handler is wired GLOBALLY (B203), guards typing, resolves via the keybind
// registry, and the hint shows.
const src = readFileSync(modPath, "utf8");
check("keydown handler is registered on document", /document\.addEventListener\("keydown",\s*onLocationsDigitKey\)/.test(src));

// B203: the menu-open gate is GONE -- the handler fires with the panel closed.
const handlerBody = (src.match(/function onLocationsDigitKey\(e\)\s*\{[\s\S]*?\n  \}/) || [""])[0];
check("B203: handler no longer gates on panel-open state (fires with menu closed)",
  handlerBody.length > 0 && !/if\s*\(!open\)\s*return;/.test(handlerBody));
guard("B203: `if (!open) return;` appears nowhere in the module", !/if\s*\(!open\)\s*return;/.test(src));

// B203: still guards modifiers and text-field focus (never steals digits from chat / inputs).
check("handler ignores modifier chords", /if \(e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey\) return;/.test(handlerBody));
check("handler ignores text-field focus (input/textarea/select + contentEditable)",
  /tagName[\s\S]{0,60}return;/.test(handlerBody) && /isContentEditable/.test(handlerBody));

// B203: the jump stays remappable -- it dispatches off DFKeybinds.resolve(e), the same source
// dwf-controls-placement's hotkey switch reads, not the raw event.key.
check("handler resolves the pressed key through DFKeybinds.resolve (remap-aware)",
  /window\.DFKeybinds[\s\S]{0,120}\.resolve\(e\)/.test(handlerBody));
check("handler matches the RESOLVED key against 1-9 (not raw e.key)",
  /\/\^\[1-9\]\$\/\.test\(key\)/.test(handlerBody));
guard("handler no longer tests the raw e.key against 1-9 (would defeat remapping)",
  !/\/\^\[1-9\]\$\/\.test\(e\.key\)/.test(handlerBody));

// B203: slots are primed on load so a jump works before the panel is ever opened.
check("slots are primed on inject (refresh() called at wiring time)",
  /document\.addEventListener\("keydown",\s*onLocationsDigitKey\);[\s\S]{0,400}refresh\(\);/.test(src));

check("panel shows the '1-9 to jump' hint", /1-9 to jump/.test(src));

console.log(`\nWT12 locations-hotkey: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
