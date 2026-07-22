// Offline contract guard: a server-side chat rate refusal must reach the sending chat UI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const server = readFileSync(path.join(root, "src", "websocket.cpp"), "utf8");
const header = readFileSync(path.join(root, "src", "websocket.h"), "utf8");
const ws = readFileSync(path.join(root, "web", "js", "dwf-ws.js"), "utf8");
const chat = readFileSync(path.join(root, "web", "js", "dwf-chat.js"), "utf8");

assert.match(header, /chat_rate_ok\(long long\* retry_after_ms/,
  "rate limiter must report how long remains");
assert.match(server, /chat_rejected[\s\S]*?rate_limit[\s\S]*?retryMs/,
  "server must send an explicit refusal to the originating connection");
assert.match(ws, /msg\.type === "chat_rejected"[\s\S]*?DwfChat\.onRejected/,
  "transport must route the refusal to chat");
assert.match(chat, /function onRejected\([\s\S]*?sending messages too quickly/,
  "chat must explain a rate refusal to the player");

globalThis.window = globalThis;
globalThis.__DWF_STORY_MODE = true;
vm.runInThisContext(chat, { filename: "dwf-chat.js" });
globalThis.DwfChat.onRejected({ type: "chat_rejected", reason: "rate_limit", retryMs: 240 });
assert.equal(globalThis.DwfChat._lastRejectionForTest(), "rate_limit",
  "real chat module records the server refusal path");

const seededSilent = server.replace(/const std::string rejected = "\{\\"type\\":\\"chat_rejected[\s\S]*?return;\n\s*}/, "return;\n        }");
assert(!seededSilent.includes('"chat_rejected\\",\\"reason'),
  "TEST-THE-TEST: removing the rejection send recreates a detectable silent drop");

console.log("PASS chat_rate_signal_test (server refusal -> WS route -> chat notice; seeded silent drop detected)");
