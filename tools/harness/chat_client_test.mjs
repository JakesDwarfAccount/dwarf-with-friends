// chat_client_test.mjs -- WP-D MULTIPLAYER CHAT, client half (offline). Drives the REAL
// web/js/dwf-chat.js through a minimal mocked DOM / fetch / DwfWS so the injection-safe
// render path, scrollback + gap-fill reconciliation, send clamping, and graceful-dormant behavior
// are exercised end-to-end (not reimplemented). The SERVER half (relay, ring, rate-limit, join/leave
// broadcast) is C++ (capture-chat-selftest + live cells in window #12).
//
// Matrix (client half): render/XSS inertness (raw text, token labels, URL schemes), exact token
// grammar + legacy degrade, location/unit click payloads, current-roster unit resolution, DWFUI
// authoring markup, @mention wire round-trip, receive/scrollback/gap-fill, send clamps, system
// lines, name "you" marker, and graceful-dormant (404).
// Run: node tools/harness/chat_client_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_PATH = path.resolve(__dirname, "../../web/js/dwf-chat.js");
const SRC = fs.readFileSync(CHAT_PATH, "utf8");
const DWFUI_PATH = path.resolve(__dirname, "../../web/js/dwf-ui-components.js");
const DWFUI_SRC = fs.readFileSync(DWFUI_PATH, "utf8");

// ---- minimal DOM stub ------------------------------------------------------------------------
function makeClassList(el) {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
    _set: set,
  };
}
// WAVE-5 (DWFUI adoption). build() -- THE PATH THE REAL CLIENT RUNS -- no longer hand-builds the
// header / Send button / log region with createElement; it LIFTS REAL NODES out of the same DWFUI
// builders chatStoryMarkup() uses (nodeFrom() -> scratch div -> innerHTML -> firstElementChild).
// The mock has to model that, or the module's live path cannot be driven here at all -- which is
// exactly the blind spot that let the Studio render a DWFUI chat panel while the client rendered a
// hand-built one. This parses the FIRST element of an assigned fragment into a real, clickable stub.
function parseFirstElement(html) {
  const m = /<([a-zA-Z][\w-]*)\b([^>]*)>/.exec(html);
  if (!m) return null;
  const el = makeEl(m[1]);
  const attrs = m[2] || "";
  const cls = /class="([^"]*)"/.exec(attrs);
  if (cls) el.className = cls[1];
  const id = /id="([^"]*)"/.exec(attrs);
  if (id) el.id = id[1];
  for (const a of attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g))
    el.dataset[a[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[2];
  if (/\bdisabled\b/.test(attrs)) el.disabled = true;
  el._innerHTML = html;               // set directly: this is not an innerHTML SINK write
  return el;
}
function makeEl(tag) {
  const el = {
    tag, id: "", _className: "", type: "", value: "", placeholder: "", maxLength: 0,
    selectionStart: 0, selectionEnd: 0, dataset: {},
    disabled: false, _textContent: "", style: {}, _handlers: {}, _attrs: {},
    children: [], scrollHeight: 100, scrollTop: 0, clientHeight: 100,
    appendChild(c) { this.children.push(c); c._parent = this; c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    get firstChild() { return this.children[0] || null; },
    get firstElementChild() { return this._firstEl || this.children[0] || null; },
    addEventListener(t, fn) { this._handlers[t] = fn; },
    removeEventListener() {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] || null; },
    focus() {},
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    // Class-selector lookup over this element's own markup: enough to resolve the ONE query the
    // module makes on builder output (head.querySelector(".dfchat-close")).
    querySelector(sel) {
      const m = /^\.([\w-]+)$/.exec(String(sel || ""));
      if (!m) return null;
      const has = node => node && node._className &&
        node._className.split(/\s+/).indexOf(m[1]) >= 0;
      if (has(this)) return this;
      if (has(this._firstEl)) return this._firstEl;
      const html = this._innerHTML || "";
      if (new RegExp('class="[^"]*\\b' + m[1] + '\\b').test(html)) {
        const stub = makeEl("button");
        stub.className = m[1];
        return stub;
      }
      return null;
    },
    // textContent: setting it makes this element a LEAF holding literal text (browser semantics).
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = String(v); this.children = []; },
    // className passthrough.
    get className() { return this._className; },
    set className(v) { this._className = String(v); },
    // Trusted composer chrome is allowed to mount DWFUI output. Every assignment is recorded so
    // hostile chat/roster payload tests can prove no unescaped payload reaches this sink.
    get innerHTML() { return this._innerHTML || ""; },
    set innerHTML(v) {
      this._innerHTML = String(v);
      this._firstEl = parseFirstElement(this._innerHTML);
      if (env) env.innerHtmlWrites.push(this._innerHTML);
    },
  };
  el.classList = makeClassList(el);
  return el;
}

