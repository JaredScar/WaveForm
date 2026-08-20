@echo off
REM Typechecks the workbench sources with the pinned Node 24 toolchain.
set "PATH=C:\Users\Axeex\.waveform-toolchain\node-v24.18.0-win-x64;%PATH%"
cd /d "C:\Users\Axeex\PhpstormProjects\WaveForm"
call node_modules\.bin\tsc.cmd -p src\tsconfig.json --noEmit
