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
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// SPDX-License-Identifier: AGPL-3.0-only

// cdp_probe.mjs -- the repo's zero-dependency, own-Chrome CDP driver.
//
// The command-line probe remains useful for one-off verification, but the driver is also exported
// so browser gates use ONE implementation instead of cloning the CDP plumbing. Chrome is always
// headless and muted. Node >=22 (global WebSocket), no npm modules.
//
// CLI usage:
//   node tools/harness/cdp_probe.mjs --url http://127.0.0.1:8765/?player=verifier \
//     --script probe.mjs.txt --shot-dir tools/orchestrator/attachments/cu-w27
// Script commands: EVAL <js> | SHOT <name> | WAIT <ms>

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_CHROME = process.env.CHROME_PATH || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "google-chrome");

export function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

export function freeTcpPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function directRun() {
  return !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

export class CdpPage {
  constructor(probe, targetId, sessionId) {
    this.probe = probe;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.errors = [];
  }

  send(method, params = {}, timeoutMs) {
    return this.probe.send(method, params, this.sessionId, timeoutMs);
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) {
    const response = await this.send("Runtime.evaluate", {
      expression, awaitPromise, returnByValue,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || "page evaluation failed");
    }
    return returnByValue ? response.result?.value : response.result;
  }

  async waitFor(expression, { timeoutMs = 10000, intervalMs = 50, message = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await delay(intervalMs);
    }
    throw new Error(`timed out waiting for ${message}; last=${JSON.stringify(last)}`);
  }

  async screenshot({ clip, format = "png" } = {}) {
    const params = { format };
    if (clip) params.clip = clip;
    const result = await this.send("Page.captureScreenshot", params);
    return Buffer.from(result.data, "base64");
  }

  async shot(filePath, options = {}) {
    const bytes = await this.screenshot(options);
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    writeFileSync(filePath, bytes);
    return filePath;
  }

  async navigate(url, { settleMs = 0 } = {}) {
    await this.send("Page.navigate", { url });
    if (settleMs) await delay(settleMs);
  }

  async close() {
    if (!this.targetId) return;
    const targetId = this.targetId;
    this.targetId = null;
    this.probe.pages.delete(this.sessionId);
    try { await this.probe.send("Target.closeTarget", { targetId }, undefined, 8000); } catch {}
  }
}

export class CdpProbe {
  constructor({
    chromePath = DEFAULT_CHROME,
    port = 0,
    width = 1600,
    height = 1000,
    profileDir = null,
    profileRoot = tmpdir(),
    attachOnly = false,
    closeAttachedBrowser = false,
    extraArgs = [],
  } = {}) {
    this.chromePath = chromePath;
    this.port = Number(port) || 0;
    this.width = width;
    this.height = height;
    this.profileDir = profileDir;
    this.profileRoot = profileRoot;
    this.ownsProfile = !profileDir;
    this.attachOnly = attachOnly;
    this.closeAttachedBrowser = closeAttachedBrowser;
    this.extraArgs = extraArgs;
    this.chrome = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.pages = new Map();
  }

  async start() {
    if (this.ws) return this;
    if (!this.port) this.port = await freeTcpPort();
    if (!this.attachOnly && !this.profileDir) {
      mkdirSync(this.profileRoot, { recursive: true });
      this.profileDir = mkdtempSync(join(this.profileRoot, "dwf-cdp-"));
    }
    this.launchOutput = [];
    if (!this.attachOnly) {
      this.chrome = spawn(this.chromePath, [
        "--headless=new",
        `--remote-debugging-port=${this.port}`,
        "--mute-audio",
        `--window-size=${this.width},${this.height}`,
        "--no-first-run",
        "--disable-background-networking",
        "--disable-component-update",
        `--user-data-dir=${this.profileDir}`,
        ...this.extraArgs,
        "about:blank",
      ], { stdio: ["ignore", "ignore", "pipe"] });
      this.chrome.once("error", error => { this.launchError = error; });
      this.chrome.stderr?.on("data", chunk => {
        if (this.launchOutput.join("").length < 8000) this.launchOutput.push(String(chunk));
      });
    }

    let version = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (response.ok) { version = await response.json(); break; }
      } catch {}
      await delay(250);
    }
    if (!version) {
      const launcherExit = this.chrome?.exitCode;
      const launchDetail = (this.launchError?.message || this.launchOutput.join("").trim()).slice(-2000);
      await this.stop();
      throw new Error(`Chrome CDP endpoint did not open on port ${this.port} (${this.chromePath}; ` +
        `launcher exit=${launcherExit ?? (this.attachOnly ? "attach-only" : "still running")})` +
        (launchDetail ? `: ${launchDetail}` : ""));
    }

    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      this.ws.onopen = resolveOpen;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = event => this.onMessage(JSON.parse(event.data));
    return this;
  }

  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const page = message.sessionId ? this.pages.get(message.sessionId) : null;
    if (!page) return;
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      page.errors.push({
        kind: "exception",
        text: detail?.exception?.description || detail?.text || "page exception",
        url: detail?.url || "",
        line: detail?.lineNumber,
      });
    }
    if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry;
      if (entry && (entry.level === "error" || entry.level === "warning")) {
        page.errors.push({ kind: `log:${entry.level}`, text: entry.text || "", url: entry.url || "", line: entry.lineNumber });
      }
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      const text = (message.params.args || []).map(arg => arg.value || arg.description || "").join(" ");
      page.errors.push({ kind: "console:error", text, url: "" });
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP is not connected (${method})`));
    }
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject, timer });
    });
  }

  async newPage({ url = "about:blank", beforeLoadScript = "", cookie = "", settleMs = 0 } = {}) {
    if (!this.ws) await this.start();
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new CdpPage(this, targetId, sessionId);
    this.pages.set(sessionId, page);
    await page.send("Page.enable");
    await page.send("Log.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    if (beforeLoadScript) {
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: beforeLoadScript });
    }
    if (cookie) {
      const equals = cookie.indexOf("=");
      const parsed = new URL(url);
      await page.send("Network.setCookie", {
        name: cookie.slice(0, equals), value: cookie.slice(equals + 1),
        domain: parsed.hostname, path: "/",
      });
    }
    await page.navigate(url, { settleMs });
    return page;
  }

  async stop() {
    for (const page of [...this.pages.values()]) await page.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP stopped"));
    }
    this.pending.clear();
    if (this.closeAttachedBrowser && this.ws?.readyState === WebSocket.OPEN) {
      try { await this.send("Browser.close", {}, undefined, 1500); } catch {}
    }
    try { this.ws?.close(); } catch {}
    this.ws = null;
    if (this.chrome && !this.attachOnly) {
      const pid = this.chrome.pid;
      try { this.chrome.kill(); } catch {}
      if (process.platform === "win32" && pid) {
        try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      }
      this.chrome = null;
    }
    if (this.ownsProfile && this.profileDir) {
      try { rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
      this.profileDir = null;
    }
  }
}

async function runCli() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const url = arg("url", "http://localhost:8765/view?player=verifier");
  const shotDir = arg("shot-dir", "tools/orchestrator/attachments/cu-w27");
  const evalSource = arg("eval");
  const script = arg("script");
  const settleMs = Number(arg("settle", "9000"));
  const port = Number(arg("port", "0"));
  const probe = new CdpProbe({ port });
  let page;
  try {
    await probe.start();
    page = await probe.newPage({ url, cookie: arg("cookie", ""), settleMs });
    const shot = async name => {
      const file = join(shotDir, name.endsWith(".png") ? name : `${name}.png`);
      await page.shot(file);
      console.log("SHOT:", file);
    };
    if (evalSource) {
      try { console.log(JSON.stringify({ value: await page.evaluate(evalSource) }, null, 1)); }
      catch (error) { console.log(JSON.stringify({ error: error.message }, null, 1)); }
      await shot("probe-eval");
    } else if (script) {
      const lines = readFileSync(script, "utf8").split(/\r?\n/)
        .filter(line => line.trim() && !line.startsWith("#"));
      for (const line of lines) {
        const space = line.indexOf(" ");
        const command = space < 0 ? line : line.slice(0, space);
        const rest = space < 0 ? "" : line.slice(space + 1);
        if (command === "EVAL") {
          try { console.log(JSON.stringify({ [rest.slice(0, 60)]: { value: await page.evaluate(rest) } })); }
          catch (error) { console.log(JSON.stringify({ [rest.slice(0, 60)]: { error: error.message } })); }
        } else if (command === "SHOT") await shot(rest.trim());
        else if (command === "WAIT") await delay(Number(rest) || 1000);
        else console.log("skip unknown line:", line);
      }
    } else await shot("probe-default");

    if (page.errors.length) {
      console.error("PAGE-ERRORS:\n" + page.errors.map(error =>
        `  [${error.kind}] ${error.text} @ ${error.url || ""}:${error.line ?? ""}`).join("\n"));
    }
  } finally {
    await probe.stop();
  }
}

if (directRun()) {
  runCli().catch(error => {
    console.error("probe failed: " + error.message);
    process.exitCode = 1;
  });
}
