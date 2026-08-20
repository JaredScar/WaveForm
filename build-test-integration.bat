@echo off
REM Runs WaveForm extension-host integration tests with the pinned Node 24
REM toolchain. Pass a suite, e.g.
REM   build-test-integration.bat --suite git
set "PATH=C:\Users\Axeex\.waveform-toolchain\node-v24.18.0-win-x64;%PATH%"
cd /d "C:\Users\Axeex\PhpstormProjects\WaveForm"
call scripts\test-integration.bat %*
