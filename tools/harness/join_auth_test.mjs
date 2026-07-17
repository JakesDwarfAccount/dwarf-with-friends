// join_auth_test.mjs -- JOIN SECURITY, client flow (ship-blocker, PROJECT-CLOSEOUT Phase 5). Drives
// the REAL web/js/dwf-join.js gate() through a minimal mocked DOM/fetch/cookie/localStorage so
// the join-screen decision logic, credential handling, and version banner are exercised end-to-end
// (not reimplemented). The SERVER-side compare/cookie/public-path gate is C++ (compile-verified +
// live cells); this covers the client half of the acceptance matrix.
//
// Auth matrix (client half): {no-password-set + stored name, no-password + no name, right pass,
// wrong pass, empty/missing pass, valid-cookie returning session (=reconnect-after-restart /
// second player)} plus a version-mismatch banner. Includes test-the-test.
//
// Run: node tools/harness/join_auth_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOIN_PATH = path.resolve(__dirname, "../../web/js/dwf-join.js");
const SRC = fs.readFileSync(JOIN_PATH, "utf8");
const require = createRequire(import.meta.url);
globalThis.DWFUI = require(path.resolve(__dirname, "../../web/js/dwf-ui-components.js"));

// ---- minimal DOM/browser mock ----------------------------------------------------------------
// WAVE-5 (DWFUI adoption). showBanner() no longer hand-builds the version banner with createElement
// and two raw buttons -- it mounts versionBannerMarkup()'s output and wires it by delegation, so the
// LIVE banner and the Studio card are one definition. (Same two-path trap as chat's build(): the
// story was migrated, the live path was not, and every gate stayed green.) The mock therefore has to
// lift a real element out of an assigned fragment -- `firstElementChild` -- exactly as a browser does.
function parseFirstElement(html) {
  const m = /<([a-zA-Z][\w-]*)\b([^>]*)>/.exec(html);
  if (!m) return null;
  const el = makeEl(m[1]);
  const attrs = m[2] || "";
  const id = /id="([^"]*)"/.exec(attrs);
  if (id) el.id = id[1];
  const cls = /class="([^"]*)"/.exec(attrs);
  if (cls) el.className = cls[1];
  el.innerHTML = html;
  return el;
}
function makeEl(tag) {
  const el = {
    tag, id: "", className: "", innerHTML: "", textContent: "", value: "",
    disabled: false, style: {}, _handlers: {}, _attrs: {}, children: [], dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { this._handlers[type] = fn; },
    removeEventListener() {},
    remove() { this._removed = true; if (env.overlay === this) env.overlay = null;
               if (env.banner === this) env.banner = null; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] || null; },
    focus() {}, select() {},
    get firstElementChild() { return parseFirstElement(String(this.innerHTML || "")); },
    // querySelector resolves the fixed set of hooks the join card / banner uses, from a per-overlay
    // registry the test can read/drive.
    querySelector(sel) { return (this._reg && this._reg[sel]) || null; },
  };
  return el;
}
// Drive a delegated [data-dfcj-act] click the way the browser would: the module's banner handler
// reads event.target.closest("[data-dfcj-act]").
function bannerClick(banner, act) {
  const target = { closest: sel => (/data-dfcj-act/.test(sel) ? { dataset: { dfcjAct: act } } : null) };
  if (banner && banner._handlers.click) banner._handlers.click({ target });
}

