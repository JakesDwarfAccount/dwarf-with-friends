// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host_install_fixture_test.mjs -- OFFLINE fixture test for WT17 host tooling (host/hostlib.mjs
// pure parts + the install.mjs CLI end-to-end). NO Dwarf Fortress, NO server, NO real processes:
// every DF root / release / config file is a throwaway fixture INSIDE a temp dir.
//
//   node tools/harness/host_install_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// Follows the completeness protocol's "test the test" (rule 3): each parser also gets a
// deliberately-bad input it MUST discriminate, not just a happy path.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import process from "node:process";
import {
  resolveManifest, checkDfhack, autodetectDfRoot, steamDfCandidates,
  DFHACK_VERSION, inspectDfhackVersion,
  parsePassword, formatPassword, readPassword, writePassword,
  parseHostFlags, formatHostFlags, readHostFlags, writeHostFlags,
  parseAudioRemote, formatSoundConfig, readAudioRemote, writeSoundConfig,
  readPanelConfig, writePanelConfig, validServerPort,
  parseCloudflaredUrl, parseCloudflaredTarget,
  pickPort, makeReceipt, readReceipt, writeReceipt,
  generatePassword, tunnelWaitVerdict, LINK_WAIT_TIMEOUT_MS,
  tunnelWrapperCommand, JOB_LIMIT_KILL_ON_JOB_CLOSE,
  PASSWORD_FILE, HOST_FLAGS_FILE, SOUND_CONFIG_FILE, RECEIPT_FILE,
} from "../../host/hostlib.mjs";
import {
  downloadVerified, extractZipWindows, fetchCloudflared, fetchDfhack,
} from "../../host/fetchers.mjs";
import {
  validateDfRoot, detectSteamDfhack, setupSnapshot,
} from "../../host/setup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(here, "..", "..", "host", "install.mjs");

// The plugin identity was renamed dfcapture.* -> dwf.* (pkg-rename + pkg-host). Probe the shipped
// installer's own deploy map so these assertions track the ACTUAL contract in BOTH states: green on
// the unmerged base (still dfcapture.*) and green after the sibling lanes land (dwf.*). The HARD
// name-drift pin lives in pkg_install_roundtrip_test.mjs + release_zip_fixture_test.mjs. The web
// root name (hack/dfcapture-web) is UNCHANGED this wave, so it is never parameterized.
const HOST_ON_DWF = resolveManifest("D:\\DF", "R:\\rel")
  .find((e) => e.role === "dll").src.endsWith("dwf.plug.dll");
const DLL = HOST_ON_DWF ? "dwf.plug.dll" : "dfcapture.plug.dll";
const LUA = HOST_ON_DWF ? "dwf.lua" : "dfcapture.lua";
console.log(`# installer name contract: ${HOST_ON_DWF ? "dwf.* (merged)" : "dfcapture.* (unmerged base)"}  [dll=${DLL} lua=${LUA} web=dfcapture-web]`);

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

const TMP = mkdtempSync(join(os.tmpdir(), "dwf-host-"));
function tmp(sub) { const p = join(TMP, sub); mkdirSync(p, { recursive: true }); return p; }

