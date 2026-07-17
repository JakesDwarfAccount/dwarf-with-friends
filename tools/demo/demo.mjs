// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Data-driven showcase recorder. Dry-run is the default; --run is the explicit live-fort gate.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpBrowser, delay } from "./cdp.mjs";
import { scenes } from "./scenes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? "") : fallback;
}
const flag = name => argv.includes(`--${name}`);
const selectedId = arg("scene", "co-build");
const baseUrl = arg("url", "").replace(/\/$/, "");
const password = arg("password", process.env.DWF_JOIN_PASSWORD || "");
const outRoot = path.resolve(arg("out", path.join(HERE, "takes")));
const port = Number(arg("cdp-port", "9238"));
const chrome = arg("chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
const ffmpeg = arg("ffmpeg", "ffmpeg");

function usage(code = 0) {
  console.log(`Usage:
  node tools/demo/demo.mjs --list
  node tools/demo/demo.mjs --scene co-build                 # validate + print plan only
  node tools/demo/demo.mjs --run --scene co-build --url http://HOST:8765 [--password PASS]

Options: --out DIR --chrome EXE --ffmpeg EXE --cdp-port N --no-record
--run drives a real fortress. Without it this command never opens Chrome or contacts a host.`);
  process.exit(code);
}

function validateScene(scene) {
  const problems = [];
  if (!scene.id || !scene.title || !Number.isFinite(scene.durationMs)) problems.push("id, title, and durationMs are required");
  const names = new Set();
  for (const player of scene.players || []) {
    if (!player.name || names.has(player.name)) problems.push(`invalid/duplicate player name: ${player.name}`);
    names.add(player.name);
    let last = -1;
    for (const step of player.steps || []) {
      if (!Number.isFinite(step.at) || step.at < last) problems.push(`${player.name}: steps must have ascending numeric 'at' times`);
      if (!ACTIONS.has(step.action)) problems.push(`${player.name}: unknown action '${step.action}'`);
      if (step.at >= scene.durationMs) problems.push(`${player.name}: step at ${step.at} is outside the scene`);
      last = step.at;
    }
  }
  if (scene.camera?.follow && !names.has(scene.camera.follow)) problems.push(`camera follows missing player: ${scene.camera.follow}`);
  let cameraLast = -1;
  for (const step of scene.camera?.steps || []) {
    if (!Number.isFinite(step.at) || step.at < cameraLast) problems.push("camera: steps must have ascending numeric 'at' times");
    if (!ACTIONS.has(step.action)) problems.push(`camera: unknown action '${step.action}'`);
    if (step.at >= scene.durationMs) problems.push(`camera: step at ${step.at} is outside the scene`);
    cameraLast = step.at;
  }
  return problems;
}

const ACTIONS = new Set(["cursor", "pan", "designate", "build", "panel", "chat", "join"]);
if (flag("help")) usage();
if (flag("list")) {
  for (const scene of scenes) console.log(`${scene.id.padEnd(18)} ${Math.round(scene.durationMs / 1000)}s  ${scene.title}`);
  process.exit(0);
}
const scene = scenes.find(item => item.id === selectedId);
if (!scene) { console.error(`Unknown scene '${selectedId}'. Use --list.`); process.exit(2); }
const problems = validateScene(scene);
if (problems.length) { console.error(problems.map(p => `SCENE ERROR: ${p}`).join("\n")); process.exit(2); }

function printPlan() {
  console.log(`${scene.id}: ${scene.title} (${scene.durationMs} ms)`);
  for (const player of scene.players) {
    console.log(`  ${player.name}${player.start === "bare" ? " (bare URL)" : ""}`);
    for (const step of player.steps) console.log(`    ${String(step.at).padStart(5)} ms  ${step.action}`);
  }
  console.log(`  camera: ${scene.camera?.player || "DWF_Camera"}${scene.camera?.start === "bare" ? " (bare URL)" : ""}${scene.camera?.follow ? ` follows ${scene.camera.follow}` : ""}`);
  for (const step of scene.camera?.steps || []) console.log(`    ${String(step.at).padStart(5)} ms  ${step.action}`);
}
printPlan();
if (!flag("run")) { console.log("DRY RUN: no browser launched and no host contacted."); process.exit(0); }
if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) { console.error("--run requires an explicit http(s) --url"); process.exit(2); }
if (!existsSync(chrome)) { console.error(`Chrome not found: ${chrome}`); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const takeDir = path.join(outRoot, scene.id, stamp);
mkdirSync(takeDir, { recursive: true });
const profile = path.join(takeDir, ".chrome-profile");
const browser = new CdpBrowser({ chrome, port, profile });
let recorder = null;
let recorderStopped = false;

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function validatePassword() {
  const version = await fetch(`${baseUrl}/version`, { cache: "no-store" });
  if (!version.ok) throw new Error(`Host /version returned HTTP ${version.status}`);
  const info = await version.json();
  if (!info.authRequired) return;
  if (!password) throw new Error("This host requires --password or DWF_JOIN_PASSWORD");
  const joined = await fetch(`${baseUrl}/join`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
  });
  if (!joined.ok) throw new Error("The join password was rejected");
}

