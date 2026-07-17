// wc20_weather_test.mjs -- WC-20 weather overlay module. Loads web/js/dwf-weather.js
// verbatim in a DOM-less environment and asserts its pure, side-effect-free bits:
//   - the ?weatherfx=0 kill switch disables the layer entirely (spec-required for parity runs)
//   - targetCount(weather) is 0 for None (no particles) and >0 for Rain/Snow, area-scaled
// The particle animation itself needs a live canvas + rAF and is verified in-browser (handoff).
//
// Run: node tools/harness/wc20_weather_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEATHER_PATH = path.resolve(__dirname, "../../web/js/dwf-weather.js");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

function loadWeather(search) {
  // Fresh sandbox per load so the module-level DISABLED const re-evaluates against `search`.
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.location = { search };
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  // No document.body -> ensureCanvas() bails (headless), start() is a safe no-op; the pure
  // helpers under test never touch the DOM.
  sandbox.document = { readyState: "complete", addEventListener() {}, createElement() { return { style: {} }; } };
  sandbox.addEventListener = () => {};
  sandbox.requestAnimationFrame = () => 0;
  sandbox.cancelAnimationFrame = () => {};
  sandbox.URLSearchParams = URLSearchParams;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(WEATHER_PATH, "utf8"), sandbox, { filename: WEATHER_PATH });
  return sandbox.DwfWeather;
}

console.log("WC-20: weather overlay module");

const on = loadWeather("");
check("module attaches DwfWeather with init/stop", on && typeof on.init === "function" && typeof on.stop === "function");
check("enabled by default (?weatherfx unset)", on._isDisabled() === false);
check("weather None (0) -> zero particles", on._targetCountForTest(0) === 0);
check("weather Rain (1) -> a positive particle count", on._targetCountForTest(1) > 0);
check("weather Snow (2) -> a positive particle count", on._targetCountForTest(2) > 0);

// B185: fixed-speed particles snapped to y=-len converge onto frame-spaced horizontal rows.
// Exercise many wraps, then bucket Y positions. The production generator must stay diffuse.
function rainBuckets(advance, seededBad) {
  const ps = Array.from({ length: 260 }, (_, i) => ({
    x: (i * 47) % 1280, y: (i * 193) % 800, rainVy: 900 * (0.86 + ((i * 73) % 101) / 100 * 0.28),
  }));
  for (let frame = 0; frame < 3600; frame++) for (const p of ps) {
    if (seededBad) {
      p.y += 900 / 60;
      if (p.y > 814) p.y = -14;
    } else advance(p, 1 / 60, 1280, 800);
  }
  const buckets = new Array(207).fill(0); // four-pixel bands expose the old 15px frame lattice
  for (const p of ps) buckets[Math.max(0, Math.min(206, Math.floor((p.y + 14) / 4)))]++;
  return Math.max(...buckets);
}
const expected = 260 / 207;
const maxAllowed = expected * 3;
check("rain Y buckets have no row clustering", rainBuckets(on._advanceRainForTest, false) <= maxAllowed);
check("TEST-THE-TEST: old fixed-speed/reset generator is rejected as banded",
      rainBuckets(on._advanceRainForTest, true) > maxAllowed);

const off = loadWeather("?weatherfx=0");
check("?weatherfx=0 disables the layer (parity-run kill switch)", off._isDisabled() === true);
// init() must be an inert no-op when disabled (no throw, no canvas).
let threw = false;
try { off.init(); } catch (_) { threw = true; }
check("init() is a safe no-op when disabled", threw === false);

console.log(failed === 0 ? "\nPASS (0 failures)" : `\nFAIL (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
