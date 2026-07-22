@echo off
setlocal
title Dwarf With Friends - Development Setup

pushd "%~dp0" >nul

where node.exe >nul 2>nul
if errorlevel 1 (
    echo.
    echo Dwarf With Friends setup could not find Node.js.
    echo Install Node.js 18 or newer, then run this file again.
    echo.
    pause
    popd >nul
    exit /b 1
)

echo.
echo Opening Dwarf With Friends setup...
echo Use "Get cloudflared" to download and verify the tunnel program.
echo Keep this window open until setup is finished.
echo.

node.exe ".\host\setup.mjs"
set "DWF_EXIT=%ERRORLEVEL%"

if not "%DWF_EXIT%"=="0" (
    echo.
    echo Dwarf With Friends setup stopped with an error.
    echo Review the message above, then press any key to close this window.
    pause >nul
)

popd >nul
exit /b %DWF_EXIT%
