@echo off
REM Installs and builds WaveForm's dependencies.
REM
REM Three things this sets up that a plain `npm install` does not:
REM   - the MSVC environment, because node-gyp's own Visual Studio detection
REM     fails against the installed toolset and needs VCINSTALLDIR preset;
REM   - Node 24 ahead of the system Node 22, because the repo's preinstall
REM     script is TypeScript and only Node 24 runs .ts natively;
REM   - an explicit `npm rebuild`, because a native build that fails during
REM     install (as the Spectre-lib check did) does not fail the install
REM     itself, leaving the .node bindings silently missing.
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
set "PATH=C:\Users\Axeex\.waveform-toolchain\node-v24.18.0-win-x64;%PATH%"
cd /d "C:\Users\Axeex\PhpstormProjects\WaveForm"
node -v
call npm install
if errorlevel 1 exit /b 1
call npm rebuild --foreground-scripts
