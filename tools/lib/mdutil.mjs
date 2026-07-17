// tools/lib/mdutil.mjs — shared utilities for the WS5 verification harness.
// Part of Dwarf With Friends (dwf). License: AGPL-3.0-only.
// Node >= 18, zero external dependencies.

import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- HTTP client

export class HttpClient {
  constructor(baseUrl) {
    this.base = new URL(baseUrl);
    this.cookie = "";
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  }

  // Join-password auth. This helper was STALE and it silently disarmed the deploy gate.
  //
  // It used to call `GET /auth?token=` and wait for a Set-Cookie named `dwf_auth`. The server
  // has since moved to `/join` + the `dfcap_auth` cookie (http_server.cpp:570,603) and there is no
  // `/auth` route at all -- so every authenticated harness call got HTTP 401, and
  // `node tools/predeploy-gate.mjs` FAILED ITS FOUR RUNTIME PROBES FOR ANY CHANGE WHATSOEVER, on any
  // server with a password set. A deploy gate that cannot pass is not a gate; it is an invitation to
  // reach for --static-only and ship a DLL unverified. Found 2026-07-12 while gating the Wave 4 wire
  // batch (the password: the gate was the only thing standing between a DLL change and F:).
  //
  // The real contract: `/join` VALIDATES the password (200/401) but does NOT set a cookie -- the
  // browser sets `dfcap_auth` itself after a successful join. So we validate, then carry the cookie
  // on every subsequent request, exactly as a browser does.
  async auth(password) {
    const res = await this.request("GET", `/join?password=${encodeURIComponent(password)}`);
    if (res.status !== 200)
      throw new Error(`auth failed: HTTP ${res.status} (POST /join rejected the join password)`);
    this.cookie = `dfcap_auth=${encodeURIComponent(password)}`;
  }

  request(method, pathq, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          agent: this.agent,
          hostname: this.base.hostname,
          port: this.base.port || 80,
          path: pathq,
          method,
          headers: this.cookie ? { Cookie: this.cookie } : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${method} ${pathq}`)));
      req.on("error", reject);
      req.end();
    });
  }

  async json(method, pathq, opts) {
    const res = await this.request(method, pathq, opts);
    let body = null;
    try { body = JSON.parse(res.body.toString("utf8")); } catch (_) { /* non-JSON */ }
    return { status: res.status, json: body };
  }
}

// -------------------------------------------- multipart/x-mixed-replace parse
// Buffer port of the retired browser multipart stream parser.
// (WS1 plan Task 2). Same framing: boundary line, CRLF, headers, CRLFCRLF,
// Content-Length body, trailing CRLF. Heartbeat parts carry
// X-Dwf-Heartbeat: 1 with a 2-byte text/plain body.

export function extractPart(buf, boundary = "--dwf") {
  const b0 = buf.indexOf(boundary);
  if (b0 < 0) return null;
  const hdrStart = b0 + boundary.length + 2; // skip boundary + CRLF
  const hdrEnd = buf.indexOf("\r\n\r\n", hdrStart);
  if (hdrEnd < 0) return null;
  const headers = {};
  buf.subarray(hdrStart, hdrEnd).toString("utf8").split("\r\n").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  const len = parseInt(headers["content-length"] || "-1", 10);
  if (len < 0) return null;
  const bodyStart = hdrEnd + 4;
  if (buf.length < bodyStart + len + 2) return null; // body + trailing CRLF not fully buffered
  return {
    headers,
    body: buf.subarray(bodyStart, bodyStart + len),
    rest: buf.subarray(bodyStart + len + 2),
  };
}

export function parseCam(s) {
  if (!s) return null;
  const p = s.split(",").map(Number);
  return p.length === 3 && p.every((n) => !isNaN(n)) ? { x: p[0], y: p[1], z: p[2] } : null;
}

// Opens GET /stream?player=… and calls onPart({headers, body, camera, seq,
// heartbeat, tRecv}) for every complete part. onEnd(errOrNull) fires once when
// the stream closes. Returns { stop(), bytes() } — bytes() is decoded body
// bytes received (chunked-framing overhead excluded; ~2% under wire bytes).
export function openStream(client, player, onPart, onEnd) {
  let buf = Buffer.alloc(0);
  let bytes = 0;
  let stopped = false;
  let ended = false;
  const finish = (err) => { if (!ended) { ended = true; onEnd(err); } };
  const req = http.request(
    {
      agent: client.agent,
      hostname: client.base.hostname,
      port: client.base.port || 80,
      path: `/stream?player=${encodeURIComponent(player)}`,
      method: "GET",
      headers: client.cookie ? { Cookie: client.cookie } : {},
    },
    (res) => {
      if (res.statusCode !== 200) {
        finish(new Error(`/stream HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.on("data", (chunk) => {
        bytes += chunk.length;
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let part;
        while ((part = extractPart(buf)) !== null) {
          buf = part.rest;
          onPart({
            headers: part.headers,
            body: part.body,
            camera: parseCam(part.headers["x-dwf-camera"]),
            seq: parseInt(part.headers["x-dwf-seq"] || "0", 10),
            heartbeat: part.headers["x-dwf-heartbeat"] === "1",
            tRecv: Date.now(),
          });
        }
      });
      res.on("end", () => { if (!stopped) finish(null); });
      res.on("error", (e) => { if (!stopped) finish(e); });
    }
  );
  req.on("error", (e) => { if (!stopped) finish(e); });
  req.end();
  return {
    stop() { stopped = true; ended = true; req.destroy(); },
    bytes: () => bytes,
  };
}

