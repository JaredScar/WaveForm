@echo off
REM Launches WaveForm's Agents window against the persistent dev profile that
REM the launch skill later clones from. Sign in once here and every isolated
REM launch inherits the session.
set "PATH=C:\Users\Axeex\.waveform-toolchain\node-v24.18.0-win-x64;%PATH%"
cd /d "C:\Users\Axeex\PhpstormProjects\WaveForm"
call scripts\code.bat --agents --user-data-dir=C:\Users\Axeex\.vscode-oss-dev
