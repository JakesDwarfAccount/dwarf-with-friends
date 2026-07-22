@echo off
setlocal
title Dwarf With Friends - Development Host

pushd "%~dp0" >nul

where node.exe >nul 2>nul
if errorlevel 1 (
    echo.
    echo Dwarf With Friends could not find Node.js.
    echo Install Node.js 18 or newer, or use the packaged release launcher.
    echo.
    pause
    popd >nul
    exit /b 1
)

echo.
echo Starting the Dwarf With Friends development host panel...
echo The panel will open in your browser.
echo Keep this window open while hosting. Closing it stops the host panel and tunnel.
echo.

node.exe ".\host\host_panel.mjs" --open
set "DWF_EXIT=%ERRORLEVEL%"

if not "%DWF_EXIT%"=="0" (
    echo.
    echo The Dwarf With Friends host panel stopped with an error.
    echo Review the message above, then press any key to close this window.
    pause >nul
)

popd >nul
exit /b %DWF_EXIT%
