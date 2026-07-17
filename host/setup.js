// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = {
  async get() { return (await fetch("/api/setup")).json(); },
  async act(action, body = {}) { return (await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) })).json(); },
};

let busy = false;
function step(number, title, state, body, action = "") {
  const icon = state.ok ? "✓" : "!";
  return `<li class="setup-step ${state.ok ? "complete" : "needs-fix"}">
    <div class="setup-icon" aria-hidden="true">${icon}</div><div class="setup-copy">
    <div class="setup-title"><span>${number}.</span> ${title}</div><div class="setup-body">${body}</div>${action}</div></li>`;
}
function button(action, label, primary = true) {
  return `<button class="btn ${primary ? "primary" : ""}" data-setup-action="${action}">${label}</button>`;
}
// Plain-English "What is this?" explainer, one consistent expandable per step. The html here is a
// static, trusted blurb (never user input), so it is embedded as-is.
function info(html) {
  return `<details class="setup-info"><summary>What is this?</summary><div class="setup-info-body">${html}</div></details>`;
}
// One blurb per step, in the wizard's voice. Facts verified against the code (fetchers.mjs pinned+
// hash-verified downloads; install.mjs copy targets + receipt + quarantine; bake_sprites; the game
// server binds 127.0.0.1 only, so cloudflared is genuinely required -- no honest LAN-skip to offer).
const INFO = {
  dfhack: `DFHack is the community modding engine that Dwarf Fortress mods run on, and Dwarf With Friends is built as a DFHack plugin — so the game needs it before the mod can load. Setup downloads DFHack straight from its official GitHub releases, pinned to the exact version 53.15-r1 and hash-verified before it is accepted. It installs into your Dwarf Fortress folder exactly the way a manual DFHack install would; nothing goes anywhere else.`,
  install: `This copies the mod into your Dwarf Fortress folder: a plugin <code>.dll</code> into <code>hack\\plugins</code> plus its interface (Lua) files and the browser UI. It also writes a small receipt, <code>dwf_install_receipt.json</code>, so re-running this setup can verify and repair the install later. Uninstalling is simply deleting those files. If an older Dwarf With Friends version is found it is moved aside into a backup (quarantined), never destroyed.`,
  sprites: `The browser view uses Dwarf Fortress's own artwork. Rather than ship the game's copyrighted art, setup bakes just the sprites it needs from YOUR installed copy of the game, right here on your machine — nothing is uploaded or redistributed. If you have DF Classic with no premium art, friends simply see placeholder shapes instead.`,
  cloudflared: `For friends to join over the internet, your PC needs a way to accept their connections. Normally that means router port-forwarding — fiddly, and different for every router. cloudflared is the one-click alternative: it opens a secure tunnel from your PC out to Cloudflare, and your friends connect through the link it hands you. Nothing to configure. It downloads directly from Cloudflare's official GitHub releases, is SHA-256 hash-verified before we accept it, and lives inside this Dwarf With Friends folder only — no system install, so deleting the folder removes it completely.`,
  finish: `The desktop shortcut just opens the launcher for this folder — the one that starts hosting and opens the host panel — so you don't have to come back here every time. Your friends never install or run any of this: they only need the link the host panel gives you.`,
};