async function makePage(player, { camera = false, bare = false } = {}) {
  const url = bare ? `${baseUrl}/` : `${baseUrl}/view?player=${encodeURIComponent(player)}`;
  const initScript = bare ? "" : `localStorage.setItem("dwf.player", ${JSON.stringify(player)});`;
  const cookie = (!bare && password) ? { name: "dfcap_auth", value: password } : null;
  const page = await browser.page({ url, width: camera ? 1920 : 1280, height: camera ? 1080 : 800, cookie, initScript });
  if (bare) await page.waitFor(`document.querySelector("#dfcapJoinOverlay") || window.__dwfStarted`, 30000);
  else await page.waitFor(`window.__dwfStarted && document.querySelector("#view")`, 30000);
  return page;
}

async function clickPanel(page, panel) {
  if (panel === "chat") {
    await page.eval(`(() => { const p=document.querySelector("#dfChatPanel"); if(p && p.classList.contains("open")) return; const e=document.querySelector("#dfChatToggle"); if(!e) throw new Error("chat control missing"); e.click(); })()`);
    return;
  }
  if (panel === "lobby") { await page.click("#lobbyBtn"); return; }
  const selector = `[data-panel=${JSON.stringify(panel)}]`;
  await page.eval(`(() => { const all=[...document.querySelectorAll(${JSON.stringify(selector)})]; const e=all.find(x=>x.offsetParent!==null); if(!e) throw new Error("panel control missing"); e.click(); })()`);
}

async function action(page, player, step) {
  if (step.action === "pan") {
    await page.eval(`(() => {
      if (!window.DFTouchNav) throw new Error("camera controls unavailable");
      window.DFTouchNav.panTiles(${Number(step.dx || 0)}, ${Number(step.dy || 0)});
      if (${Number(step.dz || 0)}) window.DFTouchNav.zStep(${Number(step.dz || 0)});
    })()`);
    return;
  }
  if (step.action === "cursor") {
    const r = await page.rect("#view");
    if (!r) throw new Error("map canvas missing");
    for (const point of step.path || []) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + r.w * point[0], y: r.y + r.h * point[1] });
      await delay(220);
    }
    return;
  }
  if (step.action === "designate") {
    await page.click("[data-dig-menu]");
    await delay(250);
    await page.click(`[data-dig-tool=${JSON.stringify(step.tool || "dig")}]`);
    await page.drag("#view", step.from, step.to, 900);
    return;
  }
  if (step.action === "build") {
    await clickPanel(page, "build");
    await delay(500);
    await page.eval(`(() => { const q=document.querySelector("[data-build-search]"); if(!q) throw new Error("build search missing"); q.value=${JSON.stringify(step.search || "Wall")}; q.dispatchEvent(new Event("input",{bubbles:true})); })()`);
    await delay(450);
    await page.click("[data-build-token]");
    await delay(300);
    const closest = await page.rect('[data-build-matmode="closest"]');
    if (closest) await page.click('[data-build-matmode="closest"]');
    await page.drag("#view", step.from, step.to || step.from, 650);
    await delay(400);
    const fallback = await page.rect("[data-place-fallback]");
    if (fallback) await page.click("[data-place-fallback]");
    return;
  }
  if (step.action === "panel") { await clickPanel(page, step.panel); return; }
  if (step.action === "chat") {
    await page.eval(`(() => { const t=document.querySelector("#dfChatToggle"); if(t && t.offsetParent!==null) t.click(); })()`);
    await delay(200);
    await page.eval(`(() => { const i=document.querySelector("#dfChatInput"); if(!i) throw new Error("chat input missing"); i.value=${JSON.stringify(step.text || "")}; i.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("[data-chat-send]").click(); })()`);
    return;
  }
  if (step.action === "join") {
    await page.waitFor(`document.querySelector("#dfcapJoinName")`, 20000);
    await page.eval(`(() => { const n=document.querySelector("#dfcapJoinName"); n.value=${JSON.stringify(player)}; const p=document.querySelector("#dfcapJoinPass"); if(p) p.value=${JSON.stringify(password)}; document.querySelector("[data-dfcj-join]").click(); })()`);
    await page.waitFor(`window.__dwfStarted && !document.querySelector("#dfcapJoinOverlay")`, 30000);
    return;
  }
  throw new Error(`Unsupported action: ${step.action}`);
}

