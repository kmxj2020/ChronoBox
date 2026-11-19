@echo off
setlocal
cd /d "%~dp0"
title ChronoBox - Install and Start
echo ======================================================
echo   ChronoBox (Windows) - Electron + TypeScript
echo ======================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
if not exist "node_modules\typescript\bin\tsc" (
    echo [1/3] Installing dependencies via npmmirror CDN...
    call npm install --registry=https://registry.npmmirror.com/
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check network or proxy settings.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies already installed.
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo [1.5/3] Completing Electron binary download from China mirror...
    call npm rebuild electron
    if errorlevel 1 (
        echo [ERROR] Electron binary download failed.
        pause
        exit /b 1
    )
)
echo [2/3] Building TypeScript project...
call npm run build
if errorlevel 1 (
    echo [ERROR] TypeScript build failed.
    pause
    exit /b 1
)
echo [3/3] Launching ChronoBox...
call npx electron .
if errorlevel 1 (
    echo [ERROR] App exited with error.
    pause
    exit /b 1
)