let env;
function resetEnv(opts) {
  const cookies = {};   // jar
  const store = {};     // localStorage
  if (opts && opts.name) store["dwf.player"] = opts.name;
  if (opts && opts.cookie) cookies["dfcap_auth"] = opts.cookie;

  env = {
    overlay: null, banner: null, styleInjected: false,
    versionResp: opts && opts.version,          // /version JSON (or null => fetch rejects)
    joinOk: opts ? opts.joinOk : true,          // what POST /join returns
    joinCalls: [], booted: 0, reloaded: 0,
    _regTemplate: null,
  };

  const document = {
    getElementById(id) { return (id === "dfcapJoinStyle" && env.styleInjected) ? {} : null; },
    createElement(tag) {
      const el = makeEl(tag);
      if (tag === "style") { env.styleInjected = true; }
      return el;
    },
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: {
      appendChild(el) {
        if (el.id === "dfcapJoinOverlay") {
          // wire the card's inputs so the test can drive submit.
          const name = makeEl("input"), pass = makeEl("input"),
                btn = makeEl("button"), err = makeEl("div");
          // WAVE-5: the Join action is a DWFUI plaque. The module addresses it by [data-dfcj-join]
          // (builders take cls+dataset hooks, not ids); `#dfcapJoinBtn` is still emitted as the
          // pinned host hook that tools/ui-lab/stories.js drives, so BOTH selectors resolve here.
          el._reg = { "#dfcapJoinName": name, "#dfcapJoinPass": el.innerHTML.indexOf("dfcapJoinPass") >= 0 ? pass : null,
                      "#dfcapJoinBtn": btn, "[data-dfcj-join]": btn, "#dfcapJoinErr": err };
          env.overlay = el;
        } else if (el.id === "dfcapVerBanner") {
          env.banner = el;
        }
        return el;
      },
    },
    querySelectorAll() { return []; },
    // cookie jar
    get cookie() { return Object.keys(cookies).map(k => `${k}=${cookies[k]}`).join("; "); },
    set cookie(v) {
      const first = String(v).split(";")[0];
      const eq = first.indexOf("=");
      const k = first.slice(0, eq).trim(), val = first.slice(eq + 1);
      if (/max-age=0/.test(v) || val === "") delete cookies[k];
      else cookies[k] = val;
    },
  };

  globalThis.window = globalThis;
  globalThis.document = document;
  globalThis.location = { reload() { env.reloaded++; }, protocol: "http:", host: "localhost:8765" };
  globalThis.localStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).indexOf("/version") === 0) {
      if (!env.versionResp) throw new Error("no /version route (old DLL)");
      return { ok: true, json: async () => env.versionResp };
    }
    if (String(url).indexOf("/join") === 0) {
      env.joinCalls.push(init && init.body);
      return { ok: env.joinOk, json: async () => ({ ok: env.joinOk, authRequired: true }) };
    }
    throw new Error("unexpected fetch " + url);
  };
  env._store = store; env._cookies = cookies;
  // reload the module fresh (resets its internal credential/started/serverInfo).
  vm.runInThisContext(SRC, { filename: JOIN_PATH });
  return globalThis.DwfJoin;
}

function startFn() { env.booted++; }
const tick = () => new Promise(r => setTimeout(r, 0));
async function submitCard(name, pass) {
  const ov = env.overlay;
  assert.ok(ov, "expected a join screen to be shown");
  if (name != null) ov._reg["#dfcapJoinName"].value = name;
  if (pass != null && ov._reg["#dfcapJoinPass"]) ov._reg["#dfcapJoinPass"].value = pass;
  await ov._reg["#dfcapJoinBtn"]._handlers.click();  // submit() (async)
  await tick(); await tick();
}

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// ---- 1. no password + stored name -> boots immediately, NO screen ----------------------------
{
  const J = resetEnv({ version: { authRequired: false, build: "0x538dea9c-aaaaaaaaa" }, name: "Urist" });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  await J.gate(startFn); await tick();
  ok(env.booted === 1, "1: booted immediately");
  ok(env.overlay === null, "1: no join screen shown for returning player w/o password");
}

// ---- 2. no password + no name -> name-only screen, submit -> boots + name saved ---------------
{
  const J = resetEnv({ version: { authRequired: false, build: "0x538dea9c-aaaaaaaaa" } });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  const p = J.gate(startFn); await tick();
  ok(env.overlay && !env.overlay._reg["#dfcapJoinPass"], "2: name-only screen (no password field)");
  ok(env.booted === 0, "2: not booted until name submitted");
  await submitCard("Cog", null); await p;
  ok(env.booted === 1, "2: booted after name submit");
  ok(env._store["dwf.player"] === "Cog", "2: name persisted");
  ok(env.DFAuthToken === undefined, "2: (no token needed)");
}

