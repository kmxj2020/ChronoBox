@echo off
setlocal
cd /d "%~dp0"
title ChronoBox - Build Windows Installer
echo ======================================================
echo   Building ChronoBox Windows Installer (.exe)
echo ======================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 18+.
    pause
    exit /b 1
)
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
if not exist "node_modules\typescript\bin\tsc" (
    echo [1/2] Installing dependencies via npmmirror CDN...
    call npm install --registry=https://registry.npmmirror.com/
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)
echo [2/2] Building Windows x64 NSIS Installer and Portable .exe...
call npm run dist:win
if errorlevel 1 (
    echo [ERROR] Packaging failed. Please check logs above.
    pause
    exit /b 1
)
echo.
echo [DONE] Output files are ready in release\
explorer release
pause
