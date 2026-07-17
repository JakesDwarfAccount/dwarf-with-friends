// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// There is no Lua interpreter in the offline harness, so a syntax error in dwf.lua is not
// caught until DFHack tries to load the plugin -- i.e. in the live fort. This is not a parser;
// it is a block-balance guard for the realistic failure mode (an unmatched `end` after editing a
// long function), with strings, long-strings and comments stripped first.
//
// It validates itself: it must report BALANCED on the committed file and UNBALANCED on seeded-bad
// variants (a dropped `end`, an extra `end`). A checker that cannot fail is worthless.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Strip comments and string literals so their contents never look like keywords.
function strip(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    // long comment / long string:  --[[ ... ]]  or  [[ ... ]]
    const long = src.startsWith("--[[", i) ? 4 : (src.startsWith("[[", i) ? 2 : 0);
    if (long) {
      const close = src.indexOf("]]", i + long);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    if (src.startsWith("--", i)) {                    // line comment
      const nl = src.indexOf("\n", i);
      if (nl === -1) break;
      out += "\n";
      i = nl;
      continue;
    }
    if (c === '"' || c === "'") {                      // quoted string
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
  }
  return out;
}

// Count block openers vs `end`. Openers: function / if / for / while / do.
// `do` is skipped when it closes a for/while header (that `do` belongs to the loop we already
// counted) and `elseif`/`else` do not open a block. A one-line `... end` still balances.
function balance(src) {
  const s = strip(src);
  let depth = 0;
  const tokens = s.match(/\b(function|if|for|while|do|end|then|repeat|until|else|elseif)\b/g) || [];
  let pendingLoop = 0;   // for/while headers awaiting their `do`
  for (const t of tokens) {
    if (t === "function" || t === "if") depth++;
    else if (t === "for" || t === "while") { depth++; pendingLoop++; }
    else if (t === "do") { if (pendingLoop > 0) pendingLoop--; else depth++; }
    else if (t === "repeat") depth++;
    else if (t === "until") depth--;
    else if (t === "end") depth--;
  }
  return depth;
}

let failed = 0;
function check(name, ok) {
  console.log((ok ? "  ok - " : "  FAIL - ") + name);
  if (!ok) failed++;
}

console.log("# lua block-balance guard");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
const d = balance(lua);
check(`dwf.lua blocks balance (depth ${d}, want 0)`, d === 0);

// self-validation: the guard must catch a dropped and an extra `end`
console.log("## seeded-bad (the guard must fail on these)");
const dropped = lua.replace(/\nend\n/, "\n");
check("a dropped `end` is caught", balance(dropped) !== 0);
check("an extra `end` is caught", balance(lua + "\nend\n") !== 0);
check("a truncated function is caught", balance(lua + "\nfunction x()\n") !== 0);
check("a balanced no-op edit is still balanced",
  balance(lua + "\nfunction noop_probe()\n    return true\nend\n") === 0);

console.log(failed ? `\n# FAIL (${failed})` : "\n# PASS");
process.exit(failed ? 1 : 0);
