// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host panel client. Vanilla JS, no deps. Talks to the local node panel's /api/* endpoints.
// One page, three sections (Status / Friend access / Tunnel & controls) -- no tabs.

const $ = (sel) => document.querySelector(sel);
const api = {
  async get(p) { const r = await fetch(p); return r.json(); },
  async post(p, body) { const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); return r.json(); },
};
function pill(kind, text) { return `<span class="pill ${kind}">${text}</span>`; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------------- STATUS ----------------
async function loadStatus() {
  const s = await api.get("/api/status");
  $("#df-root").textContent = s.dfRoot ? s.dfRoot : "Dwarf Fortress folder not found";
  $("#s-df").innerHTML = s.dfRunning ? pill("ok", "running") : pill("bad", "not running");
  $("#s-server").innerHTML = s.server.answering ? pill("ok", "answering") : pill("bad", s.server.error ? "down" : "no response");
  if (!s.server.answering) {
    $("#s-world").innerHTML = pill("warn", "—");
    $("#s-players").textContent = "—";
    $("#s-build").textContent = "—";
    return;
  }
  const w = s.world;
  $("#s-world").innerHTML = w.worldLoaded === true ? pill("ok", w.paused ? "loaded (paused)" : "loaded")
    : w.worldLoaded === false ? pill("warn", "title screen")
    : pill("warn", w.error ? esc(w.error) : "unknown");
  $("#s-players").textContent = s.players == null ? "—" : String(s.players);
  $("#s-build").textContent = s.server.build || "—";
}

// ---------------- HOSTING + FRIEND LINK ----------------
// The friend link box reflects BOTH the one-button flow (/api/hosting) and a manually started
// tunnel (/api/links): whichever knows a URL wins; a confirmed stop paints the link dead.
let lastHosting = { phase: "idle" };
let lastStopConfirmed = false;   // set ONLY when the server proves the tunnel process exited

function paintFriendLink({ url, stopped }) {
  const code = $("#friend-url");
  const copy = $("#copy-friend");
  const note = $("#friend-link-note");
  if (url) {
    code.textContent = url;
    code.className = "friend-url is-live";
    copy.disabled = false;
    note.textContent = "Send this to your friends. The link works while Dwarf Fortress and the tunnel are both running.";
  } else if (stopped) {
    code.className = "friend-url is-dead";
    copy.disabled = true;
    note.textContent = "Tunnel stopped — this friend link is dead. Start hosting (or start the tunnel) to get a fresh one.";
  } else {
    code.textContent = "no friend link yet — press Start hosting";
    code.className = "friend-url is-empty";
    copy.disabled = true;
    note.textContent = "The link works while Dwarf Fortress and the tunnel are both running.";
  }
}

async function loadHosting() {
  const [h, l] = await Promise.all([api.get("/api/hosting"), api.get("/api/links")]);
  lastHosting = h;
  const button = $("#start-hosting");
  const working = !["idle", "error", "ready", "stopped", "link-stuck"].includes(h.phase);
  button.disabled = working || h.phase === "ready";
  button.textContent =
    h.phase === "ready" ? "Hosting is live" :
    working ? "Starting…" :
    h.phase === "error" ? "Try start hosting again" : "Start hosting";
  $("#hosting-message").textContent = h.message || "";
  const error = $("#hosting-error"); error.hidden = !h.error; error.textContent = h.error || "";
  // NEVER a dead-end spinner: link-stuck (adoption deadlock or wait timeout) surfaces a Retry
  // and points at the log tail, which loadCloudflaredLog keeps fresh below.
  $("#hosting-stuck").hidden = h.phase !== "link-stuck";

  const cf = l.cloudflared;
  const url = h.friendUrl || (cf.running ? cf.url : null);
  paintFriendLink({ url, stopped: h.phase === "stopped" || (!cf.running && !url && lastStopConfirmed) });

  // tunnel state + local link (Tunnel & controls)
  $("#t-state").innerHTML = cf.running
    ? (cf.url ? pill("ok", "running") : pill("warn", "running — no link yet"))
    : pill("bad", "not running");
  $("#l-local").textContent = l.localUrl;
  $("#l-local-open").href = l.localUrl;
  if (!cf.installed) $("#fetch-cf").classList.add("primary"); else $("#fetch-cf").classList.remove("primary");
}
$("#start-hosting").addEventListener("click", async () => {
  $("#start-hosting").disabled = true;
  await api.post("/api/hosting", {});
  await loadHosting();
});
$("#retry-link").addEventListener("click", async () => {
  const b = $("#retry-link");
  b.disabled = true; b.textContent = "Restarting…";
  await api.post("/api/hosting", { action: "retry-link" });
  b.disabled = false; b.textContent = "Restart the tunnel";
  await loadHosting(); await loadCloudflaredLog();
});

// ---------------- JOIN PASSWORD ----------------
// The security posture is always VISIBLE: either "password is set" with show/copy/change/off, or
// an explicit "No password — anyone with the link can join" with a Set control. Never a silently
// empty field. Saves apply LIVE for new joins (server POSTs the plugin's /join-password route).
const pw = { value: "", shown: false, editing: false, mode: "set" };

function paintPassword() {
  const hasPw = !!pw.value;
  $("#pw-row-set").hidden = !hasPw || pw.editing;
  $("#pw-row-open").hidden = hasPw || pw.editing;
  $("#pw-editor").hidden = !pw.editing;
  if (hasPw) {
    const el = $("#friend-password");
    el.textContent = pw.shown ? pw.value : "•".repeat(Math.max(8, pw.value.length));
    el.dataset.copyText = pw.value;   // copy the real password even while masked
    $("#pw-toggle").textContent = pw.shown ? "Hide" : "Show";
  }
}
async function loadAccess() {
  if (pw.editing) return;   // never clobber an open editor on auto-refresh
  const a = await api.get("/api/access");
  pw.value = a.password || "";
  paintPassword();
}
async function savePassword(value) {
  const r = await api.post("/api/access", { password: value });
  $("#a-note").textContent = r.ok ? (r.note || "Saved.") : ("error: " + (r.error || "?"));
  pw.editing = false;
  pw.shown = false;
  await loadAccess();
  loadStatus();
}
$("#pw-toggle").addEventListener("click", () => { pw.shown = !pw.shown; paintPassword(); });
$("#pw-set").addEventListener("click", () => { pw.editing = true; $("#a-pw").value = ""; paintPassword(); $("#a-pw").focus(); });
$("#pw-change").addEventListener("click", () => { pw.editing = true; $("#a-pw").value = pw.value; paintPassword(); $("#a-pw").focus(); });
$("#pw-cancel").addEventListener("click", () => { pw.editing = false; paintPassword(); });
$("#pw-generate").addEventListener("click", async () => {
  const a = await api.get("/api/access");   // server generates (same wordlist as the default policy)
  if (a.suggestion) $("#a-pw").value = a.suggestion;
});
$("#a-save").addEventListener("click", async () => {
  const v = $("#a-pw").value.trim();
  if (!v) { $("#a-note").textContent = "Type a password (or Cancel; use Turn off to remove the password)."; return; }
  await savePassword(v);
});
$("#a-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#a-save").click(); });
$("#pw-off").addEventListener("click", async () => {
  if (!window.confirm("Turn the password off? Anyone with the friend link will be able to join.")) return;
  await savePassword("");
});