let env;
function resetEnv(initialFetches) {
  // boot() -> fetchChat(0) fires SYNCHRONOUSLY during module load, so any response the initial
  // probe should see must be queued BEFORE the module runs.
  env = { styleInjected: false, appended: [], wsSends: [], fetches: [], units: [],
    innerHtmlWrites: [], fetchQueue: (initialFetches || []).slice() };
  const document = {
    readyState: "complete",
    getElementById(id) { return (id === "dfChatStyle" && env.styleInjected) ? {} : null; },
    createElement(tag) { const el = makeEl(tag); if (tag === "style") env.styleInjected = true; return el; },
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: makeEl("body"),
    addEventListener() {},
  };
  document.body.appendChild = function (el) { env.appended.push(el); Object.getPrototypeOf; this.children.push(el); return el; };
  globalThis.window = globalThis;
  globalThis.document = document;
  globalThis.DwfTiles = {
    playerColor: (n) => ({ fill: "#" + (n === "Reg" ? "abc" : "def") }),
    getLatest: () => ({ units: env.units }),
  };
  globalThis.playerName = "Urist";
  globalThis.DwfWS = { send: (obj) => { env.wsSends.push(obj); return env.wsOpen !== false; } };
  globalThis.fetch = async (url) => {
    env.fetches.push(String(url));
    const next = env.fetchQueue.shift();
    if (!next) return { ok: false, status: 500, json: async () => ({}) };
    if (next.status === 404) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => next.body };
  };
  if (!globalThis.DWFUI) vm.runInThisContext(DWFUI_SRC, { filename: DWFUI_PATH });
  vm.runInThisContext(SRC, { filename: CHAT_PATH });
  return globalThis.DwfChat;
}
const tick = () => new Promise(r => setTimeout(r, 0));

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// Walk a stub node tree collecting every _textContent leaf (the rendered literal text).
function collectText(node, acc) {
  acc = acc || [];
  if (node._textContent) acc.push(node._textContent);
  for (const c of node.children || []) collectText(c, acc);
  return acc;
}
function findAll(node, pred, acc) {
  acc = acc || [];
  if (pred(node)) acc.push(node);
  for (const c of node.children || []) findAll(c, pred, acc);
  return acc;
}

