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
//
// B242 -- LIVE-ACCESS GUARD.
//
// Several harness suites are ORACLES: they only mean anything against a running DF + dwf
// host, and they default to http://localhost:8765. That default is a trap. When the owner is playing,
// port 8765 is HIS FORT: a sweep that "just runs every *_test.mjs" reaches into a live game, and
// the mutating oracles (burials, geld, lever-link, building-cage, trade-depot...) issue real
// writes into it. This happened twice in one week.
//
// So: a suite that talks to a DF host must call requireLiveOptIn() FIRST. Without an explicit
// opt-in it prints one SKIP line and exits 0 -- a full-suite sweep stays green and stays offline,
// and reaching a live fort becomes something you can only do on purpose.
//
//   node tools/harness/geld_oracle_test.mjs                 -> SKIP (offline, exit 0)
//   node tools/harness/geld_oracle_test.mjs --live          -> runs against http://localhost:8765
//   DFCAP_LIVE=1 node tools/harness/geld_oracle_test.mjs    -> same
//   node tools/harness/geld_oracle_test.mjs --live --host http://127.0.0.1:9000
//
// Suites that MUTATE the fort keep their own extra confirmation flag on top of this one.

const OPT_IN_FLAG = "--live";
const OPT_IN_ENV = "DFCAP_LIVE";

export function liveOptedIn(argv = process.argv) {
  return argv.includes(OPT_IN_FLAG) || process.env[OPT_IN_ENV] === "1";
}

// Call at the TOP of any suite that performs network I/O against a DF host, before the first
// fetch/WebSocket. Exits the process unless the run was explicitly opted in.
export function requireLiveOptIn(name, base) {
  if (liveOptedIn()) return true;
  const target = base ? ` (would target ${base})` : "";
  console.log(`SKIP ${name}: live-server oracle${target}.`);
  console.log(`  It talks to a real DF host, and port 8765 may be the fort mid-game.`);
  console.log(`  Opt in on purpose: node tools/harness/${name} --live [--host http://HOST:PORT]`);
  process.exit(0);
}

// For suites that are mostly OFFLINE but carry an optional live probe: gate just the probe.
// Returns false (and says so) unless the run opted in, so the offline assertions still execute.
export function liveProbeAllowed(label) {
  if (liveOptedIn()) return true;
  console.log(`  (skip) ${label}: live probe not opted in (pass --live or DFCAP_LIVE=1).`);
  return false;
}
