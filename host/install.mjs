// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host/install.mjs -- one-click dwf mod installer. Plain node, ZERO npm deps.
//
//   node host/install.mjs [--df-root "<path>"] [--release "<dir>"] [--check] [--yes] [--json]
//
// What it does (idempotent, upgrade-safe):
//   1. Resolves the DF root (--df-root, else auto-detects common Steam paths).
//   2. Verifies it is a Dwarf Fortress install WITH DFHack (clear errors otherwise).
//   3. Copies the release layout (dll + lua x2 + web/) into the exact plugin paths.
//   4. Backs up every file it is about to overwrite into host/backup/<timestamp>/ first.
//   5. Quarantines obsolete pre-rename artifacts (dfcapture.plug.dll / dfcapture.lua) so DFHack
//      cannot load two competing copies of the plugin (see spec W9 "stale-DLL trap").
//   6. Writes an install receipt (versions, paths, timestamp) into the DF root.
//
//   --check  reports install state (receipt + whether deployed files match the release) and
//            touches NOTHING. Exit 0 = installed & current, 3 = not/partly installed.
//
// The release layout this reads:  <release>/dwf.plug.dll, <release>/dwf.lua,
// <release>/web/**.  Default --release is host/release next to this script; a packaged release
// ships that folder pre-filled. (This repo builds the .dll separately -- see AGENTS.md -- so an
// unfilled host/release is expected in a dev checkout and reported honestly.)

import { existsSync, statSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveManifest, checkDfhack, autodetectDfRoot, copyTree,
  inspectDfhackVersion, makeReceipt, readReceipt, writeReceipt, tsStamp, receiptPath,
} from "./hostlib.mjs";
import { bakeSprites, spriteBakeState } from "./bake_sprites.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELEASE = path.join(HERE, "release");
// Backups land in host/backup/<ts>/ by default; DWF_BACKUP_ROOT redirects them (tests).
const BACKUP_ROOT = process.env.DWF_BACKUP_ROOT || path.join(HERE, "backup");

// The one friendly message for "the game has our files open". Same wording whether the pre-flight
// catches it up front or a copy trips EBUSY/EPERM because DF was launched mid-install.
const DF_RUNNING_MSG =
  "Dwarf Fortress is running, so its plugin files are locked and cannot be replaced. " +
  "Close Dwarf Fortress (and make sure it has fully exited), then click Install again.";

// PRE-FLIGHT: is a Dwarf Fortress process running right now? A live game holds hack/plugins/
// dwf.plug.dll open, so copying over it fails with EBUSY. We shell out to tasklist exactly the way
// setup.mjs shells out to powershell -- Windows-simple, absolute-tool, best-effort. On any failure
// (non-Windows, tasklist missing) we return false: never block an install we could not prove is
// unsafe. DWF_ASSUME_DF_RUNNING forces the answer in tests (1/true = running, 0/false = not).
export function isDfRunning(exe = "Dwarf Fortress.exe") {
  const forced = process.env.DWF_ASSUME_DF_RUNNING;
  if (forced != null && forced !== "") return forced === "1" || forced.toLowerCase() === "true";
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/NH"],
      { windowsHide: true, timeout: 10000 }).toString();
    return out.toLowerCase().includes(exe.toLowerCase());
  } catch { return false; }   // tasklist unavailable -> do not block the install
}

// True when a copy failed only because the destination is locked/read-only (a running DF, or a
// stray handle). These map to the friendly "close the game" message; every other error re-throws
// and keeps its existing raw handling.
function isLockedError(e) {
  return !!e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES");
}