// ============================================================================================
// PART A -- injection-safe render (buildLineNode), the mandatory XSS cell + test-the-test.
// Uses an independent minimal `doc` so the assertions are about the render path only.
// ============================================================================================
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  const doc = { createElement: (t) => makeEl(t) };

  // XSS SEED: a message that WOULD execute if injected as HTML must render as literal text.
  const XSS = '<img src=x onerror=alert(1)>';
  const node = C._buildLineNode(doc, { seq: 1, from: "Reg", text: XSS }, "Urist");
  const texts = collectText(node);
  ok(texts.includes(XSS), "A1: XSS payload preserved VERBATIM as text content");
  // No child element is an <img> -- the markup never became a DOM node.
  const hasImg = (function find(n) { if (n.tag === "img") return true; return (n.children || []).some(find); })(node);
  ok(!hasImg, "A2: XSS markup did NOT create an <img> element (rendered inert)");
  ok(node.children.some(c => c._className === "dfchat-name" && c._textContent === "Reg"),
     "A3: name node holds the sender name as text");

  // "you" marker for own messages.
  const mine = C._buildLineNode(doc, { seq: 2, from: "Urist", text: "hi" }, "Urist");
  ok(collectText(mine).some(t => /\(you\)/.test(t)), "A4: own message shows the (you) marker");

  // System line: no name node, just the text.
  const sys = C._buildLineNode(doc, { seq: 3, system: true, text: "Reg joined" }, "Urist");
  ok(sys._className.indexOf("dfchat-system") >= 0, "A5: system line carries the system class");
  ok(!sys.children.some(c => c._className === "dfchat-name"), "A5b: system line has no name node");
  ok(collectText(sys).includes("Reg joined"), "A5c: system line text rendered");

  // Ampersand/quotes/angle brackets all survive as literal characters (no double-escaping, no exec).
  const tricky = '5 < 3 & "x" > y';
  const tn = C._buildLineNode(doc, { seq: 4, from: "Reg", text: tricky }, "Urist");
  ok(collectText(tn).includes(tricky), "A6: special chars (< & \" >) preserved literally");

  // TEST-THE-TEST: a broken render that HTML-escaped (double-encoded) the payload must FAIL A1.
  let sawFail = false;
  try {
    const escaped = XSS.replace(/</g, "&lt;");   // simulate a buggy escape-then-innerHTML render
    assert.ok(collectText(node).includes(escaped), "seeded-wrong: escaped form should be present");
  } catch (_) { sawFail = true; }
  ok(sawFail, "A7 TEST-THE-TEST: suite rejects a double-escaped/altered payload");

  // Exact structured grammar: valid tokens become typed segments; ordinary/malformed legacy
  // text remains one inert text segment so old scrollback never disappears or mutates.
  const parsed = C._parseChatText("go [[loc:120,44,7]] then [[unit:42|Urist McMiner]]");
  ok(parsed.some(p => p.kind === "location" && p.pos.x === 120 && p.pos.y === 44 && p.pos.z === 7),
     "A8: exact location token parses with its signed integer payload");
  ok(parsed.some(p => p.kind === "unit" && p.id === 42 && p.label === "Urist McMiner"),
     "A9: exact unit token parses with id + readable fallback label");
  const legacy = "old client says [[loc:nope]] and [[unit:bad]] <b>still text</b>";
  const legacyParts = C._parseChatText(legacy);
  ok(legacyParts.length === 1 && legacyParts[0].kind === "text" && legacyParts[0].text === legacy,
     "A10 legacy degrade: malformed/ordinary text is preserved verbatim");

  // URL policy: only http/https linkify, sentence punctuation stays text, and the browser opener
  // is isolated from window.opener. javascript: remains literal text.
  const urlNode = C._buildLineNode(doc, {
    seq: 5, from: "Reg", text: "https://example.test/path). javascript:alert(1) http://safe.test/"
  }, "Urist");
  const urls = findAll(urlNode, n => n._className.includes("dfchat-url"));
  ok(urls.length === 2 && urls[0]._attrs.href === "https://example.test/path" &&
     urls[0]._attrs.target === "_blank" && /noopener/.test(urls[0]._attrs.rel),
     "A11: http(s) URLs become target=_blank rel=noopener links with trailing punctuation excluded");
  ok(!urls.some(n => /^javascript:/i.test(n._attrs.href || "")) && collectText(urlNode).join("").includes(" javascript:alert(1) "),
     "A12: javascript: is inert legacy text, never an href");

  // Hostile token labels are clickable but remain text nodes. No tag is created and no trusted
  // DWFUI innerHTML sink ever sees the raw payload.
  const TOKEN_XSS = '<img src=x onerror=alert(2)>';
  const tokenNode = C._buildLineNode(doc, {
    seq: 6, from: "Reg", text: `[[unit:7|${TOKEN_XSS}]]`
  }, "Urist");
  ok(collectText(tokenNode).includes("@" + TOKEN_XSS), "A13: hostile unit label is preserved as literal link text");
  ok(findAll(tokenNode, n => n.tag === "img").length === 0,
     "A14 XSS: token label cannot create an element");

  // TEST-THE-TEST: a permissive scheme check would incorrectly admit javascript:.
  let badSchemeCaught = false;
  try { assert.ok(/^https?:\/\//i.test("javascript:alert(1)")); } catch (_) { badSchemeCaught = true; }
  ok(badSchemeCaught, "A15 TEST-THE-TEST: scheme assertion rejects javascript:");
}

// ============================================================================================
// PART P -- ping authoring/render activation: coordinates, current unit resolution, DWFUI.
// ============================================================================================
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const doc = { createElement: (t) => makeEl(t) };
  const jumps = [], opens = [];
  C._setNavigationHooksForTest({
    cameraJump: p => { jumps.push(p); return true; },
    openUnit: id => opens.push(id),
    currentLocation: () => ({ x: 321, y: 654, z: 12 }),
  });

  const locLine = C._buildLineNode(doc, { seq: 1, from: "Reg", text: "[[loc:8,9,10]]" }, "Urist");
  const locLink = findAll(locLine, n => n._className.includes("dfchat-location"))[0];
  await locLink._handlers.click({ preventDefault() {} });
  ok(JSON.stringify(jumps[0]) === JSON.stringify({ x: 8, y: 9, z: 10 }),
     "P1 camera-jump payload: location click forwards exact x/y/z");

  // Token label says an old name and carries no coordinates. Resolution must use id=42's CURRENT
  // live AUX position, proving a walking dwarf is not sent to stale author-time coordinates.
  env.units = [{ id: 42, name: "Urist Currentname", x: 77, y: 88, z: 4 }];
  const unitLine = C._buildLineNode(doc, { seq: 2, from: "Reg", text: "[[unit:42|Urist Oldname]]" }, "Urist");
  const unitLink = findAll(unitLine, n => n._className.includes("dfchat-unit"))[0];
  await unitLink._handlers.click({ preventDefault() {} });
  ok(JSON.stringify(jumps[1]) === JSON.stringify({ x: 77, y: 88, z: 4 }),
     "P2 unit resolution: click jumps to the roster's current position, not message-time text");
  ok(opens.length === 1 && opens[0] === 42, "P3: existing unit-sheet opener runs after the unit jump");
  ok(C._resolveUnitPing(999) === null, "P4: stale/missing unit id fails closed instead of inventing a position");
  env.fetchQueue.push({ body: { unit: { id: 99, name: "Urist Offscreen" }, tile: { x: 9, y: 19, z: 2 } } });
  await C._jumpToUnit(99);
  ok(JSON.stringify(jumps[2]) === JSON.stringify({ x: 9, y: 19, z: 2 }) &&
     env.fetches.some(u => /\/unit\?.*id=99/.test(u)),
     "P4b: unit absent from AUX resolves its current tile through the existing /unit route");

  // B223: the ping button no longer stamps the CAMERA into the composer -- the whole camera
  // authoring path is GONE. P5 is now the negative: nothing about the camera can be authored, and
  // the composer is never written to by a ping. (P6 keeps the token-grammar guard.)
  ok(typeof C._insertLocationPingForTest !== "function",
     "P5: the camera-centre composer-insert path is removed (a ping targets a CLICK, not the camera)");
  ok(C._locationToken({ x: 1.5, y: 2, z: 3 }) === "", "P6: non-integer camera payload cannot be authored");

  // Character suggestions use DWFUI rowHtml/scrollHtml. Its escaping must keep a hostile roster
  // name out of markup while preserving readable text.
  const suggestions = C._unitSuggestionsHtml([{ id: 5, name: '<img onerror="boom">', x: 1, y: 2, z: 3 }]);
  ok(/class="dwfui-scroll dfchat-unit-list"/.test(suggestions) && /class="dwfui-row dfchat-unit-option"/.test(suggestions),
     "P7 DWFUI: character completion is composed from shared scroll + row builders");
  ok(!suggestions.includes("<img") && suggestions.includes("&lt;img onerror=&quot;boom&quot;&gt;"),
     "P8 XSS: DWFUI escapes hostile roster names in completion markup");
  env.units = [{ id: 5, name: '<img onerror="boom">', x: 1, y: 2, z: 3 }];
  const composer = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];})
    .find(e => e.id === "dfChatInput");
  composer.value = "@<img"; composer.selectionStart = composer.selectionEnd = composer.value.length;
  composer._handlers.input();
  const mountedSuggestion = env.innerHtmlWrites[env.innerHtmlWrites.length - 1];
  ok(!mountedSuggestion.includes('<img onerror="boom">') && mountedSuggestion.includes("&lt;img onerror=&quot;boom&quot;&gt;"),
     "P9 XSS: mounted DWFUI completion escapes the raw hostile roster name before innerHTML");
  ok(C._completeUnitMentionForTest(5, composer) && composer.value === '@<img onerror="boom"> ',
     "P10: choosing a roster completion replaces @query with the exact name and a word boundary");
}

