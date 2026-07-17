@echo off
REM B246 -- MSVC syntax-only (/Zs) check for dwf TUs, using the BUILD'S OWN include set and
REM defines, lifted from the resolved DFHack build's dfcapture_public.vcxproj
REM dfcapture_public.vcxproj (AdditionalIncludeDirectories + PreprocessorDefinitions +
REM AdditionalOptions + LanguageStandard). This is the only compile-side oracle available when the
REM DLL cannot be linked/deployed (no DF process). It proves the TU PARSES AND TYPE-CHECKS against
REM the real df-structures headers -- i.e. that df::item_statuest::description, item->getItemShapeDesc(),
REM df::engraving::art_id, world->art_image_chunks etc. actually EXIST with the types we use.
REM It does NOT prove runtime behaviour. Say so loudly in any closeout.
REM
REM Usage:  tools\harness\clzs.cmd src\interaction.cpp [more.cpp ...]
setlocal
set "DFHACK_BUILD="
set "DFHACK_SOURCE="
if /i "%~1"=="--dfhack-build" (
  set "DWF_DFHACK_BUILD=%~2"
  shift
  shift
)
for /f "usebackq delims=" %%I in (`node --input-type=module -e "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); const r=m.resolveDfhackBuild(); if(r.root) console.log(r.root); else process.exit(2)" "%~dp0..\lib\dfroot.mjs"`) do set "DFHACK_BUILD=%%I"
if not defined DFHACK_BUILD (
  echo [clzs] no DFHack build tree; pass --dfhack-build or set DWF_DFHACK_BUILD
  exit /b 2
)
for /f "tokens=1,* delims==" %%A in ('findstr /b "CMAKE_HOME_DIRECTORY:INTERNAL=" "%DFHACK_BUILD%\CMakeCache.txt" 2^>nul') do set "DFHACK_SOURCE=%%B"
if not defined DFHACK_SOURCE for %%I in ("%DFHACK_BUILD%\..") do set "DFHACK_SOURCE=%%~fI"
REM MSVC 14.51 (VS18 BuildTools) -- the exact toolset CMakeCache.txt records for this build.
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
  echo [clzs] vcvars64.bat not found
  exit /b 9
)

cl /Zs /nologo /std:c++20 /EHsc /MD /bigobj /utf-8 /vmg /vmm ^
  /DWIN32 /D_WINDOWS /DNDEBUG /D_CRT_NONSTDC_NO_WARNINGS /D_CRT_SECURE_NO_WARNINGS ^
  /DDFCAPTURE_GIT_HASH#\"b246\" /DDFHACK64 /DPROTOBUF_USE_DLLS /DLUA_BUILD_AS_DLL /DUSE_FMTLIB ^
  /Ddfcapture_public_EXPORTS ^
  /I"%~dp0..\..\third_party\cpp-httplib" ^
  /I"%DFHACK_SOURCE%\depends\SDL2\SDL2-2.26.2\include" ^
  /I"%DFHACK_SOURCE%\library\include" ^
  /I"%DFHACK_SOURCE%\library\proto" ^
  /I"%DFHACK_BUILD%\_deps\fmt-src\include" ^
  /I"%DFHACK_SOURCE%\depends\lua\include" ^
  /external:I "%DFHACK_SOURCE%\depends\zlib\include" ^
  %*
exit /b %errorlevel%
