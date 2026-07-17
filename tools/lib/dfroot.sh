# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# SPDX-License-Identifier: AGPL-3.0-only
#
# W1 -- THE DF-ROOT RESOLVER (shell half), for the Git-Bash/MSYS scripts in tools/.
#
# Same policy as tools/lib/dfroot.mjs and tools/lib/dfroot.py, and it does not reimplement it:
# it ASKS the Node resolver, so there is one candidate list, not three. Node is already a hard
# requirement of this repo (every harness suite is plain node).
#
#   . "$(dirname "$0")/../lib/dfroot.sh"
#   DF="$(df_root_or_die "$(basename "$0")" "$@")"   # an MSYS path, e.g. /c/<...>/Dwarf Fortress
#
# Honours --df-root <path> in "$@", then $DWF_DF_ROOT, then autodetect. Prints the friendly
# failure and exits 2 when there is no install.

_dfroot_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prints the DF root as an MSYS path, or nothing (exit 1) if there is none.
df_root() {
  local out
  out="$(node -e '
    import("file://" + process.argv[1] + "/dfroot.mjs").then(({ resolveDfRoot }) => {
      const r = resolveDfRoot({ argv: process.argv.slice(2) });
      if (r.root) { process.stdout.write(r.root); process.exit(0); }
      process.exit(1);
    });' "$_dfroot_lib_dir" "$@" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  # C:\X\Y -> /c/X/Y  (what the rest of these scripts expect)
  printf '%s' "$out" | sed -E 's|^([A-Za-z]):|/\L\1|; s|\\|/|g'
}

df_root_or_die() {
  local name="${1:-this script}"; shift 2>/dev/null || true
  local root
  if root="$(df_root "$@")"; then printf '%s' "$root"; return 0; fi
  {
    echo "$name: CANNOT RUN -- no Dwarf Fortress install found."
    echo
    echo "Point it at yours, either way:"
    echo '  --df-root "C:\...\Dwarf Fortress"'
    echo '  export DWF_DF_ROOT="C:\...\Dwarf Fortress"'
    echo
    echo "The install is only ever READ (except where the script says it deploys)."
  } >&2
  exit 2
}

# W22: same Node-owned policy for the DFHack CMake build tree.
dfhack_build() {
  local out
  out="$(node -e '
    import("file://" + process.argv[1] + "/dfroot.mjs").then(({ resolveDfhackBuild }) => {
      const r = resolveDfhackBuild({ argv: process.argv.slice(2) });
      if (r.root) { process.stdout.write(r.root); process.exit(0); }
      process.exit(1);
    });' "$_dfroot_lib_dir" "$@" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out" | sed -E 's|^([A-Za-z]):|/\L\1|; s|\\|/|g'
}

dfhack_build_or_die() {
  local name="${1:-this script}"; shift 2>/dev/null || true
  local root
  if root="$(dfhack_build "$@")"; then printf '%s' "$root"; return 0; fi
  {
    echo "$name: CANNOT RUN -- no DFHack build tree found."
    echo
    echo "Point it at your CMake build directory, either way:"
    echo '  --dfhack-build "C:\...\dfhack\build"'
    echo '  export DWF_DFHACK_BUILD="C:\...\dfhack\build"'
  } >&2
  exit 2
}

dwf_built_dll() {
  local build
  build="$(dfhack_build_or_die "${1:-this script}" "${@:2}")" || return
  printf '%s/plugins/external/multi-dwarf/Release/dwf.plug.dll' "$build"
}