// ============================================================================================
// PART G -- B223 PING TARGETING ("when you click the camera ping button, it should then wait
// for you to click on a unit or a location, and then send that ping in chat automatically").
//
// The map half (the armed crosshair + the /inspect pick) lives in dwf-controls-placement.js
// and is pinned by uiflow_test. What THIS suite owns is the chat half, driven through the REAL
// module: arming through the real button-delegation handler, the unit-vs-tile resolution, the
// auto-send, and -- the thing a wedged mode would break -- cancel.
//
// window.DFChatPing is the bridge. controls-placement owns arm/disarm/isArmed; chat owns
// onArmed/onDisarmed/onPick. Offline, we stand in for the map half with a faithful stub of those
// three functions (same idempotent-flag + notify contract as the real one), which is exactly how
// the two halves see each other in the browser.
// ============================================================================================
function installPingMapStub() {
  const bridge = globalThis.DFChatPing;      // chat's bindPingBridge() already published onPick etc.
  const calls = { arm: 0, disarm: 0 };
  let armed = false;
  bridge.arm = () => {
    if (armed) return;
    armed = true; calls.arm++;
    if (bridge.onArmed) bridge.onArmed();
  };
  bridge.disarm = () => {
    if (!armed) return;
    armed = false; calls.disarm++;
    if (bridge.onDisarmed) bridge.onDisarmed();
  };
  bridge.isArmed = () => armed;
  // What the real chatPingClick() does on a map click: disarm FIRST (one-shot, never wedged),
  // then hand chat the /inspect payload plus the browser-side world tile.
  bridge.click = (data, pos) => { bridge.disarm(); return bridge.onPick(data, pos); };
  return { bridge, calls, isArmed: () => armed };
}
// The one node the foot-click delegation looks for: anything carrying data-chat-ping-arm.
const pingBtnTarget = { getAttribute: (k) => (k === "data-chat-ping-arm" ? "" : null), parentNode: null };
function clickPingButton(foot) { foot._handlers.click({ target: pingBtnTarget, preventDefault() {} }); }
function findFoot() {
  return env.appended.flatMap(function walk(e) { return [e, ...(e.children || []).flatMap(walk)]; })
    .find(e => e.id === "dfChatFoot");
}

// G1: ARM -- the button arms the map pick. Nothing is written to the composer; nothing is sent.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  const foot = findFoot();
  const input = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];})
    .find(e => e.id === "dfChatInput");

  clickPingButton(foot);
  ok(map.isArmed() && map.calls.arm === 1 && C._pingArmedForTest(),
     "G1: the ping button ARMS the map pick (it does not ping anything yet)");
  ok(env.wsSends.length === 0 && input.value === "",
     "G1a: arming sends NOTHING and writes NOTHING to the composer (the old bug: it stamped the camera)");
  // The armed affordance is DWFUI's own `active` action-button state, re-rendered through the SAME
  // factory -- not a hand-stamped class.
  const armedMarkup = env.innerHtmlWrites[env.innerHtmlWrites.length - 1];
  ok(/class="dfchat-ping-location active"/.test(armedMarkup),
     "G1b: the armed button is rendered by DWFUI actionButtonsHtml with its `active` state");
  ok(/TEST-THE-TEST/.test("TEST-THE-TEST") &&
     !/class="dfchat-ping-location active"/.test('<button class="dfchat-ping-location">'),
     "G1c TEST-THE-TEST: the armed-markup assertion really rejects an UNARMED button");
}

// G2: armed -> click a UNIT -> [[unit:id|Name]] auto-sent. The unit is resolved with the SAME
// precedence a plain click uses (DFTileList.buildCandidates -- units outrank buildings/items), so
// a ping picks the unit a click would have opened.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  const foot = findFoot();
  // The real B208/B219 precedence module, standing in exactly as it does in the browser.
  globalThis.DFTileList = {
    buildCandidates: () => [
      { kind: "unit", id: 42, label: "Urist McMiner" },
      { kind: "workshop", id: 7, label: "Mason's Workshop" },
    ],
  };
  clickPingButton(foot);
  const inspect = { kind: "workshop", tile: { x: 10, y: 20, z: 5 }, buildingId: 7 };
  map.bridge.click(inspect, { x: 10, y: 20, z: 5 });

  ok(env.wsSends.length === 1 && env.wsSends[0].type === "chat" &&
     env.wsSends[0].text === "[[unit:42|Urist McMiner]]",
     "G2: clicking a tile with a unit AUTO-SENDS the unit token -- no composer step");
  ok(!map.isArmed() && !C._pingArmedForTest(), "G2a: the pick disarms (one-shot, not a sticky mode)");
  // Even though /inspect's own answer was the WORKSHOP, the top occupant is the unit -- the same
  // thing a click would open. This is the reuse the bug report asked for.
  ok(env.wsSends[0].text !== "[[loc:10,20,5]]",
     "G2b: a unit on the tile outranks the tile itself (no parallel hit-test)");
  delete globalThis.DFTileList;
}

// G3: armed -> click BARE GROUND -> [[loc:x,y,z]] auto-sent, at the CLICKED tile.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  const foot = findFoot();
  clickPingButton(foot);
  map.bridge.click({ kind: "terrain", tile: { x: 111, y: 222, z: -3 } }, { x: 111, y: 222, z: -3 });
  ok(env.wsSends.length === 1 && env.wsSends[0].text === "[[loc:111,222,-3]]",
     "G3: clicking a tile with no unit AUTO-SENDS the location token for THAT tile");

  // /inspect is down (or the host is old): the browser-side world tile the click layer computed is
  // the fallback, so a ping on bare ground still resolves instead of silently doing nothing.
  clickPingButton(foot);
  map.bridge.click(null, { x: 5, y: 6, z: 7 });
  ok(env.wsSends.length === 2 && env.wsSends[1].text === "[[loc:5,6,7]]",
     "G3a: a dead /inspect degrades to a plain location ping at the clicked tile, never to nothing");

  // Nothing resolvable at all -> nothing is sent (fail closed; no invented coordinates).
  clickPingButton(foot);
  map.bridge.click(null, null);
  ok(env.wsSends.length === 2, "G3b: an unresolvable pick sends NOTHING (fails closed)");
  ok(C._pingTargetTokenForTest(null, null) === "",
     "G3c TEST-THE-TEST: the resolver really returns no token when there is nothing to resolve");
}

