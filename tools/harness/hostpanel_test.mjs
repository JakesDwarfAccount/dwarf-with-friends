// hostpanel_test.mjs -- HOST SETTINGS panel, client half (web/js/dwf-hostpanel.js).
//
// Drives the REAL module through a minimal mocked DOM + fetch + DwfWS so the host-gating,
// the pause/autopause toggle round-trips, the join-password set/off flow, the route-absent (404)
// graceful fallback, and the empty-password guard are exercised end-to-end (not reimplemented).
//
// The SERVER-side loopback refusal of POST /join-password (403) is C++ (compile-verified +
// window-#12 live cell) -- this file is the client + shared-matrix half.
//
// Matrix covered here ({host, non-host} x control x {route present, absent}):
//   * non-host: open() no-ops, attachEscMenu injects NO row      (test-the-test: host DOES)
//   * host: entry row appears, opens the panel
//   * hostUnpauseOnly toggle -> GET /pause-config?hostunpause=on|off, state reconciles
//   * autopause toggle       -> GET /pause-config?autopause=on|off
//   * join password set      -> POST /join-password password=...  (route present -> ok)
//   * join password empty    -> rejected client-side, NO POST issued
//   * join password off      -> POST /join-password off=1
//   * join route ABSENT (404) -> joinRouteMissing fallback text rendered, no throw
//   * connected players from /diag rendered into the table
//
// Run: node tools/harness/hostpanel_test.mjs

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { parsePassword, PASSWORD_FILE } from "../../host/hostlib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(__dirname, "../../web/js/dwf-hostpanel.js");
const SRC = fs.readFileSync(SRC_PATH, "utf8");
const require = createRequire(import.meta.url);
const DWFUI = require(path.resolve(__dirname, "../../web/js/dwf-ui-components.js"));

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// ---- DOM mock ---------------------------------------------------------------------------------
// Elements track children + handlers. The innerHTML setter parses the module's own markup into a
// small selector registry so querySelector/All return real, clickable stubs (the module authors
// the markup, so a tight regex parse is faithful, not a general HTML parser).
function parseInnerHtml(el, html) {
  el._reg = {};
  const add = (sel, node) => { (el._reg[sel] = el._reg[sel] || []).push(node); };
  const mkNode = extra => Object.assign({
    _handlers: {}, dataset: {}, value: "", textContent: "", className: "", disabled: false,
    style: {}, addEventListener(t, fn) { this._handlers[t] = fn; },
    fire(t) { if (this._handlers[t]) this._handlers[t]({ preventDefault() {}, stopPropagation() {} }); },
  }, extra || {});
  // data-hp-toggle="X"
  for (const m of html.matchAll(/data-hp-toggle="([^"]+)"/g)) {
    const node = mkNode({ dataset: { hpToggle: m[1] } });
    add("[data-hp-toggle]", node); el._reg['[data-hp-toggle=' + m[1] + ']'] = [node];
  }
  // data-hp-act="X"
  for (const m of html.matchAll(/data-hp-act="([^"]+)"/g)) {
    const node = mkNode({ dataset: { hpAct: m[1] } });
    add("[data-hp-act]", node); el._reg['[data-hp-act=' + m[1] + ']'] = [node];
  }
  // #hpPw input + #hpPwMsg
  if (/id="hpPw"/.test(html)) el._reg["#hpPw"] = [mkNode({})];
  if (/id="hpPwMsg"/.test(html)) el._reg["#hpPwMsg"] = [mkNode({})];
  // WAVE-5: data-esc-row="X" -- the Esc-menu row attachEscMenu() injects. It is no longer built with
  // createElement: the module now asks DwfEscMenu.rowHtml() (-> DWFUI.plaqueBtnHtml) for the
  // native plaque markup and lifts the node off a scratch div via `firstElementChild`. The mock has
  // to model that, so the FIRST element of any parsed fragment becomes a real, clickable stub.
  for (const m of html.matchAll(/data-esc-row="([^"]+)"/g)) {
    const node = mkNode({ dataset: { escRow: m[1] } });
    add("[data-esc-row]", node); el._reg['[data-esc-row="' + m[1] + '"]'] = [node];
    (el._nodes = el._nodes || []).push(node);
  }
  const first = /<([a-zA-Z][\w-]*)\b([^>]*)>/.exec(html);
  if (first && !(el._nodes || []).length) {
    const attrs = first[2] || "";
    const dataset = {};
    for (const a of attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g))
      dataset[a[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[2];
    const clsM = /class="([^"]*)"/.exec(attrs);
    el._nodes = [mkNode({ dataset, className: clsM ? clsM[1] : "", tag: first[1] })];
  }
  el._rawHtml = html;
}