// ---------------- TUNNEL LOG ----------------
async function loadCloudflaredLog() {
  const out = $("#cf-log");
  const note = $("#cf-log-note");
  try {
    const log = await api.get("/api/cloudflared-log");
    if (log.error) {
      out.textContent = "Could not read cloudflared.log: " + log.error;
      note.textContent = "Log read failed";
    } else if (!log.exists) {
      out.textContent = "No cloudflared log yet. Start the tunnel to create it.";
      note.textContent = "host/cloudflared.log has not been created";
    } else {
      out.textContent = log.text || "(log is empty)";
      note.textContent = log.truncated ? "Showing the newest 120 lines" : "Showing the complete log";
      out.scrollTop = out.scrollHeight;
    }
  } catch (error) {
    out.textContent = "Could not load the log tail: " + String(error.message || error);
    note.textContent = "Log request failed";
  }
}
$("#cf-log-refresh").addEventListener("click", loadCloudflaredLog);

// ---------------- SERVER ACTIONS ----------------
// Stop tunnel is special: it must PROVE the process died. The button locks during 'stopping' and
// the dead-link state only paints when the server confirms stopped:true (process-table verified).
$("#stop-cf").addEventListener("click", async () => {
  const b = $("#stop-cf");
  if (b.dataset.confirm && !window.confirm(b.dataset.confirm)) return;
  b.disabled = true; b.textContent = "Stopping…";
  try {
    const r = await api.post("/api/server", { action: "stop-cf", confirm: true });
    if (r.ok && r.stopped) {
      lastStopConfirmed = true;
      $("#srv-note").textContent = r.note || "Tunnel stopped — the friend link is now dead.";
    } else {
      $("#srv-note").textContent = "error: " + (r.error || "the tunnel may still be running");
    }
  } finally {
    b.disabled = false; b.textContent = "Stop tunnel";
    await loadHosting(); await loadCloudflaredLog();
  }
});