// G4: CANCEL -- Esc and a second click on the button both leave targeting without sending.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  const foot = findFoot();
  const input = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];})
    .find(e => e.id === "dfChatInput");

  // (a) re-clicking the button toggles OFF
  clickPingButton(foot);
  ok(map.isArmed(), "G4 precondition: armed");
  clickPingButton(foot);
  ok(!map.isArmed() && !C._pingArmedForTest() && map.calls.disarm === 1 && env.wsSends.length === 0,
     "G4a: clicking the ping button again CANCELS targeting and sends nothing");

  // (b) Escape in the composer cancels. (The map-side Escape cascade never sees a keypress made
  // while a text input has focus -- it blurs and returns -- so chat must cancel it itself.)
  clickPingButton(foot);
  input._handlers.keydown({ key: "Escape", preventDefault() {} });
  ok(!map.isArmed() && !C._pingArmedForTest() && env.wsSends.length === 0,
     "G4b: Escape cancels targeting and sends nothing");

  // (c) closing the chat panel cannot strand an armed crosshair with no button left to cancel it.
  clickPingButton(foot);
  ok(map.isArmed(), "G4 precondition: armed again");
  C._closePanelForTest();
  ok(!map.isArmed() && !C._pingArmedForTest(),
     "G4c: closing chat while armed disarms the map (no crosshair with no way out)");

  // (d) NO WEDGED HANDLER. After a cancel the mode is really gone: the map's click path is no
  // longer armed, and arming again works from a clean state.
  ok(map.calls.disarm === 3, "G4d: each cancel disarmed the map exactly once (idempotent, no double-notify)");
  clickPingButton(foot);
  map.bridge.click({ kind: "terrain", tile: { x: 1, y: 2, z: 3 } }, { x: 1, y: 2, z: 3 });
  ok(env.wsSends.length === 1 && env.wsSends[0].text === "[[loc:1,2,3]]" && !map.isArmed(),
     "G4e: re-arming after a cancel still works, and still pings exactly once");

  // TEST-THE-TEST for the wedge: a pick fired at a DISARMED map must not reach chat at all. The
  // real map layer gates on chatPingArmed; here the stub proves the bridge is the only path in.
  const before = env.wsSends.length;
  map.bridge.onPick({ kind: "terrain", tile: { x: 9, y: 9, z: 9 } }, { x: 9, y: 9, z: 9 });
  ok(env.wsSends.length === before + 1,
     "G4f TEST-THE-TEST: onPick itself DOES send when called -- so G4a/b/c pass because the mode " +
     "was really disarmed, not because the send path was broken");
}

// G5: the auto-sent ping is an ORDINARY chat line -- same WS envelope as a typed message, and the
// composer is never touched (no text the player did not mean to send can ride along).
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  const foot = findFoot();
  const input = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];})
    .find(e => e.id === "dfChatInput");
  input.value = "half-typed thought";
  clickPingButton(foot);
  map.bridge.click({ kind: "terrain", tile: { x: 1, y: 2, z: 3 } }, { x: 1, y: 2, z: 3 });
  ok(env.wsSends.length === 1 && env.wsSends[0].text === "[[loc:1,2,3]]",
     "G5: the ping message IS the token -- the half-typed composer text is not swept into it");
  ok(input.value === "half-typed thought", "G5a: the composer is left exactly as the player had it");

  // Socket down: nothing is sent, and the mode still ends (no wedge on a failed send).
  env.wsOpen = false;
  clickPingButton(foot);
  map.bridge.click({ kind: "terrain", tile: { x: 4, y: 5, z: 6 } }, { x: 4, y: 5, z: 6 });
  ok(env.wsSends.length === 2 && !map.isArmed() && !C._pingArmedForTest(),
     "G5b: a ping attempted with the socket down disarms cleanly (WS.send refused it)");
}

// G6: GRACEFUL-DORMANT. Against an old host that cannot relay chat at all (GET /chat 404s), the
// ping cannot arm -- a crosshair that eats a click and can never send is worse than a dead button.
{
  const C = resetEnv([{ status: 404 }]);
  await tick(); await tick();
  ok(C._stateForTest().supported === false, "G6 precondition: chat is dormant (old host)");
  const map = installPingMapStub();
  clickPingButton(findFoot());
  ok(!map.isArmed() && !C._pingArmedForTest() && map.calls.arm === 0,
     "G6: the ping button does not arm against a host that cannot relay chat");
}

// ============================================================================================
// PART GE -- SENDER SELF-ECHO. The reported bug: a ping's chat line reached every OTHER player
// but never the pinger's own chat box. A ping is an ORDINARY chat line (G5), so it must ride the
// SAME self-echo path a typed message does: the client keeps NO local echo (B7b) and instead
// renders the copy the SERVER relays back, and the server's broadcast does NOT exclude the
// originating socket. These cells pin that a ping produces a chat ENTRY for the SENDER (not only
// receivers), rendered identically -- same clickable [[loc]] token, plus the (you) marker -- and
// a seeded sender-excluded broadcast makes the assertion FAIL.
//
// The server's broadcast_chat_to_all() (src/websocket.cpp) is modelled here: chat_post enqueues
// the relayed line to EVERY live connection, the origin included. `excludeSender:true` reproduces
// the classic "broadcast loop skips the originating socket" defect the fix must never allow back.
function relayToLocalClient(C, frame, selfName, opts) {
  if (opts && opts.excludeSender && frame.from === selfName) return;  // seeded bug: origin skipped
  C.onChat(frame);
}

