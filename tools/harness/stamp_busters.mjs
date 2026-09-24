#!/usr/bin/env node
// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// Script and stylesheet tags always carry a buster; one is added when absent.
const TAG_RE = /(\b(?:src|href)\s*=\s*["'])([^"'?#\s:]+\.(?:js|css))(\?[^"'#\s]*)?(["'])/g;
// Every other reference opts in by carrying a `?v=`, after which the tool owns the value.
// That is what lets a JSON or image fetch be stamped without stamping every URL in the client.
const LITERAL_RE = /(["'`(])((?:[^"'`?#\s:]*\/)?[^"'`?#\s:/]+\.[A-Za-z0-9]+)\?v=([^"'`)#\s&]*)/g;
const TAG_ATTRIBUTE_RE = /(?:src|href)\s*=\s*$/;
const GENERATED_BLOCK_RE = /<!-- BEGIN GENERATED SCRIPT MANIFEST -->[\s\S]*?<!-- END GENERATED SCRIPT MANIFEST -->/;

// Pages carry tags and literals; scripts carry literals only. `root` is what a leading `/`
// resolves to, and a relative reference resolves against the referencing file's own directory.
// Scripts are stamped before pages so a page hashes the script bytes it will actually serve.
const STAMPED_SCRIPTS = [{ dir: "web/js", root: "web" }, { dir: "web/css", root: "web" }];
const STAMPED_PAGES = [
  { file: "web/index.html", root: "web" },
  { file: "web/tiles.html", root: "web" },
  { file: "tools/ui-lab/index.html", root: "tools/ui-lab" },
];

// `pending` holds the stamped-but-not-yet-written bytes of files earlier in the same run, so a
// page hashes the script text it will actually serve rather than the copy still on disk.
function digest(file, pending) {
  const staged = pending && pending.get(file);
  return createHash("sha256").update(staged ?? readFileSync(file)).digest("hex").slice(0, 8);
}

function versionFrom(query = "") {
  for (const part of query.replace(/^\?/, "").split("&"))
    if (part.startsWith("v=")) return part.slice(2);
  return "";
}

function withVersion(query = "", version) {
  const parts = query ? query.slice(1).split("&") : [];
  const index = parts.findIndex((part) => part.startsWith("v="));
  if (index >= 0) parts[index] = `v=${version}`;
  else parts.unshift(`v=${version}`);
  return `?${parts.join("&")}`;
}

function listFiles(dir, extensions) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile())
    .sort();
}

function targetOf(urlPath, root, dir) {
  return urlPath.startsWith("/") ? path.join(root, urlPath.slice(1)) : path.join(dir, urlPath);
}

// Stamps one file's asset references with the 8-hex content hash of the bytes each one points at.
// `tags` enables the script/stylesheet-tag pass, so it is on for pages and off for scripts.
export function stampSource(text, { root, dir, tags = false, pending = null }) {
  const stale = [];
  let references = 0;
  const generated = tags ? text.match(GENERATED_BLOCK_RE) : null;
  const skipFrom = generated ? text.indexOf(generated[0]) : -1;
  const skipTo = generated ? skipFrom + generated[0].length : -1;

  // "" means the referenced file does not exist; the caller leaves that reference untouched
  // and the missing entry fails --check, because a buster names bytes the repo does not have.
  const hashFor = (urlPath, actual) => {
    try { return digest(targetOf(urlPath, root, dir), pending); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stale.push({ file: urlPath, actual, expected: "", missing: true });
      return "";
    }
  };

  let stamped = !tags ? text : text.replace(TAG_RE, (whole, prefix, urlPath, query, quote) => {
    references++;
    const actual = versionFrom(query);
    const expected = hashFor(urlPath, actual);
    if (!expected) return whole;
    if (actual !== expected) stale.push({ file: urlPath, actual, expected });
    return `${prefix}${urlPath}${withVersion(query, expected)}${quote}`;
  });

  stamped = stamped.replace(LITERAL_RE, (whole, quote, urlPath, actual, offset) => {
    if (offset >= skipFrom && offset < skipTo) return whole;
    if (TAG_ATTRIBUTE_RE.test(stamped.slice(Math.max(0, offset - 8), offset))) return whole;
    references++;
    const expected = hashFor(urlPath, actual);
    if (!expected) return whole;
    if (actual !== expected) stale.push({ file: urlPath, actual, expected });
    return `${quote}${urlPath}?v=${expected}`;
  });

  return { stamped, stale, references };
}

export function stampHtml(html, webRoot) {
  return stampSource(html, { root: webRoot, dir: webRoot, tags: true });
}

// Every stamped file in one shape: { path, file, text, stamped, stale, references }.
export function inspectSurfaces(repoRoot = REPO_ROOT) {
  const surfaces = [];
  const pending = new Map();
  const add = (relPath, root, tags) => {
    const file = path.join(repoRoot, ...relPath.split("/"));
    if (!existsSync(file)) return;
    const text = readFileSync(file, "utf8");
    const result = stampSource(text, {
      root: path.join(repoRoot, ...root.split("/")), dir: path.dirname(file), tags, pending,
    });
    if (result.stamped !== text) pending.set(file, result.stamped);
    surfaces.push({ path: relPath, file, text, ...result });
  };
  for (const { dir, root } of STAMPED_SCRIPTS)
    for (const file of listFiles(path.join(repoRoot, ...dir.split("/")), [".js", ".css"]))
      add(path.relative(repoRoot, file).split(path.sep).join("/"), root, false);
  for (const { file, root } of STAMPED_PAGES) add(file, root, true);
  return surfaces;
}

export function inspectStamped(repoRoot = REPO_ROOT) {
  const surfaces = inspectSurfaces(repoRoot);
  return {
    surfaces,
    stale: surfaces.flatMap((s) => s.stale.map((item) => ({ ...item, page: s.path }))),
    references: surfaces.reduce((sum, s) => sum + s.references, 0),
  };
}

export function inspectGeneratedLockstep(repoRoot = REPO_ROOT) {
  const html = readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
  const tags = [];
  for (const match of html.matchAll(TAG_RE)) {
    if (!match[2].startsWith("/js/")) continue;
    tags.push({
      file: match[2].slice("/js/".length),
      url: `${match[2]}${match[3] || ""}`,
      cacheKey: (match[3] || "").replace(/^\?/, ""),
    });
  }
  const errors = [];
  const manifestMatch = html.match(/<!-- BEGIN GENERATED SCRIPT MANIFEST -->[\s\S]*?window\.__DWF_SCRIPT_MANIFEST__\s*=\s*\[([\s\S]*?)\];[\s\S]*?<!-- END GENERATED SCRIPT MANIFEST -->/);
  let manifest = null;
  try { manifest = manifestMatch ? JSON.parse(`[${manifestMatch[1]}]`) : null; }
  catch (error) { errors.push(`generated script manifest is invalid JSON: ${error.message}`); }
  if (!manifestMatch) errors.push("generated script manifest markers or assignment are missing");
  if (manifest) {
    if (manifest.length !== tags.length)
      errors.push(`generated script manifest has ${manifest.length} rows; script tags have ${tags.length}`);
    for (let i = 0; i < Math.min(manifest.length, tags.length); i++)
      if (manifest[i]?.file !== tags[i].file || manifest[i]?.url !== tags[i].url)
        errors.push(`generated script manifest row ${i} differs: expected ${tags[i].url}, found ${manifest[i]?.url || "missing"}`);
  }

  const inventoryPath = path.join(repoRoot, "tools", "architecture", "browser-scripts.json");
  let inventory = null;
  if (!existsSync(inventoryPath)) errors.push("tools/architecture/browser-scripts.json is missing");
  else {
    try { inventory = JSON.parse(readFileSync(inventoryPath, "utf8")); }
    catch (error) { errors.push(`browser-scripts.json is invalid JSON: ${error.message}`); }
  }
  if (inventory) {
    const scripts = Array.isArray(inventory.scripts) ? inventory.scripts : [];
    if (scripts.length !== tags.length)
      errors.push(`browser-scripts.json has ${scripts.length} rows; script tags have ${tags.length}`);
    for (let i = 0; i < Math.min(scripts.length, tags.length); i++)
      if (scripts[i]?.file !== `web/js/${tags[i].file}` || scripts[i]?.cacheKey !== tags[i].cacheKey)
        errors.push(`browser-scripts.json row ${i} differs: expected ${tags[i].url}, found ${scripts[i]?.file || "missing"}?${scripts[i]?.cacheKey || ""}`);
  }
  return { errors, scripts: tags.length };
}

export function inspectRepository(repoRoot = REPO_ROOT) {
  return { ...inspectStamped(repoRoot), lockstep: inspectGeneratedLockstep(repoRoot) };
}

function main() {
  const args = process.argv.slice(2);
  let check = false;
  let repoRoot = REPO_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--repo-root" && args[i + 1]) repoRoot = path.resolve(args[++i]);
    else {
      console.error("Usage: node tools/harness/stamp_busters.mjs [--check] [--repo-root <path>]");
      process.exit(2);
    }
  }
  const result = check ? inspectRepository(repoRoot) : inspectStamped(repoRoot);
  if (result.stale.length || (check && result.lockstep.errors.length)) {
    if (check || result.stale.some((item) => item.missing)) {
      for (const item of result.stale) {
        if (item.missing) console.error(`MISSING ${item.file}: ${item.page} points at bytes no file in the repo holds`);
        else console.error(`STALE ${item.file} in ${item.page}: expected ?v=${item.expected}, found ${item.actual ? `?v=${item.actual}` : "no ?v="}`);
      }
      for (const error of result.lockstep?.errors || []) console.error(`OUT-OF-SYNC ${error}`);
      console.error(`FAIL cache busters (${result.stale.length}/${result.references} stale, ${result.lockstep?.errors.length || 0} generated lockstep errors); run node tools/harness/stamp_busters.mjs, then node tools/architecture/browser_dependency_inventory.mjs --write`);
      process.exit(1);
    }
  }
  if (check) {
    console.log(`PASS cache busters (${result.references} content hashes current across ${result.surfaces.length} files; ${result.lockstep.scripts} generated script rows in lockstep)`);
    return;
  }
  const written = [];
  for (const surface of result.surfaces) {
    if (surface.stamped === surface.text) continue;
    writeFileSync(surface.file, surface.stamped);
    written.push(surface.path);
  }
  for (const file of written) console.log(`STAMPED ${file}`);
  console.log(`STAMPED ${written.length} of ${result.surfaces.length} files (${result.references} references, ${result.stale.length} updated)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