// ---- 2b. password set + no stored name/cookie -> name+password screen (card ALWAYS on first join) ----
{
  const J = resetEnv({ version: { authRequired: true, build: "0x538dea9c-aaaaaaaaa" }, joinOk: true });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  J.gate(startFn); await tick();
  ok(env.overlay && env.overlay._reg["#dfcapJoinPass"],
     "2b: name+password screen shown on a FIRST visit (password set, no stored name/cookie)");
  ok(env.booted === 0, "2b: not booted until submitted");
  // name-field-only when passwordless, pinned at the story-markup level too (ui-lab consumes this).
  ok(!/id="dfcapJoinPass"/.test(J.storyMarkup({ needPass: false, prefillName: "" })),
     "2b: storyMarkup omits the password field when no password is required (name-only card)");
}

// ---- 3. right password -> screen, correct submit -> cookie + token + boot ---------------------
{
  const J = resetEnv({ version: { authRequired: true, build: "0x538dea9c-aaaaaaaaa" }, name: "Urist", joinOk: true });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  const p = J.gate(startFn); await tick();
  ok(env.overlay && env.overlay._reg["#dfcapJoinPass"], "3: name+password screen shown");
  ok(env.overlay._reg["#dfcapJoinName"].value === "Urist", "3: name prefilled from localStorage");
  await submitCard("Urist", "hunter2"); await p;
  ok(env.joinCalls.length === 1 && /password=hunter2/.test(env.joinCalls[0]), "3: /join validated the password");
  ok(env._cookies["dfcap_auth"] === encodeURIComponent("hunter2"), "3: credential cookie set (encoded)");
  ok(window.DwfAuth.token() === "hunter2", "3: token() exposes the passphrase for WS hello");
  ok(env.booted === 1, "3: booted after correct password");
}

// ---- 4. wrong password -> stays; then correct -> boots ---------------------------------------
{
  const J = resetEnv({ version: { authRequired: true, build: "0x538dea9c-aaaaaaaaa" }, name: "Urist", joinOk: false });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  const p = J.gate(startFn); await tick();
  await submitCard("Urist", "wrong");
  ok(env.booted === 0, "4: wrong password does NOT boot");
  ok(env.overlay && env.overlay._removed !== true, "4: screen stays up on wrong password");
  ok(/Wrong password/.test(env.overlay._reg["#dfcapJoinErr"].textContent), "4: error message shown");
  ok(!env._cookies["dfcap_auth"], "4: no credential stored on failure");
  env.joinOk = true;                       // host confirms the password now matches
  await submitCard("Urist", "hunter2"); await p;
  ok(env.booted === 1, "4: booted after correcting the password");
}

// ---- 5. empty password -> client-side reject, no /join call, no boot -------------------------
{
  const J = resetEnv({ version: { authRequired: true, build: "0x538dea9c-aaaaaaaaa" }, name: "Urist", joinOk: true });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  J.gate(startFn); await tick();
  await submitCard("Urist", "");
  ok(env.joinCalls.length === 0, "5: empty password never hits /join");
  ok(env.booted === 0, "5: empty password does not boot");
}

// ---- 6. auth + valid cookie + name -> seamless boot, NO screen (reconnect-after-restart) ------
{
  const J = resetEnv({ version: { authRequired: true, build: "0x538dea9c-aaaaaaaaa" },
                       name: "Urist", cookie: encodeURIComponent("hunter2") });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  await J.gate(startFn); await tick();
  ok(env.overlay === null, "6: no screen for a returning session that holds a valid credential cookie");
  ok(env.booted === 1, "6: seamless boot");
  ok(window.DwfAuth.token() === "hunter2", "6: credential adopted from cookie for the WS hello");
}