try {
  // node --check on every new host file
  console.log("# node --check");
  for (const f of ["hostlib.mjs", "fetchers.mjs", "install.mjs", "setup.mjs", "setup.js", "host_panel.mjs", "panel.js"]) {
    const p = join(here, "..", "..", "host", f);
    try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); check(`${f} passes node --check`, true); }
    catch (e) { check(`${f} passes node --check`, false, e.stderr ? e.stderr.toString() : e.message); }
  }

  // ---------------- W12 setup wizard state (fake trees only) ----------------
  console.log("\n# setup wizard states");
  {
    const absent = setupSnapshot({ dfRoot: join(TMP, "does-not-exist"), exists: () => false });
    guard("no DF is a friendly dead-end and blocks DFHack/install",
      !absent.steps.df.ok && !absent.steps.dfhack.ok && !absent.steps.install.ok && /does not exist|Dwarf Fortress/i.test(absent.steps.df.error));

    const noHackRoot = tmp("wizard-no-dfhack");
    writeFileSync(join(noHackRoot, "Dwarf Fortress.exe"), "MZ");
    const noHack = setupSnapshot({ dfRoot: noHackRoot });
    guard("DF without DFHack offers the missing-DFHack state",
      noHack.steps.df.ok && noHack.steps.dfhack.missing && !noHack.steps.dfhack.ok);

    const wrongRoot = tmp("wizard-wrong-dfhack");
    writeFileSync(join(wrongRoot, "Dwarf Fortress.exe"), "MZ");
    mkdirSync(join(wrongRoot, "hack", "plugins"), { recursive: true });
    writeFileSync(join(wrongRoot, "dfhack-version.txt"), "DFHack 52.04-r3\n");
    const wrong = setupSnapshot({ dfRoot: wrongRoot });
    guard("wrong DFHack version is installed-but-blocking until proceed-anyway",
      wrong.steps.dfhack.installed && wrong.steps.dfhack.wrongVersion && !wrong.steps.dfhack.ok &&
      wrong.steps.dfhack.version.version === "52.04-r3");

    const steamDfRoot = join(tmp("wizard-steam"), "steamapps", "common", "Dwarf Fortress");
    mkdirSync(join(steamDfRoot, "hack", "plugins"), { recursive: true });
    writeFileSync(join(steamDfRoot, "Dwarf Fortress.exe"), "MZ");
    writeFileSync(join(steamDfRoot, ".dwf-dfhack-version"), DFHACK_VERSION + "\n");
    mkdirSync(join(dirname(steamDfRoot), "DFHack"), { recursive: true });
    const steam = setupSnapshot({ dfRoot: steamDfRoot });
    guard("Steam DFHack is detected so the wizard can warn about double-install conflicts",
      steam.steps.dfhack.ok && steam.steps.dfhack.steam.detected &&
      detectSteamDfhack(steamDfRoot).markers.some((p) => p.endsWith(join("common", "DFHack"))));

    const healthyRoot = tmp("wizard-healthy");
    writeFileSync(join(healthyRoot, "Dwarf Fortress.exe"), "MZ");
    mkdirSync(join(healthyRoot, "hack", "plugins"), { recursive: true });
    writeFileSync(join(healthyRoot, ".dwf-dfhack-version"), DFHACK_VERSION + "\n");
    const healthy = setupSnapshot({
      dfRoot: healthyRoot, installOk: true, receipt: { installedAt: "2026-07-14T00:00:00Z" },
      sprites: { bakeable: true, missingSources: [], missingBaked: [], bakedPresent: ["dwarf.png"] },
      cloudflared: { ok: true, note: "verified" }, shortcutExists: true,
    });
    check("healthy install renders all six setup steps green",
      Object.values(healthy.steps).every((item) => item.ok));

    const receiptRoot = tmp("wizard-prior-receipt");
    writeFileSync(join(receiptRoot, "Dwarf Fortress.exe"), "MZ");
    mkdirSync(join(receiptRoot, "hack", "plugins"), { recursive: true });
    writeFileSync(join(receiptRoot, ".dwf-dfhack-version"), DFHACK_VERSION + "\n");
    const priorReceipt = makeReceipt({ dfRoot: receiptRoot, releaseDir: "fixture-release", entries: [] });
    writeReceipt(receiptRoot, priorReceipt);
    const prior = setupSnapshot({ dfRoot: receiptRoot, receipt: readReceipt(receiptRoot),
      sprites: { bakeable: false, missingSources: ["premium-art.png"], missingBaked: [], bakedPresent: [] },
      cloudflared: { ok: false }, shortcutExists: false });
    check("prior install receipt is recognized and Classic sprites stay non-fatal",
      prior.steps.install.ok && prior.steps.install.receipt && prior.steps.sprites.ok && prior.steps.sprites.classic);

    guard("pasted path validator rejects a real folder that is not the DF executable folder",
      !validateDfRoot(tmp("wizard-not-df")).ok);

    const setupHtml = readFileSync(join(here, "..", "..", "host", "setup.html"), "utf8");
    const setupJs = readFileSync(join(here, "..", "..", "host", "setup.js"), "utf8");
    check("wizard exposes Steam/itch dead-end links and all six named steps",
      setupJs.includes("store.steampowered.com") && setupJs.includes("kitfoxgames.itch.io") &&
      ["Find Dwarf Fortress", "DFHack", "Install the mod", "Sprites", "Get cloudflared", "Finish"].every((s) => setupJs.includes(s)) &&
      setupHtml.includes("setup &amp; repair"));

    // Every non-trivial step carries a consistent "What is this?" explainer, and each blurb is wired
    // into its step body via info(INFO.<step>).
    check("wizard renders a consistent 'What is this?' explainer per step",
      setupJs.includes("<summary>What is this?</summary>") &&
      ["INFO.dfhack", "INFO.install", "INFO.sprites", "INFO.cloudflared", "INFO.finish"]
        .every((k) => setupJs.includes(`info(${k})`)));
    // Each blurb states the facts we verified against the code (so drift here trips the pin).
    check("DFHack blurb: modding engine, pinned 53.15-r1, hash-verified from official GitHub releases",
      /modding engine/i.test(INFO_dfhack()) && INFO_dfhack().includes("53.15-r1") &&
      /hash-verified/i.test(INFO_dfhack()) && /official GitHub releases/i.test(INFO_dfhack()));
    check("Install blurb: names the receipt, hack/plugins + web UI, quarantine-not-destroy",
      INFO_install().includes("dwf_install_receipt.json") && /plugins/.test(INFO_install()) &&
      /quarantined/i.test(INFO_install()) && /never destroyed/i.test(INFO_install()));
    check("Sprites blurb: bakes from YOUR copy, not shipped, nothing uploaded",
      /from YOUR installed copy/i.test(INFO_sprites()) && /copyrighted/i.test(INFO_sprites()) &&
      /nothing is uploaded/i.test(INFO_sprites()));
    check("cloudflared blurb: secure tunnel, SHA-256 verified, official Cloudflare GitHub, in-folder only",
      /secure tunnel/i.test(INFO_cloudflared()) && /SHA-256/i.test(INFO_cloudflared()) &&
      /Cloudflare's official GitHub releases/i.test(INFO_cloudflared()) &&
      /no system install/i.test(INFO_cloudflared()));
    guard("cloudflared blurb makes NO false LAN-skip claim (game server binds 127.0.0.1 only)",
      !/skip this step/i.test(INFO_cloudflared()) && !/local address/i.test(INFO_cloudflared()));
    check("Finish blurb: shortcut opens the host-panel launcher; friends only need the link",
      /desktop shortcut/i.test(INFO_finish()) && /host panel/i.test(INFO_finish()) &&
      /only need the link/i.test(INFO_finish()));

    // Pull each INFO.<step> string literal out of the setup.js source for the assertions above.
    function infoBlurb(key) {
      const m = setupJs.match(new RegExp(`${key}:\\s*\`([\\s\\S]*?)\``));
      return m ? m[1] : "";
    }
    function INFO_dfhack() { return infoBlurb("dfhack"); }
    function INFO_install() { return infoBlurb("install"); }
    function INFO_sprites() { return infoBlurb("sprites"); }
    function INFO_cloudflared() { return infoBlurb("cloudflared"); }
    function INFO_finish() { return infoBlurb("finish"); }
  }

  // ---------------- pinned download fetchers (all transports are local stubs) ----------------
  console.log("\n# fetchers (offline stubs)");
  {
    const payload = Buffer.from("fixture download payload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const manifest = {
      dfhack: {
        version: DFHACK_VERSION,
        url: "https://github.invalid/dfhack.zip",
        manualUrl: "https://github.com/DFHack/dfhack/releases/tag/53.15-r1",
        sha256,
      },
      cloudflared: {
        version: "fixture",
        url: "https://github.invalid/cloudflared.exe",
        manualUrl: "https://github.invalid/cloudflared-manual",
        sha256,
      },
    };
    const goodDownload = async (_url, destination) => writeFileSync(destination, payload);

    const verified = join(tmp("fetch-ok"), "artifact.exe");
    const good = await downloadVerified({ url: manifest.cloudflared.url, sha256, destination: verified, download: goodDownload });
    check("verified download lands only at its final destination",
      good.ok && readFileSync(verified).equals(payload));

    const mismatchDest = join(tmp("fetch-mismatch"), "artifact.exe");
    const mismatch = await downloadVerified({
      url: manifest.cloudflared.url, sha256: "0".repeat(64), destination: mismatchDest, download: goodDownload,
    });
    guard("checksum mismatch is friendly and leaves no executable or .part file",
      !mismatch.ok && /checksum mismatch/i.test(mismatch.error) && !existsSync(mismatchDest) &&
      !readdirSync(dirname(mismatchDest)).some((name) => name.includes(".part-")));

    const halfwayDest = join(tmp("fetch-halfway"), "artifact.exe");
    const halfway = await downloadVerified({
      url: manifest.cloudflared.url, sha256, destination: halfwayDest,
      download: async (_url, destination) => { writeFileSync(destination, payload.subarray(0, 5)); throw new Error("connection reset halfway"); },
    });
    guard("mid-download failure removes partial bytes and gives the manual path",
      !halfway.ok && /connection reset halfway/i.test(halfway.error) &&
      halfway.manual.destination === halfwayDest && !existsSync(halfwayDest));

    const offlineDest = join(tmp("fetch-offline"), "artifact.exe");
    const offline = await downloadVerified({
      url: manifest.cloudflared.url, sha256, destination: offlineDest,
      download: async () => { throw new Error("GitHub is unreachable"); },
    });
    guard("GitHub-unreachable failure names the manual URL and exact destination without a stack",
      !offline.ok && offline.error.includes(manifest.cloudflared.url) && offline.error.includes(offlineDest) &&
      !offline.error.includes("at file:"));

    const cfRoot = tmp("fetch-cloudflared");
    const cf = await fetchCloudflared({ dwfRoot: cfRoot, manifest, download: goodDownload });
    check("cloudflared fetch installs the verified single executable in the DWF folder",
      cf.ok && cf.destination === join(cfRoot, "cloudflared.exe") && readFileSync(cf.destination).equals(payload));
    let repeatedDownload = false;
    const cfAgain = await fetchCloudflared({ dwfRoot: cfRoot, manifest,
      download: async () => { repeatedDownload = true; } });
    guard("already-verified cloudflared is idempotent and does not download again",
      cfAgain.ok && cfAgain.alreadyInstalled && !repeatedDownload);

    const dfr = tmp("fetch-dfhack");
    writeFileSync(join(dfr, "Dwarf Fortress.exe"), "MZ");
    const df = await fetchDfhack({ dfRoot: dfr, manifest, download: goodDownload,
      extract: async (_archive, stage) => {
        mkdirSync(join(stage, "hack", "plugins"), { recursive: true });
        writeFileSync(join(stage, "dfhack.exe"), "fixture");
      } });
    check("DFHack fetch downloads, verifies, extracts, and records the pinned version",
      df.ok && existsSync(join(dfr, "hack", "plugins")) &&
      readFileSync(join(dfr, ".dwf-dfhack-version"), "utf8").trim() === DFHACK_VERSION);

    const dfOfflineRoot = tmp("fetch-dfhack-offline");
    writeFileSync(join(dfOfflineRoot, "Dwarf Fortress.exe"), "MZ");
    const dfOffline = await fetchDfhack({ dfRoot: dfOfflineRoot, manifest,
      download: async () => { throw new Error("GitHub is unreachable"); } });
    guard("DFHack offline dead-end gives its release page and exact extraction folder",
      !dfOffline.ok && dfOffline.manual.url === manifest.dfhack.manualUrl &&
      dfOffline.manual.destination === dfOfflineRoot && dfOffline.error.includes(dfOfflineRoot));

    const wrongRoot = tmp("fetch-wrong-version");
    writeFileSync(join(wrongRoot, "Dwarf Fortress.exe"), "MZ");
    mkdirSync(join(wrongRoot, "hack", "plugins"), { recursive: true });
    writeFileSync(join(wrongRoot, "dfhack-version.txt"), "DFHack 52.04-r3\n");
    let wrongDownloaded = false;
    const wrong = await fetchDfhack({ dfRoot: wrongRoot, manifest,
      download: async () => { wrongDownloaded = true; } });
    guard("existing wrong-version DFHack is detected, warned, and never overwritten",
      !wrong.ok && wrong.wrongVersion && /requires exactly 53\.15-r1/i.test(wrong.error) && !wrongDownloaded);
    check("version inspector distinguishes the pinned version",
      inspectDfhackVersion(dfr).compatible === true && inspectDfhackVersion(wrongRoot).compatible === false);

    const extractCalls = [];
    const extractDest = tmp("extract-fallback");
    const fallback = await extractZipWindows("fixture.zip", extractDest, async (command) => {
      extractCalls.push(command);
      if (command === "tar.exe") throw new Error("tar unavailable");
    });
    check("zip extraction falls back from tar.exe to PowerShell Expand-Archive",
      fallback.tool === "PowerShell Expand-Archive" && extractCalls.join(",") === "tar.exe,powershell.exe");

    const panelHtml = readFileSync(join(here, "..", "..", "host", "panel.html"), "utf8");
    const panelServer = readFileSync(join(here, "..", "..", "host", "host_panel.mjs"), "utf8");
    check("missing-cloudflared refusal offers the explicit fetch action",
      panelHtml.includes('data-action="fetch-cf"') && panelServer.includes('action === "fetch-cf"'));
  }

  // ---------------- manifest resolution ----------------
  console.log("\n# resolveManifest");
  {
    const m = resolveManifest("D:\\DF", "R:\\rel");
    const by = Object.fromEntries(m.map((e) => [e.role, e]));
    check(`dll -> hack/plugins/${DLL}`,
      by.dll.dest.endsWith(join("hack", "plugins", DLL)) &&
      by.dll.src.endsWith(DLL));
    check("lua deployed to BOTH plugins and scripts",
      by["lua-plugins"].dest.endsWith(join("hack", "lua", "plugins", LUA)) &&
      by["lua-scripts"].dest.endsWith(join("hack", "scripts", LUA)));
    check("both lua entries share ONE source", by["lua-plugins"].src === by["lua-scripts"].src);
    check("web is a dir entry -> hack/dfcapture-web (name unchanged this wave)",
      by.web.kind === "dir" && by.web.dest.endsWith(join("hack", "dfcapture-web")));
    guard("manifest does NOT deploy lua to hack/plugins root (a real past trap)",
      !m.some((e) => e.dest.endsWith(join("hack", "plugins", LUA))));
    // pkg-host adds a gui mirror entry post-merge: release/gui/dwf.lua -> hack/scripts/gui/dwf.lua.
    if (HOST_ON_DWF) {
      check("gui lua entry -> hack/scripts/gui/dwf.lua",
        !!by["lua-gui"] && by["lua-gui"].dest.endsWith(join("hack", "scripts", "gui", "dwf.lua")) &&
        by["lua-gui"].src.endsWith(join("gui", "dwf.lua")));
    } else {
      console.log("  SKIP - (post-merge-only) gui lua entry hack/scripts/gui/dwf.lua (pkg-host adds it)");
    }
  }

  // ---------------- DFHack detection (injected exists) ----------------
  console.log("\n# checkDfhack");
  {
    const good = new Set([
      "X:\\DF", "X:\\DF\\Dwarf Fortress.exe", "X:\\DF\\hack", "X:\\DF\\hack\\plugins",   // dfroot-gate: allow -- synthetic fixture drive; nothing here is ever opened
    ].map((s) => s.replace(/\//g, "\\")));
    // Normalize to backslashes: on a POSIX runner join() emits X:\DF/hack for these synthetic paths.
    const ex = (p) => good.has(String(p).replace(/\//g, "\\"));
    check("complete install -> ok", checkDfhack("X:\\DF", ex).ok);
    const noHack = checkDfhack("X:\\DF2", (p) => p === "X:\\DF2" || p === "X:\\DF2\\Dwarf Fortress.exe");   // dfroot-gate: allow -- synthetic fixture drive
    guard("DF present but DFHack missing -> not ok + names the hack folder",
      !noHack.ok && noHack.problems.some((s) => /hack/i.test(s)));
    const missing = checkDfhack("X:\\Nope", () => false);
    guard("missing folder -> not ok", !missing.ok);
  }

  // ---------------- autodetect + candidates ----------------
  console.log("\n# autodetectDfRoot");
  {
    const cands = steamDfCandidates(["F"]);
    check("F: drive candidate list includes the real SteamLibrary path",
      cands.some((c) => /F:\\SteamLibrary\\steamapps\\common\\Dwarf Fortress/.test(c)));   // dfroot-gate: allow -- asserts the resolver EMITS this candidate; it is output, not configuration
    const target = cands[0];
    const present = new Set([target, target + "\\Dwarf Fortress.exe", target + "\\hack", target + "\\hack\\plugins"]);
    check("picks the first candidate that is a complete DFHack install",
      autodetectDfRoot(cands, (p) => present.has(p)) === target);
    guard("returns null when nothing matches", autodetectDfRoot(cands, () => false) === null);
  }

  // ---------------- password round-trip ----------------
  console.log("\n# join password");
  {
    check("parse first non-blank line", parsePassword("\n\n  hunter2  \n") === "hunter2");
    guard("parse SKIPS a leading comment line", parsePassword("# my note\nrealpass\n") === "realpass");
    guard("empty/whitespace file -> '' (auth disabled)", parsePassword("   \n\n") === "");
    check("format non-empty -> value + newline", formatPassword("  abc ") === "abc\n");
    guard("format empty -> '' (empty file disables auth)", formatPassword("   ") === "");
    const df = tmp("pwroot");
    writePassword(df, "swordfish");
    check("password file written to the right name",
      existsSync(join(df, PASSWORD_FILE)));
    check("password round-trips through disk", readPassword(df) === "swordfish");
    writePassword(df, "");
    check("clearing writes an empty file -> readPassword ''", readPassword(df) === "");
    check("missing file -> readPassword ''", readPassword(tmp("emptyroot")) === "");
  }

  // ---------------- host flags round-trip ----------------
  console.log("\n# host flags");
  {
    const d = parseHostFlags(null);
    check("defaults: hostunpause off, autopause on", d.hostunpause === false && d.autopause === true);
    const p = parseHostFlags("hostunpause=on\nautopause=off\n");
    check("parses on/off", p.hostunpause === true && p.autopause === false);
    guard("accepts 1/true as on", parseHostFlags("autopause=1\nhostunpause=true").autopause === true && parseHostFlags("hostunpause=true").hostunpause === true);
    check("format shape", formatHostFlags({ hostunpause: true, autopause: false }) === "hostunpause=on\nautopause=off\n");
    const dfr = tmp("flagroot");
    writeHostFlags(dfr, { hostunpause: true, autopause: false });
    const rt = readHostFlags(dfr);
    check("round-trips through disk", rt.hostunpause === true && rt.autopause === false);
    check("written to right file", existsSync(join(dfr, HOST_FLAGS_FILE)));
  }

  // ---------------- sound config (audio_remote) ----------------
  console.log("\n# audio_remote");
  {
    check("missing -> default ON", parseAudioRemote(null) === true);
    guard("explicit false disables", parseAudioRemote('{ "audio_remote": false }') === false);
    check("explicit true enables", parseAudioRemote('{"audio_remote":true}') === true);
    guard("unrelated json -> default ON (not off)", parseAudioRemote('{"foo":1}') === true);
    const dfr = tmp("audioroot");
    writeSoundConfig(dfr, false);
    check("written under dfhack-config/", existsSync(join(dfr, SOUND_CONFIG_FILE)));
    check("round-trips false", readAudioRemote(dfr) === false);
    writeSoundConfig(dfr, true);
    check("round-trips true", readAudioRemote(dfr) === true);
  }

  // ---------------- host-panel port config ----------------
  console.log("\n# host panel config");
  {
    const dfr = tmp("panel-config");
    check("missing host-panel config defaults to port 8765", readPanelConfig(dfr).port === 8765);
    writePanelConfig(dfr, { port: 9123 });
    check("game connection port persists through the fake DF tree", readPanelConfig(dfr).port === 9123);
    guard("invalid ports are rejected by validation", validServerPort(0) === null && validServerPort(65536) === null && validServerPort("abc") === null);

    const panelHtml = readFileSync(join(here, "..", "..", "host", "panel.html"), "utf8");
    const panelJs = readFileSync(join(here, "..", "..", "host", "panel.js"), "utf8");
    const panelServer = readFileSync(join(here, "..", "..", "host", "host_panel.mjs"), "utf8");
    check("W15 primary button and friend URL/password/copy surface are present",
      panelHtml.includes('id="start-hosting"') && panelHtml.includes('id="friend-url"') &&
      panelHtml.includes('id="friend-password"') && panelHtml.includes('data-copy="friend-url"'));
    check("W15 waits for manual fortress load, starts the stream, then cloudflared",
      panelServer.includes("Now load your fortress — I’ll wait.") &&
      panelServer.includes('["capture-stream-start", String(GAME_PORT), "127.0.0.1"]') &&
      panelServer.indexOf("capture-stream-start") < panelServer.indexOf('action: "start-cf"'));
    check("Config labels are the approved plain-English wording",
      ["Join password", "Only I can unpause", "Pause when someone disconnects",
       "Friends can hear game audio", "Game connection port"].every((label) => panelHtml.includes(label)) &&
      panelJs.includes('port: Number($("#c-port").value)'));
  }

  // ---------------- host panel v1 redesign (owner findings 1-6) ----------------
  // The redesign's PURE decision logic + the shipped page/server pins. No server here (that lives
  // in hostpanel_test.mjs's spawned-panel section); this block guards the offline-checkable half.
  console.log("\n# host panel v1 redesign");
  {
    // --- Finding 2/3: tunnelWaitVerdict, the deadlock/timeout POLICY (all five verdicts + guard) ---
    // ready: a URL is known -> stop waiting, we're live.
    check("verdict ready when a friend URL is known",
      tunnelWaitVerdict({ url: "https://x.trycloudflare.com", running: true, logExists: true, startedByPanel: true, waitedMs: 0 }) === "ready");
    // no-tunnel: nothing is running -> caller should start one.
    check("verdict no-tunnel when cloudflared is not running",
      tunnelWaitVerdict({ url: null, running: false, logExists: false, startedByPanel: false, waitedMs: 0 }) === "no-tunnel");
    // unreadable (finding 2, the adoption deadlock the owner hit): a FOREIGN cloudflared we didn't
    // start, with no log of ours to read -> surface it NOW, never spin forever.
    check("verdict unreadable when a foreign cloudflared runs with no readable log (adoption deadlock)",
      tunnelWaitVerdict({ url: null, running: true, logExists: false, startedByPanel: false, waitedMs: 0 }) === "unreadable");
    // timeout (finding 3): our own tunnel, but no link after timeoutMs -> surface log + retry.
    check("verdict timeout once waitedMs passes timeoutMs",
      tunnelWaitVerdict({ url: null, running: true, logExists: true, startedByPanel: true, waitedMs: 30001, timeoutMs: 30000 }) === "timeout");
    // wait: our own tunnel, still inside the window -> keep polling (bounded).
    check("verdict wait while inside the timeout window",
      tunnelWaitVerdict({ url: null, running: true, logExists: true, startedByPanel: true, waitedMs: 1000, timeoutMs: 30000 }) === "wait");
    // GUARD (test-the-test): startedByPanel:true must SUPPRESS the unreadable verdict even with no
    // log yet -- our own just-spawned tunnel is not the foreign-deadlock case, it just needs a beat.
    guard("startedByPanel:true suppresses 'unreadable' (our own fresh tunnel is not the deadlock)",
      tunnelWaitVerdict({ url: null, running: true, logExists: false, startedByPanel: true, waitedMs: 0, timeoutMs: 30000 }) === "wait");
    guard("default timeout constant is 30s (env override is host_panel's job, not the policy's)",
      LINK_WAIT_TIMEOUT_MS === 30000);

    // --- Finding 6: generatePassword shape + variation (feeds the Generate button + "generate" policy) ---
    check("generatePassword shape is word-word-NN", /^[a-z]+-[a-z]+-\d{2}$/.test(generatePassword()));
    guard("generatePassword varies with the injected RNG (not a constant)", (() => {
      const seq = [0.01, 0.99, 0.5];   // deterministic, distinct picks
      let i = 0; const rand = () => seq[i++ % seq.length];
      let j = 0; const rand2 = () => [0.9, 0.1, 0.2][j++ % 3];
      return generatePassword(rand) !== generatePassword(rand2) &&
             /^[a-z]+-[a-z]+-\d{2}$/.test(generatePassword(rand));
    })());

    // --- Page pins: one page, three headed sections, NO tabs, honest open-door copy ---
    const panelHtml = readFileSync(join(here, "..", "..", "host", "panel.html"), "utf8");
    const panelJs = readFileSync(join(here, "..", "..", "host", "panel.js"), "utf8");
    const panelServer = readFileSync(join(here, "..", "..", "host", "host_panel.mjs"), "utf8");
    const OPEN_DOOR = "anyone with the link can join";
    check("finding 1: three headed sections Status / Friend access / Tunnel & controls",
      /<h2>Status<\/h2>/.test(panelHtml) && /<h2>Friend access<\/h2>/.test(panelHtml) &&
      /<h2>Tunnel &amp; controls<\/h2>/.test(panelHtml));
    guard("finding 1: the tab/corner-nav layout is GONE (no class=\"tab \" survivors)",
      !/class="tab /.test(panelHtml) && !/class="tabs"/.test(panelHtml));
    check("finding 2/3: the stuck-link Retry hero (#retry-link) is on the page",
      panelHtml.includes('id="retry-link"') && panelHtml.includes('id="hosting-stuck"'));
    check("finding 4: friend link carries the dead-link paint hook (is-dead in css/js)",
      panelJs.includes('"friend-url is-dead"'));

    // --- Finding 6: the open (no-password) state is LOUD + LABELED, never a silently-empty field ---
    // The honesty contract: with no password, the panel shows an explicit labeled open-door line and
    // a one-click "Set a password", plus a masked (never blank) value box when a password IS set.
    const passwordStateHonest = (html) =>
      html.includes(OPEN_DOOR) && html.includes('id="pw-set"') && /id="pw-row-open"/.test(html) &&
      html.includes('id="pw-toggle"');
    check("finding 6: open state renders the honest 'anyone with the link can join' + Set control",
      passwordStateHonest(panelHtml));
    // SEEDED-BAD (test-the-test): a silently-empty, unlabeled password box -- the exact anti-pattern
    // the owner rejected -- MUST fail the honesty pin. If this ever passes, the contract has rotted.
    guard("seeded-bad: a silently-empty unlabeled password state FAILS the honesty pin",
      !passwordStateHonest('<div id="pw-row-open"><code id="friend-password"></code></div>'));

    // --- Server source pins: the six findings are wired in host_panel.mjs (not just the page) ---
    check("finding 6: DEFAULT_PASSWORD_POLICY is the ratified \"open\", applied only on a fresh install",
      /DEFAULT_PASSWORD_POLICY\s*=\s*"open"/.test(panelServer) &&
      /existsSync\(passwordFilePath\(DF_ROOT\)\)/.test(panelServer));
    check("finding 4: stop path taskkills THEN polls processRunning before claiming stopped",
      (() => {
        const kill = panelServer.indexOf('taskkill", ["/IM", "cloudflared.exe"');
        const poll = panelServer.indexOf('processRunning("cloudflared.exe")', kill);
        const gate = panelServer.indexOf("stopped: true", kill);
        return kill > -1 && poll > kill && gate > poll;   // kill -> confirm-gone -> only then stopped:true
      })());
    check("finding 5: live password apply reads the OLD password, writes the file, THEN POSTs /join-password",
      (() => {
        const prev = panelServer.indexOf("const prev = readPassword(DF_ROOT)");
        const write = panelServer.indexOf("writePassword(DF_ROOT, next)", prev);
        const live = panelServer.indexOf('gamePostForm("/join-password"', write);
        return prev > -1 && write > prev && live > write && /cookiePw:\s*prev/.test(panelServer);
      })());
    check("finding 3: LINK_TIMEOUT_MS honors the DWF_LINK_TIMEOUT_MS env override for fast tests",
      /DWF_LINK_TIMEOUT_MS/.test(panelServer));
    check("finding 2/3: the hosting flow is wired through tunnelWaitVerdict -> link-stuck",
      /tunnelWaitVerdict\(\{/.test(panelServer) &&
      /verdict === "unreadable"/.test(panelServer) && /verdict === "timeout"/.test(panelServer) &&
      /setHosting\("link-stuck"/.test(panelServer));

    // --- Orphaned-tunnel fix: terminal exit (Ctrl+C / Ctrl+Break / window close) kills OUR tunnel ---
    // The bug: cloudflared is spawned detached+unref'd, and the panel registered NO signal handlers,
    // so Ctrl+C exited node and left the tunnel serving the public friend link. The pin: all four
    // terminal signals are wired to a shutdown that runs the tunnel stop, THEN exits. (Runtime
    // behavior -- the pid actually dying -- is exercised in hostpanel_test.mjs section 11.)
    const signalCleanupPinned = (src) => {
      const reg = /for \(const sig of \[([^\]]*)\]\)[^]{0,200}?process\.on\(sig, \(\) => shutdown\(sig\)\)/.exec(src);
      if (!reg) return false;
      if (!["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"].every((s) => reg[1].includes(`"${s}"`))) return false;
      const sd = src.indexOf("function shutdown(");
      if (sd < 0) return false;
      const body = src.slice(sd, sd + 1200);
      return /stopTunnelOnExit\(\)/.test(body) && /process\.exit\(0\)/.test(body);
    };
    check("orphan fix: SIGINT/SIGTERM/SIGBREAK/SIGHUP are all wired to the tunnel-stopping shutdown",
      signalCleanupPinned(panelServer));
    guard("seeded-bad: removing the signal registration FAILS the pin (= orphaned tunnel on Ctrl+C)",
      !signalCleanupPinned(panelServer.replace("process.on(sig, () => shutdown(sig))", "void 0")));
    check("orphan fix: the spawned cloudflared pid is TRACKED for a pid-targeted kill (not image-name nuking)",
      /TUNNEL\.pid = child\.pid/.test(panelServer) &&
      panelServer.includes('taskkill", ["/PID", String(TUNNEL.pid), "/T", "/F"]'));
    check("orphan fix: an impatient SECOND Ctrl+C force-exits instead of hanging",
      /if \(SHUTTING_DOWN\) process\.exit\(1\)/.test(panelServer));
    check("orphan fix: the signal exit is CAPPED by a hard-stop timer (a slow kill can't hang Ctrl+C)",
      /setTimeout\(\(\) => process\.exit\(1\), \d+\)/.test(panelServer));
    check("orphan fix idempotent: the Stop button's confirmed stop clears TUNNEL.pid (Stop then Ctrl+C is clean)",
      (() => {
        const stop = panelServer.indexOf("async function stopCloudflaredConfirmed");
        return stop > -1 && panelServer.indexOf("TUNNEL.pid = 0", stop) > stop;
      })());
    check("orphan fix: a synchronous 'exit' fallback still taskkills the tracked pid (handler-less exits)",
      /process\.on\("exit",[^]{0,400}?execFileSync\("taskkill", \["\/PID"/.test(panelServer));

    // --- Job-object backstop: cloudflared is spawned INSIDE a kill-on-close job, tied to the panel ---
    // Signal handlers alone are NOT enough on Windows: cmd's "Terminate batch job (Y/N)?" answered Y
    // force-kills node MID-cleanup, and closing the console window (the X) delivers CTRL_CLOSE_EVENT
    // unreliably with a short OS deadline -- a detached cloudflared survives both. The fix: the panel
    // never spawns cloudflared directly/detached; it spawns the powershell job wrapper as a plain
    // child, and the KERNEL kills cloudflared when the panel dies by any means. Pin both halves.
    // (1) The wrapper builder itself: powershell, encoded script with KILL_ON_JOB_CLOSE + panel-pid
    //     watch, all variable data in env (no quoting surface).
    const wrap = tunnelWrapperCommand({ exe: "C:\\x y\\cloudflared.exe", args: ["tunnel", "--url", "http://localhost:8765"], panelPid: 4242 });
    const wrapScript = Buffer.from(wrap.args[wrap.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    check("job wrapper: powershell -EncodedCommand carrying the job-object script",
      wrap.file === "powershell.exe" && wrap.args.includes("-EncodedCommand") && wrap.args.includes("-NonInteractive"));
    check("job wrapper: script creates a KILL_ON_JOB_CLOSE job and assigns cloudflared to it",
      wrapScript.includes("0x2000") && wrapScript.includes("AssignProcessToJobObject") &&
      wrapScript.includes("CreateJobObject") && JOB_LIMIT_KILL_ON_JOB_CLOSE === 0x2000);
    check("job wrapper: script watches the panel pid and exits when the panel dies (job handle closes -> kernel kills cloudflared)",
      wrapScript.includes("DWF_PANEL_PID") && wrapScript.includes("HasExited") &&
      /if \(-not \$cf\.HasExited\) \{ try \{ \$cf\.Kill\(\) \} catch \{\} \}/.test(wrapScript));
    check("job wrapper: exe/args/pid ride in env vars, args pre-quoted (paths with spaces survive)",
      wrap.env.DWF_TUNNEL_EXE === "C:\\x y\\cloudflared.exe" && wrap.env.DWF_PANEL_PID === "4242" &&
      wrap.env.DWF_TUNNEL_ARGS === "tunnel --url http://localhost:8765" &&
      tunnelWrapperCommand({ exe: "x", args: ['a b'], panelPid: 1 }).env.DWF_TUNNEL_ARGS === '"a b"');
    // (2) The panel's start-cf spawn goes THROUGH the wrapper and is NOT detached. A detached
    //     direct spawn -- the exact pre-fix shape -- must fail this pin.
    const jobSpawnPinned = (src) => {
      const s = src.indexOf('action === "start-cf"');
      if (s < 0) return false;
      const seg = src.slice(s, src.indexOf('action === "fetch-cf"', s));
      return /tunnelWrapperCommand\(\{/.test(seg) && /spawn\(wrap\.file, wrap\.args/.test(seg) &&
             !/detached:\s*true/.test(seg);
    };
    check("job wrapper: start-cf spawns cloudflared through the wrapper, NOT detached",
      jobSpawnPinned(panelServer));
    guard("seeded-bad: the old detached direct spawn FAILS the job-wrapper pin (= tunnel outlives the panel)",
      !jobSpawnPinned(panelServer.replace(/const wrap = tunnelWrapperCommand\(\{[^]*?spawn\(wrap\.file, wrap\.args, \{[^]*?windowsHide: true,\n\s*\}\);/,
        'const child = spawn(cf, ["tunnel", "--url", `http://localhost:${GAME_PORT}`], {\n        detached: true, stdio: ["ignore", logStream, logStream], windowsHide: true,\n      });')));
  }

  // ---------------- cloudflared parsing ----------------
  console.log("\n# cloudflared parsing");
  {
    const log = [
      "2026-07-11T03:14:00Z INF Thank you for trying Cloudflare Tunnel.",
      "2026-07-11T03:14:01Z INF +--------------------------------------------------------+",
      "2026-07-11T03:14:01Z INF |  https://calm-frost-1234.trycloudflare.com             |",
      "2026-07-11T03:14:01Z INF +--------------------------------------------------------+",
    ].join("\n");
    check("parses the quick-tunnel URL from a log", parseCloudflaredUrl(log) === "https://calm-frost-1234.trycloudflare.com");
    guard("returns null when no trycloudflare URL present", parseCloudflaredUrl("INF starting metrics server on 127.0.0.1:20241") === null);
    guard("null/empty input -> null", parseCloudflaredUrl("") === null && parseCloudflaredUrl(null) === null);
    check("recovers --url target from a cmdline",
      parseCloudflaredTarget('cloudflared.exe tunnel --url http://localhost:8765') === "http://localhost:8765");
    guard("target null when no --url", parseCloudflaredTarget("cloudflared.exe --version") === null);
  }

  // ---------------- port fallback ----------------
  console.log("\n# port fallback");
  {
    const busy = new Set([8790, 8791, 8792]);
    check("skips busy ports to first free", pickPort(8790, (p) => !busy.has(p)) === 8793);
    check("start free -> returns start", pickPort(9000, () => true) === 9000);
    guard("none free within tries -> -1", pickPort(1, () => false, 5) === -1);
  }

  // ---------------- receipt round-trip ----------------
  console.log("\n# install receipt");
  {
    const dfr = tmp("receiptroot");
    const entries = resolveManifest(dfr, "R:\\rel");
    const rec = makeReceipt({ dfRoot: dfr, releaseDir: "R:\\rel", entries, versions: { release: "1.2.3" } });
    writeReceipt(dfr, rec);
    check("receipt file at right name", existsSync(join(dfr, RECEIPT_FILE)));
    const back = readReceipt(dfr);
    check("round-trips versions + files", back.versions.release === "1.2.3" && back.files.length === entries.length);
    check("records every deployed role", back.files.map((f) => f.role).sort().join(",") ===
      (HOST_ON_DWF ? "dll,lua-gui,lua-plugins,lua-scripts,web" : "dll,lua-plugins,lua-scripts,web"));
    check("missing receipt -> null", readReceipt(tmp("noreceipt")) === null);
    guard("corrupt receipt -> null (no throw)", (() => { const d = tmp("badreceipt"); writeFileSync(join(d, RECEIPT_FILE), "{not json"); return readReceipt(d) === null; })());
  }

  // ---------------- installer end-to-end (CLI, real temp fixtures) ----------------
  console.log("\n# install.mjs end-to-end");
  {
    // Build a fake DF-root that looks like a DFHack install.
    const dfr = tmp("e2e-df");
    writeFileSync(join(dfr, "Dwarf Fortress.exe"), "MZ");           // pretend exe
    mkdirSync(join(dfr, "hack", "plugins"), { recursive: true });
    mkdirSync(join(dfr, "hack", "lua", "plugins"), { recursive: true });
    mkdirSync(join(dfr, "hack", "scripts"), { recursive: true });
    mkdirSync(join(dfr, "hack", "dfcapture-web"), { recursive: true });
    // Pre-existing web file to force a backup on upgrade.
    mkdirSync(join(dfr, "hack", "dfcapture-web", "js"), { recursive: true });
    writeFileSync(join(dfr, "hack", "dfcapture-web", "js", "app.js"), "OLD VERSION\n");

    // Build a fake release (names track the shipped installer's contract).
    const rel = tmp("e2e-rel");
    writeFileSync(join(rel, DLL), "DLLBYTES-v1");
    writeFileSync(join(rel, LUA), "-- lua v1\n");
    // gui mirror source (deployed only when the installer is on the dwf.* contract; harmless on base).
    mkdirSync(join(rel, "gui"), { recursive: true });
    writeFileSync(join(rel, "gui", "dwf.lua"), "-- gui lua v1\n");
    mkdirSync(join(rel, "web", "js"), { recursive: true });
    writeFileSync(join(rel, "web", "index.html"), "<html>v1</html>\n");
    writeFileSync(join(rel, "web", "js", "app.js"), "NEW VERSION\n");
    writeFileSync(join(rel, "VERSION.txt"), "1.0.0-test\n");

    const backupRoot = tmp("e2e-backup");
    // These fixtures use FAKE DF roots, so the DF-running pre-flight must be pinned OFF (the real
    // game may be running on the dev machine and would otherwise refuse every fixture install).
    // Individual tests override DWF_ASSUME_DF_RUNNING via extraEnv to exercise the refusal path.
    const runInstall = (args, extraEnv = {}) => {
      const outv = execFileSync(process.execPath, [INSTALL, ...args], {
        env: { ...process.env, DWF_BACKUP_ROOT: backupRoot, DWF_ASSUME_DF_RUNNING: "0", ...extraEnv }, stdio: "pipe",
      });
      return JSON.parse(outv.toString());
    };

    // --check BEFORE install: not installed.
    let chk;
    try { execFileSync(process.execPath, [INSTALL, "--df-root", dfr, "--release", rel, "--check", "--json"], { env: { ...process.env, DWF_BACKUP_ROOT: backupRoot }, stdio: "pipe" }); chk = { ok: true }; }
    catch (e) { chk = JSON.parse(e.stdout.toString()); }  // exit 3
    guard("--check before install reports NOT up to date", chk.ok === false);

    // install
    const res = runInstall(["--df-root", dfr, "--release", rel, "--json", "--yes"]);
    check("install reports ok", res.ok === true && res.stage === "installed");
    check("dll deployed", existsSync(join(dfr, "hack", "plugins", DLL)) &&
      readFileSync(join(dfr, "hack", "plugins", DLL), "utf8") === "DLLBYTES-v1");
    check("lua deployed to BOTH paths",
      readFileSync(join(dfr, "hack", "lua", "plugins", LUA), "utf8") === "-- lua v1\n" &&
      readFileSync(join(dfr, "hack", "scripts", LUA), "utf8") === "-- lua v1\n");
    if (HOST_ON_DWF) {
      check("gui lua deployed to hack/scripts/gui/dwf.lua",
        readFileSync(join(dfr, "hack", "scripts", "gui", "dwf.lua"), "utf8") === "-- gui lua v1\n");
    }
    check("web tree deployed (new app.js overwrote old)",
      readFileSync(join(dfr, "hack", "dfcapture-web", "js", "app.js"), "utf8") === "NEW VERSION\n" &&
      existsSync(join(dfr, "hack", "dfcapture-web", "index.html")));
    check("receipt written with version", (readReceipt(dfr) || {}).versions?.release === "1.0.0-test");
    check("backup captured the overwritten app.js",
      res.backupDir && existsSync(join(res.backupDir, "hack", "dfcapture-web", "js", "app.js")) &&
      readFileSync(join(res.backupDir, "hack", "dfcapture-web", "js", "app.js"), "utf8") === "OLD VERSION\n");

    // W11: the fixture DF root has no data/vanilla art, so the sprite bake must
    // fail NON-fatally (install still ok) with the graphical-edition message.
    check("sprite bake on art-less fixture: non-fatal, clear message, recorded in receipt",
      res.spriteBake && res.spriteBake.ok === false &&
      (res.spriteBake.problems || []).some((s) => /DF art|graphical/i.test(s)) &&
      (readReceipt(dfr) || {}).spriteBake?.ok === false);

    // --check AFTER install: up to date (exit 0, no throw).
    let post;
    try { post = JSON.parse(execFileSync(process.execPath, [INSTALL, "--df-root", dfr, "--release", rel, "--check", "--json"], { env: { ...process.env, DWF_BACKUP_ROOT: backupRoot }, stdio: "pipe" }).toString()); }
    catch (e) { post = JSON.parse(e.stdout.toString()); }
    check("--check after install reports up to date", post.ok === true && (post.missing || []).length === 0 && (post.stale || []).length === 0);
    check("--check reports sprites un-bakeable here WITHOUT failing the check",
      post.ok === true && post.sprites && post.sprites.bakeable === false);

    // idempotent re-install: no backup needed the second time (files already match).
    const res2 = runInstall(["--df-root", dfr, "--release", rel, "--json", "--yes"]);
    guard("idempotent re-install makes no backup (nothing changed)", res2.ok === true && res2.backupDir === null);

    // upgrade: change the release, re-install, assert a fresh backup of the now-stale dll.
    writeFileSync(join(rel, DLL), "DLLBYTES-v2");
    const res3 = runInstall(["--df-root", dfr, "--release", rel, "--json", "--yes"]);
    check("upgrade backs up the replaced dll and deploys v2",
      res3.backupDir && existsSync(join(res3.backupDir, "hack", "plugins", DLL)) &&
      readFileSync(join(res3.backupDir, "hack", "plugins", DLL), "utf8") === "DLLBYTES-v1" &&
      readFileSync(join(dfr, "hack", "plugins", DLL), "utf8") === "DLLBYTES-v2");

    // error path: DF root without DFHack -> exit 3, clear problem.
    const bad = tmp("e2e-nohack");
    writeFileSync(join(bad, "Dwarf Fortress.exe"), "MZ");
    let err;
    try { execFileSync(process.execPath, [INSTALL, "--df-root", bad, "--release", rel, "--json", "--yes"], { env: { ...process.env, DWF_BACKUP_ROOT: backupRoot }, stdio: "pipe" }); err = { ok: true }; }
    catch (e) { err = JSON.parse(e.stdout.toString()); }
    guard("install into a non-DFHack folder fails with a DFHack problem",
      err.ok === false && (err.problems || []).some((s) => /DFHack/i.test(s)));

    // ---- cold-start guard: a running Dwarf Fortress must be refused, not crash ----
    // Source pin: the DF-running pre-flight must sit AHEAD of the copy loop, and use tasklist.
    const installSrc = readFileSync(INSTALL, "utf8");
    const preflightIdx = installSrc.indexOf("if (isDfRunning())");
    const copyIdx = installSrc.indexOf("copyTree(e.src, e.dest");
    check("install.mjs runs a DF-running pre-flight AHEAD of the copy loop (via tasklist)",
      preflightIdx > -1 && copyIdx > -1 && preflightIdx < copyIdx && /tasklist/.test(installSrc));

    // Runtime: DWF_ASSUME_DF_RUNNING=1 forces the pre-flight to trip. It must refuse with the
    // friendly message and NEVER reach the copy (fresh root -> dll must not be deployed).
    const runDf = tmp("e2e-df-running");
    writeFileSync(join(runDf, "Dwarf Fortress.exe"), "MZ");
    mkdirSync(join(runDf, "hack", "plugins"), { recursive: true });
    writeFileSync(join(runDf, ".dwf-dfhack-version"), DFHACK_VERSION + "\n");
    let dfRun;
    try { runInstall(["--df-root", runDf, "--release", rel, "--json", "--yes"], { DWF_ASSUME_DF_RUNNING: "1" }); dfRun = { ok: true }; }
    catch (e) { dfRun = JSON.parse(e.stdout.toString()); }   // exit 3 carries the JSON on stdout
    check("DF-running pre-flight refuses with a friendly message (no stack)",
      dfRun.ok === false && dfRun.stage === "df-running" &&
      /Dwarf Fortress is running/i.test(dfRun.error) && !/copyfile|copyTree|EBUSY/i.test(dfRun.error));
    guard("pre-flight fires BEFORE any copy -- the dll was never deployed",
      !existsSync(join(runDf, "hack", "plugins", DLL)));

    // Belt-and-braces: DF launched AFTER the pre-flight -> a copy hits a locked dest. Simulate with a
    // read-only deployed dll (EPERM on overwrite) and assert the SAME friendly message, not a stack.
    const lockDf = tmp("e2e-locked");
    writeFileSync(join(lockDf, "Dwarf Fortress.exe"), "MZ");
    mkdirSync(join(lockDf, "hack", "plugins"), { recursive: true });
    mkdirSync(join(lockDf, "hack", "lua", "plugins"), { recursive: true });
    mkdirSync(join(lockDf, "hack", "scripts"), { recursive: true });
    writeFileSync(join(lockDf, ".dwf-dfhack-version"), DFHACK_VERSION + "\n");
    const lockedDll = join(lockDf, "hack", "plugins", DLL);
    writeFileSync(lockedDll, "LOCKED-OLD");
    chmodSync(lockedDll, 0o444);                             // read-only -> overwrite throws EPERM
    writeFileSync(join(rel, DLL), "DLLBYTES-locktest");      // differs -> forces the overwrite attempt
    let locked;
    try { runInstall(["--df-root", lockDf, "--release", rel, "--json", "--yes"], { DWF_ASSUME_DF_RUNNING: "0" }); locked = { ok: true }; }
    catch (e) { locked = JSON.parse(e.stdout.toString()); }
    check("a locked/read-only dest yields the friendly message, never a raw EBUSY/copyfile stack",
      locked.ok === false && locked.stage === "df-running" &&
      /Dwarf Fortress is running/i.test(locked.error) && !/copyfile|copyTree/i.test(locked.error));
    chmodSync(lockedDll, 0o644);                             // restore so temp cleanup can remove it
  }
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failed ? "FAIL" : "PASS"} - ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