function render(s) {
  const x = s.steps;
  const rows = [];
  let dfBody, dfAction = "";
  const pathEntry = (extra = "") => `<div class="path-entry"${extra}><input id="df-path" type="text" placeholder="C:\\...\\Dwarf Fortress" aria-label="Dwarf Fortress folder">${button("choose-df", "Use this folder")}</div>`;
  if (x.df.ok) {
    dfBody = `Found <code>${esc(s.dfRoot)}</code>`;
    dfAction = `<button class="btn small" type="button" data-toggle-df>Use a different folder</button>
      ${pathEntry(` id="df-alt" hidden`)}`;
  } else {
    dfBody = `<strong>Dwarf With Friends needs Dwarf Fortress.</strong> We never download the game. Install it from
      <a href="https://store.steampowered.com/app/975370/Dwarf_Fortress/" target="_blank" rel="noopener">Steam</a> or
      <a href="https://kitfoxgames.itch.io/dwarf-fortress" target="_blank" rel="noopener">itch.io</a>, then paste the folder containing <code>Dwarf Fortress.exe</code>.`;
    dfAction = pathEntry();
  }
  rows.push(step(1, "Find Dwarf Fortress", x.df, dfBody, dfAction));

  let hackBody = "Install Dwarf Fortress first."; let hackAction = "";
  if (x.df.ok && x.dfhack.missing) {
    hackBody = `DFHack is not installed in this Dwarf Fortress folder. DWF requires exactly DFHack ${esc(x.dfhack.version?.required || "53.15-r1")}.`;
    hackAction = button("install-dfhack", "Install DFHack for me");
  } else if (x.dfhack.wrongVersion) {
    hackBody = `<strong>Version warning:</strong> DFHack ${esc(x.dfhack.version.version)} is installed, but this mod was built for exactly 53.15-r1. Proceeding may fail to load or crash.`;
    hackAction = x.dfhack.ok ? "" : button("proceed-wrong-dfhack", "Proceed anyway");
  } else if (x.dfhack.ok) hackBody = x.dfhack.version.compatible ? `DFHack ${esc(x.dfhack.version.version)} is ready.` : "DFHack is installed. Its exact version could not be read, so setup will verify the mod after installation.";
  if (x.dfhack.steam.detected) hackBody += `<div class="warning"><strong>Steam DFHack detected.</strong> Avoid maintaining a second manual DFHack install at the same time; the two can conflict. Use one DFHack installation for this Dwarf Fortress folder.</div>`;
  rows.push(step(2, "DFHack", x.dfhack, hackBody + info(INFO.dfhack), hackAction));

  const installBody = x.install.ok
    ? `Dwarf With Friends is installed${x.install.receipt?.installedAt ? ` (verified receipt from ${esc(new Date(x.install.receipt.installedAt).toLocaleString())})` : " and current"}.`
    : "Copies the mod into DFHack safely. Existing files are backed up and an install receipt is kept for repair.";
  rows.push(step(3, "Install the mod", x.install, installBody + info(INFO.install),
    !x.install.ok && x.dfhack.ok ? button("install-mod", "Install Dwarf With Friends") : ""));

  let spriteBody = "Install the mod first."; let spriteAction = "";
  if (x.sprites.classic) spriteBody = "Premium Dwarf Fortress art was not found (DF Classic). This is non-fatal: the game works, with simple placeholders for these sprites.";
  else if (x.sprites.ok) spriteBody = `Sprites are baked from your own Dwarf Fortress art (${x.sprites.state.bakedPresent.length} ready).`;
  else if (x.install.ok) { spriteBody = "Sprites need to be baked from your own Dwarf Fortress art. This does not upload or redistribute the art."; spriteAction = button("bake-sprites", "Bake sprites"); }
  rows.push(step(4, "Sprites", x.sprites, spriteBody + info(INFO.sprites), spriteAction));

  rows.push(step(5, "Get cloudflared", x.cloudflared, esc(x.cloudflared.note) + info(INFO.cloudflared),
    x.cloudflared.ok ? "" : button("fetch-cloudflared", "Get cloudflared")));

  const readyBeforeFinish = x.df.ok && x.dfhack.ok && x.install.ok && x.sprites.ok && x.cloudflared.ok;
  const finishBody = x.finish.ok ? "Your desktop shortcut is ready. Setup is complete." : "Create a desktop shortcut for opening the host panel.";
  const finishAction = `${!x.finish.ok && readyBeforeFinish ? button("create-shortcut", "Create desktop shortcut") : ""}
    ${readyBeforeFinish ? button("open-panel", "Open the host panel now", true) : ""}`;
  rows.push(step(6, "Finish", x.finish, finishBody + info(INFO.finish), finishAction));

  $("#setup-steps").innerHTML = rows.join("");
  const allGood = Object.values(x).every((item) => item.ok);
  $("#setup-summary").textContent = allGood ? "All six checks passed. You are ready to host." : "Work from top to bottom. Setup will re-check after every fix.";
}

async function refresh() {
  try { render(await api.get()); }
  catch (error) { $("#setup-summary").textContent = `Setup could not check this computer: ${error.message}`; }
}
document.addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-toggle-df]");
  if (toggle) {
    const alt = $("#df-alt");
    if (alt) { alt.hidden = !alt.hidden; if (!alt.hidden) $("#df-path")?.focus(); }
    return;
  }
  const target = event.target.closest("[data-setup-action]");
  if (!target || busy) return;
  busy = true; target.disabled = true; target.classList.add("working");
  $("#setup-summary").textContent = target.dataset.setupAction === "bake-sprites" ? "Baking sprites from your Dwarf Fortress art…" : "Working…";
  const body = target.dataset.setupAction === "choose-df" ? { path: $("#df-path")?.value || "" } : {};
  try {
    const result = await api.act(target.dataset.setupAction, body);
    $("#setup-summary").textContent = result.ok ? (result.note || "Done. Checking again…") : (result.error || (result.problems || []).join(" ") || "That step did not finish.");
    if (result.ok && target.dataset.setupAction !== "open-panel") await refresh();
  } catch (error) { $("#setup-summary").textContent = `That step failed: ${error.message}`; }
  finally { busy = false; target.disabled = false; target.classList.remove("working"); }
});
refresh();
