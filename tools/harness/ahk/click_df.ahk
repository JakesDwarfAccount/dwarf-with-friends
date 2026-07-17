; click_df.ahk <x> <y>  -- reliably foreground DF, then move-then-click at screen (x,y).
; Synthetic OS clicks are ignored by DF's title widgets; AHK move-then-click on the FOREGROUND
; window registers. The Alt-key tap defeats Windows' SetForegroundWindow lock so WinActivate
; actually raises DF (WinActivate alone silently fails when another app owns the foreground).
SetTitleMatchMode, 2
CoordMode, Mouse, Screen
x := A_Args[1]
y := A_Args[2]
WinGet, id, ID, Dwarf Fortress
if (id = "")
{
    FileAppend, NO-DF-WINDOW`n, *
    ExitApp, 2
}
Send, {Alt down}{Alt up}
WinActivate, ahk_id %id%
WinWaitActive, ahk_id %id%,, 6
clicks := A_Args[3]
if (clicks = "")
    clicks := 1
Sleep, 400
MouseMove, %x%, %y%, 12
Sleep, 250
Click, %x%, %y%
Sleep, 200
WinGetTitle, at, A
FileAppend, CLICK %x%`,%y% activeTitle=%at%`n, *
ExitApp, 0