// GE1: the pinger picks a tile; the token auto-sends; the CORRECT server relay echoes it back to
// the origin too -> the sender's own log gains the line (applied AND rendered as a clickable loc
// link with the (you) marker). This is the whole bug: BEFORE the relay reaches back, the sender
// has nothing; the self-echo is what gives them a record of their own ping.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  const foot = findFoot();
  clickPingButton(foot);
  // Arm + pick bare ground -> the token is what goes on the wire (G3).
  map.bridge.click({ kind: "terrain", tile: { x: 5, y: 6, z: 7 } }, { x: 5, y: 6, z: 7 });
  const token = env.wsSends[0] && env.wsSends[0].text;
  ok(token === "[[loc:5,6,7]]", "GE1: the ping auto-sends the location token on the wire");
  ok(C._stateForTest().count === 0,
     "GE1a: NO local echo -- before the server relays it back the sender has no line (the bug window)");

  // The server assigns seq 1, sets from = the pinger, and broadcasts to ALL including the origin.
  relayToLocalClient(C, { type: "chat", seq: 1, from: "Urist", text: token, ts: 1 }, "Urist");
  ok(C._stateForTest().count === 1,
     "GE1b: the origin is NOT excluded -- the sender's own ping is applied to their log");

  const doc = { createElement: (t) => makeEl(t) };
  const selfLine = C._buildLineNode(doc, { seq: 1, from: "Urist", text: token }, "Urist");
  const locLink = findAll(selfLine, n => n._className.includes("dfchat-location"))[0];
  ok(locLink && locLink._attrs["data-chat-location"] === "5,6,7",
     "GE1c: the SENDER's own ping renders the SAME clickable [[loc]] token receivers get");
  ok(collectText(selfLine).some(t => /\(you\)/.test(t)),
     "GE1d: ...and it carries the (you) marker, since from === the pinger");
}

// GE2: parity -- a receiver (a DIFFERENT player) gets the identical line off the same broadcast,
// clickable, but WITHOUT (you). Proves GE1 is real self-echo symmetry, not a self-only render.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  globalThis.playerName = "Reg";               // this client is the RECEIVER, not the pinger
  await tick(); await tick();
  relayToLocalClient(C, { type: "chat", seq: 1, from: "Urist", text: "[[loc:5,6,7]]", ts: 1 }, "Reg");
  ok(C._stateForTest().count === 1, "GE2: a receiver also gets the pinger's line off the broadcast");
  const doc = { createElement: (t) => makeEl(t) };
  const rxLine = C._buildLineNode(doc, { seq: 1, from: "Urist", text: "[[loc:5,6,7]]" }, "Reg");
  const rxLink = findAll(rxLine, n => n._className.includes("dfchat-location"))[0];
  ok(rxLink && rxLink._attrs["data-chat-location"] === "5,6,7",
     "GE2a: the receiver's copy carries the same clickable location token");
  ok(!collectText(rxLine).some(t => /\(you\)/.test(t)),
     "GE2b: ...and NO (you) marker, since the receiver is not the pinger");
  globalThis.playerName = "Urist";             // restore for later cells
}

// GE3 TEST-THE-TEST: the seeded sender-excluded broadcast. If the relay skips the origin socket
// (the exact bug), the pinger's own log stays empty and GE1b's expectation MUST fail. This is what
// gives GE1 teeth: it passes because the origin is really included, not because onChat is a no-op.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const map = installPingMapStub();
  clickPingButton(findFoot());
  map.bridge.click({ kind: "terrain", tile: { x: 5, y: 6, z: 7 } }, { x: 5, y: 6, z: 7 });
  const token = env.wsSends[0].text;
  // BUGGY relay: exclude the sender from the broadcast.
  relayToLocalClient(C, { type: "chat", seq: 1, from: "Urist", text: token, ts: 1 },
                     "Urist", { excludeSender: true });
  let sawFail = false;
  try {
    assert.ok(C._stateForTest().count === 1,
              "seeded-bad: a sender-excluded broadcast should leave the pinger with no line");
  } catch (_) { sawFail = true; }
  ok(sawFail,
     "GE3 TEST-THE-TEST: excluding the origin from the broadcast makes the self-echo assertion FAIL");
  ok(C._stateForTest().count === 0,
     "GE3a: ...and concretely, the excluded pinger really has zero record of their own ping");
}

// ============================================================================================
// PART B -- full module through the DOM stub: scrollback, receive, gap-fill, dormant, send.
// ============================================================================================

// B1: late-join scrollback -- GET /chat returns history; box populates, lastSeq adopts latest.
{
  const C = resetEnv([{ body: { latest: 3, lines: [
    { seq: 1, from: "Reg", text: "hello" },
    { seq: 2, system: true, text: "Cog joined" },
    { seq: 3, from: "Cog", text: "hi all" },
  ] } }]);
  await tick(); await tick();   // boot() -> fetchChat(0)
  ok(env.fetches[0] === "/chat", "B1: probes GET /chat on boot (no since)");
  const s = C._stateForTest();
  ok(s.supported === true && s.lastSeq === 3 && s.count === 3, "B1: scrollback applied, lastSeq=latest");
}

// B2: live receive in order -> applied.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  C.onChat({ type: "chat", seq: 1, from: "Reg", text: "yo", ts: 1 });
  C.onChat({ type: "chat", seq: 2, from: "Urist", text: "hey", ts: 2 });
  const s = C._stateForTest();
  ok(s.lastSeq === 2 && s.count === 2, "B2: in-order live frames applied");
}

