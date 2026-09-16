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

// Resolve grouped and flat documentation layouts.
import fs from "node:fs";
import path from "node:path";

// docs/guides/X.md -> docs/X.md ; .github/X.md -> X.md ; docs/X.md -> X.md
function publicCandidates(rel) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  const out = [];
  if (parts[0] === "docs" && parts.length === 3) out.push(`docs/${base}`);
  if (parts[0] === ".github" && parts.length === 2) out.push(base);
  if (parts[0] === "docs" && parts.length === 2) out.push(base);
  return out;
}

// Absolute path to `rel` in whichever tree `root` is, or null when neither location has it.
export function findDoc(root, rel) {
  for (const candidate of [rel, ...publicCandidates(rel)]) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

// Same, but throws naming both locations. Callers that must have the document use this so the
// failure says which tree it was looking in rather than printing a bare ENOENT.
export function requireDoc(root, rel) {
  const found = findDoc(root, rel);
  if (found) return found;
  const tried = [rel, ...publicCandidates(rel)].join(", ");
  throw new Error(`document not found in either tree layout: ${rel} (tried ${tried})`);
}

export function readDoc(root, rel, encoding = "utf8") {
  return fs.readFileSync(requireDoc(root, rel), encoding);
}