// ---- 7. version mismatch (stale tab) -> blocking banner shown --------------------------------
{
  const J = resetEnv({ version: { authRequired: false, build: "0x538dea9c-bbbbbbbbb" }, name: "Urist" });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";  // client baked an OLDER commit
  await J.gate(startFn); await tick();
  ok(env.banner && env.banner.className === "hard", "7: hard stale-tab banner shown on build mismatch");
  ok(env.booted === 1, "7: app still boots (banner overlays)");
}

// ---- 8. no-empty-name join: Join disabled until a name is typed; empty submit never boots ------
{
  const J = resetEnv({ version: { authRequired: false, build: "0x538dea9c-aaaaaaaaa" } });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  J.gate(startFn); await tick();
  const ov = env.overlay;
  ok(ov, "8: name screen shown for a passwordless first visit");
  ok(ov._reg["#dfcapJoinBtn"].disabled === true, "8: Join is DISABLED while the name is empty");
  await submitCard("   ", null);   // whitespace-only -> trims to empty
  ok(env.booted === 0, "8: whitespace-only name does not boot");
  ok(/enter a name/i.test(ov._reg["#dfcapJoinErr"].textContent), "8: empty-name error shown");
  await submitCard("Cog", null);
  ok(env.booted === 1, "8: boot proceeds once a real name is entered");
  ok(env._store["dwf.player"] === "Cog", "8: the chosen name is what gets persisted");
}

// ---- 9. SEEDED-BAD REGRESSION: dwf-tiles.js must NOT persist its player fallback ---------------
// The silent-UUID-auto-join root cause: dwf-tiles.js loads BEFORE the join gate and used to
// `localStorage.setItem("dwf.player", player)` at load. On a passwordless first visit that wrote the
// in-memory UUID fallback, so gate() then read a "stored name" and booted with ZERO prompt. This
// pins that dwf-tiles.js leaves localStorage["dwf.player"] untouched, THEN feeds the resulting store
// into the real gate to prove the card is shown. Restore that setItem and BOTH halves fail.
{
  const TILES_SRC = fs.readFileSync(path.resolve(__dirname, "../../web/js/dwf-tiles.js"), "utf8");
  const lsMap = {};
  const sandbox = {};
  sandbox.window = sandbox; sandbox.self = sandbox;
  sandbox.location = { search: "", protocol: "http:", host: "localhost:8765" };
  sandbox.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
    createElement() { return { style: {} }; }, body: { appendChild() {} } };
  sandbox.addEventListener = () => {};
  sandbox.sessionStorage = { getItem: () => null, setItem() {} };
  sandbox.localStorage = { getItem: k => (k in lsMap ? lsMap[k] : null),
    setItem: (k, v) => { lsMap[k] = String(v); }, removeItem: k => { delete lsMap[k]; } };
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.crypto = { randomUUID: () => "11111111-2222-3333-4444-555555555555" };
  sandbox.requestAnimationFrame = () => 0; sandbox.cancelAnimationFrame = () => {};
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  sandbox.console = console;
  sandbox.Image = class { constructor() { this.onload = null; this.onerror = null; } set src(_v) {} get src() { return ""; } };
  sandbox.fetch = async () => ({ ok: false, json: async () => null });
  vm.createContext(sandbox);
  vm.runInContext(TILES_SRC, sandbox, { filename: "dwf-tiles.js" });
  ok(!("dwf.player" in lsMap),
     "9: dwf-tiles.js did NOT persist a name on a passwordless first visit (no UUID poisoning of the gate)");

  // The gate reads that same store -> the join card MUST appear rather than a silent auto-join.
  const J = resetEnv({ version: { authRequired: false, build: "0x538dea9c-aaaaaaaaa" } });
  if ("dwf.player" in lsMap) env._store["dwf.player"] = lsMap["dwf.player"];  // would be the UUID if the bug returned
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  J.gate(startFn); await tick();
  ok(env.overlay && env.booted === 0,
     "9: with tiles.js not poisoning storage, the gate shows the name card instead of silently auto-joining");
}

