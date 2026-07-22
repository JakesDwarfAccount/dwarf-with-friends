#!/usr/bin/env node
// Keeps the newcomer path concrete and prevents the review template from quietly becoming generic.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = relative => readFileSync(path.join(root, relative), "utf8");

const contributing = read("CONTRIBUTING.md");
for (const phrase of [
  "Choose the smallest useful path",
  "launch_preflight.mjs --stage=suites --json",
  "AI assistance is welcome",
  "inputs, validation",
]) assert.ok(contributing.includes(phrase), `CONTRIBUTING.md is missing: ${phrase}`);

const development = read("docs/DEVELOPMENT.md");
for (const phrase of [
  "tools/release/test-manifest.json",
  "live read-only",
  "Windows native-build workflow",
]) assert.ok(development.includes(phrase), `docs/DEVELOPMENT.md is missing: ${phrase}`);

const pullRequest = read(".github/PULL_REQUEST_TEMPLATE.md");
for (const heading of [
  "## Intentionally unchanged",
  "## Data flow and failure behaviour",
  "## Risk check",
  "## AI assistance and explain-back",
]) assert.ok(pullRequest.includes(heading), `pull request template is missing: ${heading}`);

const issueForms = [
  "good-first-route-policy.yml",
  "good-first-blind-spot.yml",
  "good-first-browser-dependency.yml",
  "good-first-installer-diagnostic.yml",
  "good-first-public-adr.yml",
];
for (const file of issueForms) {
  const relative = path.join(".github", "ISSUE_TEMPLATE", file);
  assert.ok(existsSync(path.join(root, relative)), `missing issue form: ${file}`);
  const form = read(relative);
  assert.match(form, /^name: "Good first issue:/m, `${file} needs a clear name`);
  assert.match(form, /labels: \["good-first-issue"/, `${file} needs the newcomer label`);
  assert.match(form, /Definition of done|Source evidence/, `${file} needs an explicit finish line`);
}

console.log(`ok contributor surface: ${issueForms.length} scoped issue forms and an explain-back review path`);
