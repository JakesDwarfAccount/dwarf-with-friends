// audio_client_test.mjs -- runtime test for the BROWSER half of web/js/dwf-audio.js
// (spec 2026-07-09-audio-director-spec.md: the AUDIO DIRECTOR). Drives the REAL module through a
// minimal mocked window/document/AudioContext/Audio/fetch/localStorage/performance -- the
// director state machine runs under a FAKE CLOCK, so the sync/gap/stall behavior is exercised
// deterministically, not reimplemented.
//
// Regression cells map to the measured live failures (spec §1):
//   S1 broken-record: frozen env.elapsedMs must produce ZERO seeks (was 3 rewinds / 15 s stall).
//   S2 wrap-straddle: element at 119.9 s vs server phase 0.1 s must NOT seek (old raw-diff did).
//   S3 tight threshold: steady fresh frames with sub-tolerance jitter -> ZERO playing seeks.
//   M2 all-at-once:    audible ambience never exceeds 1 bed + 1 feature + 1 weather.
//
//   node tools/harness/audio_client_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DWFUI = require(path.resolve(here, "../../web/js/dwf-ui-components.js"));
const SRC = fs.readFileSync(path.resolve(here, "../../web/js/dwf-audio.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(cond, name) { ok(cond, "(test-the-test) " + name); }

// ---- fake Web Audio + media --------------------------------------------------------------
function fakeParam() {
  return { value: 1, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} };
}
function fakeGain() { return { gain: fakeParam(), connect() {} }; }
class FakeCtx {
  constructor() { this.state = "suspended"; this.currentTime = 0; this.destination = {}; this.resumed = 0; }
  createGain() { return fakeGain(); }
  createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
  createMediaElementSource() { return { connect() {} }; }
  createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  decodeAudioData(_buf, done) { done({}); }
  resume() { this.state = "running"; this.resumed++; return Promise.resolve(); }
}
class FakeAudio {
  constructor() {
    this.paused = true; this._src = ""; this.loop = false; this.preload = ""; this.crossOrigin = "";
    this.duration = FakeAudio.duration; this._ct = 0; this._h = {};
    this.readyState = 4; this.ended = false; this.networkState = 1;
    FakeAudio.instances.push(this);
  }
  play() {
    if (FakeAudio.blocked) { this.paused = true; return Promise.reject(new Error("autoplay blocked")); }
    this.paused = false; this.ended = false; return Promise.resolve();
  }
  pause() { this.paused = true; }
  addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); }
  fire(t) { (this._h[t] || []).forEach(fn => { try { fn(); } catch (_) {} }); }
  get currentTime() { return this._ct; }
  set currentTime(v) { FakeAudio.seeks.push({ el: this._src, from: this._ct, to: v, paused: this.paused }); this._ct = v; }
  set src(v) { this._src = v; this._ct = 0; if (v) this.fire("loadedmetadata"); }
  get src() { return this._src || ""; }
}
FakeAudio.blocked = false;    // simulate the browser autoplay policy per-test
FakeAudio.duration = 120;     // seconds, applied to newly created elements
FakeAudio.seeks = [];         // every currentTime assignment, module-wide
FakeAudio.instances = [];

// ---- fake DOM ----------------------------------------------------------------------------
function makeEl(tag) {
  const reg = {};
  const el = {
    tag, id: "", className: "", title: "", textContent: "", value: "", checked: false,
    _innerHTML: "", style: {}, _handlers: {}, children: [], _attrs: {},
    classList: { _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); } },
    set innerHTML(v) { this._innerHTML = v; }, get innerHTML() { return this._innerHTML; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] || null; },
    closest() { return null; },
    // querySelector returns a stable stub per selector so refreshPopover reads back what handlers set.
    querySelector(sel) { return reg[sel] || (reg[sel] = makeEl("stub")); },
    querySelectorAll() { return []; },
    remove() {},
    focus() {}, select() {},
    fire(type, ev) { (this._handlers[type] || []).forEach(fn => fn(ev || {})); },
  };
  return el;
}

