// lobby_rename_test.mjs -- SELF-ROW RENAME (players list -> "Rename" your own row).
//
// Feature: an easy way to change YOUR OWN name from inside the players list. This covers the
// two contracts that make it real rather than the __dwfAdoptName trap:
//   1. UI  -- the rename control renders on the SELF row only, as a DWFUI plaque (dwf-lobby stays
//             hand-built-control-free), delegated on pointerdown like the follow control.
//   2. MECHANISM (server rename) -- the commit RE-BROADCASTS via a WS control message
//             {"type":"rename","name":...} so every other roster + the on-map cursor label update,
//             AND persists the new name to localStorage. A commit that only relabels locally
//             (window.__dwfAdoptName without the DwfWS.send) is the seeded-bad case and MUST fail.
//
// The DLL half (websocket.cpp rename handler + client_state rename_player_state) is compile-deferred
// and rides the next build; its wire contract is pinned here by source assertion so the two ends
// cannot silently drift.
//
// Run: node tools/harness/lobby_rename_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const LOBBY_PATH = path.join(root, "web/js/dwf-lobby.js");
const JOIN_PATH = path.join(root, "web/js/dwf-join.js");
const lobbySrc = fs.readFileSync(LOBBY_PATH, "utf8");
const joinSrc = fs.readFileSync(JOIN_PATH, "utf8");

let passed = 0;
const it = (msg, fn) => { fn(); passed++; };

// ---------------------------------------------------------------------------------------------
// 1. UI: the rename control renders on the SELF row only, via a DWFUI plaque, and is delegated.
// ---------------------------------------------------------------------------------------------
function kebab(k) { return k.replace(/[A-Z]/g, m => "-" + m.toLowerCase()); }
function dsAttrs(d) { return Object.keys(d || {}).map(k => ` data-${kebab(k)}="${d[k]}"`).join(""); }

// Minimal DWFUI stub: enough for lobbyRowsHtml to emit rows + plaques with their dataset hooks.
global.window = {
  DWFUI: {
    esc: s => String(s == null ? "" : s),
    plaqueBtnHtml: c => `<button class="${(c && c.cls) || ""}"${dsAttrs(c && c.dataset)}${c && c.disabled ? " disabled" : ""}>${(c && c.label) || ""}</button>`,
    rowHtml: cfg => `<div${dsAttrs(cfg && cfg.dataset)}>` + ((cfg && cfg.cells) || []).map(x => x.html).join("") + `</div>`,
  },
};

const Lobby = require(LOBBY_PATH);
assert.equal(typeof Lobby.lobbyRowsHtml, "function", "lobby exports lobbyRowsHtml for offline render");

const rows = Lobby.lobbyRowsHtml([
  { name: "Urist", self: true },
  { name: "Domas", self: false, camx: 10, camy: 10, camz: 5 },
]);

it("rename control renders on the self row", () => {
  assert.match(rows, /data-lobby-rename="Urist"/, "self row carries the rename hook prefilled with the current name");
});
it("rename control renders on the self row ONLY", () => {
  assert.equal((rows.match(/data-lobby-rename/g) || []).length, 1, "exactly one rename control (self)");
  assert.doesNotMatch(rows, /data-lobby-rename="Domas"/, "a non-self row never gets a rename control");
});
it("the non-self row keeps its follow control", () => {
  assert.equal((rows.match(/data-lobby-follow="Domas"/g) || []).length, 1, "non-self follow control intact");
  // Self can't follow itself, so the follow action column is the rename control instead.
  assert.doesNotMatch(rows, /data-lobby-follow="Urist"/, "self row's follow action column is replaced by rename");
});
it("dwf-lobby adds NO hand-built control (dwfui_adoption 'migrated' stays handBuilt=0)", () => {
  assert.equal((lobbySrc.match(/<(?:button|input|select)\b/g) || []).length, 0,
    "the rename control is a DWFUI plaque, not a hand-built <button>/<input>");
});
it("the rename control is delegated on pointerdown (survives 30Hz re-render)", () => {
  assert.match(lobbySrc, /event\.target\.closest\("\[data-lobby-rename\]"\)/,
    "boot() routes the rename control through the delegated pointerdown handler");
  assert.match(lobbySrc, /DwfJoin\.showRenameScreen/, "the rename control opens the dwf-join rename dialog");
});

