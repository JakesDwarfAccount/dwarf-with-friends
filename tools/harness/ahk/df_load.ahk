; Autonomous DF save loader for dwf WS testing.
; DFHack simulateInput + synthetic OS clicks are no-ops on the modern widget title screen;
; only AHK's move-then-click registers. Window is moved to a known position so the fixed
; screen-coordinate clicks land on the right widgets.
SetTitleMatchMode, 2
CoordMode, Mouse, Screen
DetectHiddenWindows, Off

; 1) Focus + reposition the DF window to a known geometry (50,50 @ 1200x800).
WinWait, Dwarf Fortress,, 60
if ErrorLevel
{
    FileAppend, LOADER-FAIL: DF window not found`n, *
    ExitApp, 2
}
WinActivate, Dwarf Fortress
WinWaitActive, Dwarf Fortress,, 10
WinMove, Dwarf Fortress,, 50, 50, 1200, 800
Sleep, 1500

; 2) Title screen -> "Continue Active Game"
MouseMove, 970, 730, 10
Sleep, 400
Click, 970, 730
Sleep, 2500

; 3) World selection -> most-recent world row
MouseMove, 790, 730, 10
Sleep, 400
Click, 790, 730
Sleep, 2500

; 4) Fort/save selection -> most-recent fort save
MouseMove, 800, 725, 10
Sleep, 400
Click, 800, 725
Sleep, 2000

FileAppend, LOADER-DONE: click sequence issued`n, *
ExitApp, 0
