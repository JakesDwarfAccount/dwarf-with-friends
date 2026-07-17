#!/usr/bin/env bash
# Headless (NO synthetic input) DF relaunch + load-save test — the "operator-at-keyboard mode"
# probe. Kills DF, relaunches, then tries `dfhack-run load-save <folder>` (which uses
# gui.simulateInput on the title screen). Polls fortress mode; reports HEADLESS-LOAD-OK
# or HEADLESS-LOAD-FAILED (leaving DF at the title for a human to click Continue).
set -u
# W1: resolved, never hardcoded (--df-root / $DWF_DF_ROOT / autodetect).
. "$(dirname "${BASH_SOURCE[0]}")/../lib/dfroot.sh"
DF="$(df_root_or_die "headless_reload_test.sh" "$@")"
SAVE="${1:-region1}"
run() { "$DF/hack/dfhack-run.exe" "$@" 2>&1; }
lua() { "$DF/hack/dfhack-run.exe" lua "$1" 2>/dev/null | tr -d '\r\n'; }

echo "[1] kill DF (headless ok)"
PID=$(tasklist //FI "IMAGENAME eq Dwarf Fortress.exe" //FO CSV //NH 2>/dev/null | head -1 | cut -d, -f2 | tr -d '"')
[ -n "$PID" ] && taskkill //PID "$PID" //F >/dev/null 2>&1
sleep 3

echo "[2] relaunch + wait for DFHack RPC"
powershell.exe -NoProfile -Command "Start-Process -FilePath '$(cygpath -w "$DF/Dwarf Fortress.exe")' -WorkingDirectory '$(cygpath -w "$DF")'" >/dev/null 2>&1
for i in $(seq 1 60); do netstat -ano 2>/dev/null | grep -q "127.0.0.1:5000.*LISTEN" && break; sleep 3; done
sleep 10
echo "  viewscreen: $(lua 'print(dfhack.gui.getCurFocus and dfhack.gui.getCurFocus()[1] or "?")')"

echo "[3] try headless load-save $SAVE"
OUT=$(run load-save "$SAVE")
echo "  load-save said: $OUT"

echo "[4] poll fortress mode (90s)"
for i in $(seq 1 30); do
  [ "$(lua 'print(dfhack.world.isFortressMode())')" = "true" ] && {
    echo "HEADLESS-LOAD-OK"; run capture-stream-start >/dev/null 2>&1; exit 0; }
  sleep 3
done
echo "HEADLESS-LOAD-FAILED (DF left at title; waiting for manual load — poll isFortressMode)"
exit 2