document.querySelectorAll("[data-action]").forEach((b) => {
  b.addEventListener("click", async () => {
    const action = b.dataset.action;
    const msg = b.dataset.confirm;
    if (msg && !window.confirm(msg)) return;
    if (action === "start-cf" || action === "start-df") lastStopConfirmed = false;
    $("#srv-note").textContent = "working...";
    b.disabled = true;
    try {
      const r = await api.post("/api/server", { action, confirm: true });
      $("#srv-note").textContent = r.ok ? (r.note || "done") : ("error: " + (r.error || "?"));
    } finally { b.disabled = false; }
    setTimeout(() => { loadStatus(); loadHosting(); loadCloudflaredLog(); }, 1200);
  });
});

// ---------------- ADVANCED CONFIG ----------------
async function loadConfig() {
  const c = await api.get("/api/config");
  if (!c.dfRoot) { $("#c-note").textContent = "no DF folder found"; return; }
  $("#c-audio").checked = !!c.audioRemote;
  $("#c-autopause").checked = !!c.hostFlags.autopause;
  $("#c-hostunpause").checked = !!c.hostFlags.hostunpause;
  $("#c-port").value = c.port || 8765;
}
$("#c-save").addEventListener("click", async () => {
  const body = {
    audioRemote: $("#c-audio").checked,
    hostFlags: { autopause: $("#c-autopause").checked, hostunpause: $("#c-hostunpause").checked },
    port: Number($("#c-port").value),
  };
  const r = await api.post("/api/config", body);
  $("#c-note").textContent = r.ok ? (r.note || "saved") : ("error: " + (r.error || "?"));
  loadStatus();
});

// ---------------- copy buttons ----------------
document.querySelectorAll(".copy").forEach((b) => {
  b.addEventListener("click", async () => {
    const el = $("#" + b.dataset.copy);
    const txt = el.dataset.copyText ?? el.textContent;
    const label = b.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied!"; setTimeout(() => (b.textContent = label), 1200); }
    catch { b.textContent = "copy failed"; setTimeout(() => (b.textContent = label), 1600); }
  });
});

// ---------------- boot + auto-refresh ----------------
loadStatus(); loadHosting(); loadAccess(); loadCloudflaredLog(); loadConfig();
setInterval(() => { loadStatus(); loadHosting(); loadAccess(); loadCloudflaredLog(); }, 4000);