// B2b: unread badge counts human chat only; repeated join/leave churn collapses in the log.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  C._resetForTest();
  C._applyLineForTest({ seq: 1, system: true, text: "Reg joined" });
  C._applyLineForTest({ seq: 2, system: true, text: "Cog left" });
  ok(C._stateForTest().unread === 0, "B2b: system join/leave lines do not increment unread");
  C._applyLineForTest({ seq: 3, from: "Reg", text: "hello" });
  ok(C._stateForTest().unread === 1, "B2c: human message increments unread");
  const collapsed = C._collapsePresenceLines([
    { seq: 1, system: true, text: "Reg joined" },
    { seq: 2, system: true, text: "Cog left" },
    { seq: 3, from: "Reg", text: "hello" },
  ]);
  ok(collapsed.length === 2 && collapsed[0].text === "2 players joined or left.",
     "B2d: adjacent join/leave churn renders as one activity line");
}

// B3: GAP-FILL -- a seq jump (missed lines) triggers a GET /chat?since=<lastSeq> refetch.
{
  const C = resetEnv([{ body: { latest: 1, lines: [{ seq: 1, from: "Reg", text: "one" }] } }]);
  await tick(); await tick();
  ok(C._stateForTest().lastSeq === 1, "B3: seeded at seq 1");
  // A live frame lands at seq 5 -> we jumped past 2,3,4 -> module should refetch since=1.
  env.fetchQueue.push({ body: { latest: 5, lines: [
    { seq: 2, from: "Cog", text: "two" }, { seq: 3, from: "Cog", text: "three" },
    { seq: 4, from: "Cog", text: "four" }, { seq: 5, from: "Reg", text: "five" },
  ] } });
  C.onChat({ type: "chat", seq: 5, from: "Reg", text: "five", ts: 9 });
  await tick(); await tick();
  ok(env.fetches.some(u => u === "/chat?since=1"), "B3: gap triggered a since=1 refetch");
  const s = C._stateForTest();
  ok(s.lastSeq === 5 && s.count === 5, "B3: hole filled -- all 5 lines present, no gap");
  ok(C._needFetchSince(1, 5) === 1 && C._needFetchSince(1, 2) === -1,
     "B3b: gap math (jump past next -> refetch; contiguous -> none)");
}

// B4: dedup -- the same seq arriving twice (live + gap-fill overlap) is not double-counted.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  C.onChat({ type: "chat", seq: 1, from: "Reg", text: "dup", ts: 1 });
  C.onChat({ type: "chat", seq: 1, from: "Reg", text: "dup", ts: 1 });
  ok(C._stateForTest().count === 1, "B4: duplicate seq applied once");
}

// B5: graceful-dormant -- GET /chat 404 (old host) -> supported=false, input disabled.
{
  const C = resetEnv([{ status: 404 }]);
  await tick(); await tick();
  ok(C._stateForTest().supported === false, "B5: 404 marks host chat-less (dormant)");
  const input = env.appended.map(e => e).flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];})
                   .find(e => e.id === "dfChatInput");
  ok(input && input.disabled === true, "B5b: input disabled in dormant state");
}

// B6: dormant self-heal -- a live chat frame after a 404 re-enables the box.
{
  const C = resetEnv([{ status: 404 }]);
  await tick(); await tick();
  ok(C._stateForTest().supported === false, "B6: starts dormant");
  C.onChat({ type: "chat", seq: 1, from: "Reg", text: "host updated!", ts: 1 });
  ok(C._stateForTest().supported === true, "B6: live frame self-enables chat");
}

// B7: send -- normal message goes out over DwfWS as {type:"chat",text}; input cleared.
// empty/whitespace ignored; long paste clamped to 500.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const all = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];});
  const input = all.find(e => e.id === "dfChatInput");
  // WAVE-5: Send is a NATIVE PLAQUE (DWFUI.plaqueBtnHtml) in the LIVE build() path, not a raw
  // <button id="dfChatSend">. DWFUI builders take cls + dataset hooks, not ids, so the handle is
  // [data-chat-send]. Same element, same click handler, same WS dispatch.
  const sendBtn = all.find(e => e.dataset && e.dataset.chatSend !== undefined);
  ok(input && sendBtn, "B7: input + native Send plaque present in the LIVE panel");
  ok(sendBtn && /dwfui-plaque/.test(sendBtn.className || ""),
     "B7: the LIVE Send control is a DWFUI plaque -- the client renders what the Studio shows");

  input.value = "hello world";
  sendBtn._handlers.click();
  ok(env.wsSends.length === 1 && env.wsSends[0].type === "chat" && env.wsSends[0].text === "hello world",
     "B7a: normal message sent over WS");
  ok(input.value === "", "B7b: input cleared after send (no local echo)");

  // Author-visible @Name expands to the structured token only at send time. Parse the exact WS
  // payload again to prove the existing transport round-trip retains id + fallback label.
  env.units = [{ id: 42, name: "Urist McMiner", x: 3, y: 4, z: 5 }];
  input.value = "meet @Urist McMiner now";
  sendBtn._handlers.click();
  const wireText = env.wsSends[1].text;
  ok(wireText === "meet [[unit:42|Urist McMiner]] now",
     "B7c token round-trip: @completion expands to the exact unit wire token");
  const roundTrip = C._parseChatText(wireText).find(p => p.kind === "unit");
  ok(roundTrip && roundTrip.id === 42 && roundTrip.label === "Urist McMiner",
     "B7d token round-trip: relayed text parses back to the same unit id + label");

  input.value = "meet [[loc:1,2,3]]";
  sendBtn._handlers.click();
  const locRoundTrip = C._parseChatText(env.wsSends[2].text).find(p => p.kind === "location");
  ok(env.wsSends[2].text === "meet [[loc:1,2,3]]" && locRoundTrip && locRoundTrip.pos.z === 3,
     "B7e token round-trip: location wire text is sent unchanged and parses to the same payload");

  // Server's 500 limit is bytes. A Unicode-heavy structured line can be below input.maxLength
  // in code units but above the wire byte cap; reject it rather than let the server split a token.
  input.value = "[[loc:1,2,3]] " + "é".repeat(245);
  sendBtn._handlers.click();
  ok(env.wsSends.length === 3 && input.value.startsWith("[[loc:1,2,3]]"),
     "B7f: UTF-8 byte overflow with a token is rejected, never transport-truncated");

  input.value = "   ";
  sendBtn._handlers.click();
  ok(env.wsSends.length === 3, "B7g: whitespace-only message NOT sent");

  input.value = "x".repeat(9000);           // 10KB-ish paste
  sendBtn._handlers.click();
  ok(env.wsSends.length === 4 && env.wsSends[3].text.length === 500,
     "B7h: long paste clamped to 500 chars before send");
}

