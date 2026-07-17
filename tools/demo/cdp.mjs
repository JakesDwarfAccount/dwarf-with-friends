// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Small reusable CDP core derived from tools/harness/cdp_probe.mjs. Node >=22; zero npm modules.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class CdpBrowser {
  constructor({ chrome, port, profile }) {
    this.chromePath = chrome;
    this.port = port;
    this.profile = profile;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.errors = [];
  }

  async launch() {
    mkdirSync(this.profile, { recursive: true });
    this.child = spawn(this.chromePath, [
      "--headless=new", "--mute-audio", "--autoplay-policy=user-gesture-required",
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`,
      "--no-first-run", "--disable-background-networking", "--window-size=1920,1080", "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (response.ok) {
          const version = await response.json();
          this.ws = new WebSocket(version.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
          this.ws.onmessage = event => this.onMessage(JSON.parse(event.data));
          return;
        }
      } catch { /* Chrome is still starting */ }
      await delay(250);
    }
    throw new Error(`Chrome CDP endpoint did not open on port ${this.port}`);
  }

  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      return message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      this.errors.push(`${detail?.text || "page exception"}: ${detail?.exception?.description || ""}`);
    }
    const listener = this.listeners.get(`${message.sessionId || ""}:${message.method}`);
    if (listener) listener(message.params || {});
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000).unref?.();
    });
  }

  on(sessionId, method, callback) { this.listeners.set(`${sessionId}:${method}`, callback); }
  off(sessionId, method) { this.listeners.delete(`${sessionId}:${method}`); }

  async page({ url, width = 1280, height = 800, cookie = null, initScript = "" }) {
    const { browserContextId } = await this.send("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId, background: true });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new CdpPage(this, { browserContextId, targetId, sessionId, width, height });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setVisibleSize", { width, height });
    if (initScript) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
    if (cookie) {
      const target = new URL(url);
      await page.send("Network.setCookie", { name: cookie.name, value: cookie.value, domain: target.hostname, path: "/" });
    }
    await page.send("Page.navigate", { url });
    return page;
  }

  async close() {
    try { this.ws?.close(); } catch { /* best effort */ }
    try { this.child?.kill(); } catch { /* best effort */ }
    await delay(200);
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export class CdpPage {
  constructor(browser, details) { Object.assign(this, details); this.browser = browser; }
  send(method, params = {}) { return this.browser.send(method, params, this.sessionId); }
  on(method, callback) { this.browser.on(this.sessionId, method, callback); }
  off(method) { this.browser.off(this.sessionId, method); }

  async eval(expression) {
    const out = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || "page evaluation failed");
    return out.result?.value;
  }

  async waitFor(expression, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return; } catch { /* page is loading */ }
      await delay(200);
    }
    throw new Error(`Page condition timed out: ${expression}`);
  }

  async rect(selector) {
    return this.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`);
  }

  async click(selector) {
    const r = await this.rect(selector);
    if (!r) throw new Error(`Missing element: ${selector}`);
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async drag(selector, from, to, durationMs = 700) {
    const r = await this.rect(selector);
    if (!r) throw new Error(`Missing drag surface: ${selector}`);
    const point = p => ({ x: r.x + r.w * p[0], y: r.y + r.h * p[1] });
    const a = point(from), b = point(to), count = 14;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button: "left", clickCount: 1 });
    for (let i = 1; i <= count; i++) {
      await delay(durationMs / count);
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + (b.x - a.x) * i / count, y: a.y + (b.y - a.y) * i / count, button: "left" });
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b, button: "left", clickCount: 1 });
  }
}

export { delay };