let gById = {};   // shared id registry: any appended element with an id becomes findable
function makeEl(tag) {
  const el = {
    tag, id: "", className: "", textContent: "", value: "", disabled: false,
    style: {}, dataset: {}, children: [], _handlers: {}, _attrs: {}, _reg: {}, _rawHtml: "",
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }, toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
    },
    set innerHTML(v) { parseInnerHtml(this, String(v)); },
    get innerHTML() { return this._rawHtml; },
    // WAVE-5: the module lifts DWFUI-built markup off a scratch <div> with firstElementChild.
    get firstElementChild() { return (this._nodes && this._nodes[0]) || this.children[0] || null; },
    appendChild(c) { this.children.push(c); if (c && c.id) gById[c.id] = c; return c; },
    insertBefore(c, ref) { this.children.push(c); if (c && c.id) gById[c.id] = c; return c; },
    addEventListener(t, fn) { this._handlers[t] = fn; },
    removeEventListener() {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] || null; },
    focus() {}, select() {},
    querySelector(sel) { const a = this._reg[sel]; return a ? a[0] : null; },
    querySelectorAll(sel) { return this._reg[sel] || []; },
    fire(t, ev) { if (this._handlers[t]) this._handlers[t](ev || { preventDefault() {}, stopPropagation() {} }); },
  };
  return el;
}

