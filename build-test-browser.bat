@echo off
REM Runs WaveForm browser unit tests (Chromium, headless) with the pinned Node 24
REM toolchain. Pass a --runGlob, e.g.
REM   build-test-browser.bat --runGlob "**/vs/sessions/**\/*.test.js"
set "PATH=C:\Users\Axeex\.waveform-toolchain\node-v24.18.0-win-x64;%PATH%"
cd /d "C:\Users\Axeex\PhpstormProjects\WaveForm"
call node test\unit\browser\index.js --browser chromium %*
