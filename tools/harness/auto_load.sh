#!/usr/bin/env bash
# Fully autonomous deploy + load for dwf. Uses low-level mouse_event clicks (AHK SendInput
# is ignored by DF's SDL2; mouse_event works) with the DF window pinned to (0,0,1400,1000) so
# click coords are stable. Verifies each menu transition via DFHack and retries.
set -u
# W1: resolved, never hardcoded (--df-root / $DWF_DF_ROOT / autodetect).
. "$(dirname "${BASH_SOURCE[0]}")/../lib/dfroot.sh"
DF="$(df_root_or_die "auto_load.sh" "$@")"
DLL="$(dwf_built_dll "auto_load.sh" "$@")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# AutoHotkey is host-specific; point DWF_AHK_EXE at your AutoHotkeyU64.exe (MSYS-style path).
EXE="${DWF_AHK_EXE:?auto_load.sh: set DWF_AHK_EXE to your AutoHotkeyU64.exe path}"
MEC="$HERE/ahk/click_me.ahk"
run() { "$DF/hack/dfhack-run.exe" "$@" 2>/dev/null; }
lua() { "$DF/hack/dfhack-run.exe" lua "$1" 2>/dev/null | tr -d '\r\n'; }
click() { "$EXE" "$(cygpath -w "$MEC")" "$1" "$2" >/dev/null 2>&1; }

DEPLOY=deploy
for arg in "$@"; do [ "$arg" = "noload" ] && DEPLOY=noload; done
if [ "$DEPLOY" = "deploy" ]; then
  echo "[1] kill DF + copy DLL"
  PID=$(tasklist //FI "IMAGENAME eq Dwarf Fortress.exe" //FO CSV //NH 2>/dev/null | head -1 | cut -d, -f2 | tr -d '"')
  [ -n "$PID" ] && taskkill //PID "$PID" //F >/dev/null 2>&1
  sleep 3
  cp "$DLL" "$DF/hack/plugins/dwf.plug.dll" || { echo "COPY FAIL"; exit 1; }
  # Quarantine any stale pre-rename DLL so DFHack does not load BOTH (old + new bind :5000 = trap).
  [ -e "$DF/hack/plugins/dfcapture.plug.dll" ] && { rm -f "$DF/hack/plugins/dfcapture.plug.dll"; echo "removed stale dfcapture.plug.dll (pre-rename)"; }
fi

echo "[2] relaunch + wait for title RPC"
powershell.exe -NoProfile -Command "Start-Process -FilePath '$(cygpath -w "$DF/Dwarf Fortress.exe")' -WorkingDirectory '$(cygpath -w "$DF")'" >/dev/null 2>&1
for i in $(seq 1 60); do netstat -ano 2>/dev/null | grep -q "127.0.0.1:5000.*LISTEN" && break; sleep 3; done
sleep 8

echo "[3] pin window to (0,0,1400,1000)"
powershell.exe -NoProfile -Command "
Add-Type @'
using System;using System.Runtime.InteropServices;
public class W{[DllImport(\"user32.dll\")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);}
'@;
\$p=Get-Process 'Dwarf Fortress' -EA SilentlyContinue | Where-Object {\$_.MainWindowHandle -ne 0} | Select-Object -First 1;
if(\$p){[void][W]::ShowWindow(\$p.MainWindowHandle,9);Start-Sleep -Milliseconds 300;[void][W]::MoveWindow(\$p.MainWindowHandle,0,0,1400,1000,\$true)}
" >/dev/null 2>&1
sleep 2

echo "[4] Continue -> World -> Save (mouse_event, verified)"
# Continue active game: mode 0 -> 2
for t in 1 2 3 4 5; do [ "$(lua 'print(dfhack.gui.getCurViewscreen().mode)')" = "2" ] && break; click 1045 812; sleep 1.5; done
echo "  after Continue: mode=$(lua 'print(dfhack.gui.getCurViewscreen().mode)')"
# World row: mode 2 -> 3
for t in 1 2 3 4 5; do [ "$(lua 'print(dfhack.gui.getCurViewscreen().mode)')" = "3" ] && break; click 1000 812; sleep 1.5; done
echo "  after World: mode=$(lua 'print(dfhack.gui.getCurViewscreen().mode)')"
# Save row 2 (region1, active): -> load
for t in 1 2 3; do [ "$(lua 'print(dfhack.world.isFortressMode())')" = "true" ] && break; click 830 865; sleep 2; done

echo "[5] wait for fortress mode"
for i in $(seq 1 25); do [ "$(lua 'print(dfhack.world.isFortressMode())')" = "true" ] && { echo "  FORTRESS MODE"; run capture-stream-start >/dev/null 2>&1; exit 0; }; sleep 3; done
echo "  TIMEOUT loading"; exit 2