let env;
function resetEnv(opts) {
  opts = opts || {};
  gById = {};
  const byId = gById;
  const document = {
    _byId: byId,
    getElementById(id) { return byId[id] || null; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    head: makeEl("head"),
    documentElement: makeEl("html"),
    body: makeEl("body"),
  };

  const fetchCalls = [];
  function fetchMock(url, init) {
    fetchCalls.push({ url, init: init || {} });
    const method = (init && init.method) || "GET";
    let status = 200, body = "{}";
    if (url === "/pause-config" || url.startsWith("/pause-config?")) {
      // reflect the toggle into returned state
      const cfg = Object.assign({ hostUnpauseOnly: false, autopause: true, paused: false, by: "host" }, env.pauseState);
      const u = new URL("http://x" + (url.startsWith("/") ? url : "/" + url));
      if (u.searchParams.has("hostunpause")) cfg.hostUnpauseOnly = u.searchParams.get("hostunpause") === "on";
      if (u.searchParams.has("autopause")) cfg.autopause = u.searchParams.get("autopause") === "on";
      env.pauseState = cfg;
      body = JSON.stringify(cfg);
    } else if (url === "/diag") {
      body = JSON.stringify({ players: env.players || [] });
    } else if (url === "/version") {
      body = JSON.stringify({ build: "0xdeadbeef-testgit", authRequired: !!env.authRequired });
    } else if (url === "/sound-info") {
      if (env.soundInfo === undefined) { status = 404; body = "not found"; }
      else body = JSON.stringify(env.soundInfo);
    } else if (url === "/join-password") {
      if (env.joinRoutePresent === false) { status = 404; body = "not found"; }
      else if (env.joinForbidden) { status = 403; body = JSON.stringify({ ok: false, err: "host only" }); }
      else { status = 200; env.authRequired = !/(^|&)off=1(&|$)/.test((init && init.body) || ""); body = JSON.stringify({ ok: true, authRequired: env.authRequired }); }
    }
    return Promise.resolve({
      ok: status >= 200 && status < 300, status,
      text: () => Promise.resolve(body),
    });
  }

  const windowObj = {
    DWFUI,
    DwfWS: { isHost: () => !!opts.host },
    DFCAPTURE_BUILD: "0xbaked-stamp",
    player: opts.player || "hostplayer",
    confirm: () => (env.confirmAnswer !== undefined ? env.confirmAnswer : true),
    addEventListener() {},
  };

  env = {
    document, window: windowObj, fetch: fetchMock, fetchCalls,
    pauseState: null, players: opts.players || [], authRequired: !!opts.authRequired,
    soundInfo: opts.soundInfo, joinRoutePresent: opts.joinRoutePresent, joinForbidden: opts.joinForbidden,
    confirmAnswer: undefined,
  };

  const sandbox = {
    window: windowObj, document, fetch: fetchMock, console,
    URL, encodeURIComponent, setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => { fn && fn(); return 0; },
    requestAnimationFrame: (fn) => { fn && fn(); return 0; },
    Promise, Array, Math, JSON, String, Number, Boolean, Object,
  };
  windowObj.window = windowObj;
  // In a browser `window.X = ...` also publishes X as a bare global; the module reads bare
  // `DwfWS`. Mirror that so the vm sandbox matches real browser scoping.
  sandbox.DwfWS = windowObj.DwfWS;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  sandbox.fetchCalls = fetchCalls;
  return { sandbox, HP: windowObj.DwfHostPanel };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// ---- 1. non-host: open() no-ops --------------------------------------------------------------
{
  const { sandbox, HP } = resetEnv({ host: false });
  HP.open();
  ok(!HP.isOpen(), "non-host open() must not open the panel");
  ok(!sandbox.document._byId["hostPanelBackdrop"] || !sandbox.document._byId["hostPanelBackdrop"].classList.contains("open"),
     "non-host: backdrop never opened");
  ok(sandbox.fetchCalls.length === 0, "non-host: no host routes fetched");
}

// ---- 2. attachEscMenu gate (test-the-test: host DOES, non-host does NOT) ----------------------
function buildEscEl(sandbox) {
  const el = sandbox.document.createElement("div");
  const rows = sandbox.document.createElement("div");
  rows._reg = {};
  rows.querySelector = sel => (sel === ".esc-rows" ? null : (rows._reg[sel] ? rows._reg[sel][0] : null));
  rows.querySelectorAll = () => [];
  const settings = sandbox.document.createElement("button");
  settings.dataset.escRow = "settings";
  rows._reg['[data-esc-row="settings"]'] = [settings];
  rows.insertBefore = (c) => {
    rows.children.push(c);
    if (c.dataset && c.dataset.escRow) rows._reg['[data-esc-row="' + c.dataset.escRow + '"]'] = [c];
    return c;
  };
  el._reg = { ".esc-rows": [rows] };
  el.querySelector = sel => (el._reg[sel] ? el._reg[sel][0] : null);
  el._rows = rows;
  return el;
}
{
  const nonHost = resetEnv({ host: false });
  const escN = buildEscEl(nonHost.sandbox);
  nonHost.HP.attachEscMenu(escN);
  ok(!escN._rows.children.some(c => c.dataset && c.dataset.escRow === "host-settings"),
     "non-host: attachEscMenu injects NO Host settings row");

  const host = resetEnv({ host: true });
  const escH = buildEscEl(host.sandbox);
  host.HP.attachEscMenu(escH);
  const row = escH._rows.children.find(c => c.dataset && c.dataset.escRow === "host-settings");
  ok(!!row, "host: attachEscMenu injects exactly one Host settings row");
  // idempotent: second call adds no duplicate
  escH._rows._reg['[data-esc-row="host-settings"]'] = [row];
  host.HP.attachEscMenu(escH);
  ok(escH._rows.children.filter(c => c.dataset && c.dataset.escRow === "host-settings").length === 1,
     "host: attachEscMenu is idempotent (no duplicate row)");
  // clicking the row opens the panel
  host.sandbox.window.closeEscMenu = () => { host._closed = true; };
  row.fire("click");
  ok(host.HP.isOpen(), "host: clicking the Host settings row opens the panel");
}

// ---- 3. host open renders sections + loads players/version -----------------------------------
{
  const { sandbox, HP } = await (async () => {
    const e = resetEnv({ host: true, players: [{ player: "guest", connections: 2, rttMs: 34, lastInboundAgeMs: 900 }], authRequired: true });
    e.HP.open();
    await tick(); await tick();
    return e;
  })();
  ok(HP.isOpen(), "host open() opens the panel");
  const panel = sandbox.document._byId["hostPanel"];
  ok(/Connected players/.test(panel._rawHtml), "players section rendered");
  ok(/guest/.test(panel._rawHtml), "player row rendered from /diag");
  ok(/Only the host can unpause/.test(panel._rawHtml), "pause permission toggle rendered");
  ok(/<input type="text" class="dwfui-text-input" id="hpPw"/.test(panel._rawHtml),
     "join passphrase uses DWFUI textInputHtml while preserving #hpPw");
  ok(/autocomplete="off"/.test(panel._rawHtml) && /spellcheck="false"/.test(panel._rawHtml),
     "join passphrase preserves browser editing attributes");
  ok(/0xdeadbeef-testgit/.test(panel._rawHtml), "footer shows server build stamp");
  ok(/a password is required/.test(panel._rawHtml), "join status reflects authRequired=true");
}

// ---- 4. hostUnpauseOnly + autopause toggles round-trip ---------------------------------------
{
  const e = resetEnv({ host: true });
  e.HP.open();
  await tick(); await tick();
  const panel = e.sandbox.document._byId["hostPanel"];
  const before = e.sandbox.fetchCalls.length;
  panel._reg["[data-hp-toggle=hostunpause]"][0].fire("click");
  await tick(); await tick();
  const huoCall = e.sandbox.fetchCalls.slice(before).find(c => /hostunpause=on/.test(c.url));
  ok(!!huoCall, "hostUnpauseOnly toggle issues GET /pause-config?hostunpause=on");

  const panel2 = e.sandbox.document._byId["hostPanel"];
  const before2 = e.sandbox.fetchCalls.length;
  panel2._reg["[data-hp-toggle=autopause]"][0].fire("click");
  await tick(); await tick();
  const apCall = e.sandbox.fetchCalls.slice(before2).find(c => /autopause=off/.test(c.url));
  ok(!!apCall, "autopause toggle issues GET /pause-config?autopause=off (was default on)");
}

// ---- 5. join password: set (route present) ---------------------------------------------------
{
  const e = resetEnv({ host: true, authRequired: false, joinRoutePresent: true });
  e.HP.open();
  await tick(); await tick();
  const panel = e.sandbox.document._byId["hostPanel"];
  panel._reg["#hpPw"][0].value = "hunter2";
  const before = e.sandbox.fetchCalls.length;
  panel._reg["[data-hp-act=pw-set]"][0].fire("click");
  await tick(); await tick();
  const post = e.sandbox.fetchCalls.slice(before).find(c => c.url === "/join-password" && (c.init.method === "POST"));
  ok(!!post, "set password issues POST /join-password");
  ok(/password=hunter2/.test(post.init.body), "POST body carries the new passphrase (url-encoded)");
}

// ---- 6. join password: EMPTY rejected client-side (no POST) ----------------------------------
{
  const e = resetEnv({ host: true, joinRoutePresent: true });
  e.HP.open();
  await tick(); await tick();
  const panel = e.sandbox.document._byId["hostPanel"];
  panel._reg["#hpPw"][0].value = "   ";   // whitespace only
  const before = e.sandbox.fetchCalls.length;
  panel._reg["[data-hp-act=pw-set]"][0].fire("click");
  await tick(); await tick();
  const post = e.sandbox.fetchCalls.slice(before).find(c => c.url === "/join-password");
  ok(!post, "empty/whitespace password is rejected client-side -- NO POST issued (counterexample)");
}

// ---- 7. join password: turn OFF -> POST off=1 ------------------------------------------------
{
  const e = resetEnv({ host: true, authRequired: true, joinRoutePresent: true });
  e.HP.open();
  await tick(); await tick();
  const panel = e.sandbox.document._byId["hostPanel"];
  const before = e.sandbox.fetchCalls.length;
  panel._reg["[data-hp-act=pw-off]"][0].fire("click");
  await tick(); await tick();
  const post = e.sandbox.fetchCalls.slice(before).find(c => c.url === "/join-password" && c.init.method === "POST");
  ok(!!post && /off=1/.test(post.init.body), "turn-off issues POST /join-password off=1");
}

// ---- 8. join route ABSENT (404) -> graceful fallback, no throw -------------------------------
{
  const e = resetEnv({ host: true, joinRoutePresent: false });
  e.HP.open();
  await tick(); await tick();
  const panel = e.sandbox.document._byId["hostPanel"];
  panel._reg["#hpPw"][0].value = "willfail";
  panel._reg["[data-hp-act=pw-set]"][0].fire("click");
  await tick(); await tick();
  const panel2 = e.sandbox.document._byId["hostPanel"];
  ok(/capture-join-password/.test(panel2._rawHtml), "404 route-absent -> console-command fallback shown inline");
}

// ---- 9. WAVE-5 DWFUI ADOPTION: the EMITTED markup, not the source ----------------------------
// A source-regex test is not proof (a green /DWFUI/ match once reported "0 queued" while 467
// controls bypassed the layer). Every cell below reads the markup this panel ACTUALLY RENDERS.
{
  const e = resetEnv({ host: true, authRequired: true, joinRoutePresent: true,
    players: [{ player: "urist", connections: 2, rttMs: 41, lastInboundAgeMs: 900 }] });
  e.HP.open();
  await tick(); await tick();
  const html = e.sandbox.document._byId["hostPanel"]._rawHtml;

  ok(/class="dwfui-plaque[^"]*hp-btn/.test(html),
     "join-password actions render as DWFUI plaques (plaqueBtnHtml), keeping the pinned .hp-btn class");
  ok(!/<button[^>]*class="hp-btn/.test(html),
     "no hand-built <button class=\"hp-btn\"> survives (counterexample to the plaque cell)");
  ok(/class="dwfui-plaque[^"]*hp-btn hp-danger red"|red[^"]*hp-danger|hp-danger/.test(html) &&
     /dwfui-plaque red|red[\s"]/.test(html),
     "the destructive 'turn off password' plaque carries the RED tone");

  ok(!/&times;/.test(html), "the header close is NOT a &times; glyph any more");
  ok(/data-dwfui-sprite="BUILDING_JOBS_REMOVE"/.test(html) || /data-dwfui-native-art="true"/.test(html),
     "the header close is the NATIVE close tile (artBtnHtml), not a raw <button>&times;</button>");
  ok(/data-hp-act="close"/.test(html), "...and it still carries the [data-hp-act=close] wire");

  ok(!/<table/.test(html), "the players list is no longer a raw <table>");
  ok(/class="dwfui-row[^"]*dwfui-row--table/.test(html),
     "the players list renders through rowHtml({chassis:'table'})");
  ok(/data-hp-player="urist"/.test(html), "...and each player row keeps an addressable data hook");

  ok(/class="dwfui-scroll[^"]*hp-scroll"/.test(html) && /data-dwfui-scroll-key="hostpanel"/.test(html),
     "#hostPanel's raw overflow:auto is now DWFUI.scrollHtml (native scrollbar + scroll preservation)");

  ok(/class="dwfui-switch/.test(html) && /class="dwfui-switch-track"/.test(html),
     "the pause switches paint through the SHARED .dwfui-switch-track -- the private .hp-sw pill copy is gone");
}

