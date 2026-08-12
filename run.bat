@echo off
chcp 65001 >nul
title Xtractor - Smart Attendance System

echo ========================================
echo تطبيق الحضور الذكي Xtractor
echo ========================================
echo.
echo جاري تشغيل الخادم...
echo.
pushd "%~dp0" >nul

echo Checking for .env (will copy from .env.example if missing)...
if exist ".env" goto deps_check
if exist ".env.example" goto copy_env
goto deps_check

:copy_env
copy ".env.example" ".env" >nul
echo Created .env from .env.example. Please edit .env to add AIRTABLE_API_KEY and PROTECTION_API_KEY as needed.

:deps_check

where node >nul 2>&1 || (echo ERROR: Node.js not found in PATH. Install Node.js and try again. & pause & exit /b 1)

if not exist "node_modules" (
    echo Installing npm dependencies (this may take a moment)...
    npm install --no-audit --no-fund || (echo npm install failed. & pause & exit /b 1)
)

echo Launching server (logs printed below)...
node server.js

echo.
echo Server process exited with code %ERRORLEVEL%.
pause
popd >nul