#!/usr/bin/env bash
# df_lock.sh -- atomic DF access-lock helper for the dwf dev harness.
#
# WHY: the old protocol was "if DF_LOCK doesn't exist, write it with my name, then
# re-read to detect a clobber". The exists()-then-write() check is NOT atomic: two
# agents can both observe "no lock", both write, and the re-read only catches the
# clobber AFTER both have already started driving DF. That TOCTOU window caused 3
# near-miss lock races on 2026-07-07.
#
# FIX: acquire via a noclobber (O_EXCL) create -- `set -C; ... > $LOCK` opens the
# file with O_CREAT|O_EXCL, so exactly ONE racer's create succeeds and every other
# gets EEXIST, even under a simultaneous acquire. The historical re-read-to-verify
# is kept as defense-in-depth. Stale-lock semantics are UNCHANGED: this helper never
# auto-breaks a lock; a holder must release it (or a human/orchestrator removes a
# confirmed-dead one) -- `check` just prints the holder + age so that call is informed.
#
# Usage:
#   df_lock.sh acquire <name> [--wait]   # atomically claim DF_LOCK; --wait polls until free
#   df_lock.sh release <name>            # release ONLY if the lock is ours (never steals)
#   df_lock.sh check                     # print holder + age, or "free"
#
# Exit codes: 0 = acquired / released / check-printed;
#             1 = held by someone else (acquire without --wait);
#             2 = usage error / refused to release another agent's lock.
#
# Env overrides (mainly for tests): DF_LOCK_PATH (lock file location),
#             DF_LOCK_POLL_SECS (--wait poll interval, default 60).
set -u

LOCK="${DF_LOCK_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/DF_LOCK}"
POLL="${DF_LOCK_POLL_SECS:-60}"

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Atomic claim: succeeds iff WE created the file. Content is one line:
#   <name> <pid> <utc>
# Written in a single redirect so a reader never sees a torn/partial line.
_try_acquire() {
  local name="$1"
  if ( set -C; printf '%s %s %s\n' "$name" "$$" "$(now_utc)" > "$LOCK" ) 2>/dev/null; then
    # Defense-in-depth re-read (the old protocol's clobber check), on top of O_EXCL.
    case "$(cat "$LOCK" 2>/dev/null)" in
      "$name "*) return 0 ;;
    esac
  fi
  return 1
}

cmd_acquire() {
  [ $# -ge 1 ] || { echo "usage: df_lock.sh acquire <name> [--wait]" >&2; return 2; }
  local name="$1"; shift
  local wait=0
  [ "${1:-}" = "--wait" ] && wait=1
  while true; do
    if _try_acquire "$name"; then
      echo "ACQUIRED DF_LOCK: $(cat "$LOCK" 2>/dev/null)"
      return 0
    fi
    local h; h="$(cat "$LOCK" 2>/dev/null || true)"
    if [ -z "$h" ]; then continue; fi   # freed between our create-attempt and this read: retry now
    echo "HELD by: $h"
    [ "$wait" -eq 1 ] || return 1
    sleep "$POLL"
  done
}

cmd_release() {
  [ $# -ge 1 ] || { echo "usage: df_lock.sh release <name>" >&2; return 2; }
  local name="$1"
  [ -e "$LOCK" ] || { echo "already free"; return 0; }
  case "$(cat "$LOCK" 2>/dev/null)" in
    "$name "*) rm -f "$LOCK"; echo "RELEASED DF_LOCK ($name)"; return 0 ;;
    *) echo "REFUSING to release: DF_LOCK is held by another agent: $(cat "$LOCK" 2>/dev/null)" >&2
       return 2 ;;
  esac
}

cmd_check() {
  [ -e "$LOCK" ] || { echo "free"; return 0; }
  echo "held: $(cat "$LOCK" 2>/dev/null)"
}

case "${1:-}" in
  acquire) shift; cmd_acquire "$@" ;;
  release) shift; cmd_release "$@" ;;
  check)   cmd_check ;;
  *) echo "usage: df_lock.sh {acquire <name> [--wait]|release <name>|check}" >&2; exit 2 ;;
esac
