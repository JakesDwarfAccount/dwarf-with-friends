# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, version 3 of the License.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# SPDX-License-Identifier: AGPL-3.0-only
#
# W1 -- THE DF-ROOT RESOLVER (Python half).
#
# The SAME policy as tools/lib/dfroot.mjs (the Node half, which wraps host/hostlib.mjs).  Two
# languages force two implementations; `tools/harness/dfroot_resolver_test.mjs` runs both against
# the same fixtures and FAILS if they disagree, so there is still exactly one policy:
#
#     --df-root <path>   (explicit; --df / --dfroot also accepted)      AUTHORITATIVE
#     $DWF_DF_ROOT       (legacy $DFCAPTURE_DF_ROOT / $DF_ROOT honoured)
#     autodetect         (Steam's libraryfolders.vdf, then the usual install spots)
#     -> otherwise NOTHING. Never a silent fall back to one developer's machine.
#
# An explicit root is authoritative: wrong-but-named fails loudly instead of quietly serving art
# from some other install we happened to find.
#
# Zero dependencies (stdlib only) on purpose: every gate, builder and spike here can import it,
# whichever interpreter they run under.

import os
import re
import sys

ENV_VARS = ["DWF_DF_ROOT", "DFCAPTURE_DF_ROOT", "DF_ROOT"]
FLAGS = ["--df-root", "--df", "--dfroot"]
DFHACK_BUILD_ENV_VARS = ["DWF_DFHACK_BUILD"]
DFHACK_BUILD_FLAGS = ["--dfhack-build"]
DFHACK_BUILD_NAMES = ["build-msvc", "build", "build-vs2022", "build-vs2026"]

# Keep in lockstep with host/hostlib.mjs steamDfCandidates() -- the resolver test asserts it.
DRIVES = ["C", "D", "E", "F", "G", "H"]
TAILS = [
    r"SteamLibrary\steamapps\common\Dwarf Fortress",
    r"Steam\steamapps\common\Dwarf Fortress",
    r"Program Files (x86)\Steam\steamapps\common\Dwarf Fortress",
    r"Program Files\Steam\steamapps\common\Dwarf Fortress",
    r"Games\Dwarf Fortress",
]
STEAM_VDFS = [
    r"C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf",
    r"C:\Program Files\Steam\steamapps\libraryfolders.vdf",
]


def steam_df_candidates(drives=None):
    """The fixed guesses. Pure: touches no disk."""
    return ["%s:\\%s" % (d, t) for d in (drives or DRIVES) for t in TAILS]


def steam_library_df_candidates(exists=os.path.exists, read_text=None, vdfs=None):
    """Installs Steam itself knows about -- finds drives the fixed list never guesses."""
    if read_text is None:
        def read_text(p):
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()
    out = []
    for vdf in (vdfs if vdfs is not None else STEAM_VDFS):
        if not exists(vdf):
            continue
        try:
            text = read_text(vdf)
        except OSError:
            continue
        for lib in re.findall(r'"path"\s*"([^"]+)"', text):
            lib = lib.replace("\\\\", "\\")
            out.append(os.path.join(lib, "steamapps", "common", "Dwarf Fortress"))
    return out


def is_df_root(df_root, exists=os.path.exists):
    """A DF install holds the game exe OR the vanilla raws (raws are all most tools need)."""
    if not df_root:
        return False
    return (exists(os.path.join(df_root, "Dwarf Fortress.exe"))
            or exists(os.path.join(df_root, "data", "vanilla")))


def has_dfhack(df_root, exists=os.path.exists):
    return bool(df_root) and exists(os.path.join(df_root, "hack", "plugins"))


def df_candidates(exists=os.path.exists, read_text=None):
    return steam_library_df_candidates(exists, read_text) + steam_df_candidates()


def autodetect_df_root(candidates=None, exists=os.path.exists, read_text=None):
    cands = candidates if candidates is not None else df_candidates(exists, read_text)
    for c in cands:
        if is_df_root(c, exists) and has_dfhack(c, exists):
            return c
    for c in cands:
        if is_df_root(c, exists):
            return c
    for c in cands:
        if exists(c):
            return c
    return None


