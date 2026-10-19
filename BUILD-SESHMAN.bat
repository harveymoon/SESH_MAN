@echo off
setlocal enabledelayedexpansion
title seshMan builder
cd /d C:\code\session_manager
echo ============================================
echo   seshMan builder
echo ============================================
echo.

:waitclose
tasklist /FI "IMAGENAME eq seshMan.exe" 2>nul | find /I "seshMan.exe" >nul
if not errorlevel 1 (
    echo seshMan is still RUNNING. Close it, then press any key...
    pause >nul
    goto waitclose
)
echo seshMan is closed. Waiting 10s for Windows to release locks...
timeout /t 10 /nobreak >nul

:cleanold
if not exist "release\seshMan-win32-x64" goto build
echo Removing the old build folder...
rd /s /q "release\seshMan-win32-x64" 2>nul
if exist "release\seshMan-win32-x64" (
    echo.
    echo   The old build folder is LOCKED - hunting the holders...
    if exist "tools\handle64.exe" (
        powershell -NoProfile -Command "& '%CD%\tools\handle64.exe' -accepteula -nobanner '%CD%\release\seshMan-win32-x64' 2>$null | ForEach-Object { if ($_ -match '^(\S+)\s+pid: (\d+)') { [pscustomobject]@{N=$Matches[1];P=[int]$Matches[2]} } } | Sort-Object P -Unique | ForEach-Object { if ($_.N -in @('seshMan.exe','claude.exe')) { Write-Host ('  NOT killing ' + $_.N + ' pid ' + $_.P + ' - close it yourself') } else { Write-Host ('  killing zombie locker: ' + $_.N + ' pid ' + $_.P); Stop-Process -Id $_.P -Force -ErrorAction SilentlyContinue } }"
        timeout /t 3 /nobreak >nul
        rd /s /q "release\seshMan-win32-x64" 2>nul
    ) else (
        echo   ^(tools\handle64.exe missing - cannot auto-identify holders^)
    )
)
if exist "release\seshMan-win32-x64" (
    echo.
    echo   Still locked. Close any terminal/Explorer window inside the folder,
    echo   wait 30s for antivirus, then press any key to retry...
    pause >nul
    goto cleanold
)

:build
echo.
echo Building (1-2 minutes)...
echo --------------------------------------------
call npm run pack
if errorlevel 1 (
    echo.
    echo   *** BUILD FAILED - see the error above. ***
    echo   Press any key to retry, or close this window to give up.
    pause >nul
    goto waitclose
)

echo --------------------------------------------
echo.
echo   BUILD SUCCEEDED:
for %%F in ("release\seshMan-win32-x64\seshMan.exe") do echo     %%~tF   %%~zF bytes
echo.
choice /C YN /M "Launch the new seshMan now"
if errorlevel 2 goto done
start "" "C:\code\session_manager\release\seshMan-win32-x64\seshMan.exe"

:done
echo.
echo Done. You can close this window.
pause >nul
