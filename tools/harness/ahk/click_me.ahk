; click_me.ahk <physX> <physY> -- low-level mouse_event click at PHYSICAL screen pixels.
; Distinct from AHK's default SendInput Click: uses SetCursorPos + mouse_event, which some
; SDL2 builds honor when SendInput is ignored.
SetTitleMatchMode, 2
px := A_Args[1]
py := A_Args[2]
WinGet, id, ID, Dwarf Fortress
Send, {Alt down}{Alt up}
WinActivate, ahk_id %id%
WinWaitActive, ahk_id %id%,, 6
Sleep, 400
DllCall("SetCursorPos", "int", px, "int", py)
Sleep, 250
DllCall("mouse_event", "uint", 0x02, "uint", 0, "uint", 0, "uint", 0, "uptr", 0)  ; LEFTDOWN
Sleep, 120
DllCall("mouse_event", "uint", 0x04, "uint", 0, "uint", 0, "uint", 0, "uptr", 0)  ; LEFTUP
Sleep, 200
FileAppend, ME-CLICK %px%`,%py%`n, *
ExitApp, 0