// WAVE-5 (DWFUI adoption). The mute/UI-clicks toggles are now NATIVE CHECK TILES (DWFUI.checkHtml),
// the track picker is the NATIVE CYCLER (DWFUI.cyclerHtml -- native DF has no <select> in any of the
// 33 captures) and Play/Auto are NATIVE PLAQUES. Those controls are re-rendered in place, so the
// module wires them by DELEGATION on the popover and reads `event.target.closest("[data-audio-*]")`.
// This builds a click target the module's real handler resolves exactly as the browser would --
// the harness drives the SAME code path the player does, not a parallel one.
function clickTarget(dataset) {
  const el = makeEl("button");
  el.dataset = dataset;
  el.closest = sel => {
    const attr = /\[data-([a-z-]+)/.exec(sel);
    if (!attr) return null;
    const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (dataset[key] === undefined) return null;
    const want = /="([^"]+)"/.exec(sel);
    if (want && dataset[key] !== want[1]) return null;
    return el;
  };
  return el;
}
const clickPop = (pop, dataset) => pop.fire("click", { target: clickTarget(dataset) });
function makeDoc(store) {
  const byId = {};
  const docHandlers = {};
  const doc = {
    readyState: "complete",
    createElement(tag) { return makeEl(tag); },
    getElementById(id) { return byId[id] || null; },
    querySelector() { return null; },   // no pre-existing topbar -> module uses floating button
    head: { appendChild(el) { if (el.id) byId[el.id] = el; } },
    documentElement: { appendChild() {} },
    body: { appendChild(el) { if (el.id) byId[el.id] = el; return el; } },
    addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (docHandlers[t]) docHandlers[t] = docHandlers[t].filter(f => f !== fn); },
    _fire(type, ev) { (docHandlers[type] || []).slice().forEach(fn => fn(ev || {})); },
    _byId: byId,
  };
  return doc;
}

// ---- environment builder -----------------------------------------------------------------
function boot(opts) {
  opts = opts || {};
  const store = {};
  if (opts.store) Object.assign(store, opts.store);
  const fetchLog = [];
  const intervals = [];
  const timeouts = [];
  FakeAudio.blocked = false;
  FakeAudio.duration = opts.duration || 120;
  FakeAudio.seeks = [];
  FakeAudio.instances = [];

  const g = {};
  g.window = g;
  g.DWFUI = DWFUI;
  g.location = { search: opts.search || "" };
  g.document = makeDoc(store);
  g.localStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  g.AudioContext = FakeCtx;
  g.Audio = FakeAudio;
  g.URLSearchParams = URLSearchParams;
  g.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  g.clearInterval = () => {};
  g.setTimeout = (fn) => { timeouts.push(fn); return timeouts.length; };   // manual flush
  g.requestAnimationFrame = () => 0;
  // FAKE CLOCK: the director reads performance.now(); tests advance it explicitly.
  let fakeNow = 100000;
  g.performance = { now: () => fakeNow };
  g.Date = Date;
  g.DwfTiles = { getLatest: () => opts.latest || null };
  if (opts.pause) g.DwfPause = opts.pause;
  g.fetch = (url) => {
    fetchLog.push(String(url));
    const u = String(url);
    if (u.indexOf("/sound-info") === 0) {
      if (opts.probe === "old") return Promise.resolve({ ok: false, status: 404 });
      if (opts.probe === "auth") return Promise.resolve({ ok: false, status: 401 });  // join gate pending
      return Promise.resolve({ ok: true, json: async () => ({
        audio: true, allowed: opts.probe !== "denied", remote: false, loopback: opts.probe !== "denied" }) });
    }
    if (u.indexOf("/reports") === 0) {
      const page = opts.reports ? opts.reports.shift() : null;
      return Promise.resolve({ ok: true, json: async () => (page || { nextReportId: 1, reports: [] }) });
    }
    if (u.indexOf("/sound/") === 0) {
      if (opts.missing && u.indexOf(opts.missing) >= 0) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(16) });
    }
    if (u.indexOf("/music") === 0) return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    return Promise.resolve({ ok: false, status: 404 });
  };

  const ctx = vm.createContext(g);
  vm.runInContext(SRC, ctx, { filename: "dwf-audio.js" });
  const env = { g, store, fetchLog, intervals, timeouts, opts, api: g.DwfAudio };
  env.clock = {
    advance(ms) { fakeNow += ms; },
    now() { return fakeNow; },
  };
  // helpers: intervals[0] = /reports poll (2 s), intervals[1] = director tick (1 s)
  env.pollTick = () => intervals[0] && intervals[0]();
  env.tick = (ms) => { if (ms) fakeNow += ms; if (intervals[1]) intervals[1](); };
  // element playback simulation: move a playing element's clock with the fake clock
  env.playMusic = (ms) => {
    const m = env.api._state.music;
    if (m && !m.paused) m._ct = m._ct + ms / 1000;
  };
  return env;
}
const tick = () => new Promise(r => setImmediate(r));

// convenience: booted + probed + unlocked + playing the given canonical music
async function bootPlaying(musicObj, opts) {
  const lt = { env: { music: musicObj } };
  const e = boot(Object.assign({ probe: "loopback", latest: lt }, opts || {}));
  await tick(); await tick();
  e.g.document._fire("pointerdown", { target: {} });   // unlock -> envTick
  await tick();
  e.latest = lt;
  return e;
}

