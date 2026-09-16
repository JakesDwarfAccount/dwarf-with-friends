// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// dwf-audio.js -- the audio director: one state machine owning music, ambience and stingers.

(function (root) {
  "use strict";

  // ---- Pure core (no DOM, no AudioContext); also exported for offline tests. ----

  // ---- director tunables (spec §3.5; GAP_MS is the sparseness knob) -------------------------
  var GAP_MS = 120000;                    // scheduled silence between music cards (auto mode)
  var DRIFT_TOLERANCE_MS = 20000;         // circular error before a playing element is corrected
  var CORRECTION_MIN_INTERVAL_MS = 60000; // at most one drift correction per minute
  var STALL_GAP_MS = 12000;               // buffering this long in PLAY -> give up until next cycle
  var STINGER_MIN_GAP_MS = 6000;          // one-shot spacing (later ones in the window are dropped)
  var STINGER_DUCK_MS = 2500;             // music duck window per stinger
  var AMBIENT_IN_SCANS = 2;               // scans a candidate must persist before fading in
  var AMBIENT_OUT_SCANS = 3;              // scans absent before an active loop fades out
  var AMBIENT_PAUSE_AFTER_MS = 6000;      // fade-out age at which a silent channel is paused
  var TICK_MS = 1000;                     // director tick
  var SCAN_EVERY_TICKS = 5;               // viewport ambience scan cadence (in ticks)
  var DIRECTOR_CONST = {
    GAP_MS: GAP_MS, DRIFT_TOLERANCE_MS: DRIFT_TOLERANCE_MS,
    CORRECTION_MIN_INTERVAL_MS: CORRECTION_MIN_INTERVAL_MS, STALL_GAP_MS: STALL_GAP_MS,
    STINGER_MIN_GAP_MS: STINGER_MIN_GAP_MS, STINGER_DUCK_MS: STINGER_DUCK_MS,
    AMBIENT_IN_SCANS: AMBIENT_IN_SCANS, AMBIENT_OUT_SCANS: AMBIENT_OUT_SCANS,
    AMBIENT_PAUSE_AFTER_MS: AMBIENT_PAUSE_AFTER_MS, TICK_MS: TICK_MS,
    SCAN_EVERY_TICKS: SCAN_EVERY_TICKS,
  };

  // Percent-encode each path SEGMENT: track dir names contain '&' and '!', which must reach the server as
  // literals, while '/' stays the separator.
  function soundUrl(rel) {
    if (!rel || typeof rel !== "string") return null;
    var parts = rel.split("/").map(function (s) { return encodeURIComponent(s); });
    return "/sound/" + parts.join("/");
  }

  // Copied VERBATIM from DF's own sound_standard.txt; the typeKey strings are byte-identical to
  // df::announcement_type enum keys. A typeKey not in this table returns null, i.e. no stinger.
  var STINGER_MAP = {
    STRUCK_DEEP_METAL: "sounds/adamantine.ogg",
    AMBUSH_THIEF_SUPPORT_SKULKING: "sounds/ambush.ogg",
    AMBUSH_THIEF_SUPPORT_NATURE: "sounds/ambush.ogg",
    AMBUSH_THIEF_SUPPORT: "sounds/ambush.ogg",
    AMBUSH_SNATCHER_SUPPORT: "sounds/ambush.ogg",
    AMBUSH_AMBUSHER_NATURE: "sounds/ambush.ogg",
    AMBUSH_AMBUSHER: "sounds/ambush.ogg",
    MADE_ARTIFACT: "sounds/artifact_created.ogg",
    BIRTH_CITIZEN: "sounds/baby_born.ogg",
    FEATURE_DISCOVERY: "sounds/cavern_break.ogg",
    ENDGAME_EVENT_2: "sounds/demon_attack.ogg",
    MEGABEAST_ARRIVAL: "sounds/megabeast.ogg",
    WEREBEAST_ARRIVAL: "sounds/megabeast.ogg",
    UNDEAD_ATTACK: "sounds/siege.ogg",
    STRANGE_MOOD: "sounds/strange_mood.ogg",
    MARRIAGE: "sounds/wedding.ogg",
  };

  function stingerForType(typeKey) {
    if (typeof typeKey !== "string") return null;
    return Object.prototype.hasOwnProperty.call(STINGER_MAP, typeKey)
      ? soundUrl(STINGER_MAP[typeKey]) : null;
  }

  // Keys MUST match src/music_sync.h::is_valid_track -- the server validates POST /music against the same set.
  var TRACKS = {
    koganusan:            { label: "Koganusan",              full: "tracks/koganusan/KG_Full.ogg" },
    expansive_cavern:     { label: "Expansive Cavern",       full: "tracks/expansive_cavern/EC_Full.ogg" },
    death_spiral:         { label: "Death Spiral",           full: "tracks/death_spiral/DS_Full.ogg" },
    hill_dwarf:           { label: "Hill Dwarf",             full: "tracks/hill_dwarf/HD_Full.ogg" },
    forgotten_beast:      { label: "Forgotten Beast",        full: "tracks/forgotten_beast/FB_Full.ogg" },
    drink_and_industry:   { label: "Drink & Industry",       full: "tracks/drink_&_industry/DI_Full.ogg" },
    vile_force_of_darkness:{ label: "Vile Force of Darkness", full: "tracks/vile_force_of_darkness/VFOD_Full.ogg" },
    first_year:           { label: "First Year",             full: "tracks/first_year/FY_Full.ogg" },
    another_year:         { label: "Another Year",           full: "tracks/another_year/AY_Full.ogg" },
    strike_the_earth:     { label: "Strike the Earth!",      full: "tracks/strike_the_earth!/STE_Full.ogg" },
    strange_moods:        { label: "Strange Moods",          full: "tracks/strange_moods/SM_Full.ogg" },
    winter_entombs_you:   { label: "Winter Entombs You",     full: "tracks/winter_entombs_you/WEY_Full.ogg" },
    craftsdwarfship:      { label: "Craftsdwarfship",        full: "tracks/craftsdwarfship/CS_Full.ogg" },
    mountainhome:         { label: "Mountainhome",           full: "tracks/mountainhome/MH_Full.ogg" },
    nabidas:              { label: "Nabidas",                full: "tracks/nabidas/Nabidas.ogg" },
    dwarf_fortress:       { label: "Dwarf Fortress (Theme)", full: "tracks/dwarf_fortress/Dwarf_Fortress.ogg" },
    song_game:            { label: "In-Game (Default)",      full: "song_game.ogg" },
  };

  // Ordered playlist for the host picker.
  var PLAYLIST_ORDER = [
    "hill_dwarf", "strange_moods", "mountainhome", "craftsdwarfship", "nabidas",
    "first_year", "another_year", "winter_entombs_you", "expansive_cavern",
    "forgotten_beast", "vile_force_of_darkness", "koganusan", "death_spiral",
    "strike_the_earth", "drink_and_industry", "dwarf_fortress", "song_game",
  ];

  function trackList() {
    return PLAYLIST_ORDER.map(function (key) {
      var t = TRACKS[key];
      return { key: key, label: t.label, url: soundUrl(t.full) };
    });
  }
  function trackFullUrl(key) {
    var t = TRACKS[key];
    return t ? soundUrl(t.full) : null;
  }
  function trackLabel(key) {
    var t = TRACKS[key];
    return t ? t.label : (key || "");
  }

  // The reference rule the server's select_auto_track mirrors; the SERVER owns the decision so every
  // client agrees. season enum: 0 spring / 1 summer / 2 autumn / 3 winter.
  function autoMusicTrack(env, ctx) {
    env = env || {}; ctx = ctx || {};
    if (env.siege === true) return "vile_force_of_darkness";   // EVENT:SIEGE
    if (env.season === 3) return "winter_entombs_you";         // CONTEXT:WINTER
    if (ctx.firstYear === true) return "first_year";           // CONTEXT:FIRST_YEAR
    if (ctx.firstYear === false) return "another_year";        // CONTEXT:SECOND_YEAR_PLUS
    return "hill_dwarf";                                       // CONTEXT:MAIN baseline
  }

  // ---- The deterministic play/silence schedule every client derives from the shared numbers. ----
  // Returns {mode:"play", posMs, cycleMs} or {mode:"gap", resumeInMs, cycleMs}.
  function musicPlan(elapsedMs, durMs, manual) {
    if (!(typeof elapsedMs === "number" && isFinite(elapsedMs) && elapsedMs >= 0)) elapsedMs = 0;
    if (!(typeof durMs === "number" && isFinite(durMs) && durMs > 0)) {
      return { mode: "play", posMs: elapsedMs, cycleMs: null };
    }
    var cycleMs = manual ? durMs : durMs + GAP_MS;
    var phase = elapsedMs % cycleMs;
    if (phase < durMs) return { mode: "play", posMs: phase, cycleMs: cycleMs };
    return { mode: "gap", resumeInMs: cycleMs - phase, cycleMs: cycleMs };
  }

  // Circular distance on the cycle -- the wrap-straddle fix. Raw |a-b| reads a full track length
  // when the two positions straddle the loop point; the true error is the short way around.
  function circularDeltaMs(aMs, bMs, cycleMs) {
    var d = Math.abs(aMs - bMs);
    if (!(typeof cycleMs === "number" && isFinite(cycleMs) && cycleMs > 0)) return d;
    d = d % cycleMs;
    return Math.min(d, cycleMs - d);
  }

  // ---- AMBIENCE (pure; director spec §3.2) ----------------------------------------------------
  // Base (bed) ambience: alignment-flavored surface, else cavern.
  function baseAmbience(view) {
    if (view.outside === true) {
      if (view.evil === 2) return view.savage ? "ambience/Terrifying.ogg" : "ambience/Evil.ogg";
      if (view.evil === 0) return "ambience/Good.ogg";
      return "ambience/Outside.ogg";
    }
    if (view.cavern === true) return "ambience/Cavern.ogg";
    return null;
  }

  // At most one candidate per layer. Danger REPLACES bed+feature, weather always rides on top, and the
  // gains sit UNDER the music channel.
  function ambienceCandidates(view) {
    view = view || {};
    var out = [];
    var wx = null;
    if (view.weather === 2 || (view.weather === 1 && view.season === 3)) wx = "ambience/Blizzard.ogg";
    else if (view.weather === 1) wx = "ambience/Thunderstorm.ogg";
    if (wx) out.push({ url: soundUrl(wx), gain: 0.6, layer: "weather" });

    if (view.siege === true) {
      out.push({ url: soundUrl("ambience/Siege.ogg"), gain: 0.9, layer: "danger" });
      return out;
    }
    if (view.combat === true) {
      out.push({ url: soundUrl("ambience/Combat.ogg"), gain: 0.9, layer: "danger" });
      return out;
    }

    // ONE feature loop: the top-weight proximity candidate (weights keep V2's relative order).
    var cand = [];
    if (view.workshop === true) cand.push({ file: "ambience/Workshop.ogg", weight: 70, gain: 0.5 });
    if (typeof view.magmaDist === "number") {
      if (view.magmaDist <= 6) cand.push({ file: "ambience/Magma_Close.ogg", weight: 78, gain: 0.55 });
      else if (view.magmaDist <= 20) cand.push({ file: "ambience/Magma_Far.ogg", weight: 58, gain: 0.4 });
      else cand.push({ file: "ambience/Magma_Low.ogg", weight: 42, gain: 0.3 });
    }
    if (view.tradeDepot === true) cand.push({ file: "ambience/Trade_Depot.ogg", weight: 60, gain: 0.4 });
    if (view.riverFlow >= 5) cand.push({ file: "ambience/River_High.ogg", weight: 62, gain: 0.5 });
    else if (view.riverFlow >= 3) cand.push({ file: "ambience/River_Medium.ogg", weight: 50, gain: 0.4 });
    else if (view.riverFlow >= 1) cand.push({ file: "ambience/River_Low.ogg", weight: 40, gain: 0.3 });
    cand.sort(function (a, b) { return b.weight - a.weight; });
    if (cand.length) out.push({ url: soundUrl(cand[0].file), gain: cand[0].gain, layer: "feature" });

    var base = baseAmbience(view);
    if (base) out.push({ url: soundUrl(base), gain: 0.35, layer: "bed" });
    return out;
  }

  // Per-layer hysteresis: a different candidate must persist `inScans` scans to take the layer, and an
  // absent layer keeps its loop for `outScans` scans before clearing.
  function layerStep(st, cand, inScans, outScans) {
    st = st || { url: null, gain: 0, candUrl: null, candN: 0, missN: 0 };
    var next = { url: st.url, gain: st.gain, candUrl: null, candN: 0, missN: 0 };
    if (cand && cand.url === st.url) { next.gain = cand.gain; return next; }
    if (!cand) {
      if (st.url == null) return next;
      next.missN = st.missN + 1;
      if (next.missN >= outScans) { next.url = null; next.gain = 0; next.missN = 0; }
      return next;
    }
    next.candN = (st.candUrl === cand.url) ? st.candN + 1 : 1;
    next.candUrl = cand.url;
    if (next.candN >= inScans) {
      next.url = cand.url; next.gain = cand.gain;
      next.candUrl = null; next.candN = 0;
    }
    return next;
  }

  // One scan step over all layers. Danger enters/exits in ONE scan (a siege must not wait 10 s)
  // and, while active, force-clears bed+feature (they crossfade out immediately).
  function ambienceStep(state, cands) {
    state = state || {};
    var byLayer = {};
    (cands || []).forEach(function (c) { byLayer[c.layer] = c; });
    var next = {
      danger: layerStep(state.danger, byLayer.danger, 1, 1),
      weather: layerStep(state.weather, byLayer.weather, AMBIENT_IN_SCANS, AMBIENT_OUT_SCANS),
      feature: layerStep(state.feature, byLayer.feature, AMBIENT_IN_SCANS, AMBIENT_OUT_SCANS),
      bed: layerStep(state.bed, byLayer.bed, AMBIENT_IN_SCANS, AMBIENT_OUT_SCANS),
    };
    if (next.danger.url) {
      next.feature = { url: null, gain: 0, candUrl: null, candN: 0, missN: 0 };
      next.bed = { url: null, gain: 0, candUrl: null, candN: 0, missN: 0 };
    }
    return next;
  }

  // Hysteresis state -> the desired audible set {url: gain}. Budget by construction:
  // danger+weather (2) or bed+feature+weather (3) -- never more.
  function ambienceDesired(state) {
    var out = {};
    if (!state) return out;
    ["danger", "weather", "feature", "bed"].forEach(function (k) {
      var l = state[k];
      if (l && l.url) out[l.url] = l.gain;
    });
    return out;
  }

  // UI click sounds (borrowed adventure-mode clicks -- the fortress system has none; opt-in only).
  var UI_CLICKS = {
    click: ["audio/ui/clicks/generic/click-001.ogg", "audio/ui/clicks/generic/click-002.ogg"],
    confirm: ["audio/ui/clicks/confirm/click-001.ogg"],
  };
  function uiClickUrl(kind, idx) {
    var arr = UI_CLICKS[kind] || UI_CLICKS.click;
    if (!arr.length) return null;
    var i = ((idx | 0) % arr.length + arr.length) % arr.length;
    return soundUrl(arr[i]);
  }

  // Persistence codec: mix settings <-> plain object. Clamps volumes to [0,1], coerces bools.
  // Defaults mirror DF's starting-volume.txt (music 0.85, rest 1.0), UNMUTED, UI clicks OFF.
  var MIX_DEFAULTS = { master: 1, music: 0.85, ambient: 1, sfx: 1, ui: 1, muted: false, uiClicks: false };
  function clamp01(v, dflt) {
    v = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(v)) return dflt;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function truthy(v) { return v === true || v === "true" || v === 1; }
  function decodeMix(raw) {
    var o = raw || {};
    if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = {}; } }
    return {
      master: clamp01(o.master, MIX_DEFAULTS.master),
      music: clamp01(o.music, MIX_DEFAULTS.music),
      ambient: clamp01(o.ambient, MIX_DEFAULTS.ambient),
      sfx: clamp01(o.sfx, MIX_DEFAULTS.sfx),
      ui: clamp01(o.ui, MIX_DEFAULTS.ui),
      muted: truthy(o.muted),
      uiClicks: truthy(o.uiClicks),   // default OFF (undefined -> false)
    };
  }
  function encodeMix(mix) { return JSON.stringify(decodeMix(mix)); }

  var PURE = {
    soundUrl: soundUrl, stingerForType: stingerForType,
    trackList: trackList, trackFullUrl: trackFullUrl, trackLabel: trackLabel,
    autoMusicTrack: autoMusicTrack,
    musicPlan: musicPlan, circularDeltaMs: circularDeltaMs,
    ambienceCandidates: ambienceCandidates, ambienceStep: ambienceStep,
    ambienceDesired: ambienceDesired, baseAmbience: baseAmbience,
    uiClickUrl: uiClickUrl, decodeMix: decodeMix, encodeMix: encodeMix,
    STINGER_MAP: STINGER_MAP, TRACKS: TRACKS, MIX_DEFAULTS: MIX_DEFAULTS,
    DIRECTOR_CONST: DIRECTOR_CONST,
    storyMarkup: audioPanelMarkup,
    isValidTrack: function (k) {
      return Object.prototype.hasOwnProperty.call(TRACKS, k);
    },
  };

  // Node/offline: export the pure core and stop (no DOM, no AudioContext, no auto-boot).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PURE;
    return;
  }

  // ---- Browser runtime ----

  var params = (function () {
    try { return new URLSearchParams((root.location && root.location.search) || ""); }
    catch { return { get: function () { return null; } }; }
  })();
  var DISABLED = params.get("audio") === "0";

  var LS = { mix: "dwf.audio.mix" };
  var DwfUtil = root.DwfUtil || (typeof require === "function" ? require("./dwf-util.js") : null);
  var lsGet = DwfUtil.lsGet, lsSet = DwfUtil.lsSet;
  var audioErr = DwfUtil.DwfErr;

  // Autoplay denial and play/pause interruption are browser control flow; other rejections are failures.
  function reportPlayFailure(key, err) {
    if (err && (err.name === "NotAllowedError" || err.name === "AbortError")) return;
    audioErr.report(key, err);
  }

  function perfNow() {
    try { return root.performance.now(); } catch { return Date.now(); }
  }

  var state = {
    ctx: null,
    gains: {},              // master/music/ambient/sfx/ui GainNodes
    unlocked: false,
    available: false,       // /sound-info said this DLL has the route
    allowed: false,         // this peer is served real audio (loopback or audio_remote)
    probed: false,
    mix: decodeMix(lsGet(LS.mix)),
    buffers: {},            // url -> decoded AudioBuffer (stingers/clicks)
    music: null,            // the ONE <audio> element for the music slot
    musicNode: null,        // MediaElementSource
    musicFade: null,        // director-owned fade GainNode (separate from the user music slider)
    musicTrack: null,       // track key currently loaded on the music element
    // The HOST PICKER's selection. The native cycler (DF has no dropdown) has no value slot, so the
    // module holds it. Seeded from the canonical server track whenever one is known.
    trackPick: null,
    musicWanted: false,     // intent flag: resume on unlock if autoplay rejected play()
    director: {
      track: null, manual: false,          // canonical selection last seen
      anchorElapsed: 0, anchorAt: 0, haveAnchor: false,
      lastFrameElapsed: null,              // dedupe: only a CHANGED elapsed re-anchors
      mode: "idle",                        // idle | play | gap | swap
      swapAt: 0,                           // fade-out start for a pending track swap
      gapFadeAt: 0,                        // fade-out start for the current gap entry
      lastCorrectionAt: -1e15,             // drift-correction rate limiter
      stallSince: null,                    // waiting/stalled onset while in PLAY
      suspendedCycle: false,               // stalled-out: silent until the next cycle boundary
      lastPhaseMs: 0,
    },
    lastStingerAt: -1e15,
    stingerDuckUntil: 0,
    ducked: false,          // world-pause duck
    ambState: null,         // pure per-layer hysteresis state
    ambPool: [],            // [{el,node,gain,url,target,fadeOutAt}] -- size AMBIENT_POOL_SIZE
    scanCount: 0,
    reportCursor: null,
    reportTimer: null,
    tickTimer: null,
    dom: {},
  };

  function AC() { return root.AudioContext || root.webkitAudioContext || null; }
  function isHost() {
    try { return !!(root.DwfWS && typeof root.DwfWS.isHost === "function" && root.DwfWS.isHost()); }
    catch { return false; }
  }

  function ensureContext() {
    if (state.ctx || !AC()) return state.ctx;
    try {
      state.ctx = new (AC())();
      var g = state.gains;
      g.master = state.ctx.createGain();
      g.master.connect(state.ctx.destination);
      ["music", "ambient", "sfx", "ui"].forEach(function (ch) {
        g[ch] = state.ctx.createGain();
        g[ch].connect(g.master);
      });
      applyMix();
    } catch (err) { state.ctx = null; audioErr.report("audio.context", err); }
    return state.ctx;
  }

  function applyMix() {
    if (!state.ctx) return;
    var now = state.ctx.currentTime;
    try {
      state.gains.master.gain.setTargetAtTime(state.mix.muted ? 0 : state.mix.master, now, 0.02);
      ["ambient", "sfx", "ui"].forEach(function (ch) {
        state.gains[ch].gain.setTargetAtTime(state.mix[ch], now, 0.02);
      });
    } catch (err) { audioErr.report("audio.mix-apply", err); }
    updateMusicGain();
  }
  // User music volume x pause-duck x stinger-duck. The director's play/gap fades live on the
  // SEPARATE musicFade node so they never fight the user's slider.
  function updateMusicGain() {
    if (!state.ctx || !state.gains.music) return;
    var now = state.ctx.currentTime;
    var duck = 1;
    if (state.ducked) duck *= 0.4;
    var stung = perfNow() < state.stingerDuckUntil;
    if (stung) duck *= 0.45;
    try {
      state.gains.music.gain.setTargetAtTime(
        state.mix.music * duck, now, (state.ducked || stung) ? 0.08 : 0.4);
    } catch (err) { audioErr.report("audio.music-gain", err); }
  }
  function saveMix() { lsSet(LS.mix, encodeMix(state.mix)); }

  // ---- autoplay unlock ------------------------------------------------------------------------
  function installUnlock() {
    if (state.unlocked) return;
    function unlock() {
      if (state.unlocked) return;
      ensureContext();
      if (state.ctx && state.ctx.state === "suspended")
        state.ctx.resume().catch(function (err) { reportPlayFailure("audio.context-resume", err); });
      state.unlocked = true;
      root.document.removeEventListener("pointerdown", unlock, true);
      root.document.removeEventListener("keydown", unlock, true);
      refreshPopover();
      // play() calls made before the first gesture were rejected by the autoplay policy.
      // Re-drive from the current env now that we have a gesture.
      if (state.musicWanted && state.music && state.director.mode === "play") {
        state.music.play().catch(function (err) { reportPlayFailure("audio.music-play", err); });
      }
      envTick(true);
    }
    root.document.addEventListener("pointerdown", unlock, true);
    root.document.addEventListener("keydown", unlock, true);
  }

  // ---- capability probe -----------------------------------------------------------------------
  function probe() {
    return fetch("/sound-info", { cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) return "retry";   // auth gate not passed yet (join sets cookie, no reload)
        state.probed = true;
        if (!r.ok) { state.available = false; state.allowed = false; refreshPopover(); return "done"; }
        return r.json().then(function (j) {
          state.available = !!(j && j.audio === true);
          state.allowed = !!(j && j.allowed === true);
          refreshPopover();
          return "done";
        });
      })
      .catch(function (err) { audioErr.report("audio.probe", err); state.probed = true; state.available = false; state.allowed = false; refreshPopover(); return "done"; });
  }

  // ---- SFX (stingers + clicks) ----------------------------------------------------------------
  function loadBuffer(url) {
    if (!url) return Promise.reject();
    if (state.buffers[url]) return Promise.resolve(state.buffers[url]);
    if (!ensureContext()) return Promise.reject();
    return fetch(url, { cache: "force-cache" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        return new Promise(function (res, rej) {
          state.ctx.decodeAudioData(buf, function (d) { state.buffers[url] = d; res(d); }, rej);
        });
      });
  }
  function playBuffer(url, ch) {
    if (!state.ctx || !state.unlocked) return;
    loadBuffer(url).then(function (d) {
      try {
        var src = state.ctx.createBufferSource();
        src.buffer = d;
        src.connect(state.gains[ch] || state.gains.sfx);
        src.start();
      } catch (err) { audioErr.report("audio.buffer-source", err); }
    }).catch(function (err) { audioErr.report("audio.buffer-load", err); });
  }
  function synthBlip(kind) {
    if (!state.ctx || !state.unlocked) return;
    try {
      var o = state.ctx.createOscillator(), g = state.ctx.createGain();
      o.type = "sine";
      o.frequency.value = kind === "confirm" ? 660 : 440;
      var t = state.ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g); g.connect(state.gains.ui || state.gains.master);
      o.start(t); o.stop(t + 0.09);
    } catch (err) { audioErr.report("audio.synth", err); }
  }
  var clickIdx = 0;
  function playClick(kind) {
    // UI clicks are OFF by default -- only fire when the player opted in.
    if (DISABLED || state.mix.muted || !state.mix.uiClicks) return;
    if (state.available && state.allowed) playBuffer(uiClickUrl(kind, clickIdx++), "ui");
    else synthBlip(kind);
  }
  // Stingers are INTERRUPTS: spaced at least STINGER_MIN_GAP_MS apart, later ones in the window dropped,
  // and the music channel ducks briefly so the one-shot reads over the bed.
  function playStinger(typeKey) {
    if (DISABLED || state.mix.muted || !state.available || !state.allowed) return;
    var url = stingerForType(typeKey);
    if (!url) return;
    var t = perfNow();
    if (t - state.lastStingerAt < STINGER_MIN_GAP_MS) return;
    state.lastStingerAt = t;
    state.stingerDuckUntil = t + STINGER_DUCK_MS;
    updateMusicGain();                       // duck now; the tick restores after the window
    playBuffer(url, "sfx");
  }

  // ---- Music director ----

  function ensureMusicEl() {
    if (state.music || typeof root.Audio === "undefined") return state.music;
    try {
      state.music = new root.Audio();
      state.music.preload = "auto";     // buffer ahead; the schedule (not the element) loops
      state.music.loop = false;
      // No crossOrigin: /sound is same-origin, cookie rides automatically, MediaElementSource stays
      // untainted (crossOrigin would force CORS mode and, with no ACAO header, silence the node).
      state.music.addEventListener("loadedmetadata", function () { musicOnMetadata(); });
      ["waiting", "stalled"].forEach(function (evn) {
        state.music.addEventListener(evn, function () {
          if (state.director.mode === "play" && state.director.stallSince == null) {
            state.director.stallSince = perfNow();
          }
        });
      });
      ["playing", "canplay"].forEach(function (evn) {
        state.music.addEventListener(evn, function () { state.director.stallSince = null; });
      });
      if (ensureContext() && state.ctx.createMediaElementSource) {
        state.musicNode = state.ctx.createMediaElementSource(state.music);
        state.musicFade = state.ctx.createGain();
        state.musicFade.gain.value = 0;
        state.musicNode.connect(state.musicFade);
        state.musicFade.connect(state.gains.music);
      }
    } catch (err) { state.music = null; audioErr.report("audio.music-element", err); }
    return state.music;
  }
  function musicFadeTo(v, tau) {
    if (!state.musicFade || !state.ctx) return;
    try { state.musicFade.gain.setTargetAtTime(v, state.ctx.currentTime, tau || 0.4); }
    catch (err) { audioErr.report("audio.music-fade", err); }
  }
  function musicPlaying() { return !!(state.music && !state.music.paused && state.music.src); }
  function stopMusic() {
    state.musicWanted = false;
    state.musicTrack = null;
    state.director.mode = "idle";
    if (state.music) { try { state.music.pause(); } catch (err) { audioErr.report("audio.music-stop", err); } }
    refreshPopover();
  }

  // The anchor advances ONLY when a frame's elapsedMs actually changed, so a stalled aux stream freezes
  // the anchor and the director never rewinds to stale data.
  function noteMusicFrame(m) {
    var d = state.director;
    if (!m || typeof m.track !== "string") return;
    var t = perfNow();
    var manual = m.manual === true;
    var elapsed = (typeof m.elapsedMs === "number" && m.elapsedMs >= 0) ? m.elapsedMs : 0;
    if (m.track !== d.track || manual !== d.manual) {
      d.track = m.track; d.manual = manual;
      d.anchorElapsed = elapsed; d.anchorAt = t; d.haveAnchor = true;
      d.lastFrameElapsed = elapsed;
      d.suspendedCycle = false; d.stallSince = null;
    } else if (elapsed !== d.lastFrameElapsed) {
      d.anchorElapsed = elapsed; d.anchorAt = t; d.haveAnchor = true;
      d.lastFrameElapsed = elapsed;
    }
  }
  function projectedElapsedMs() {
    var d = state.director;
    if (!d.haveAnchor) return null;
    return d.anchorElapsed + (perfNow() - d.anchorAt);
  }
  function currentMusicPlan() {
    var d = state.director, el = state.music;
    var durMs = (el && isFinite(el.duration) && el.duration > 0) ? el.duration * 1000 : null;
    return musicPlan(projectedElapsedMs(), durMs, d.manual);
  }

  // loadedmetadata: duration just became known -- place the element correctly ONCE (this is the
  // join/track-change seek; the element is at 0 and may already be playing the wrong position).
  function musicOnMetadata() {
    var d = state.director, el = state.music;
    if (!el || !d.track || state.musicTrack !== d.track) return;
    var plan = currentMusicPlan();
    if (plan.mode === "play") {
      try { el.currentTime = plan.posMs / 1000; } catch (err) { audioErr.report("audio.music-seek", err); }
    } else {
      d.mode = "gap"; d.gapFadeAt = perfNow() - 1e6;   // pause immediately, no audible fade needed
      musicFadeTo(0.0001, 0.05);
      try { el.pause(); } catch (err) { audioErr.report("audio.music-pause", err); }
    }
    refreshPopover();
  }

  // One director tick for the music slot. currentTime is set ONLY: entering play (paused element),
  // at loadedmetadata, or as a rare rate-limited circular drift correction.
  function musicTick() {
    var d = state.director;
    if (DISABLED || !state.available || !state.allowed || !d.track || state.mix.muted) {
      if (musicPlaying()) { try { state.music.pause(); } catch (err) { audioErr.report("audio.music-pause", err); } }
      if (state.mix.muted || !d.track) d.mode = "idle";
      return;
    }
    var el = ensureMusicEl();
    var url = trackFullUrl(d.track);
    if (!el || !url) return;

    // -- track change: two-phase fade-out -> swap (src only reassigned on a fading/paused element).
    if (state.musicTrack !== d.track) {
      if (musicPlaying() && d.mode !== "swap") {
        d.mode = "swap"; d.swapAt = perfNow();
        musicFadeTo(0.0001, 0.25);
        return;
      }
      if (d.mode === "swap" && perfNow() - d.swapAt < 800) return;   // let the fade land
      try { el.pause(); } catch (err) { audioErr.report("audio.music-pause", err); }
      state.musicTrack = d.track;
      state.musicWanted = true;
      d.mode = "idle"; d.stallSince = null; d.suspendedCycle = false;
      d.lastCorrectionAt = -1e15;
      try { el.src = url; } catch (err) { audioErr.report("audio.music-source", err); }
      // fall through: the plan below starts playback; metadata will place it exactly.
    }

    var plan = currentMusicPlan();

    // -- stall degradation: buffering too long in PLAY -> go silent until the next cycle boundary
    // (never fight a starving pipe with seeks).
    if (plan.mode === "play" && d.stallSince != null && perfNow() - d.stallSince > STALL_GAP_MS) {
      d.suspendedCycle = true; d.stallSince = null;
    }
    if (d.suspendedCycle) {
      if (plan.mode === "gap" || plan.posMs < d.lastPhaseMs) d.suspendedCycle = false;  // boundary reached
      else plan = { mode: "gap", resumeInMs: 0, cycleMs: plan.cycleMs };
    }
    if (plan.mode === "play") d.lastPhaseMs = plan.posMs;

    if (plan.mode === "play") {
      var posSec = plan.posMs / 1000;
      // `ended` stays true until a play() or seek clears it, so re-enter play when the schedule restarted and
      // only wait out the sliver where the element finished just before the play->gap flip.
      if (el.ended) {
        if (d.manual || plan.posMs < el.currentTime * 1000 - 2000) {
          d.mode = "idle";               // re-enter below: paused seek + play() clears `ended`
        } else {
          if (d.mode !== "gap") { d.mode = "gap"; d.gapFadeAt = perfNow() - 1e6; }
          return;
        }
      }
      if (d.mode !== "play") {
        // entering PLAY (join / gap-exit / post-swap): seek while PAUSED, fade in, go.
        if (!el.paused) { try { el.pause(); } catch (err) { audioErr.report("audio.music-pause", err); } }
        if (plan.cycleMs != null) {   // pre-metadata we can't place it; metadata handler will
          try { if (Math.abs((el.currentTime || 0) - posSec) > 1.5) el.currentTime = posSec; }
          catch (err) { audioErr.report("audio.music-seek", err); }
        }
        musicFadeTo(1, 0.3);
        state.musicWanted = true;
        d.mode = "play"; d.stallSince = null;
        if (state.unlocked) {
          try { el.play().catch(function (err) { reportPlayFailure("audio.music-play", err); }); }
          catch (err) { reportPlayFailure("audio.music-play", err); }
        }
      } else if (el.paused) {
        if (state.unlocked) {
          try { el.play().catch(function (err) { reportPlayFailure("audio.music-play", err); }); }
          catch (err) { reportPlayFailure("audio.music-play", err); }
        }
      } else if (plan.cycleMs != null) {
        // steady PLAY: rare, rate-limited, circular drift correction -- the ONLY playing seek.
        var err = circularDeltaMs(el.currentTime * 1000, plan.posMs, plan.cycleMs);
        if (err > DRIFT_TOLERANCE_MS &&
            perfNow() - d.lastCorrectionAt > CORRECTION_MIN_INTERVAL_MS &&
            el.readyState >= 3) {
          d.lastCorrectionAt = perfNow();
          try { el.currentTime = posSec; } catch (err) { audioErr.report("audio.music-seek", err); }
        }
      }
    } else {   // gap: scheduled silence -- fade, then pause (keep src + buffer for the resume)
      if (d.mode !== "gap") {
        d.mode = "gap"; d.gapFadeAt = perfNow();
        musicFadeTo(0.0001, 0.4);
      } else if (!el.paused && perfNow() - d.gapFadeAt > 1600) {
        try { el.pause(); } catch (err) { audioErr.report("audio.music-pause", err); }
      }
    }
  }

  // ---- Ambience bed ----

  var AMBIENT_POOL_SIZE = 4;   // 3 audible max + 1 crossfade headroom
  function ensureAmbientPool() {
    if (state.ambPool.length) return state.ambPool;
    for (var i = 0; i < AMBIENT_POOL_SIZE; i++) {
      state.ambPool.push({ el: null, node: null, gain: null, url: null, target: 0, fadeOutAt: 0 });
    }
    return state.ambPool;
  }
  function ambientChannel(ch) {
    if (ch.el || typeof root.Audio === "undefined" || !ensureContext()) return ch;
    try {
      ch.el = new root.Audio(); ch.el.preload = "auto"; ch.el.loop = true;
      ch.gain = state.ctx.createGain(); ch.gain.gain.value = 0;
      if (state.ctx.createMediaElementSource) {
        ch.node = state.ctx.createMediaElementSource(ch.el);
        ch.node.connect(ch.gain); ch.gain.connect(state.gains.ambient);
      }
    } catch (err) { audioErr.report("audio.ambient-channel", err); }
    return ch;
  }
  function rampChannel(ch, target) {
    var entering = target > 0 && ch.target === 0;
    ch.target = target;
    if (target === 0 && !ch.fadeOutAt) ch.fadeOutAt = perfNow();
    if (target > 0) ch.fadeOutAt = 0;
    if (!ch.gain || !state.ctx) return;
    // slow crossfades: ~8 s in, quicker out (the pause timer needs the gain near zero by then)
    try {
      ch.gain.gain.setTargetAtTime(target, state.ctx.currentTime,
        target === 0 ? 1.2 : (entering ? AMBIENT_TAU_S : 0.8));
    } catch (err) { audioErr.report("audio.ambient-ramp", err); }
  }
  function poolFind(url) {
    for (var i = 0; i < state.ambPool.length; i++) if (state.ambPool[i].url === url) return state.ambPool[i];
    return null;
  }
  // src is only ever reassigned on a PAUSED (or never-started) element -- a fading channel keeps
  // its url until it is silent; prefer the longest-silent channel for reuse.
  function poolAcquire(desired) {
    var pool = ensureAmbientPool(), best = null;
    for (var i = 0; i < pool.length; i++) {
      var ch = pool[i];
      if (ch.url && desired[ch.url] != null) continue;      // serving an active loop
      if (ch.el && !ch.el.paused) continue;                 // still audibly fading -- leave it
      if (!best || !best.url) { if (!ch.url) { best = ch; break; } }
      if (!best) best = ch;
    }
    return best;
  }
  function applyAmbience(desired) {   // desired = {url: gain}
    var pool = ensureAmbientPool();
    pool.forEach(function (ch) {
      if (ch.url && desired[ch.url] == null && ch.target !== 0) rampChannel(ch, 0);
    });
    Object.keys(desired).forEach(function (url) {
      var ch = poolFind(url) || poolAcquire(desired);
      if (!ch) return;                 // all channels audible (transient crossfade) -- next scan
      ambientChannel(ch);
      if (ch.url !== url) {
        ch.url = url;
        try { if (ch.el) ch.el.src = url; } catch (err) { audioErr.report("audio.ambient-source", err); }
      }
      if (ch.el && ch.el.paused && state.unlocked) {
        try { ch.el.play().catch(function (err) { reportPlayFailure("audio.ambient-play", err); }); }
        catch (err) { reportPlayFailure("audio.ambient-play", err); }
      }
      rampChannel(ch, desired[url]);
    });
  }
  // Every tick: channels that finished fading out get PAUSED (no zombie decode/network).
  function ambiencePauseTick() {
    state.ambPool.forEach(function (ch) {
      if (ch.el && !ch.el.paused && ch.target === 0 && ch.fadeOutAt &&
          perfNow() - ch.fadeOutAt > AMBIENT_PAUSE_AFTER_MS) {
        try { ch.el.pause(); } catch (err) { audioErr.report("audio.ambient-pause", err); }
      }
    });
  }
  function silenceAmbience() {   // mute / stop: instant, and reset hysteresis so unmute re-earns
    state.ambState = null;
    state.ambPool.forEach(function (ch) {
      if (ch.target !== 0) rampChannel(ch, 0);
      if (ch.el && !ch.el.paused) { try { ch.el.pause(); } catch (err) { audioErr.report("audio.ambient-pause", err); } }
    });
  }

  // ---- viewport scan: tiles + buildings + env -> the digested `view` for ambienceCandidates ----
  function getLatest() {
    try {
      var T = root.DwfTiles;
      return (T && typeof T.getLatest === "function") ? T.getLatest() : null;
    } catch { return null; }
  }
  function isMagma(liq) { return liq === 2 || liq === "magma"; }
  function isWater(liq) { return liq === 1 || liq === "water"; }
  function scanView() {
    var latest = getLatest();
    var env = (latest && latest.env) || {};
    var view = {
      weather: env.weather | 0, season: env.season | 0,
      siege: env.siege === true, combat: false,
      evil: (typeof env.evil === "number") ? env.evil : 1, savage: env.savage === true,
      workshop: false, tradeDepot: false, magmaDist: null, riverFlow: 0,
      outside: false, cavern: false,
    };
    if (!latest) return view;
    var bs = Array.isArray(latest.buildings) ? latest.buildings : [];
    for (var bi = 0; bi < bs.length; bi++) {
      var ty = (bs[bi] && bs[bi].type) || "";
      if (ty === "Workshop" || ty === "Furnace") view.workshop = true;   // "forges" = Furnace
      if (ty === "TradeDepot") view.tradeDepot = true;
    }
    var tiles = Array.isArray(latest.tiles) ? latest.tiles : [];
    var w = latest.width | 0, h = latest.height | 0;
    var cx = w / 2, cy = h / 2, anyTile = false, anyOutside = false, magmaBest = Infinity;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t) continue;
      anyTile = true;
      if (t.outside) anyOutside = true;
      var fl = t.flow | 0;
      if (fl > 0 && isMagma(t.liquid) && w > 0) {
        var gx = i % w, gy = (i / w) | 0;
        var d = Math.max(Math.abs(gx - cx), Math.abs(gy - cy));
        if (d < magmaBest) magmaBest = d;
      }
      if (fl > view.riverFlow && isWater(t.liquid)) view.riverFlow = fl;
    }
    if (anyTile) { view.outside = anyOutside; view.cavern = !anyOutside; }
    if (magmaBest < Infinity) view.magmaDist = magmaBest;
    return view;
  }

  // ---- The director tick. ----
  function envTick(forceScan) {
    if (DISABLED) return;
    var latest = getLatest();
    noteMusicFrame(latest && latest.env && latest.env.music);
    musicTick();
    updateMusicGain();       // restores an expired stinger duck (ramped, not stepped)
    ambiencePauseTick();
    state.scanCount++;
    if (forceScan === true || state.scanCount % SCAN_EVERY_TICKS === 0) {
      if (state.mix.muted || !state.available || !state.allowed) {
        silenceAmbience();
      } else {
        state.ambState = ambienceStep(state.ambState, ambienceCandidates(scanView()));
        applyAmbience(ambienceDesired(state.ambState));
      }
      refreshPopover();
    }
  }
  function pollReports() {
    if (DISABLED || !state.available || !state.allowed) return;
    var since = state.reportCursor, player = lsGet("dwf.player") || "";
    var url = "/reports?player=" + encodeURIComponent(player) +
      (since == null ? "&max=1" : "&since=" + since) + "&t=" + Date.now();
    fetch(url, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (page) {
        if (!page) return;
        if (since == null) { state.reportCursor = page.nextReportId; return; }  // seed only (no backlog replay)
        state.reportCursor = page.nextReportId;
        var reps = page.reports || [];
        for (var i = 0; i < reps.length; i++) {
          if (reps[i] && !reps[i].continuation) playStinger(reps[i].typeKey);
        }
      }).catch(function () { audioErr.count("audio.reports-poll"); });
  }

  // ---- pause ducking --------------------------------------------------------------------------
  function onPause(msg) {
    if (!msg || typeof msg.paused !== "boolean") return;
    state.ducked = msg.paused;
    updateMusicGain();
  }
  function hookPause() {
    try {
      var P = root.DwfPause;
      if (P && typeof P.onPause === "function" && !P.__audioHooked) {
        var orig = P.onPause;
        P.onPause = function (m) { try { orig(m); } catch (err) { audioErr.report("audio.pause-handler", err); } onPause(m); };
        P.__audioHooked = true;
      }
    } catch (err) { audioErr.report("audio.pause-hook", err); }
  }

  // ---- host control: POST /music --------------------------------------------------------------
  function postMusic(bodyObj) {
    fetch("/music", {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    }).then(function () { /* canonical env.music updates on the next aux frame -> everyone syncs */ })
      .catch(function (err) { audioErr.report("audio.music-post", err); });
  }

  // Native DF has no dropdown, so the track playlist is the three-slice cycler.
  // Keep `id="dfAudioTrack"` on the picker host: tools/harness/ui_lab_test pins that exact string.
  function trackCyclerHtml(pick) {
    return '<div id="dfAudioTrack" class="audio-track">' + root.DWFUI.cyclerHtml({
      label: trackLabel(pick), cls: "audio-track-cycler", ariaLabel: "Choose a track for everyone",
      previous: { dataset: { audioCycle: "prev" }, title: "Previous track" },
      next: { dataset: { audioCycle: "next" }, title: "Next track" },
    }) + '</div>';
  }

  function audioPanelMarkup(options) {
    options = options || {};
    var D = root.DWFUI;
    var mix = decodeMix(options.mix || MIX_DEFAULTS);
    var pick = normalizeTrackPick(options.track || state.trackPick);
    var msg = options.message || "";
    var now = options.now || "";
    // The five mixer sliders stay raw range inputs: DF has no continuous-value control, so a DWFUI
    // sliderHtml would be a component with no native grammar to render.
    var slider = function (id, label, value) {
      return '<div class="audio-row"><label>' + label + '</label>' +
        '<input type="range" id="' + id + '" min="0" max="1" step="0.01" value="' + value + '"></div>';
    };
    var muteCheck = '<span id="dfAudioMute" class="acheck">' + D.checkHtml({
      checked: !!mix.muted, cls: "amute", dataset: { audioCheck: "mute" },
      title: "Mute all audio", ariaLabel: "Mute all audio",
    }) + '</span>';
    var clicksCheck = D.checkHtml({
      checked: !!mix.uiClicks, cls: "aclicks", dataset: { audioCheck: "clicks" },
      title: "UI click sounds", ariaLabel: "UI click sounds",
    });
    return D.headerHtml({ tag: "h4", titleTag: "span", title: "Audio & Music", titleCls: "audio-title", close: false }) +
      '<div class="audio-message' + (msg ? "" : " audio-hidden") + '" id="dfAudioMsg">' + D.esc(msg) + '</div>' +
      '<div class="now' + (now ? "" : " audio-hidden") + '" id="dfAudioNow">' + D.esc(now) + '</div>' +
      '<div class="audio-row"><label>Mute</label>' + muteCheck + '</div>' +
      slider("dfAudioMaster", "Master", mix.master) +
      slider("dfAudioMusic", "Music", mix.music) +
      slider("dfAudioAmbient", "Ambient", mix.ambient) +
      slider("dfAudioSfx", "Effects", mix.sfx) +
      slider("dfAudioUi", "UI", mix.ui) +
      '<div class="audio-row">' + clicksCheck + '<span class="clicklbl">UI clicks (not in native DF)</span></div>' +
      '<div id="dfAudioHost" class="' + (options.host === false ? "audio-hidden" : "") + '"><hr>' +
      '<div class="audio-row music">' + trackCyclerHtml(pick) +
      D.plaqueBtnHtml({ label: "Play (all)", tone: "green", cls: "aplay",
        dataset: { audioAct: "play" }, title: "Play for everyone" }) +
      D.plaqueBtnHtml({ label: "Auto", tone: "grey", cls: "aauto",
        dataset: { audioAct: "auto" }, title: "Hand music back to the game (season/siege)" }) +
      '</div></div>';
  }

  // The cycler is a STEPPER over the ordered playlist, so the module holds the pick. Same 17 keys,
  // same POST /music body.
  function normalizeTrackPick(key) {
    return (key && PLAYLIST_ORDER.indexOf(key) >= 0) ? key : PLAYLIST_ORDER[0];
  }
  function stepTrackPick(dir) {
    var order = PLAYLIST_ORDER;
    var i = order.indexOf(normalizeTrackPick(state.trackPick));
    state.trackPick = order[(i + (dir < 0 ? -1 : 1) + order.length) % order.length];
    return state.trackPick;
  }

  function buildUi() {
    if (typeof root.document === "undefined" || state.dom.btn) return;
    if (typeof root.DWFUI !== "undefined" && typeof root.DWFUI.require === "function")
      root.DWFUI.require("audio", ["headerHtml", "checkHtml", "cyclerHtml", "plaqueBtnHtml", "esc"]);
    var btn = root.document.createElement("button");
    btn.id = "audioBtn";
    btn.className = "square-button";
    btn.title = "Audio & music";
    // DECLARED ART GAP. DEF-015: interface_map.json has no speaker, sound, volume or audio sprite, because
    // DF has no in-game audio control at all, so the character stays rather than minting a token we lack.
    btn.textContent = "🔊";   // speaker -- declared art gap, see above
    var chost = root.document.querySelector("#topbar .topbar-controls");
    if (chost) chost.appendChild(btn);
    else { btn.classList.add("audio-btn-fallback"); root.document.body.appendChild(btn); }
    state.dom.btn = btn;

    var pop = root.document.createElement("div");
    pop.id = "dfAudioPop";
    pop.innerHTML = audioPanelMarkup({ mix: state.mix, host: isHost(), track: state.musicTrack });
    root.document.body.appendChild(pop);
    state.dom.pop = pop;
    if (root.DFPanelFrame) root.DFPanelFrame.register({
      key: "audio", el: function () { return state.dom.pop; }, title: "Audio & Music", headSel: "h4",
      closable: true, open: openPopover, close: closePopover,
      isOpen: function () { return pop.classList.contains("open"); }, escClosable: true, zBand: false,
    });

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (pop.classList.contains("open")) closePopover(); else openPopover();
      refreshPopover();
    });
    root.document.addEventListener("pointerdown", function (ev) {
      try { if (pop.classList.contains("open") && !ev.target.closest("#dfAudioPop,#audioBtn")) closePopover(); }
      catch (err) { audioErr.report("audio.outside-click", err); }
    });

    function openPopover() {
      pop.classList.add("open");
      try { if (root.DFPanelFrame) root.DFPanelFrame.syncOpenState("audio", true); }
      catch (err) { audioErr.report("audio.panel-open", err); }
    }
    function closePopover() {
      try { if (root.DFPanelFrame) root.DFPanelFrame.syncOpenState("audio", false); }
      catch (err) { audioErr.report("audio.panel-close", err); }
      pop.classList.remove("open");
    }

    // The five sliders are raw DOM controls by design and refreshPopover never replaces them, so a drag is
    // never interrupted by a re-render.
    function slider(id, ch) {
      pop.querySelector(id).addEventListener("input", function (e) {
        state.mix[ch] = clamp01(parseFloat(e.target.value), state.mix[ch]);
        applyMix(); saveMix();
      });
    }
    slider("#dfAudioMaster", "master"); slider("#dfAudioMusic", "music");
    slider("#dfAudioAmbient", "ambient"); slider("#dfAudioSfx", "sfx"); slider("#dfAudioUi", "ui");

    // The DWFUI controls are re-rendered in place, so they are wired by DELEGATION on the popover: a
    // listener bound to a child would be thrown away the first time its markup refreshed.
    function setMuted(next) {
      state.mix.muted = !!next;
      applyMix(); saveMix();
      if (state.mix.muted) {
        if (state.music) { try { state.music.pause(); } catch (err) { audioErr.report("audio.music-pause", err); } }
        state.director.mode = "idle";
        silenceAmbience();
      } else { envTick(true); }
      btn.classList.toggle("df-muted", state.mix.muted);
      refreshPopover();
    }
    pop.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var check = t.closest("[data-audio-check]");
      if (check) {
        if (check.dataset.audioCheck === "mute") { setMuted(!state.mix.muted); return; }
        state.mix.uiClicks = !state.mix.uiClicks; saveMix(); refreshPopover();
        return;
      }
      var cycle = t.closest("[data-audio-cycle]");
      if (cycle) { stepTrackPick(cycle.dataset.audioCycle === "prev" ? -1 : 1); refreshPopover(); return; }
      // HOST-ONLY music control: Play broadcasts to everyone, Auto hands control back to the game.
      var act = t.closest("[data-audio-act]");
      if (!act) return;
      if (act.dataset.audioAct === "auto") { postMusic({ auto: true }); return; }
      var k = normalizeTrackPick(state.trackPick);
      if (k) postMusic({ track: k });
    });
    refreshPopover();
  }

  function refreshPopover() {
    var d = state.dom, pop = d.pop;
    if (!pop) return;
    try {
      var D = root.DWFUI;
      // The native check tiles are stateful ART, not a DOM `.checked` flag: refresh by re-emitting checkHtml.
      var muteHost = pop.querySelector("#dfAudioMute");
      if (muteHost) muteHost.innerHTML = D.checkHtml({
        checked: !!state.mix.muted, cls: "amute", dataset: { audioCheck: "mute" },
        title: "Mute all audio", ariaLabel: "Mute all audio",
      });
      var clicksTile = pop.querySelector('[data-audio-check="clicks"]');
      if (clicksTile && clicksTile.parentNode) clicksTile.parentNode.innerHTML = D.checkHtml({
        checked: !!state.mix.uiClicks, cls: "aclicks", dataset: { audioCheck: "clicks" },
        title: "UI click sounds", ariaLabel: "UI click sounds",
      }) + '<span class="clicklbl">UI clicks (not in native DF)</span>';
      pop.querySelector("#dfAudioMaster").value = state.mix.master;
      pop.querySelector("#dfAudioMusic").value = state.mix.music;
      pop.querySelector("#dfAudioAmbient").value = state.mix.ambient;
      pop.querySelector("#dfAudioSfx").value = state.mix.sfx;
      pop.querySelector("#dfAudioUi").value = state.mix.ui;
      if (d.btn) d.btn.classList.toggle("df-muted", state.mix.muted);

      // Host gets the playlist; non-host sees only now-playing + personal mix. The cycler shows the
  
      var hostBox = pop.querySelector("#dfAudioHost");
      if (hostBox) hostBox.classList.toggle("audio-hidden", !isHost());
      if (state.musicTrack) state.trackPick = normalizeTrackPick(state.musicTrack);
      var trackHost = pop.querySelector("#dfAudioTrack");
      if (trackHost && trackHost.parentNode)
        trackHost.outerHTML = trackCyclerHtml(normalizeTrackPick(state.trackPick));

      var now = pop.querySelector("#dfAudioNow");
      var nowText = "";
      if (state.available && state.allowed && state.musicTrack) {
        nowText = (state.director.mode === "gap")
          ? "♪ " + trackLabel(state.musicTrack) + " — quiet interlude"
          : "♪ Now playing: " + trackLabel(state.musicTrack);
      }
      now.textContent = nowText;
      now.classList.toggle("audio-hidden", !nowText);

      var msg = pop.querySelector("#dfAudioMsg"), text = "";
      if (!state.probed) text = "";
      else if (!state.available) text = "Host needs a plugin update for audio.";
      else if (!state.allowed) text = "Host has not enabled remote audio — UI sounds only.";
      else if (!state.unlocked) text = "Click anywhere to enable sound.";
      msg.textContent = text;
      msg.classList.toggle("audio-hidden", !text);
    } catch (err) { audioErr.report("audio.popover-refresh", err); }
  }

  // ---- click sounds on UI interaction (opt-in) ------------------------------------------------
  function installClickSounds() {
    root.document.addEventListener("pointerdown", function (ev) {
      try {
        var t = ev.target && ev.target.closest && ev.target.closest("button,.square-button,[data-action]");
        if (!t) return;
        playClick(t.getAttribute && /confirm|play|ok/i.test(t.getAttribute("data-action") || "") ? "confirm" : "click");
      } catch (err) { audioErr.report("audio.click-handler", err); }
    }, true);
  }

  // ---- boot -----------------------------------------------------------------------------------
  function start() {
    if (DISABLED || state._started) return;
    state._started = true;
    installUnlock();
    buildUi();
    installClickSounds();
    hookPause();
    (function probeLoop() {
      probe().then(function (result) {
        if (result === "retry") { root.setTimeout(probeLoop, 4000); return; }
        if (!state.available) return;
        state.reportTimer = root.setInterval(pollReports, 2000);
        pollReports();                       // seed the cursor (no backlog replay)
        state.tickTimer = root.setInterval(envTick, TICK_MS);
        envTick(true);
        hookPause();
      });
    })();
  }
  function stop() {
    if (state.reportTimer) root.clearInterval(state.reportTimer);
    if (state.tickTimer) root.clearInterval(state.tickTimer);
    stopMusic(); silenceAmbience();
  }

  root.DwfAudio = {
    init: start, stop: stop,
    onReport: function (rep) { if (rep && !rep.continuation) playStinger(rep.typeKey); },
    onPause: onPause,
    playClick: playClick,
    storyMarkup: audioPanelMarkup,
    preparePreview: function () {},
    _state: state, _pure: PURE,
  };

  if (!DISABLED && !root.__DWF_STORY_MODE) {
    if (root.document && root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", start);
    } else { start(); }
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