def _flag_value(argv):
    for f in FLAGS:
        if f in argv:
            i = argv.index(f)
            if i + 1 < len(argv):
                return argv[i + 1], f
        for a in argv:
            if a.startswith(f + "="):
                return a[len(f) + 1:], f
    return None


def _env_value(env):
    for v in ENV_VARS:
        if env.get(v):
            return env[v], "$" + v
    return None


def resolve_df_root(explicit=None, argv=None, env=None, exists=os.path.exists, read_text=None):
    """-> (root_or_None, source, explicit_bool, tried[]). See the module header for the order."""
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    tried = []

    named = None
    if explicit:
        named = (explicit, "--df-root")
    else:
        named = _flag_value(argv) or _env_value(env)

    if named:
        root = os.path.abspath(named[0])
        tried.append("  [%s] %s" % (named[1], root))
        return (root if exists(root) else None), named[1], True, tried

    cands = df_candidates(exists, read_text)
    found = autodetect_df_root(cands, exists, read_text)
    tried += ["  [autodetect] %s" % c for c in cands]
    return found, "autodetect", False, tried


def missing_df_message(tried, explicit=False, purpose=""):
    why = ("\n  It needs one because: %s" % purpose) if purpose else ""
    head = ("The Dwarf Fortress folder you named does not exist.%s" % why) if explicit \
        else ("No Dwarf Fortress install was found on this machine.%s" % why)
    shown = tried if explicit else tried[:8] + (
        ["  ... and %d more" % (len(tried) - 8)] if len(tried) > 8 else [])
    return "\n".join([
        head, "",
        "Looked in:", *shown, "",
        "Point it at your install, either way:",
        '  --df-root "C:\\...\\Dwarf Fortress"',
        "  set DWF_DF_ROOT=C:\\...\\Dwarf Fortress",
        "", "The install is only ever READ.",
    ])


def df_root_or_die(tool_name, explicit=None, purpose="", argv=None):
    """Tools a human runs on purpose: no install => say exactly what to pass, exit 2."""
    root, _source, is_explicit, tried = resolve_df_root(explicit=explicit, argv=argv)
    if root:
        return root
    sys.stderr.write("%s: CANNOT RUN.\n\n" % tool_name)
    sys.stderr.write(missing_df_message(tried, is_explicit, purpose) + "\n")
    sys.exit(2)


def df_root_or_skip(name, purpose="reads Dwarf Fortress's own raws/art as an oracle", argv=None):
    """Test suites: no install => one SKIP line, exit 0. Mirrors dfroot.mjs dfRootOrSkip."""
    root, _source, is_explicit, _tried = resolve_df_root(argv=argv)
    if root and (is_explicit or is_df_root(root)):
        return root
    print("SKIP %s: needs a Dwarf Fortress install (%s)." % (name, purpose))
    print('  Point it at one with --df-root "C:\\...\\Dwarf Fortress", or set DWF_DF_ROOT.')
    sys.exit(0)


def df_root_default(argv=None, sub=None):
    """For argparse `default=` and module-level constants: the resolved root (optionally with a
    subpath like "data/vanilla" appended), or "" when there is no DF install. NON-FATAL on
    purpose -- a module-level constant must not kill a test that merely imports the module.
    Pair it with require() at the point the DF files are actually read."""
    root, _source, _explicit, _tried = resolve_df_root(argv=argv)
    if not root:
        return ""
    return os.path.join(root, *sub.split("/")) if sub else root


def df_root_for(caller_file, purpose="", sub=None, argv=None):
    """The module-level constant helper for SCRIPTS: resolves like df_root_default, but when no
    install is found it DIES with the friendly message *if this module is the program being run*,
    and returns "" if it is merely being imported (by a test, say). One line at the call site,
    right behaviour in both roles."""
    root, _source, is_explicit, tried = resolve_df_root(argv=argv)
    if root:
        return os.path.join(root, *sub.split("/")) if sub else root
    entry = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else ""
    if entry and os.path.abspath(caller_file) == entry:
        sys.stderr.write("%s: CANNOT RUN.\n\n" % os.path.basename(caller_file))
        sys.stderr.write(missing_df_message(tried, is_explicit, purpose) + "\n")
        sys.exit(2)
    return ""


