@echo off
setlocal
cd /d "%~dp0.."
title dwf Texture Pipeline Lab
node tools\texture-lab-server.mjs
if errorlevel 1 (
  echo.
  echo The Texture Lab server could not start.
  pause
)