// B8: send while socket down -> not sent, input preserved (WS.send returns false).
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  env.wsOpen = false;
  await tick(); await tick();
  const all = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];});
  const input = all.find(e => e.id === "dfChatInput");
  const sendBtn = all.find(e => e.dataset && e.dataset.chatSend !== undefined);   // WAVE-5: native plaque, [data-chat-send]
  input.value = "offline msg";
  sendBtn._handlers.click();
  ok(input.value === "offline msg", "B8: text preserved when socket is down");
}

// ---- W5: THE TWO CODE PATHS MUST NOT DIVERGE -------------------------------------------------
// chatStoryMarkup() feeds the Studio card. build() is what the PLAYER runs. They used to be two
// different panels -- the story a DWFUI one, the client a hand-built one with
// `closeBtn.textContent = "x"`. A lane could migrate the story, see the Studio go green, and change
// NOTHING A PLAYER SEES. These cells assert the LIVE DOM, and then that the story agrees with it.
{
  const C = resetEnv([{ body: { latest: 0, lines: [] } }]);
  await tick(); await tick();
  const all = env.appended.flatMap(function walk(e){return [e,...(e.children||[]).flatMap(walk)];});

  // --- the LIVE panel (build()) ---
  // headerHtml's `cls` REPLACES its default class (that is the strangler seam), so the DWFUI
  // signature to look for is its OUTPUT: the bitmap title span and the native close tile.
  const head = all.find(e => /dfchat-head/.test(e.className || ""));
  ok(!!head && /dwfui-head-title/.test(head.innerHTML || "") &&
     /data-dwfui-bitmap-text/.test(head.innerHTML || ""),
     "W5-live: the client's chat header IS DWFUI.headerHtml output (bitmap title), not a createElement lookalike");
  ok(head && !/×/.test(collectText(head).join("")),
     "W5-live: the close control is NOT a raw × text node any more");
  ok(head && /data-dwfui-native-art="true"/.test(head.innerHTML || "") &&
     /dfchat-close/.test(head.innerHTML || ""),
     "W5-live: ...it is the NATIVE close tile (artBtnHtml), and .dfchat-close stays a CLOSE_SEL member");

  const send = all.find(e => e.dataset && e.dataset.chatSend !== undefined);
  ok(send && /dwfui-plaque/.test(send.className), "W5-live: Send is a native plaque in the CLIENT");

  const logHost = all.find(e => e.id === "dfChatLog");
  ok(!!logHost, "W5-live: #dfChatLog survives (PanelFrame fillSel hook preserved)");
  ok(logHost && /dwfui-scroll/.test((logHost.firstElementChild || {}).className || ""),
     "W5-live: the chat log scrolls through DWFUI.scrollHtml -- the NATIVE bar, not the browser default");
  ok(!/#dfChatLog\{[^}]*overflow-y:\s*auto/.test(SRC),
     "W5-live: ...and the injected CSS no longer restates overflow-y:auto on #dfChatLog (that is what made the default bar)");

  // --- the STORY agrees with the LIVE panel ---
  const story = C.storyMarkup({ lines: [], open: true });
  ok(/class="dfchat-head"/.test(story) && /dwfui-head-title/.test(story) &&
     /dwfui-plaque[^"]*dfchat-send/.test(story) &&
     /dwfui-scroll[^"]*dfchat-log/.test(story) && /id="dfChatLog"/.test(story),
     "W5-story: the Studio card renders the SAME three controls the client does");
  ok(!/&times;/.test(story), "W5-story: no &times; escape hatch left in the story path either");

  // --- THE SECURITY BOUNDARY. NOT migration debt. Must NOT have moved. ---
  // buildLineNode()/appendChatBody() render EVERY piece of player-supplied text through textContent
  // and safe attributes -- never innerHTML. The "migrate every row to rowHtml" instinct lands here
  // naturally and the diff would look like faithful compliance. This cell exists to make that fail.
  ok(/\*\*\* Injection-critical/.test(SRC),
     "W5-security: the injection-critical marker on the message render path is still present");
  const lineFn = SRC.slice(SRC.indexOf("function buildLineNode"), SRC.indexOf("function isPresenceSystemLine"));
  ok(!/innerHTML/.test(lineFn),
     "W5-security: buildLineNode() STILL contains no innerHTML -- the message path was NOT migrated to rowHtml");
  const bodyFn = SRC.slice(SRC.indexOf("function appendChatBody"), SRC.indexOf("// Exposed for the offline test"));
  ok(!/innerHTML/.test(bodyFn) && /textContent/.test(bodyFn),
     "W5-security: appendChatBody() STILL renders player text via textContent only");
  ok(/DWFUI\.require\("chat"/.test(SRC), "W5: the module DECLARES its DWFUI dependencies");
}

console.log(`chat_client_test: OK (${passed} assertions)`);
