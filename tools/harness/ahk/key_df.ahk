; key_df.ahk <keys>  -- foreground DF, send a key sequence (AHK Send syntax).
SetTitleMatchMode, 2
keys := A_Args[1]
WinGet, id, ID, Dwarf Fortress
Send, {Alt down}{Alt up}
WinActivate, ahk_id %id%
WinWaitActive, ahk_id %id%,, 6
Sleep, 500
Send, %keys%
Sleep, 200
FileAppend, KEYS %keys%`n, *
ExitApp, 0
