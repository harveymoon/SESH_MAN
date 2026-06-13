@echo off
rem Double-click to launch seshMan independently of any Claude Code session.
rem Launches the Electron GUI binary directly (no cmd wrapper window).
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
