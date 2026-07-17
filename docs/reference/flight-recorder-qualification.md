# Flight Recorder qualification protocol

This is the first-restart acceptance protocol for the ground-truth Flight Recorder. It validates
the deployed recorder without synthetic input, camera writes, plugin reloads, or a second DF
instance. The harness acquires `DF_LOCK` atomically through the repository helper and releases it
on success or failure.

The protocol is deliberately split into one automated baseline and two operator-prepared native-screen
checks. A static build or source-contract test is necessary but cannot prove that DF's live screen
arrays, texture table, and work-order UI state survive a real session.

## Before restart clearance

These checks are safe with the current DF session untouched:

```powershell
node tools\harness\flight_recorder_contract_test.mjs
node tools\harness\flight_recorder_qualification.mjs --selftest
```

Both must exit 0. The qualification self-test exercises legacy-v2 and current-v3 envelope
compatibility, zlib payload decoding,
all 14 possible GPS UI-plane identities and element widths (seven base planes plus seven top
overlay planes), the explicit `gps_top_in_use` contract, all 26 viewport-plane identities and
widths, and intentional missing-plane, bad-width, and compressed-payload corruption. It proves
both adversarial directions: `true` with a missing top plane fails, and `false` with any top plane
also fails. It does not contact DF.

New captures use recorder format v3. Existing v1/v2 sessions and the evidence manifests that hash
them remain valid historical evidence and must not be rewritten. Rich v3 frames add fixed-width
`ui_hash`/`route_stamp` values and eight strict family-slice envelopes; cheap v3 frames keep slices
disabled. The baseline harness still verifies the screen/status/work-order compatibility fields,
while `tools/harness/flight_recorder_v3_qualification.mjs` strictly grades the new slice wave.

Build with the exact command in `AGENTS.md`, verify the DFHack source junction is a real
`ReparsePoint`, and record the cleared DLL's SHA-256:

```powershell
Get-FileHash "<DFHACK_ROOT>\build-msvc\plugins\external\multi-dwarf\Release\dwf.plug.dll" -Algorithm SHA256
```

Do not copy that DLL while DF is running. Deployment remains gated by
`deploy_integrity_check.mjs` before and after the copy, and the copy requires a full DF shutdown.

## Cleared restart and manual world load

After the owner grants restart clearance, follow the repository's full-restart procedure under `DF_LOCK`:
stop DF, copy the gated DLL only while DF is stopped, relaunch exactly one instance, and let the owner load
the fortress manually. Never hot-reload the plugin.

If join authentication is enabled, set the password in the current shell so it does not appear in
the command line:

```powershell
$env:DWF_JOIN_PASSWORD = "<current join password>"
```

The live commands below acquire and release `DF_LOCK` themselves. On Windows the harness resolves
Git for Windows' real `bin/bash.exe` from `git.exe` and standard install locations; it deliberately
does not invoke the Windows/WSL `bash.exe` launcher. A portable Git install can be named with
`DWF_GIT_BASH`. Do not pre-create or manually edit the lock file, and do not bypass the helper if
Git Bash cannot be resolved.

## Phase 1 — automated baseline

Run this with the fortress loaded and the native game left on any stable fortress screen:

```powershell
node tools\harness\flight_recorder_qualification.mjs --phase baseline --seconds 2 `
  --expected-dll-sha256 "<cleared DLL SHA-256>"
