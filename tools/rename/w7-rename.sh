#!/usr/bin/env bash
# w7-rename.sh -- HISTORICAL, already executed: the brand rename dfcapture -> dwf. A PURE,
# MECHANICAL, HISTORY-PRESERVING rename. It substituted tokens and `git mv`d files and did
# NOTHING else. Kept for the record; running it again is a loud no-op by design (see below).
#
# Two phases:
#   Phase A -- substitute file CONTENTS in every tracked text file (tools/rename/w7-sub.pl
#              holds the exact rule set, including all W9 protected literals).
#   Phase B -- `git mv` every file whose NAME contains `dfcapture`, EXCEPT the two lua files
#              whose FILENAMES are the C++<->lua bridge key and stay until W9.
#
# Run once, from anywhere inside the worktree. Re-running after a successful run is a no-op
# for Phase A and will fail loudly in Phase B (old paths already gone) -- by design.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SUB="tools/rename/w7-sub.pl"
[ -f "$SUB" ] || { echo "missing $SUB" >&2; exit 1; }

# Extensions we never read (true binaries). w7-sub.pl also self-guards on NUL bytes, so this
# is only a performance filter, not a correctness one.
SKIP_RE='\.(png|jpg|jpeg|gif|ico|bmp|webp|ttf|otf|woff|woff2|eot|zip|gz|tgz|dll|exe|pdf|mp3|wav|ogg|bin|pyc|class|o|obj|lib|a)$'

echo "== Phase A: content substitution =="
count=0
while IFS= read -r -d '' f; do
    case "$f" in
        tools/rename/*) continue ;;   # never rewrite the rename tooling itself
    esac
    if [[ "$f" =~ $SKIP_RE ]]; then continue; fi
    if perl "$SUB" "$f" >/dev/null; then
        count=$((count + 1))
    fi
done < <(git ls-files -z)
echo "   scanned tracked files; substitution applied where tokens were present"

echo "== Phase B: history-preserving file renames (git mv) =="
moved=0
while IFS= read -r -d '' f; do
    # W9: these lua FILENAMES are how DFHack resolves the module to the plugin -- do NOT rename.
    case "$f" in
        dfcapture.lua|scripts/gui/dfcapture.lua) continue ;;
    esac
    base="${f##*/}"
    case "$base" in
        *dfcapture*)
            dir="${f%/*}"
            [ "$dir" = "$f" ] && dir="."          # file at repo root
            newbase="${base/dfcapture/dwf}"        # basenames contain the token exactly once
            git mv "$f" "$dir/$newbase"
            moved=$((moved + 1))
            ;;
    esac
done < <(git ls-files -z)
echo "   git mv complete: $moved files renamed"

# Stage the content edits on tracked files that were NOT renamed. `git add -u` only touches
# already-tracked paths (never sweeps untracked junk); the renames are already staged by git mv.
git add -u
echo "== done. review with: git status && git diff --cached --stat =="