def require(value, tool_name, purpose=""):
    """Guard at the point of use: a falsy/absent DF path becomes the friendly failure, exit 2."""
    if value and os.path.exists(value):
        return value
    _root, _s, is_explicit, tried = resolve_df_root()
    sys.stderr.write("%s: CANNOT RUN.\n\n" % tool_name)
    sys.stderr.write(missing_df_message(tried, is_explicit, purpose) + "\n")
    sys.exit(2)


def dfhack_run(df_root):
    """DFHack's CLI lives in hack/, NOT at the DF root."""
    return os.path.join(df_root, "hack", "dfhack-run.exe")


# W22 -- DFHack CMake build-tree resolution. Keep in lockstep with host/hostlib.mjs and
# tools/lib/dfroot.mjs; dfroot_resolver_test.mjs runs both implementations on the same fixtures.
def dfhack_build_candidates(repo_root):
    out = []
    directory = os.path.abspath(repo_root)
    for _depth in range(6):
        for name in DFHACK_BUILD_NAMES:
            candidate = os.path.join(directory, name)
            if candidate not in out:
                out.append(candidate)
        for name in DFHACK_BUILD_NAMES:
            candidate = os.path.join(directory, "dfhack", name)
            if candidate not in out:
                out.append(candidate)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return out


def is_dfhack_build(build_root, exists=os.path.exists):
    if not build_root:
        return False
    return (exists(os.path.join(build_root, "CMakeCache.txt"))
            or exists(os.path.join(build_root, "plugins", "external", "multi-dwarf", "Release",
                                   "dfcapture.plug.dll")))


def autodetect_dfhack_build(candidates, exists=os.path.exists):
    for candidate in candidates:
        if is_dfhack_build(candidate, exists):
            return candidate
    return None


def resolve_dfhack_build(argv=None, env=None, exists=os.path.exists, repo_root=None,
                         candidates=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    tried = []
    named = None
    for flag in DFHACK_BUILD_FLAGS:
        if flag in argv:
            index = argv.index(flag)
            if index + 1 < len(argv):
                named = (argv[index + 1], flag)
                break
        for arg in argv:
            if arg.startswith(flag + "="):
                named = (arg[len(flag) + 1:], flag)
                break
        if named:
            break
    if not named:
        for var in DFHACK_BUILD_ENV_VARS:
            if env.get(var):
                named = (env[var], "$" + var)
                break
    if named:
        root = os.path.abspath(named[0])
        tried.append("  [%s] %s" % (named[1], root))
        return (root if exists(root) else None), named[1], True, tried

    if repo_root is None:
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    cands = candidates if candidates is not None else dfhack_build_candidates(repo_root)
    found = autodetect_dfhack_build(cands, exists)
    tried += ["  [autodetect] %s" % candidate for candidate in cands]
    return found, "autodetect", False, tried


def missing_dfhack_build_message(tried, explicit=False, purpose=""):
    why = ("\n  It needs one because: %s" % purpose) if purpose else ""
    head = ("The DFHack build tree you named does not exist.%s" % why) if explicit \
        else ("No DFHack build tree was found on this machine.%s" % why)
    shown = tried if explicit else tried[:8] + (
        ["  ... and %d more" % (len(tried) - 8)] if len(tried) > 8 else [])
    return "\n".join([
        head, "", "Looked in:", *shown, "",
        "Point it at your CMake build directory, either way:",
        '  --dfhack-build "C:\\...\\dfhack\\build"',
        '  set DWF_DFHACK_BUILD=C:\\...\\dfhack\\build',
    ])


def dfhack_build_or_die(tool_name, purpose="", argv=None):
    root, _source, is_explicit, tried = resolve_dfhack_build(argv=argv)
    if root:
        return root
    sys.stderr.write("%s: CANNOT RUN.\n\n" % tool_name)
    sys.stderr.write(missing_dfhack_build_message(tried, is_explicit, purpose) + "\n")
    sys.exit(2)


def built_dwf_dll(build_root, config="Release"):
    return os.path.join(build_root, "plugins", "external", "multi-dwarf", config,
                        "dfcapture.plug.dll")