```

The harness performs no input. It validates:

- `/recorder/start`, `/recorder/status`, and `/recorder/stop` lifecycle and counters;
- duplicate start returns HTTP 409 with `already running`;
- an output path below a file returns HTTP 500 with `cannot create dir`;
- cheap mode emits a manifest and changed-frame record without rich-only slices, while retaining
  the complete base GPS UI texture stack (`texpos`, `lower`, `anchored`, anchored x/y, and flag);
- every record explicitly states `gps_top_in_use`; when true, its screen and complete matching
  texture stack are present as exactly seven additional, dimension-matched planes, and when false
  none of those top planes may be present;
- rich `vp=1` mode emits timing, focus, live UNIT_STATUS mapping, and all 26 canonical viewport
  planes with decoded lengths matching their dimensions and element widths;
- every zlib/base64 payload decodes to `raw_len`;
- manifest `build` equals `/version.git`, with a nonempty DF version;
- the DLL loaded in `<DF>/hack/plugins/` has the exact cleared SHA-256 when the expected hash is
  supplied.

Output is written beneath `recordings/qualification/<timestamp>-baseline/`, which is gitignored.
The final `qualification-report.json` names both source JSONL sessions and the observed server/DLL
identities, and binds each session with its SHA-256.

## Phase 2 — status mapping and blink timing

The owner preparation is required because the harness never navigates or moves the camera:

1. In native DF, show a fortress map view containing at least one visible dwarf with a need/status
   bubble. Hungry, thirsty, or drowsy dwarves are the Rule 0001 targets.
2. Leave the native window visible and the game running normally.
3. Run:

```powershell
node tools\harness\flight_recorder_qualification.mjs --phase status --seconds 5 `
  --expected-dll-sha256 "<cleared DLL SHA-256>"
```

This phase requires the 41-row runtime UNIT_STATUS texpos mapping, finds those texture IDs in the
decoded viewport planes, and records the corresponding `frame`, `ui_tick`, and `ui_tick % 1000`.
It requires hits at two or more UI phases. If it reports no hit, that is a preparation failure—not
permission to automate navigation. The owner should place an appropriate dwarf on screen and rerun.

Passing this phase qualifies the recorder's mapping and timing fields. Promoting Rule 0001 to
`corpus-confirmed` still requires the reducer to match the relevant timer thresholds and blink
windows against the saved frame IDs.

## Phase 3 — native work-order slice

The owner preparation:

1. Open native **Work Orders**.
2. Select a real order and open its **Conditions** editor.
3. Leave the screen showing **Suggested conditions**.
4. Run:

```powershell
node tools\harness\flight_recorder_qualification.mjs --phase work-order --seconds 2 `
  --expected-dll-sha256 "<cleared DLL SHA-256>"
```

The harness requires the flattened native text grid to contain `Suggested conditions`, a resolved
manager-order id, a nonempty native suggestion vector, and complete filter shapes including the
`contains` vector.

To qualify the existing-condition half, use an order that already has at least one item condition
and rerun:

```powershell
node tools\harness\flight_recorder_qualification.mjs --phase work-order --expect-existing `
  --expected-dll-sha256 "<cleared DLL SHA-256>"
```

Passing proves that the recorder paired the native screen, render-owned suggestion vector, and
simulation-owned existing/requested filters. Rule 0002 still becomes `corpus-confirmed` only after
the reducer verifies the visible suppression/operator facts against these recorded frames.

## Failure semantics and recovery

- The harness refuses to run if another recorder session is active.
- Missing or broken Git Bash fails before any recorder route is called; install Git for Windows or
  set `DWF_GIT_BASH` to its `bash.exe`.
- A failure after start makes a best-effort `/recorder/stop` call before releasing `DF_LOCK`.
- If a long passive capture loses only the final stop reply with `ECONNRESET`, the harness makes a
  fresh authenticated status request. It recovers only when that authoritative status says the
  recorder is stopped; a running or unreachable recorder remains a hard failure.
- It never breaks another holder's lock.
- A missing password, wrong deployed DLL hash, malformed JSONL, missing plane, bad decompression,
  early recorder stop, missing UNIT_STATUS hit, or absent native work-order screen is a hard fail.
- Asynchronous file/size failures currently surface as `running:false`, counters stopping, and a
  `dwf.log` diagnostic. The baseline safely covers structured start/conflict failure responses; do
  not manufacture a disk-full condition on the machine.
- Do not weaken a failed check. Preserve the JSONL and report, record the exact error, and return to
  source/build diagnosis before another restart.

Qualification is complete only when baseline, status, and both work-order runs pass against the
same deployed DLL hash, followed by the five-route v3 session described in the combined recorder-v3
slice design. Grade that stopped JSONL session with:

```powershell
node tools/harness/flight_recorder_v3_qualification.mjs <session.jsonl>
```

No individual pass authorizes hot reload, deployment, or a Rule Ledger promotion by itself.