// R1/R4 source cells: the private palette + the pill CSS are the two things that must be ABSENT.
{
  ok(!/width:\s*34px;\s*height:\s*18px/.test(SRC),
     "R4: the verbatim 34x18 pill geometry (the switch-CSS copy) is deleted from this module");
  const styleBlock = /st\.textContent\s*=\s*`([\s\S]*?)`;/.exec(SRC);
  ok(!!styleBlock, "the injected <style> block is still found (guard against this cell going vacuous)");
  const hex = (styleBlock[1].match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g) || []);
  ok(hex.length === 0,
     `R1: the injected style block states ZERO colour hex literals (found ${hex.length}: ${hex.join(",")})`);
  ok(/--dwfui-gold/.test(styleBlock[1]), "...because it consumes the shared --dwfui-* custom properties");
  ok(/DWFUI\.require\("host-panel"/.test(SRC), "the module DECLARES its DWFUI dependencies (require)");
}

// ---- 10. LIVE host panel server (host/host_panel.mjs) -- findings 4/5/6 end-to-end ------------
// Spawns the REAL node panel against a throwaway DF root whose game port is pinned to an UNUSED
// port (39321), so a live password apply can NEVER reach a real game server on 8765 -- important on
// the owner's own machine. We drive the panel's own HTTP surface: the page renders three sections,
// the "open" default writes an EXPLICIT empty password file, and password set/change/clear all
// round-trip to disk (the file is the cold-start truth the plugin loads at init).
{
  const IS_WIN = process.platform === "win32";
  const FAKE_GAME_PORT = 39321;   // must be UNUSED -- the live /join-password apply targets it
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dwf-panel-live-"));
  const PANEL = path.resolve(__dirname, "../../host/host_panel.mjs");
  // Pin the game port BEFORE the panel boots so GAME_PORT can never default to the real 8765.
  fs.mkdirSync(path.join(tmpRoot, "dfhack-config"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "dfhack-config", "dwf-host-panel.json"),
    JSON.stringify({ port: FAKE_GAME_PORT }) + "\n");
  // Make it look enough like a DF+DFHack root that DF_ROOT resolves (checkDfhack is not gating here).
  fs.writeFileSync(path.join(tmpRoot, "Dwarf Fortress.exe"), "MZ");
  fs.mkdirSync(path.join(tmpRoot, "hack", "plugins"), { recursive: true });

  const pwFile = path.join(tmpRoot, PASSWORD_FILE);
  const readPwFile = () => (fs.existsSync(pwFile) ? parsePassword(fs.readFileSync(pwFile, "utf8")) : null);

  function httpReq(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body != null ? JSON.stringify(body) : null;
      const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
      const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers, timeout: 4000 }, (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, body: b, json: j }); });
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("panel request timeout")); });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  const child = spawn(process.execPath, [PANEL, "--df-root", tmpRoot], {
    env: { ...process.env, DWF_LINK_TIMEOUT_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let panelPort = 0;
  try {
    // Parse the panel URL off stdout (the panel prints "dwf host panel  ->  http://127.0.0.1:PORT/").
    panelPort = await new Promise((resolve, reject) => {
      let out = "";
      const to = setTimeout(() => reject(new Error("panel did not print its URL in time:\n" + out)), 8000);
      child.stdout.on("data", (c) => {
        out += c;
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) { clearTimeout(to); resolve(Number(m[1])); }
      });
      child.on("exit", (code) => { clearTimeout(to); reject(new Error("panel exited early (" + code + ")\n" + out)); });
    });
    ok(panelPort > 0, "live panel booted and printed its localhost URL");

    // The page itself: one page, the three headed sections, no tabs.
    const page = await httpReq(panelPort, "GET", "/");
    ok(/<h2>Status<\/h2>/.test(page.body) && /<h2>Friend access<\/h2>/.test(page.body) &&
       /<h2>Tunnel &amp; controls<\/h2>/.test(page.body), "GET / serves the three headed sections");
    ok(!/class="tab /.test(page.body), "served page has no tab layout survivors");

    // Finding 6: the "open" default policy wrote an EXPLICIT empty password file at startup
    // (a deliberate open door -- never a missing file we'd silently misread).
    ok(fs.existsSync(pwFile) && fs.readFileSync(pwFile, "utf8").trim() === "",
       "finding 6: fresh start wrote an EXPLICIT empty password file (open default)");
    const access0 = await httpReq(panelPort, "GET", "/api/access");
    ok(access0.json && access0.json.password === "" && access0.json.authEnabled === false,
       "GET /api/access reports the open state honestly (password '', authEnabled false)");
    ok(/^[a-z]+-[a-z]+-\d{2}$/.test(access0.json.suggestion || ""),
       "GET /api/access offers a word-word-NN suggestion for the Generate button");

    // Finding 5: set a password -> file round-trips; server is down on the fake port so it is
    // 'saved but not live' (honest note), which is exactly the cold-start contract.
    const setR = await httpReq(panelPort, "POST", "/api/access", { password: "amber-forge-12" });
    ok(setR.json && setR.json.ok === true && readPwFile() === "amber-forge-12",
       "finding 5: POST /api/access sets the password and it round-trips to disk");
    ok(setR.json.applied === false && /Saved/i.test(setR.json.note),
       "finding 5: honest note -- saved to disk, not live (game server on the fake port is down)");

    // Change it.
    const chgR = await httpReq(panelPort, "POST", "/api/access", { password: "iron-anvil-34" });
    ok(chgR.json && chgR.json.ok === true && readPwFile() === "iron-anvil-34",
       "finding 5: changing the password rewrites the file");

    // Clear it -> explicit empty file again (open door).
    const clrR = await httpReq(panelPort, "POST", "/api/access", { password: "" });
    ok(clrR.json && clrR.json.ok === true && fs.readFileSync(pwFile, "utf8").trim() === "" &&
       readPwFile() === "" && /Saved/i.test(clrR.json.note),
       "finding 5/6: clearing the password rewrites an empty (open-door) file");

    // Hosting flow starts idle (nothing launched).
    const hosting = await httpReq(panelPort, "GET", "/api/hosting");
    ok(hosting.json && hosting.json.phase === "idle", "GET /api/hosting starts in the idle phase");

    // Finding 4: stop-cf must PROVE the process is gone. GUARDED -- only when NO cloudflared is
    // running, so this can never kill a real host tunnel on the owner's machine.
    let cloudflaredRunning = false;
    if (IS_WIN) {
      try {
        const t = execFileSync("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe", "/NH", "/FO", "CSV"], { stdio: "pipe" }).toString();
        cloudflaredRunning = /cloudflared\.exe/i.test(t);
      } catch { cloudflaredRunning = true; /* be safe: if we can't tell, don't kill */ }
    }
    if (IS_WIN && !cloudflaredRunning) {
      const stop = await httpReq(panelPort, "POST", "/api/server", { action: "stop-cf", confirm: true });
      ok(stop.json && stop.json.ok === true && stop.json.stopped === true && /dead/i.test(stop.json.note),
         "finding 4: stop-cf confirms the process is gone and reports stopped:true (no tunnel was running)");
    } else {
      // Don't touch a live cloudflared; the confirmed-stop ORDERING is pinned in host_install_fixture_test.
      console.log("  SKIP - live stop-cf (a cloudflared is running or non-Windows; ordering is pinned offline)");
    }
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---- 11. terminal-exit tunnel cleanup (Ctrl+C must not orphan the spawned cloudflared) --------
// The orphaned-tunnel bug: cloudflared is spawned detached+unref'd and the panel had NO signal
// handlers, so Ctrl+C exited node and left the tunnel serving the public friend link. The fix
// wires SIGINT/SIGTERM/SIGBREAK/SIGHUP to a shutdown that pid-taskkills the tracked tunnel, then
// exits. Exercised here against the REAL host_panel.mjs module: a dummy detached node child stands
// in for cloudflared (its pid goes into the exported TUNNEL.pid), then the signal is emitted.
if (process.platform === "win32") {
  const PANEL = path.resolve(__dirname, "../../host/host_panel.mjs");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dwf-panel-sig-"));
  // Fake DF root pinned to an unused game port, so nothing touches a real install or server.
  fs.writeFileSync(path.join(tmpRoot, "Dwarf Fortress.exe"), "MZ");
  fs.mkdirSync(path.join(tmpRoot, "hack", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "dfhack-config"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "dfhack-config", "dwf-host-panel.json"), JSON.stringify({ port: 39321 }) + "\n");
  const HARNESS = path.join(tmpRoot, "sig_harness.mjs");
  fs.writeFileSync(HARNESS, `
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
process.argv.push("--df-root", process.env.DWF_FAKE_DF_ROOT);   // NEVER autodetect a real DF root
const mod = await import(pathToFileURL(process.env.DWF_PANEL_PATH).href);
const dummy = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
dummy.unref();
mod.TUNNEL.pid = dummy.pid;          // the dummy stands in for the spawned cloudflared
mod.TUNNEL.startedByPanel = true;
console.log("DUMMY_PID=" + dummy.pid);
const mode = process.env.DWF_HARNESS_MODE;
if (mode === "sigint") process.emit("SIGINT");
else if (mode === "double-sigint") { process.emit("SIGINT"); process.emit("SIGINT"); }
setTimeout(() => process.exit(99), 12000);   // mode "none" idles here until the parent kills it
`);
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async (pid) => {
    let alive = pidAlive(pid);
    for (let i = 0; alive && i < 10; i++) { await new Promise((s) => setTimeout(s, 200)); alive = pidAlive(pid); }
    return !alive;
  };
  const runHarness = (mode, { forceKillAfterMs = 0 } = {}) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [HARNESS], {
      env: { ...process.env, DWF_PANEL_PATH: PANEL, DWF_FAKE_DF_ROOT: tmpRoot, DWF_HARNESS_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", dummyPid = 0;
    c.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/DUMMY_PID=(\d+)/);
      if (m && !dummyPid) {
        dummyPid = Number(m[1]);
        if (forceKillAfterMs) setTimeout(() => c.kill(), forceKillAfterMs);
      }
    });
    const to = setTimeout(() => { c.kill(); reject(new Error("signal harness hung:\n" + out)); }, 20000);
    c.on("exit", (code) => { clearTimeout(to); resolve({ code, dummyPid, out }); });
  });
  try {
    // (a) SIGINT runs the cleanup: the panel exits 0 and the tracked tunnel pid is DEAD.
    const a = await runHarness("sigint");
    ok(a.dummyPid > 0, "sigint harness spawned a dummy tunnel process");
    const aDead = await waitDead(a.dummyPid);
    ok(a.code === 0, `SIGINT handler exits the panel cleanly (got code ${a.code})`);
    ok(aDead, "SIGINT killed the spawned tunnel pid -- no orphaned friend link");

    // (b) an impatient SECOND Ctrl+C force-exits (code 1); the sync 'exit' fallback still kills the pid.
    const b = await runHarness("double-sigint");
    const bDead = await waitDead(b.dummyPid);
    ok(b.code === 1, `second Ctrl+C force-exits with code 1 (got code ${b.code})`);
    ok(bDead, "even the force-exit path does not orphan the tracked tunnel pid");
    if (!bDead) { try { process.kill(b.dummyPid); } catch { /* cleanup */ } }

    // (c) SEEDED-BAD (test-the-test): a hard kill that BYPASSES the handlers (TerminateProcess --
    // for cleanup purposes exactly what pre-fix Ctrl+C amounted to) leaves the dummy ALIVE. This
    // proves the orphan detection in (a) is real: remove the signal handlers and (a) fails.
    const c = await runHarness("none", { forceKillAfterMs: 300 });
    ok(c.dummyPid > 0 && pidAlive(c.dummyPid),
       "seeded-bad: killing the panel WITHOUT the signal path orphans the tunnel (the bug the pin catches)");
    try { process.kill(c.dummyPid); } catch { /* cleanup */ }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
} else {
  console.log("  SKIP - terminal-exit tunnel cleanup (Windows-only taskkill path)");
}

// ---- 12. job-object backstop (the tunnel dies with the panel EVEN when node is force-killed) --
// Section 11 proves the graceful signal path. This section proves the GUARANTEED path: cloudflared
// is spawned through hostlib's powershell job wrapper (kill-on-close Win32 Job Object + panel-pid
// watch), so TerminateProcess on the panel -- exactly what cmd's "Terminate batch job (Y/N)?"
// answered Y does, and what window-X-close amounts to after the OS deadline -- still takes the
// tunnel down. No signal handler runs on this path AT ALL; the kernel does the cleanup.
// Runtime shape: a fake panel spawns a sleeper (cloudflared stand-in) through the REAL
// tunnelWrapperCommand, the test TerminateProcess-kills the fake panel, and the sleeper must die.
// SEEDED-BAD: the same fake panel using the pre-fix shape (detached direct spawn, no job) leaves
// the sleeper ALIVE after the kill -- proving the wrapped assertion detects real orphans.
if (process.platform === "win32") {
  const HOSTLIB = path.resolve(__dirname, "../../host/hostlib.mjs");
  const tmpJw = fs.mkdtempSync(path.join(os.tmpdir(), "dwf-jobwrap-"));
  const SLEEPER = path.join(tmpJw, "sleeper.mjs");
  const JW_HARNESS = path.join(tmpJw, "jobwrap_harness.mjs");
  fs.writeFileSync(SLEEPER, `
import fs from "node:fs";
fs.writeFileSync(process.env.DWF_SLEEPER_PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(JW_HARNESS, `
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const { tunnelWrapperCommand } = await import(pathToFileURL(process.env.DWF_HOSTLIB_PATH).href);
let child;
if (process.env.DWF_JOBWRAP_MODE === "detached") {
  // the PRE-FIX shape: detached, no job -- the orphaning bug itself, kept as the seeded-bad
  child = spawn(process.execPath, [process.env.DWF_SLEEPER_PATH], { detached: true, stdio: "ignore" });
} else {
  const wrap = tunnelWrapperCommand({ exe: process.execPath, args: [process.env.DWF_SLEEPER_PATH], panelPid: process.pid });
  child = spawn(wrap.file, wrap.args, { env: { ...process.env, ...wrap.env }, stdio: "ignore", windowsHide: true });
}
child.unref();
setInterval(() => {}, 1000);   // idle until the test TerminateProcess-kills us (the Ctrl+C-then-Y stand-in)
`);
  const jwAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const jwSleep = (ms) => new Promise((s) => setTimeout(s, ms));
  const jwWaitDead = async (pid, tries = 40) => {   // wrapper polls every 300ms; allow ~8s
    let alive = jwAlive(pid);
    for (let i = 0; alive && i < tries; i++) { await jwSleep(200); alive = jwAlive(pid); }
    return !alive;
  };
  const runJobwrap = async (mode) => {
    const pidFile = path.join(tmpJw, mode + ".pid");
    let err = "";
    const c = spawn(process.execPath, [JW_HARNESS], {
      env: { ...process.env, DWF_HOSTLIB_PATH: HOSTLIB, DWF_SLEEPER_PATH: SLEEPER,
             DWF_SLEEPER_PID_FILE: pidFile, DWF_JOBWRAP_MODE: mode },
      stdio: ["ignore", "ignore", "pipe"],
    });
    c.stderr.on("data", (d) => (err += d));
    let sleeperPid = 0;   // Add-Type compiles C# on first use; give the pid file up to 20s
    for (let i = 0; i < 100 && !sleeperPid; i++) {
      await jwSleep(200);
      try { sleeperPid = Number(fs.readFileSync(pidFile, "utf8").trim()) || 0; } catch { /* not yet */ }
      if (c.exitCode !== null && !sleeperPid) break;
    }
    if (!sleeperPid) { try { c.kill(); } catch { /* gone */ } throw new Error(`jobwrap ${mode}: sleeper never started\n` + err); }
    c.kill();   // TerminateProcess: no signal handler runs -- the Y-force-kill / window-X scenario
    return sleeperPid;
  };
  try {
    const wrappedPid = await runJobwrap("wrapped");
    ok(await jwWaitDead(wrappedPid),
       "job backstop: TerminateProcess on the panel still kills the wrapped tunnel (kernel kill-on-job-close, no handler ran)");
    const detachedPid = await runJobwrap("detached");
    await jwSleep(1500);   // give an (incorrect) cleanup every chance to fire -- none exists
    ok(jwAlive(detachedPid),
       "seeded-bad: the pre-fix detached-without-job spawn ORPHANS the tunnel when the panel is force-killed");
    try { process.kill(detachedPid); } catch { /* cleanup */ }
  } finally {
    try { fs.rmSync(tmpJw, { recursive: true, force: true }); } catch { /* best effort */ }
  }
} else {
  console.log("  SKIP - job-object backstop (Windows-only powershell job wrapper)");
}

console.log(`hostpanel_test: ${passed} assertions passed`);
