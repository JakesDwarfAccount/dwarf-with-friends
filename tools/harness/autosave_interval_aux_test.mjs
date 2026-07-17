// autosave_interval_aux_test.mjs -- fixture coverage for the optional env.autosave AUX field.
//
//   node tools/harness/autosave_interval_aux_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const { autosaveIntervalLabel } = require(path.join(root, "web/js/dwf-settings.js"));

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}

function renderedAutosave(aux) {
  return autosaveIntervalLabel(aux && aux.env && aux.env.autosave);
}

console.log("# AUTOSAVE-INTERVAL-AUX fixtures");
check(() => assert.equal(renderedAutosave({ env: { autosave: "seasonal" } }), "Seasonal"),
  "field present: seasonal interval renders its DF label");
check(() => assert.equal(renderedAutosave({ env: {} }), "Not reported by the host"),
  "field absent: old host keeps the honest fallback");
check(() => assert.equal(renderedAutosave({ env: { autosave: "__proto__" } }), "Not reported by the host"),
  "seeded-bad interval: unknown host data is not invented");

console.log("# producer/transport seams");
const producer = fs.readFileSync(path.join(root, "src/world_stream.cpp"), "utf8");
const transport = fs.readFileSync(path.join(root, "web/js/dwf-ws.js"), "utf8");
check(() => assert.match(producer, /d_init->feature\.autosave/),
  "producer reads d_init.feature.autosave");
check(() => assert.match(producer, /\\\"autosave\\\"/),
  "producer emits the additive env.autosave field");
check(() => assert.match(transport, /DwfSessionInfo\.autosave/),
  "AUX transport retains the optional value for Settings");

console.log("# TEST-THE-TEST");
const badLabel = () => "Seasonal";
check(() => assert.notEqual(badLabel(undefined), "Not reported by the host"),
  "a seeded-bad always-seasonal formatter fails the absent-field expectation");
check(() => assert.equal(autosaveIntervalLabel(undefined), "Not reported by the host"),
  "the real formatter preserves the absent-field fallback");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