// ------------------------------------------------------- DFHack / DF process

export function dfhackRunPath(dfDir) {
  const candidates = [
    path.join(dfDir, "hack", "dfhack-run.exe"),
    path.join(dfDir, "dfhack-run.exe"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(`dfhack-run.exe not found under ${dfDir}`);
}

export function dfhackRun(dfDir, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(dfhackRunPath(dfDir), args, { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`dfhack-run ${args.join(" ")}: ${err.message} ${String(stderr).trim()}`));
        else resolve(String(stdout).trim());
      });
  });
}

// df.global.enabler.calculated_fps: int32, library/xml/df.g_src.enabler.xml:151.
// (Smoothed float alternative: df.global.enabler.fps, same file line 159.)
export async function readHostFps(dfDir) {
  const out = await dfhackRun(dfDir, ["lua", "print(df.global.enabler.calculated_fps)"]);
  const m = out.match(/-?\d+/);
  if (!m) throw new Error(`unparseable fps output: ${JSON.stringify(out)}`);
  return parseInt(m[0], 10);
}

export async function mapLoaded(dfDir) {
  const out = await dfhackRun(dfDir, ["lua", "print(dfhack.isMapLoaded())"]);
  return /true/.test(out);
}

export function findDFPid(exeName = "Dwarf Fortress.exe") {
  return new Promise((resolve, reject) => {
    execFile("tasklist", ["/FI", `IMAGENAME eq ${exeName}`, "/FO", "CSV", "/NH"],
      { windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        const m = String(stdout).match(/^"[^"]+","(\d+)"/m);
        resolve(m ? parseInt(m[1], 10) : null);
      });
  });
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; } // EPERM = exists but not ours = alive
}

// ------------------------------------------------------------------ reporting

export function pct(list, p) {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function fmtTable(rows) {
  if (!rows.length) return "(no rows)";
  const keys = Object.keys(rows[0]);
  const grid = [keys, ...rows.map((r) => keys.map((k) => String(r[k])))];
  const w = keys.map((_, i) => Math.max(...grid.map((row) => row[i].length)));
  const line = (row) => row.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(grid[0]), w.map((x) => "-".repeat(x)).join("  "),
          ...grid.slice(1).map(line)].join("\n");
}

// --flag value pairs; bare --flag becomes boolean true. Defaults are strings.
export function parseArgs(argv, defaults) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
