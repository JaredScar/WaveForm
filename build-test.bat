@echo off
REM Runs WaveForm node unit tests with the pinned Node 24 toolchain.
REM Pass a --run glob, e.g. build-test.bat --run out/vs/platform/agentHost/**
set "PATH=C:\Users\Axeex\.waveform-toolchain\node-v24.18.0-win-x64;%PATH%"
cd /d "C:\Users\Axeex\PhpstormProjects\WaveForm"
call node_modules\.bin\mocha.cmd test\unit\node\index.js --delay --ui=tdd --timeout=15000 --exit %*
