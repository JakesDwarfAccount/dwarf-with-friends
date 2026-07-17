#!/usr/bin/env bash
# Autonomous deploy + load cycle for dwf.
# 1) kill DF  2) copy freshly-built DLL  3) relaunch  4) wait for DFHack RPC (title)
# 5) AHK-load the save  6) wait for fortress mode. Exits 0 when fort is loaded.
set -u
# W1: resolved, never hardcoded (--df-root / $DWF_DF_ROOT / autodetect).
. "$(dirname "${BASH_SOURCE[0]}")/../lib/dfroot.sh"
DF="$(df_root_or_die "deploy_load.sh" "$@")"
DLL_SRC="$(dwf_built_dll "deploy_load.sh" "$@")"
# AHK loader lives outside the repo; point $DWF_AHK_DIR at the dir holding
# ahkfiles/AutoHotkeyU64.exe and df_load.ahk.
AHK_DIR="${DWF_AHK_DIR:?set DWF_AHK_DIR to the folder holding ahkfiles/AutoHotkeyU64.exe and df_load.ahk}"
AHK="$AHK_DIR/ahkfiles/AutoHotkeyU64.exe"
LOADER="$AHK_DIR/df_load.ahk"
RUN="C:\\Program Files\\... "

echo "[1] killing DF"
PID=$(tasklist //FI "IMAGENAME eq Dwarf Fortress.exe" //FO CSV //NH 2>/dev/null | head -1 | cut -d, -f2 | tr -d '"')
[ -n "$PID" ] && taskkill //PID "$PID" //F >/dev/null 2>&1
sleep 3

echo "[2] copying DLL"
cp "$DLL_SRC" "$DF/hack/plugins/dwf.plug.dll" || { echo "COPY FAIL (DF still locking?)"; exit 1; }
# Quarantine any stale pre-rename DLL so DFHack does not load BOTH (old + new bind :5000 = trap).
[ -e "$DF/hack/plugins/dfcapture.plug.dll" ] && { rm -f "$DF/hack/plugins/dfcapture.plug.dll"; echo "removed stale dfcapture.plug.dll (pre-rename)"; }

echo "[3] relaunching DF"
powershell.exe -NoProfile -Command "Start-Process -FilePath '$(cygpath -w "$DF/Dwarf Fortress.exe")' -WorkingDirectory '$(cygpath -w "$DF")'" >/dev/null 2>&1

echo "[4] waiting for DFHack RPC (title screen)"
for i in $(seq 1 60); do
  if netstat -ano 2>/dev/null | grep -q "127.0.0.1:5000.*LISTEN"; then echo "  RPC up (${i}x3s)"; break; fi
  sleep 3
done
sleep 8   # let the title screen widgets settle

echo "[5] AHK-loading the save"
"$AHK" "$(cygpath -w "$LOADER")"
echo "  loader exit=$?"

echo "[6] waiting for fortress mode"
for i in $(seq 1 45); do
  R=$("$DF/hack/dfhack-run.exe" lua "print(dfhack.world.isFortressMode())" 2>/dev/null | tr -d '\r\n')
  if [ "$R" = "true" ]; then echo "  FORTRESS MODE (${i}x4s)"; exit 0; fi
  sleep 4
done
echo "  TIMEOUT: not in fortress mode"
exit 2