async function runTimeline(page, player, steps, startedAt) {
  for (const step of steps) {
    await delay(Math.max(0, startedAt + step.at - Date.now()));
    console.log(`${player}: ${step.action} @ ${step.at}ms`);
    await action(page, player, step);
  }
}

async function startRecorder(page, masterPath) {
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-f", "image2pipe", "-use_wallclock_as_timestamps", "1", "-framerate", "60", "-i", "pipe:0",
    "-vf", "fps=60", "-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq",
    "-rc", "vbr", "-cq", "16", "-b:v", "35M", "-maxrate", "55M", "-pix_fmt", "yuv420p", masterPath,
  ];
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  let frames = 0;
  page.on("Page.screencastFrame", params => {
    frames++;
    const ack = () => page.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (child.stdin.destroyed) return ack();
    if (child.stdin.write(Buffer.from(params.data, "base64"))) ack();
    else child.stdin.once("drain", ack);
  });
  await page.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  return {
    async stop() {
      await page.send("Page.stopScreencast");
      page.off("Page.screencastFrame");
      child.stdin.end();
      const code = await new Promise(resolve => child.on("close", resolve));
      if (code !== 0) throw new Error(`ffmpeg recorder exited ${code}`);
      if (!frames) throw new Error("CDP screencast produced no frames");
      return frames;
    },
  };
}

async function makeCuts(master, readmeMp4, webm) {
  await runProcess(ffmpeg, ["-hide_banner", "-loglevel", "warning", "-y", "-i", master,
    "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-maxrate", "2400k", "-bufsize", "4800k",
    "-pix_fmt", "yuv420p", "-an", readmeMp4]);
  if (statSync(readmeMp4).size > 10 * 1024 * 1024) throw new Error("README mp4 exceeds 10 MiB; shorten the scene or lower its cut bitrate");
  await runProcess(ffmpeg, ["-hide_banner", "-loglevel", "warning", "-y", "-i", master,
    "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-an", webm]);
}

try {
  await validatePassword();
  await browser.launch();
  const pages = new Map();
  for (const player of scene.players) pages.set(player.name, await makePage(player.name, { bare: player.start === "bare" }));
  const cameraName = scene.camera?.player || "DWF_Camera";
  const camera = await makePage(cameraName, { camera: true, bare: scene.camera?.start === "bare" });
  if (scene.camera?.follow) {
    await camera.waitFor(`window.DwfSpectate && window.DwfSpectate.followPlayer(${JSON.stringify(scene.camera.follow)})`, 30000);
  }
  const master = path.join(takeDir, `${scene.id}-master.mp4`);
  if (!flag("no-record")) recorder = await startRecorder(camera, master);
  const startedAt = Date.now();
  const timelines = scene.players.map(player => runTimeline(pages.get(player.name), player.name, player.steps || [], startedAt));
  if (scene.camera?.steps?.length) timelines.push(runTimeline(camera, cameraName, scene.camera.steps, startedAt));
  await Promise.all([...timelines, delay(scene.durationMs)]);
  if (recorder) {
    const frames = await recorder.stop();
    recorderStopped = true;
    console.log(`Recorded ${frames} source frames: ${master}`);
    const readme = path.join(takeDir, `${scene.id}-readme.mp4`);
    const webm = path.join(takeDir, `${scene.id}.webm`);
    await makeCuts(master, readme, webm);
    console.log(`Cuts: ${readme}\n      ${webm}`);
  }
  if (browser.errors.length) console.warn("PAGE ERRORS:\n" + browser.errors.map(e => `  ${e}`).join("\n"));
} catch (error) {
  console.error(`DEMO FAILED: ${error.stack || error}`);
  process.exitCode = 1;
} finally {
  if (recorder && !recorderStopped) {
    try { await recorder.stop(); } catch { /* preserve the original failure */ }
  }
  await browser.close();
}