// ============================================================================================
(async function run() {
  // pull the director constants off the pure export for tolerance-aware cells
  const C = (() => {
    const g = { window: {}, module: { exports: {} } };
    g.module.exports = {};
    const ctx = vm.createContext({ module: g.module, exports: g.module.exports });
    vm.runInContext(SRC, ctx, { filename: "dwf-audio.js" });
    return g.module.exports.DIRECTOR_CONST;
  })();
  guard(C && C.GAP_MS > 0 && C.DRIFT_TOLERANCE_MS > 3000, "director constants readable + tolerance is tens of seconds");

  // ---- 1. dormant vs OLD DLL (no /sound route) -----------------------------------------------
  {
    const e = boot({ probe: "old" });
    await tick(); await tick();
    ok(e.api && typeof e.api.init === "function", "1: module exposes DwfAudio");
    ok(e.api._state.probed === true && e.api._state.available === false, "1: probe marks host dormant (no route)");
    ok(e.intervals.length === 0, "1: dormant -> no report/tick polling started");
    ok(!e.fetchLog.some(u => u.indexOf("/sound/") === 0), "1: dormant -> never fetches audio bytes");
  }

  // ---- 2. available + loopback allowed -> polling armed --------------------------------------
  {
    const e = boot({ probe: "loopback" });
    await tick(); await tick();
    ok(e.api._state.available === true && e.api._state.allowed === true, "2: loopback peer allowed");
    ok(e.intervals.length >= 2, "2: report poll + director tick armed", `got ${e.intervals.length}`);
    ok(e.fetchLog.some(u => u.indexOf("/reports") === 0), "2: seeds the /reports cursor on boot");
  }

  // ---- 3. autoplay unlock: suspended until a user gesture ------------------------------------
  {
    const e = boot({ probe: "loopback" });
    await tick();
    ok(e.api._state.unlocked === false, "3: starts locked (autoplay policy)");
    e.g.document._fire("pointerdown", { target: {} });
    await tick();
    ok(e.api._state.unlocked === true, "3: a user gesture unlocks");
    ok(e.api._state.ctx && e.api._state.ctx.resumed >= 1, "3: AudioContext resumed on unlock");
  }

  // ---- 4. UI clicks default OFF; opt-in fetches a real click; denied peer synths --------------
  {
    const e = boot({ probe: "loopback" });
    e.g.document._fire("pointerdown", {}); await tick();
    ok(e.api._state.mix.uiClicks === false, "4: UI clicks default OFF (not in native DF)");
    const before = e.fetchLog.length;
    e.api.playClick("click"); await tick();
    guard(!e.fetchLog.slice(before).some(u => u.indexOf("/sound/audio/ui") === 0),
      "default-off UI clicks fetch nothing");
  }
  {
    const e = boot({ probe: "loopback" });
    e.g.document._fire("pointerdown", {}); await tick();
    e.api._state.mix.uiClicks = true;        // player opted in
    e.api.playClick("click"); await tick();
    ok(e.fetchLog.some(u => u.indexOf("/sound/audio/ui/clicks/") === 0), "4: opted-in click fetches a real .ogg");
  }
  {
    const e = boot({ probe: "denied" });     // remote peer, audio_remote off
    e.g.document._fire("pointerdown", {}); await tick();
    e.api._state.mix.uiClicks = true;
    const before = e.fetchLog.length;
    e.api.playClick("click"); await tick();
    ok(e.api._state.available === true && e.api._state.allowed === false, "4: remote-denied state");
    guard(!e.fetchLog.slice(before).some(u => u.indexOf("/sound/") === 0),
      "denied peer NEVER fetches copyrighted bytes (synth blip instead)");
  }

  // ---- 5. stinger: onReport fires the mapped sound; non-stinger key does NOT -----------------
  {
    const e = boot({ probe: "loopback" });
    e.g.document._fire("pointerdown", {}); await tick();
    e.api.onReport({ typeKey: "MEGABEAST_ARRIVAL", continuation: false });
    await tick();
    ok(e.fetchLog.some(u => u === "/sound/sounds/megabeast.ogg"), "5: MEGABEAST_ARRIVAL -> megabeast.ogg");
    const before = e.fetchLog.length;
    e.api.onReport({ typeKey: "COMBAT", continuation: false });
    e.api.onReport({ typeKey: "MEGABEAST_ARRIVAL", continuation: true });   // continuation ignored
    await tick();
    guard(!e.fetchLog.slice(before).some(u => u.indexOf("/sound/") === 0),
      "a non-stinger key AND a continuation line fire nothing");
  }

  // ---- 5b. stinger spacing + duck (director spec §3.3) ----------------------------------------
  {
    const e = boot({ probe: "loopback" });
    e.g.document._fire("pointerdown", {}); await tick();
    e.api.onReport({ typeKey: "MEGABEAST_ARRIVAL", continuation: false });
    await tick();
    ok(e.clock.now() < e.api._state.stingerDuckUntil, "5b: stinger ducks the music channel");
    const before = e.fetchLog.length;
    e.clock.advance(1000);                                     // 1 s later -- inside the window
    e.api.onReport({ typeKey: "STRANGE_MOOD", continuation: false });
    await tick();
    ok(!e.fetchLog.slice(before).some(u => u.indexOf("/sound/sounds/") === 0),
      "5b: a second stinger 1 s later is dropped (min spacing)");
    e.clock.advance(C.STINGER_MIN_GAP_MS);                     // past the window
    e.api.onReport({ typeKey: "STRANGE_MOOD", continuation: false });
    await tick();
    ok(e.fetchLog.some(u => u === "/sound/sounds/strange_mood.ogg"), "5b: after the window it fires again");
  }

  // ---- 6. join-time catch-up suppression: first poll only SEEDS the cursor -------------------
  {
    const e = boot({ probe: "loopback", reports: [
      { nextReportId: 50, reports: [{ id: 49, typeKey: "MEGABEAST_ARRIVAL", continuation: false }] },
      { nextReportId: 51, reports: [{ id: 50, typeKey: "STRANGE_MOOD", continuation: false }] },
    ]});
    e.g.document._fire("pointerdown", {}); await tick(); await tick();
    guard(!e.fetchLog.some(u => u === "/sound/sounds/megabeast.ogg"),
      "backlog stinger on join is suppressed (cursor seeded, not replayed)");
    e.pollTick(); await tick(); await tick();
    ok(e.fetchLog.some(u => u === "/sound/sounds/strange_mood.ogg"), "6: a fresh event after join DOES play");
  }

  // ---- 7. mute persistence round-trips through localStorage ----------------------------------
  {
    const e = boot({ probe: "loopback" });
    await tick();
    const pop = e.g.document.getElementById("dfAudioPop");
    ok(!!pop, "7: audio popover built");
    clickPop(pop, { audioCheck: "mute" });
    ok(e.api._state.mix.muted === true, "7: the native mute TILE toggles state (delegated [data-audio-check])");
    ok((e.store["dwf.audio.mix"] || "").indexOf('"muted":true') >= 0, "7: mute persisted to localStorage");
    const e2 = boot({ probe: "loopback", store: { "dwf.audio.mix": e.store["dwf.audio.mix"] } });
    await tick();
    ok(e2.api._state.mix.muted === true, "7: reload restores muted mix");
  }

  // ---- 8. pause ducking wraps DwfPause.onPause without touching ws.js -------------------
  {
    let origCalls = 0;
    const pause = { onPause: () => { origCalls++; } };
    const e = boot({ probe: "loopback", pause });
    await tick();
    e.g.DwfPause.onPause({ paused: true });
    ok(origCalls === 1, "8: original pause handler still invoked");
    ok(e.api._state.ducked === true, "8: pause ducks the music channel");
    e.g.DwfPause.onPause({ paused: false });
    ok(e.api._state.ducked === false, "8: unpause un-ducks");
  }

  // ---- 9. ?audio=0 kill switch: module inert ------------------------------------------------
  {
    const e = boot({ probe: "loopback", search: "?audio=0" });
    await tick(); await tick();
    ok(e.api && e.api._state._started !== true, "9: ?audio=0 -> module never boots");
    guard(e.fetchLog.length === 0, "kill switch -> ZERO fetches (parity-safe)");
  }

  // ---- 10. missing ogg file never throws -----------------------------------------------------
  {
    const e = boot({ probe: "loopback", missing: "megabeast.ogg" });
    e.g.document._fire("pointerdown", {}); await tick();
    let threw = false;
    try { e.api.onReport({ typeKey: "MEGABEAST_ARRIVAL", continuation: false }); await tick(); await tick(); }
    catch (_) { threw = true; }
    ok(!threw, "10: a 404 on the stinger file is swallowed (no throw)");
  }

  // ---- 11. 401 (join gate pending) is NOT dormant: probe retries until authed -----------------
  {
    const e = boot({ probe: "auth" });
    await tick(); await tick();
    ok(e.api._state.probed === false, "11: 401 leaves probed UNSETTLED (not dormant)");
    ok(e.api._state.available === false && e.intervals.length === 0, "11: nothing armed while auth pending");
    ok(e.timeouts.length >= 1, "11: a re-probe is scheduled");
    e.opts.probe = "loopback";            // user typed the passphrase; cookie now valid
    e.timeouts.shift()(); await tick(); await tick();
    ok(e.api._state.available === true && e.api._state.allowed === true, "11: re-probe flips to available after join");
    ok(e.intervals.length >= 2, "11: polls armed after the successful re-probe");
    guard(e.api._state.probed === true, "the settled probe is marked probed (message logic keyed on it)");
  }

  // ---- 12. SYNCED music: the server's canonical env.music drives playback + join seek ---------
  {
    const e = await bootPlaying({ track: "winter_entombs_you", elapsedMs: 5000, manual: false });
    ok(e.api._state.music && /winter_entombs_you\/WEY_Full/.test(e.api._state.music.src),
      "12: plays the server's canonical track");
    ok(e.api._state.musicTrack === "winter_entombs_you", "12: state tracks the canonical key");
    ok(e.api._state.music.paused === false, "12: music actually playing");
    ok(Math.abs(e.api._state.music.currentTime - 5) < 0.1,
      "12: seeked to the server elapsed (late-join sync)", `ct=${e.api._state.music.currentTime}`);
    ok(e.api._state.director.mode === "play", "12: director in PLAY");
  }
  // 12b. a server track SWAP (e.g. siege) re-points the element via the two-phase fade.
  {
    const e = await bootPlaying({ track: "hill_dwarf", elapsedMs: 0, manual: false });
    ok(/hill_dwarf/.test(e.api._state.music.src), "12b: initial canonical track");
    e.latest.env.music = { track: "vile_force_of_darkness", elapsedMs: 0, manual: false };
    e.tick(1000);                                   // phase 1: fade-out starts
    ok(e.api._state.director.mode === "swap", "12b: swap begins with a fade-out");
    ok(/hill_dwarf/.test(e.api._state.music.src), "12b: src not yanked mid-fade");
    e.tick(1000);                                   // phase 2: fade landed -> swap + play
    ok(/vile_force_of_darkness\/VFOD_Full/.test(e.api._state.music.src),
      "12b: follows the server's track swap after the fade");
    ok(e.api._state.music.paused === false, "12b: new track playing");
  }
  // 12c. host-only control POSTs /music; the host waits for the canonical echo.
  {
    const e = boot({ probe: "loopback" });
    e.g.DwfWS = { isHost: () => true };
    await tick();
    const pop = e.g.document.getElementById("dfAudioPop");
    // The <select> is gone (native DF has no dropdown): the cycler steps the module-held pick.
    e.api._state.trackPick = "mountainhome";
    clickPop(pop, { audioAct: "play" });
    await tick();
    ok(e.fetchLog.some(u => u.indexOf("/music") === 0), "12c: host Play POSTs /music (server broadcasts)");
    guard(!/hill_dwarf|mountainhome/.test((e.api._state.music && e.api._state.music.src) || ""),
      "host does NOT play locally -- waits for the canonical env.music echo");
  }

  // ---- 13. muting still advances the /reports cursor (no stinger barrage on unmute) ------------
  {
    const e = boot({ probe: "loopback", reports: [
      { nextReportId: 10, reports: [] },
      { nextReportId: 20, reports: [{ id: 15, typeKey: "MEGABEAST_ARRIVAL", continuation: false }] },
      { nextReportId: 30, reports: [{ id: 25, typeKey: "STRANGE_MOOD", continuation: false }] },
    ]});
    e.g.document._fire("pointerdown", {}); await tick(); await tick();
    e.api._state.mix.muted = true;
    e.pollTick(); await tick(); await tick();
    ok(e.api._state.reportCursor === 20, "13: cursor advances during mute", `got ${e.api._state.reportCursor}`);
    guard(!e.fetchLog.some(u => u === "/sound/sounds/megabeast.ogg"),
      "muted-period event never fires (neither now nor on unmute)");
    e.api._state.mix.muted = false;
    e.pollTick(); await tick(); await tick();
    ok(e.fetchLog.some(u => u === "/sound/sounds/strange_mood.ogg"), "13: fresh post-unmute event plays");
  }

  // ============================================================================================
  // DIRECTOR CELLS (the measured live failures, spec §1)
  // ============================================================================================

  // ---- 14. NO-SEEK-WHILE-PLAYING: steady fresh frames, sub-tolerance jitter -> zero seeks (S3) --
  {
    const m = { track: "hill_dwarf", elapsedMs: 5000, manual: false };
    const e = await bootPlaying(m);
    const seeksAtStart = FakeAudio.seeks.length;
    // 60 ticks of healthy stream: elapsed tracks the clock with +-800 ms network jitter
    for (let i = 0; i < 60; i++) {
      m.elapsedMs += 1000 + (i % 3 === 0 ? 800 : -400);   // jitter, always advancing
      e.tick(1000); e.playMusic(1000);
      await tick();
    }
    ok(FakeAudio.seeks.length === seeksAtStart,
      "14: ZERO seeks over 60 s of jittery healthy stream (no-seek-while-playing invariant)",
      `seeks=${JSON.stringify(FakeAudio.seeks.slice(seeksAtStart))}`);
    ok(e.api._state.music.paused === false, "14: still playing");
  }

  // ---- 15. S1 REGRESSION (broken record): frozen elapsedMs -> ZERO seeks, playback continues ---
  {
    const m = { track: "hill_dwarf", elapsedMs: 30000, manual: false };
    const e = await bootPlaying(m);
    const seeksAtStart = FakeAudio.seeks.length;
    // aux stream stalls: 20 ticks with the SAME elapsedMs (old code rewound every 3 s tick)
    for (let i = 0; i < 20; i++) { e.tick(1000); e.playMusic(1000); await tick(); }
    ok(FakeAudio.seeks.length === seeksAtStart,
      "15: aux stall -> ZERO rewinds (was 3 rewinds/15 s live)",
      `seeks=${JSON.stringify(FakeAudio.seeks.slice(seeksAtStart))}`);
    ok(e.api._state.music.paused === false, "15: music keeps playing through the stall");
    // stream resumes CONSISTENT with the projection -> still no seek
    m.elapsedMs += 20000;
    e.tick(1000); e.playMusic(1000); await tick();
    ok(FakeAudio.seeks.length === seeksAtStart, "15: consistent resume -> still no seek");
  }

  // ---- 16. S2 REGRESSION (wrap straddle): manual loop boundary -> no seek ----------------------
  {
    // manual mode, dur 120 s (cycle = dur): element at 119.9 s, server phase 0.1 s.
    const m = { track: "mountainhome", elapsedMs: 0, manual: true };
    const e = await bootPlaying(m);
    // walk playback legitimately to just before the boundary
    for (let i = 0; i < 119; i++) { m.elapsedMs += 1000; e.tick(1000); e.playMusic(1000); await tick(); }
    ok(Math.abs(e.api._state.music.currentTime - 119) < 0.5, "16: element walked to the boundary",
      `ct=${e.api._state.music.currentTime}`);
    const seeksAtStart = FakeAudio.seeks.length;
    m.elapsedMs = 120100;                    // server crossed the loop point (phase 0.1 s)
    e.tick(900); e.playMusic(900);           // element at ~119.9 s -- the straddle
    await tick();
    ok(FakeAudio.seeks.length === seeksAtStart,
      "16: straddle window -> NO seek (old raw-diff read 119.8 s of 'drift')",
      `seeks=${JSON.stringify(FakeAudio.seeks.slice(seeksAtStart))}`);
  }

  // ---- 17. genuine desync -> exactly ONE rate-limited correction ------------------------------
  {
    const m = { track: "hill_dwarf", elapsedMs: 5000, manual: false };
    const e = await bootPlaying(m);
    const seeksAtStart = FakeAudio.seeks.length;
    // server jumps 40 s ahead (beyond DRIFT_TOLERANCE_MS = 20 s) and stays there
    for (let i = 0; i < 10; i++) {
      m.elapsedMs += (i === 0 ? 40000 : 1000);
      e.tick(1000); e.playMusic(1000); await tick();
    }
    const seeks = FakeAudio.seeks.slice(seeksAtStart);
    ok(seeks.length === 1, "17: >tolerance desync -> exactly ONE correction (rate-limited)",
      `seeks=${JSON.stringify(seeks)}`);
    // correction snapped to phase 45 s, then 10 s of playback -> ~55 s
    ok(Math.abs(e.api._state.music.currentTime - 55) < 3,
      "17: corrected onto the server phase", `ct=${e.api._state.music.currentTime}`);
  }

  // ---- 18. THE GAP: scheduled silence, pause without src churn, resume at the boundary ---------
  {
    // dur 120 s -> cycle = 120 s + GAP_MS. Put the server just past track end.
    const m = { track: "hill_dwarf", elapsedMs: 121000, manual: false };
    const e = await bootPlaying(m);
    e.tick(1000); await tick();
    ok(e.api._state.director.mode === "gap", "18: past track end -> director in GAP");
    // fade window passes -> element paused, src retained (no refetch on resume)
    const src = e.api._state.music.src;
    e.tick(2000); await tick();
    ok(e.api._state.music.paused === true, "18: gap pauses the element after the fade");
    ok(e.api._state.music.src === src, "18: src retained through the gap (buffer kept warm)");
    // walk to the cycle boundary: elapsed -> 120000 + GAP_MS + 500 (phase 0.5 s of cycle 2)
    const seeksBefore = FakeAudio.seeks.length;
    m.elapsedMs = 120000 + C.GAP_MS + 500;
    e.tick(1000); await tick();
    ok(e.api._state.director.mode === "play", "18: cycle boundary -> back to PLAY");
    ok(e.api._state.music.paused === false, "18: resumed");
    ok(e.api._state.music.currentTime < 3, "18: resumed near the track start",
      `ct=${e.api._state.music.currentTime}`);
    guard(FakeAudio.seeks.slice(seeksBefore).every(s => s.paused === true),
      "any gap-exit placement seek happened while PAUSED");
    ok(e.api._state.music.src === src, "18: resume did NOT reassign src (no refetch)");
  }

  // ---- 18b. LIVE-CAUGHT REGRESSION: natural `ended` must not deadlock the next cycle -----------
  {
    // Element plays to its real end (ended=true stays set until a play()/seek clears it). The
    // live run 2026-07-09 stuck in GAP forever here: the old ended-branch always returned to gap
    // and nothing ever cleared `ended`.
    const m = { track: "hill_dwarf", elapsedMs: 0, manual: false };
    const e = await bootPlaying(m);
    // walk to the natural end of the 120 s element
    for (let i = 0; i < 120; i++) { m.elapsedMs += 1000; e.tick(1000); e.playMusic(1000); await tick(); }
    const el = e.api._state.music;
    el._ct = el.duration; el.ended = true; el.paused = true;   // the browser's natural-end state
    m.elapsedMs = 121000;                                       // schedule now in the gap
    e.tick(1000); await tick();
    ok(e.api._state.director.mode === "gap", "18b: natural end -> gap");
    // ... whole gap passes; the NEXT cycle begins (phase ~1 s) while `ended` is still true
    m.elapsedMs = 120000 + C.GAP_MS + 1000;
    e.tick(1000); await tick();
    ok(e.api._state.director.mode === "play", "18b: next cycle re-enters PLAY despite ended=true");
    ok(el.paused === false, "18b: element playing again (deadlock regression)");
    ok(el.currentTime < 4, "18b: restarted near the track start", `ct=${el.currentTime}`);
  }

  // ---- 19. MANUAL mode never gaps (host jukebox loops) -----------------------------------------
  {
    const m = { track: "mountainhome", elapsedMs: 121000, manual: true };   // past dur 120 s
    const e = await bootPlaying(m);
    e.tick(1000); await tick();
    ok(e.api._state.director.mode === "play", "19: manual mode wraps instead of gapping");
    ok(e.api._state.music.paused === false, "19: manual keeps playing");
    ok(Math.abs(e.api._state.music.currentTime - 2) < 2, "19: wrapped modulo dur",
      `ct=${e.api._state.music.currentTime}`);
  }

  // ---- 20. M2 REGRESSION: ambience budget + hysteresis + fade-out pause ------------------------
  {
    const heavy = { env: { weather: 1, season: 1, music: { track: "hill_dwarf", elapsedMs: 0, manual: false } },
      buildings: [{ type: "Workshop" }, { type: "TradeDepot" }],
      width: 4, height: 1,
      tiles: [ { liquid: 2, flow: 5, outside: false }, { liquid: 1, flow: 6, outside: false },
               { outside: true }, { outside: true } ] };
    const e = boot({ probe: "loopback", latest: heavy });
    await tick(); await tick();
    e.g.document._fire("pointerdown", {}); await tick();
    // run enough scans for hysteresis to admit the loops (scan every SCAN_EVERY_TICKS ticks)
    for (let i = 0; i < C.SCAN_EVERY_TICKS * 4; i++) { e.tick(1000); await tick(); }
    const audible = e.api._state.ambPool.filter(c => c.url && c.target > 0);
    ok(audible.length > 0 && audible.length <= 3,
      "20: audible ambience capped at 3 (1 bed + 1 feature + 1 weather) -- the 'all at once' cell",
      `audible=${audible.length}`);
    ok(audible.some(c => /Magma_Close/.test(c.url)), "20: top-weight feature (magma) present");
    ok(audible.some(c => /Thunderstorm/.test(c.url)), "20: weather layer present");
    ok(audible.some(c => /Outside/.test(c.url)), "20: bed present");
    guard(!audible.some(c => /Workshop|Trade_Depot|River/.test(c.url)),
      "lower-weight features did NOT stack (one feature slot only)");
    ok(audible.every(c => c.gain !== null ? c.target <= 0.9 : true), "20: gains under music");
    // feature leaves the view -> loop persists OUT_SCANS, then fades, then is PAUSED
    heavy.tiles = [{ outside: true }, { outside: true }, { outside: true }, { outside: true }];
    heavy.buildings = [];
    const magmaCh = e.api._state.ambPool.find(c => /Magma_Close/.test(c.url || ""));
    for (let i = 0; i < C.SCAN_EVERY_TICKS * (C.AMBIENT_OUT_SCANS + 1); i++) { e.tick(1000); await tick(); }
    ok(magmaCh.target === 0, "20: departed feature fades out after hysteresis");
    for (let i = 0; i < Math.ceil(C.AMBIENT_PAUSE_AFTER_MS / 1000) + 2; i++) { e.tick(1000); await tick(); }
    ok(magmaCh.el.paused === true, "20: fully-faded channel is PAUSED (no zombie loops)");
  }

  // ---- 21. muted music never starts; unmute re-drives ------------------------------------------
  {
    const e = await bootPlaying({ track: "hill_dwarf", elapsedMs: 0, manual: false });
    const pop = e.g.document.getElementById("dfAudioPop");
    clickPop(pop, { audioCheck: "mute" });
    e.tick(1000); await tick();
    ok(e.api._state.music.paused === true, "21: mute pauses music");
    clickPop(pop, { audioCheck: "mute" });
    e.tick(1000); await tick();
    ok(e.api._state.music.paused === false, "21: unmute resumes from the canonical schedule");
  }

  // ---- 22. WAVE-5 DWFUI ADOPTION -- asserted on the EMITTED MARKUP, not on the source ----------
  // A green /DWFUI/ source-regex is NOT proof (it once reported "0 queued" while 467 controls
  // bypassed the layer). Every cell below reads the markup audioPanelMarkup ACTUALLY RENDERS.
  {
    const e22 = boot({ probe: "loopback" });
    await tick();
    const html = e22.api.storyMarkup({ mix: { muted: false, uiClicks: true, master: 1, music: 1, ambient: 1, sfx: 1, ui: 1 },
      host: true, track: "mountainhome" });

    ok(!/<select/.test(html),
       "22: the track picker is NOT a <select> -- native DF has no dropdown in any of the 33 captures");
    ok(/class="dwfui-cycler/.test(html) && /TYPE_FILTER_LEFT/.test(html) && /TYPE_FILTER_RIGHT/.test(html),
       "22: it is the NATIVE three-slice cycler (cyclerHtml: TYPE_FILTER_LEFT/_TEXT/_RIGHT)");
    ok(/id="dfAudioTrack"/.test(html),
       "22: ...and the pinned id=\"dfAudioTrack\" hook (ui_lab_test, tools/ui-lab) is PRESERVED");
    ok(/data-audio-cycle="prev"/.test(html) && /data-audio-cycle="next"/.test(html),
       "22: the cycler carries both step wires");
    ok(/Mountainhome/.test(html), "22: the cycler shows the CURRENT pick's label (not a raw key)");

    ok(!/<input[^>]*type="checkbox"/.test(html), "22: no raw checkbox survives");
    ok(/class="dwfui-check/.test(html) && /SQUADS_NOT_SELECTED/.test(html),
       "22: the toggles are the NATIVE 2-state check tile -- and UNCHECKED renders a REAL tile");
    ok(/id="dfAudioMute"/.test(html),
       "22: ...and the pinned id=\"dfAudioMute\" hook (tools/ui-lab/stories.js) is PRESERVED");

    ok(!/<button[^>]*id="dfAudioPlay"/.test(html) && /class="dwfui-plaque[^"]*aplay/.test(html),
       "22: Play is a native plaque, not a raw <button>");
    ok(/data-audio-act="play"/.test(html) && /data-audio-act="auto"/.test(html),
       "22: ...and both host-music wires still dispatch");

    // THE DECLARED NON-NATIVE CONTROL. DF has NO continuous-value control (grep interface_map.json
    // for SLIDER|TRACK|THUMB|VOLUME -> no value affordance). The 5 mixer sliders MUST stay raw, and
    // DWFUI must NOT grow a sliderHtml. This cell PINS that decision so a later lane cannot quietly
    // "finish the migration" by inventing DF art for a control DF does not have.
    const ranges = (html.match(/<input[^>]*type="range"/g) || []).length;
    ok(ranges === 5, `22: all 5 mixer sliders remain raw <input type=range> (declared non-native; found ${ranges})`);
    ok(typeof DWFUI.sliderHtml !== "function",
       "22: DWFUI grew NO sliderHtml -- DF has no value affordance, so there is no native grammar to render");

    const styleHex = (/st\.textContent = \[([\s\S]*?)\]\.join\(""\);/.exec(SRC) || ["", ""])[1]
      .match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g) || [];
    ok(styleHex.length === 0,
       `22: R1 -- the injected style block states ZERO colour hex literals (found ${styleHex.length})`);
    ok(/DWFUI\.require\("audio"/.test(SRC), "22: the module DECLARES its DWFUI dependencies");
  }

  console.log(`\n${passed + failed} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