// ---- TEST-THE-TEST: a valid password wrongly marked failing must make an assertion FAIL -------
{
  const J = resetEnv({ version: { authRequired: true, build: "0x538dea9c-aaaaaaaaa" }, name: "Urist", joinOk: true });
  window.DFCAPTURE_BUILD = "0x538dea9c-aaaaaaaaa";
  const p = J.gate(startFn); await tick();
  await submitCard("Urist", "hunter2"); await p;
  let sawFailure = false;
  try { assert.ok(env.booted === 0, "seeded-wrong: correct password should NOT boot"); }
  catch (_) { sawFailure = true; }
  ok(sawFailure, "TEST-THE-TEST FAILED: suite accepted a correct password as a non-boot");
}

// ---- W5: DWFUI adoption, asserted on the EMITTED markup + the LIVE banner --------------------
{
  const J0 = resetEnv({ name: "Urist", version: { build: "0xaaaa-bbbb", authRequired: false } });
  const card = J0.storyMarkup({ needPass: true, prefillName: "Urist" });
  // Every <button> in the card must be BUILDER-EMITTED (a plaque), not hand-written. A builder's own
  // <button> is the point; a hand-rolled one is the defect.
  const buttons = card.match(/<button[^>]*>/g) || [];
  ok(buttons.length === 1 && /dwfui-plaque/.test(buttons[0]),
     "W5: the join card's ONLY button is a DWFUI plaque -- no hand-built control survives");
  ok(/class="dwfui-plaque[^"]*dfcj-join"/.test(card) && /data-dfcj-join/.test(card),
     "W5: Join renders through plaqueBtnHtml and keeps an addressable wire");
  ok(/id="dfcapJoinBtn"/.test(card),
     "W5: ...and the pinned id=\"dfcapJoinBtn\" hook (tools/ui-lab/stories.js) is PRESERVED");
  ok(/<input[^>]*id="dfcapJoinName"/.test(card) && /<input[^>]*id="dfcapJoinPass"/.test(card),
     "W5: the name/password fields stay real DOM <input>s (the deliberate editable-input exception)");

  // THE LIVE BANNER, not the story. showBanner() used to hand-build a different banner than
  // versionBannerMarkup(); they are ONE definition now, so this drives the real mounted node.
  const J1 = resetEnv({ name: "Urist", version: { build: "0xaaaa-bbbb", authRequired: false } });
  J1.checkVersion("0xcccc-dddd", "");
  ok(env.banner && env.banner.className === "hard", "W5: the LIVE hard banner still mounts");
  ok(/dwfui-plaque/.test(env.banner.innerHTML || ""),
     "W5: the LIVE banner's actions are DWFUI plaques -- showBanner() consumes versionBannerMarkup()");
  ok(!/<button[^>]*>Refresh now<\/button>/.test(env.banner.innerHTML || ""),
     "W5: ...no hand-built raw button survives in the live banner (counterexample)");
  bannerClick(env.banner, "refresh");
  ok(env.reloaded === 1, "W5: the LIVE banner's Refresh plaque still reloads the tab (wire preserved)");

  const softMarkup = J1.versionBannerMarkup({ level: "soft", reason: "assets" });
  ok(/data-dfcj-act="dismiss"/.test(softMarkup),
     "W5: the soft banner keeps its Dismiss action (a wired capability, not deleted)");

  ok(/DWFUI\.require\("join"/.test(SRC), "W5: the module DECLARES its DWFUI dependencies");
  const styleHex = (/var css =([\s\S]*?);\n\s*var st =/.exec(SRC) || ["", ""])[1]
    .match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g) || [];
  ok(styleHex.length === 0,
     `W5 R1: the injected style block states ZERO colour hex literals (found ${styleHex.length})`);
}

console.log(`join_auth_test: OK (${passed} assertions)`);
