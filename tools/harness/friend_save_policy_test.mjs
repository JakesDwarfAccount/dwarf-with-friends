// The browser quicksave is a friend-group action: every joined player may request it, while the
// existing world-state and duplicate-save guards remain authoritative.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");
const routes = read("src", "session_routes.cpp");
const interaction = read("src", "interaction.cpp");
const menu = read("web", "js", "dwf-escmenu.js");
const http = read("src", "http_server.cpp");

const saveStart = routes.indexOf("auto save_handler");
const saveEnd = routes.indexOf("server.Post(\"/save\"");
const saveRoute = routes.slice(saveStart, saveEnd);
assert.ok(saveRoute.length > 0, "save route must exist");
assert.doesNotMatch(saveRoute, /request_has_host_authority|peer_ip_is_loopback|host only/,
  "save route must not restrict a joined friend to the loopback host");
assert.match(saveRoute, /save_world_on_core_thread/,
  "all friend save requests must use the established core-thread save boundary");
assert.match(saveRoute, /res\.status\s*=\s*409/,
  "unsafe world state or an overlapping save must remain a conflict");

const publicPaths = http.slice(http.indexOf("bool join_public_path"), http.indexOf("bool local_diagnostic_path"));
assert.doesNotMatch(publicPaths, /["']\/save["']/,
  "/save must remain behind the shared-password gate when authentication is enabled");

assert.match(menu, /key:\s*"web-save"[^\n]*hostOnly:\s*false[^\n]*webSave:\s*true/,
  "the Save the fortress row must be enabled for joined friends");
assert.doesNotMatch(menu.slice(menu.indexOf("async function doWebSave")), /if\s*\(!isHostClient\(\)\)/,
  "the save action must not silently restore a client-side host gate");
assert.match(menu, /const disabled = saveInFlight/,
  "the browser must still suppress overlapping clicks from the same client");
for (const key of ["save-title", "save-continue", "retire", "abandon", "quit"])
  assert.match(menu, new RegExp(`key: "${key}"[^\\n]*hostOnly: true`),
    `${key} must remain a disabled cosmetic row`);

assert.match(interaction, /autosave_request/,
  "the save boundary must still use DF's supported autosave request mechanism");
assert.match(interaction, /save already in progress/,
  "the server must still reject overlapping saves");

console.log("PASS friend_save_policy_test (joined friends may save; auth, collision, and world-state guards remain)");