// ---------------------------------------------------------------------------------------------
// 2. MECHANISM: renameSelf re-broadcasts + persists (the whole point), and validates like join.
// ---------------------------------------------------------------------------------------------
function loadJoin() {
  const sent = [];
  const adopted = [];
  const store = {};
  globalThis.window = globalThis;
  globalThis.DwfWS = { send: o => { sent.push(o); return true; } };
  globalThis.__dwfAdoptName = n => adopted.push(n);
  globalThis.playerName = "Urist";
  globalThis.localStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  globalThis.document = {
    getElementById() { return null; },
    createElement() { return { style: {}, appendChild() {} }; },
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  vm.runInThisContext(joinSrc, { filename: JOIN_PATH });
  return { DwfJoin: globalThis.DwfJoin, sent, adopted, store };
}

it("renameSelf RE-BROADCASTS the new name over the WS control channel (not a local relabel)", () => {
  const { DwfJoin, sent } = loadJoin();
  const r = DwfJoin.renameSelf("Sazir");
  assert.equal(r.ok, true, "a valid name commits");
  assert.equal(r.name, "Sazir");
  assert.equal(sent.length, 1, "exactly one control message is sent");
  assert.deepEqual(sent[0], { type: "rename", name: "Sazir" }, "the rename message carries the mechanism's wire contract");
});
it("renameSelf persists the new name to localStorage['dwf.player']", () => {
  const { DwfJoin, store } = loadJoin();
  DwfJoin.renameSelf("Sazir");
  assert.equal(store["dwf.player"], "Sazir", "the new name survives a reload");
});
it("SEEDED-BAD: a rename that only relabels locally (no rebroadcast) must FAIL", () => {
  const { DwfJoin, sent, adopted } = loadJoin();
  DwfJoin.renameSelf("Sazir");
  // The __dwfAdoptName trap: relabelling self alone leaves every other client stale. The contract
  // is that renameSelf ALSO broadcasts. If a future edit drops the DwfWS.send, `sent` is empty and
  // this assertion fails -- exactly the regression this test exists to catch.
  assert.ok(sent.some(m => m && m.type === "rename"), "the rebroadcast is mandatory, not optional");
  assert.ok(adopted.includes("Sazir"), "local adoption still happens for instant self-feedback (in addition to, not instead of, the broadcast)");
});
it("validation matches the join card: trimmed, non-empty, maxlength 32", () => {
  const { DwfJoin, sent, store } = loadJoin();
  // empty / whitespace-only is rejected with no broadcast + no persistence
  const bad = DwfJoin.renameSelf("   ");
  assert.equal(bad.ok, false, "whitespace-only name is rejected");
  assert.equal(sent.length, 0, "a rejected rename broadcasts nothing");
  assert.equal(store["dwf.player"], undefined, "a rejected rename persists nothing");
  // trim + 32-char clamp
  const long = DwfJoin.renameSelf("   " + "a".repeat(50) + "   ");
  assert.equal(long.ok, true);
  assert.equal(long.name.length, 32, "name is trimmed then clamped to 32");
  assert.equal(sent[0].name.length, 32, "the broadcast carries the clamped name");
});

// ---------------------------------------------------------------------------------------------
// 3. WIRE CONTRACT: the compile-deferred DLL half must speak the same {"type":"rename"} message.
// ---------------------------------------------------------------------------------------------
const wsSrc = fs.readFileSync(path.join(root, "src/websocket.cpp"), "utf8");
const csSrc = fs.readFileSync(path.join(root, "src/client_state.cpp"), "utf8");
it("the DLL rename handler is present and reuses the in-place registry rename", () => {
  // 1bf50648 refactored dispatch to the local is_type lambda over the strict json_mini document.
  assert.match(wsSrc, /is_type\("rename"\)/, "server handles the rename control message");
  assert.match(wsSrc, /ws_rename_connection\(conn,\s*requested\)/, "server renames the connection's registry bucket in place");
  assert.match(wsSrc, /rename_player_state\(oldName,\s*finalName\)/, "server carries name-keyed camera/cursor/follow across the rename");
  assert.match(wsSrc, /send_hello_ack\(conn\)/, "server replies with an authoritative-name hello_ack the client adopts");
});
it("client_state exposes the rename_player_state migration helper", () => {
  assert.match(csSrc, /void rename_player_state\(/, "the name-keyed state migration helper exists");
});

console.log(`lobby_rename_test: PASS (${passed} assertions)`);