function parseArgs(argv) {
  const out = { dfRoot: "", release: "", check: false, yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--df-root") out.dfRoot = argv[++i] ?? "";
    else if (a === "--release") out.release = argv[++i] ?? "";
    else if (a === "--check") out.check = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

const USAGE = `dwf mod installer

  node host/install.mjs [options]

Options:
  --df-root "<path>"   Your Dwarf Fortress folder (the one with "Dwarf Fortress.exe").
                       Omit to auto-detect common Steam locations.
  --release "<dir>"    Folder containing the release files (dwf.plug.dll, dwf.lua, web/).
                       Default: host/release next to this installer.
  --check              Report install state only. Changes nothing.
  --yes, -y            Do not pause for confirmation (for scripts).
  --json               Machine-readable output.
  --help, -h           This help.
`;

// Does the release folder actually contain the files we need to install?
function checkRelease(releaseDir) {
  const problems = [];
  const need = [
    ["dwf.plug.dll", "file"],
    ["dwf.lua", "file"],
    [path.join("gui", "dwf.lua"), "file"],
    ["web", "dir"],
  ];
  if (!existsSync(releaseDir)) {
    problems.push(`Release folder not found: ${releaseDir}`);
    return { ok: false, problems };
  }
  for (const [name, kind] of need) {
    const p = path.join(releaseDir, name);
    if (!existsSync(p)) { problems.push(`Release is missing ${kind}: ${name}`); continue; }
    const isDir = statSync(p).isDirectory();
    if (kind === "dir" && !isDir) problems.push(`Release ${name} should be a folder`);
    if (kind === "file" && isDir) problems.push(`Release ${name} should be a file`);
  }
  return { ok: problems.length === 0, problems };
}

// Best-effort version strings for the receipt (never fatal).
function releaseVersions(releaseDir) {
  const v = {};
  const vf = path.join(releaseDir, "VERSION.txt");
  if (existsSync(vf)) v.release = readFileSync(vf, "utf8").trim();
  const dll = path.join(releaseDir, "dwf.plug.dll");
  if (existsSync(dll)) v.dllBytes = statSync(dll).size;
  return v;
}

// Byte-equal file compare (small files; the dll is the only large one and equality short-circuits).
function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

// Compare every release file against its deployed twin. Returns {installed, upToDate, missing:[], stale:[]}.
function deployState(dfRoot, releaseDir) {
  const entries = resolveManifest(dfRoot, releaseDir);
  const missing = [], stale = [];
  for (const e of entries) {
    if (e.kind === "file") {
      if (!existsSync(e.dest)) missing.push(e.role);
      else if (existsSync(e.src) && !sameFile(e.src, e.dest)) stale.push(e.role);
    } else { // dir: shallow existence + per-file compare
      if (!existsSync(e.dest)) { missing.push(e.role); continue; }
      const diff = dirDiff(e.src, e.dest);
      if (diff.missing.length) missing.push(`${e.role} (${diff.missing.length} files)`);
      if (diff.stale.length) stale.push(`${e.role} (${diff.stale.length} files)`);
    }
  }
  return { missing, stale, upToDate: missing.length === 0 && stale.length === 0 };
}

function dirDiff(src, dest) {
  const missing = [], stale = [];
  const walk = (rel) => {
    const s = path.join(src, rel);
    if (!existsSync(s)) return;
    if (statSync(s).isDirectory()) {
      for (const e of readdirSync(s)) walk(path.join(rel, e));
    } else {
      const d = path.join(dest, rel);
      if (!existsSync(d)) missing.push(rel);
      else if (!sameFile(s, d)) stale.push(rel);
    }
  };
  walk("");
  return { missing, stale };
}

function out(json, human, obj) {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else console.log(human);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }

  const releaseDir = args.release || DEFAULT_RELEASE;

  // --- resolve DF root ---
  let dfRoot = args.dfRoot;
  let autodetected = false;
  if (!dfRoot) { dfRoot = autodetectDfRoot(); autodetected = !!dfRoot; }

  const lines = [];
  const push = (s) => lines.push(s);
  push("dwf installer");
  push(dfRoot ? `  Dwarf Fortress: ${dfRoot}${autodetected ? "  (auto-detected)" : ""}`
              : "  Dwarf Fortress: NOT FOUND");

  // --- verify DF + DFHack ---
  const df = checkDfhack(dfRoot);
  if (!df.ok) {
    push("\nCannot proceed:");
    for (const p of df.problems) push("  - " + p);
    if (autodetected || !args.dfRoot) push("\nTip: pass your folder explicitly with  --df-root \"C:\\...\\Dwarf Fortress\"  (or set DWF_DF_ROOT)");
    out(args.json, lines.join("\n"),
      { ok: false, stage: "verify-df", dfRoot, autodetected, problems: df.problems });
    process.exit(3);
  }
  push("  DFHack: found");
  const dfhackVersion = inspectDfhackVersion(dfRoot);
  const warnings = [];
  if (dfhackVersion.detected && !dfhackVersion.compatible) {
    warnings.push(`DFHack ${dfhackVersion.version} is installed; this plugin requires exactly 53.15-r1.`);
    push(`  WARNING: ${warnings[0]}`);
  } else if (dfhackVersion.compatible) {
    push(`  DFHack version: ${dfhackVersion.version} (compatible)`);
  }

  // ================= --check mode =================
  if (args.check) {
    const receipt = readReceipt(dfRoot);
    const rel = checkRelease(releaseDir);
    let state = null;
    if (rel.ok) state = deployState(dfRoot, releaseDir);
    push("\nInstall state (--check, nothing changed):");
    push("  receipt: " + (receipt
      ? `present -- installed ${receipt.installedAt}${receipt.versions?.release ? " (release " + receipt.versions.release + ")" : ""}`
      : "none (never installed by this tool)"));
    if (!rel.ok) {
      push("  release: incomplete -- cannot compare deployed files:");
      for (const p of rel.problems) push("    - " + p);
      out(args.json, lines.join("\n"), { ok: !!receipt, stage: "check", dfRoot, receipt,
        warnings, dfhackVersion, releaseProblems: rel.problems });
      process.exit(receipt ? 0 : 3);
    }
    if (state.upToDate) push("  files: all deployed files match the release (up to date)");
    else {
      if (state.missing.length) push("  files MISSING: " + state.missing.join(", "));
      if (state.stale.length)   push("  files STALE (differ from release): " + state.stale.join(", "));
    }
    // W11: the composite sprites are baked from THIS install's DF art (they are
    // not in the release -- they derive from the paid DF graphics). Report them.
    const sprites = spriteBakeState({ dfRoot });
    let spritesOk = true;
    if (!sprites.recipeOk) {
      push("  sprites: recipe missing/unreadable (host/sprite_recipe.json)");
      spritesOk = false;
    } else if (!sprites.bakeable) {
      push("  sprites: cannot bake on this install (DF art not found, e.g. " +
           `${sprites.missingSources[0]}) -- the graphical (Steam/itch) edition is`);
      push("           required for sprites; friends will see placeholder dots instead");
      // not a repair-able failure on this install: do not fail --check for it
    } else if (sprites.missingBaked.length) {
      push(`  sprites: MISSING ${sprites.missingBaked.length} baked file(s) -- re-run the installer to bake them`);
      spritesOk = false;
    } else {
      push(`  sprites: baked (${sprites.bakedPresent.length}/${sprites.bakedPresent.length} present)`);
    }
    out(args.json, lines.join("\n"),
      { ok: state.upToDate && spritesOk, stage: "check", dfRoot, receipt, warnings, dfhackVersion,
        missing: state.missing, stale: state.stale, sprites });
    process.exit(state.upToDate && spritesOk ? 0 : 3);
  }

  // ================= install =================
  const rel = checkRelease(releaseDir);
  if (!rel.ok) {
    push("\nThe release files to install are missing:");
    for (const p of rel.problems) push("  - " + p);
    push(`\nExpected in: ${releaseDir}`);
    push("A packaged dwf release ships these. In a source checkout, build the .dll (see AGENTS.md)");
    push("and assemble the release folder, or pass --release <dir>.");
    out(args.json, lines.join("\n"), { ok: false, stage: "release", releaseDir,
      warnings, dfhackVersion, problems: rel.problems });
    process.exit(3);
  }

  // PRE-FLIGHT: DF must be closed before we touch its plugin files. A running game holds
  // hack/plugins/dwf.plug.dll open and the copy below would crash with EBUSY. Refuse up front with a
  // friendly, actionable message instead of a stack trace. This also guards the wizard's verify/
  // repair re-run, which invokes this same installer. (--check above never reaches here: it is
  // read-only and must stay usable while the game runs.)
  if (isDfRunning()) {
    push("\nCannot install right now:");
    push("  - " + DF_RUNNING_MSG);
    out(args.json, lines.join("\n"),
      { ok: false, stage: "df-running", dfRoot, error: DF_RUNNING_MSG });
    process.exit(3);
  }

  const entries = resolveManifest(dfRoot, releaseDir);
  const backupDir = path.join(BACKUP_ROOT, tsStamp());

  // Back up anything we are about to overwrite, then copy. BELT-AND-BRACES: DF can be launched
  // between the pre-flight check and here, so a copy can still hit EBUSY/EPERM on a locked file.
  // Turn that into the SAME friendly message rather than a raw Node crash; other errors re-throw.
  const copied = [];
  let backedUp = 0;
  try {
    for (const e of entries) {
      // backup existing dest(s) -- only when the content actually differs (idempotent re-install
      // of identical files backs up nothing).
      if (e.kind === "file") {
        if (existsSync(e.dest) && !sameFile(e.src, e.dest)) { backupOne(e.dest, dfRoot, backupDir); backedUp++; }
        copyTree(e.src, e.dest, () => {});
        copied.push(e.role);
      } else {
        // dir: back up per-file overwrites, then copy the whole tree
        const diff = dirDiff(e.src, e.dest);
        for (const rel2 of [...diff.stale]) { backupOne(path.join(e.dest, rel2), dfRoot, backupDir); backedUp++; }
        const n = copyTree(e.src, e.dest, () => {});
        copied.push(`${e.role} (${n} files)`);
      }
    }
  } catch (e) {
    if (!isLockedError(e)) throw e;   // genuine errors keep their existing (raw) handling
    push("\nCannot finish the install:");
    push("  - " + DF_RUNNING_MSG);
    out(args.json, lines.join("\n"),
      { ok: false, stage: "df-running", dfRoot, error: DF_RUNNING_MSG });
    process.exit(3);
  }

  // W9 stale-DLL trap: DFHack loads EVERY dll in hack/plugins, so a leftover pre-rename
  // dfcapture.plug.dll would run a SECOND copy of the plugin beside the new dwf.plug.dll (they
  // contend for the same HTTP port and DF state -- erratic, not a clean crash). Quarantine the
  // obsolete dfcapture.* artifacts into the same backup dir. Idempotent + safe on a fresh install.
  const staleRemoved = removeStaleArtifacts(dfRoot, backupDir, push);

  // W11: bake the composite sprites from THIS install's own DF art into the
  // deployed web root. They are not in the release: their pixels derive from
  // the paid DF graphics, which this project may not redistribute. A failed
  // bake is not fatal -- the client falls back to placeholder dots -- but it
  // is reported loudly and recorded in the receipt.
  push("\nBaking sprites from your Dwarf Fortress art:");
  const bake = bakeSprites({ dfRoot, log: push });
  if (!bake.ok) {
    push("  ! Sprite bake did not complete. The game still works; units and some");
    push("    furniture draw as simple placeholders until sprites are baked.");
    for (const p of bake.problems) push("    - " + p);
  }

  // The backup dir is "used" (and worth recording) if we backed up an overwrite OR quarantined a
  // stale artifact into it -- either way it now holds recoverable files.
  const usedBackup = backedUp > 0 || staleRemoved.length > 0;
  const receipt = makeReceipt({
    dfRoot, releaseDir, entries,
    versions: releaseVersions(releaseDir),
    backupDir: usedBackup ? backupDir : null,
  });
  receipt.spriteBake = { ok: bake.ok, written: bake.written, problems: bake.problems };
  receipt.staleRemoved = staleRemoved;
  writeReceipt(dfRoot, receipt);

  push("\nInstalled:");
  for (const c of copied) push("  + " + c);
  push(usedBackup ? `  (backed up ${backedUp} overwritten + ${staleRemoved.length} obsolete file(s) to ${backupDir})`
                  : "  (fresh install -- nothing to back up)");
  push(`  receipt: ${receiptPath(dfRoot)}`);
  push("\nDone. Next: set a join password and start the server with the host panel:");
  push("  node host/host_panel.mjs");
  out(args.json, lines.join("\n"),
    { ok: true, stage: "installed", dfRoot, warnings, dfhackVersion, copied, staleRemoved,
      backupDir: usedBackup ? backupDir : null, spriteBake: receipt.spriteBake, receipt });
  process.exit(0);
}

// Copy one existing file into the backup dir, preserving its path RELATIVE to the DF root
// (so hack/plugins/dwf.plug.dll -> <backup>/hack/plugins/dwf.plug.dll).
function backupOne(destFile, dfRoot, backupDir) {
  const rel = path.relative(dfRoot, destFile);
  const to = path.join(backupDir, rel);
  copyTree(destFile, to, () => {});
}

// Detect and remove pre-rename (dfcapture.*) artifacts that must not coexist with the deployed
// dwf.* set. The .dll + .lua files are QUARANTINED (copied into the backup dir, then deleted from
// the install) so a mistaken removal is recoverable; the pure-scratch .old web dir is deleted
// outright. Returns the list of removed paths (relative to dfRoot). Idempotent: once the old files
// are gone, every existsSync below is false and the function is a clean no-op -- and it is a no-op
// on a fresh install where none of these ever existed. NOTE: hack/dfcapture-web/ is deliberately
// NOT touched -- it is the LIVE served web root (src/web_assets.cpp:31 kWebRoot), not a stale name.
function removeStaleArtifacts(dfRoot, backupDir, log) {
  const removed = [];
  const header = () => { if (!removed.length) log("\nRemoving obsolete pre-rename artifacts (DFHack must not load two plugin copies):"); };
  const quarantine = (rel) => {
    const abs = path.join(dfRoot, rel);
    if (!existsSync(abs)) return;
    header();
    backupOne(abs, dfRoot, backupDir);            // recoverable copy first
    rmSync(abs, { recursive: true, force: true }); // then remove from the live install
    removed.push(rel);
    log(`  - quarantined stale ${rel.replace(/\\/g, "/")} -> ${path.join(backupDir, rel)}`);
  };

  // 1) old plugin dll + any *.bak-* / versioned clutter sitting beside it in hack/plugins.
  //    DFHack scans this whole folder, so every dfcapture.plug.dll* here is a load hazard.
  const pluginsDir = path.join(dfRoot, "hack", "plugins");
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      if (name === "dfcapture.plug.dll" || name.startsWith("dfcapture.plug.dll.")) {
        quarantine(path.join("hack", "plugins", name));
      }
    }
  }
  // 2) old lua module (the one DFHack binds by filename) + the legacy script copies + old gui script.
  quarantine(path.join("hack", "lua", "plugins", "dfcapture.lua"));
  quarantine(path.join("hack", "scripts", "dfcapture.lua"));
  quarantine(path.join("hack", "scripts", "gui", "dfcapture.lua"));
  // 3) old web scratch dir -- pure leftover, safe to delete outright (NOT the live dfcapture-web/).
  const oldWeb = path.join(dfRoot, "hack", "dfcapture-web.old");
  if (existsSync(oldWeb)) {
    header();
    rmSync(oldWeb, { recursive: true, force: true });
    removed.push(path.join("hack", "dfcapture-web.old"));
    log("  - deleted stale hack/dfcapture-web.old/");
  }
  return removed;
}

main();
